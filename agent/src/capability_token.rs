//! Verification for control-plane-issued `suma-cap+jws` connection grants.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};

use crate::caps::CapabilityClaims;

const CAPABILITY_HEADER: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6InN1bWEtY2FwK2p3cyJ9";

pub fn decode_public_key(value: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(value.trim())
        .map_err(|_| "SUMA_AGENT_VERIFY_KEY is not valid base64".to_string())?;
    if bytes.len() != 32 {
        return Err("SUMA_AGENT_VERIFY_KEY must contain a 32-byte Ed25519 key".to_string());
    }
    Ok(bytes)
}

pub fn verify_capability_token(
    public_key: &[u8],
    token: &str,
    now_seconds: i64,
) -> Result<CapabilityClaims, String> {
    let mut parts = token.split('.');
    let header = parts.next().ok_or_else(|| "malformed token".to_string())?;
    let payload = parts.next().ok_or_else(|| "malformed token".to_string())?;
    let signature = parts.next().ok_or_else(|| "malformed token".to_string())?;
    if parts.next().is_some() || header != CAPABILITY_HEADER {
        return Err("not a capability token".to_string());
    }
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "malformed token signature".to_string())?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(format!("{header}.{payload}").as_bytes(), &signature)
        .map_err(|_| "bad capability token signature".to_string())?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "malformed token payload".to_string())?;
    let claims: CapabilityClaims =
        serde_json::from_slice(&payload).map_err(|_| "malformed capability claims".to_string())?;
    if claims.exp < now_seconds {
        return Err("capability token expired".to_string());
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn signed_token(exp: i64) -> (Vec<u8>, String) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let payload = URL_SAFE_NO_PAD.encode(
            format!(
                r#"{{"mid":"m-1","sub":"u-1","caps":["pty.spawn"],"iat":1000,"exp":{exp},"jti":"j-1"}}"#
            )
            .as_bytes(),
        );
        let signing_input = format!("{CAPABILITY_HEADER}.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(pair.sign(signing_input.as_bytes()).as_ref());
        (
            pair.public_key().as_ref().to_vec(),
            format!("{signing_input}.{signature}"),
        )
    }

    #[test]
    fn verifies_signature_type_and_expiry() {
        let (public_key, token) = signed_token(1_300);
        let claims = verify_capability_token(&public_key, &token, 1_100).unwrap();
        assert_eq!(claims.mid, "m-1");
        assert_eq!(claims.jti, "j-1");
        assert_eq!(
            verify_capability_token(&public_key, &token, 1_301).unwrap_err(),
            "capability token expired"
        );
    }

    #[test]
    fn rejects_tampering_and_other_token_families() {
        let (public_key, token) = signed_token(1_300);
        let mut tampered = token.clone();
        tampered.push('A');
        assert_eq!(
            verify_capability_token(&public_key, &tampered, 1_100).unwrap_err(),
            "bad capability token signature"
        );
        let device = token.replacen(CAPABILITY_HEADER, "eyJ0eXAiOiJKV1QifQ", 1);
        assert_eq!(
            verify_capability_token(&public_key, &device, 1_100).unwrap_err(),
            "not a capability token"
        );
    }
}
