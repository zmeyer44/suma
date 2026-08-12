//! Tunnel authentication.
//!
//! Every CONNECT carries a bearer token in `Proxy-Authorization`. The token
//! binds the tunnel to a user id so per-user metering and abuse controls
//! (§9) have something to key on; a missing or unverifiable token is a 407 —
//! the gateway never opens an anonymous tunnel.
//!
//! Verification is deliberately a single seam: [`TokenVerifier`], with two
//! implementations:
//!
//! * [`SharedSecretVerifier`] — the one a deployment may serve traffic with.
//!   It recomputes a keyed BLAKE3 MAC over the token body and compares in
//!   constant time, so a token cannot be forged and the `user` field cannot be
//!   swapped to charge another account (§9 metering).
//! * [`DevTokenVerifier`] — shape-check only, i.e. **no authentication at
//!   all**. Reachable only through the explicit `SUMA_EGRESS_DEV_INSECURE=1`
//!   opt-in, which also forces a loopback bind (see [`crate::startup`]).
//!
//! Both are interim: the end state is asymmetric verification against the
//! control plane's public key, with expiry inside the token. A shared secret
//! means the gateway can also *mint* tokens, which an asymmetric scheme fixes.
//! That change lands behind this same trait and nothing in the connection path
//! moves.

/// Expected prefix of an egress token: `sm-egress-v1.<user>.<sig>`.
pub const DEV_TOKEN_PREFIX: &str = "sm-egress-v1";

/// Shared secret length. 32 bytes = the BLAKE3 key size; supplied as 64 hex
/// characters in the environment.
pub const SHARED_SECRET_BYTES: usize = 32;

/// The one seam where token trust is decided. Returns the authenticated user
/// id, or `None` — callers must fail closed with 407 on `None`.
pub trait TokenVerifier: Send + Sync {
    fn verify(&self, token: &str) -> Option<String>;
}

/// Development verifier: shape-checks `sm-egress-v1.<user>.<sig>` and trusts
/// it. This is NOT authentication — anyone who can reach the listener can pick
/// any `user` they like. It exists so the wire flow, the 407 path, and
/// per-user metering are real while control-plane key distribution is built,
/// and it is unreachable without the `SUMA_EGRESS_DEV_INSECURE=1` opt-in
/// that pins the listener to loopback.
pub struct DevTokenVerifier;

impl TokenVerifier for DevTokenVerifier {
    fn verify(&self, token: &str) -> Option<String> {
        let (user, sig) = split_token(token)?;
        if sig.is_empty() {
            return None;
        }
        Some(user.to_string())
    }
}

/// Verifier for `sm-egress-v1.<user>.<mac>`, where `<mac>` is
/// `BLAKE3-keyed(secret, "sm-egress-v1.<user>")` in lowercase hex.
///
/// The MAC covers the user id, so the metering identity is authenticated: a
/// holder of one user's token cannot re-point it at another account, and a
/// caller without the secret cannot produce a token at all.
///
/// Known limits, deliberately stated rather than implied away: the token
/// carries no expiry (revocation is control-plane-side until the asymmetric
/// scheme lands), and a symmetric secret means every gateway holding it can
/// mint tokens as well as check them.
pub struct SharedSecretVerifier {
    key: [u8; SHARED_SECRET_BYTES],
}

impl SharedSecretVerifier {
    pub fn new(key: [u8; SHARED_SECRET_BYTES]) -> Self {
        SharedSecretVerifier { key }
    }

    /// Parse the 64-hex-character form used in configuration.
    pub fn from_hex(secret_hex: &str) -> anyhow::Result<Self> {
        let bytes = decode_hex(secret_hex.trim()).ok_or_else(|| {
            anyhow::anyhow!(
                "egress token secret must be {} bytes of lowercase hex ({} characters)",
                SHARED_SECRET_BYTES,
                SHARED_SECRET_BYTES * 2
            )
        })?;
        let key: [u8; SHARED_SECRET_BYTES] = bytes.try_into().map_err(|_| {
            anyhow::anyhow!(
                "egress token secret must be exactly {} bytes of hex",
                SHARED_SECRET_BYTES
            )
        })?;
        Ok(SharedSecretVerifier::new(key))
    }

    /// The issuing side of the same MAC. The control plane mints tokens; the
    /// gateway only ever calls [`TokenVerifier::verify`]. Kept here so the two
    /// halves cannot drift apart.
    pub fn mint(&self, user: &str) -> String {
        let body = token_body(user);
        let mac = blake3::keyed_hash(&self.key, body.as_bytes());
        format!("{body}.{}", hex(mac.as_bytes()))
    }
}

impl TokenVerifier for SharedSecretVerifier {
    fn verify(&self, token: &str) -> Option<String> {
        let (user, sig) = split_token(token)?;
        let provided = decode_hex(sig)?;
        let provided: [u8; 32] = provided.try_into().ok()?;
        let expected = blake3::keyed_hash(&self.key, token_body(user).as_bytes());
        // `blake3::Hash`'s PartialEq is constant-time; comparing the hex
        // strings instead would leak the MAC one byte at a time.
        if expected == blake3::Hash::from(provided) {
            Some(user.to_string())
        } else {
            None
        }
    }
}

/// The MAC'd part of a token — everything a verifier must bind, including the
/// user id the tunnel is metered against.
fn token_body(user: &str) -> String {
    format!("{DEV_TOKEN_PREFIX}.{user}")
}

/// Common shape check: `sm-egress-v1.<user>.<sig>` with a well-formed user
/// id. Returns `(user, sig)`; the signature is not inspected here.
fn split_token(token: &str) -> Option<(&str, &str)> {
    let mut parts = token.split('.');
    let prefix = parts.next()?;
    let user = parts.next()?;
    let sig = parts.next()?;
    if parts.next().is_some() || prefix != DEV_TOKEN_PREFIX {
        return None;
    }
    let user_ok = !user.is_empty()
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !user_ok {
        return None;
    }
    Some((user, sig))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).expect("nibble"));
        out.push(char::from_digit((b & 0x0f) as u32, 16).expect("nibble"));
    }
    out
}

/// Lowercase-hex decode. `None` on odd length, non-hex, or uppercase input —
/// configuration and tokens have one canonical spelling.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    s.as_bytes()
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .filter(|_| !pair[0].is_ascii_uppercase())?;
            let lo = (pair[1] as char)
                .to_digit(16)
                .filter(|_| !pair[1].is_ascii_uppercase())?;
            Some(((hi << 4) | lo) as u8)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_well_shaped_token_and_extracts_the_user() {
        let v = DevTokenVerifier;
        assert_eq!(
            v.verify("sm-egress-v1.user_123.devsig"),
            Some("user_123".to_string())
        );
    }

    #[test]
    fn rejects_wrong_prefix_missing_segments_and_bad_user_ids() {
        let v = DevTokenVerifier;
        assert_eq!(v.verify(""), None);
        assert_eq!(v.verify("garbage"), None);
        assert_eq!(v.verify("wrong-prefix.user.sig"), None);
        assert_eq!(v.verify("sm-egress-v1.user"), None); // missing sig
        assert_eq!(v.verify("sm-egress-v1..sig"), None); // empty user
        assert_eq!(v.verify("sm-egress-v1.user."), None); // empty sig
        assert_eq!(v.verify("sm-egress-v1.user.sig.extra"), None);
        assert_eq!(v.verify("sm-egress-v1.us er.sig"), None); // bad charset
    }

    fn key() -> [u8; SHARED_SECRET_BYTES] {
        let mut k = [0u8; SHARED_SECRET_BYTES];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn shared_secret_verifier_accepts_its_own_tokens() {
        let v = SharedSecretVerifier::new(key());
        let token = v.mint("user_123");
        assert!(token.starts_with("sm-egress-v1.user_123."));
        assert_eq!(v.verify(&token), Some("user_123".to_string()));
    }

    /// The defect this verifier exists to close: a well-shaped token with a
    /// signature nobody could have computed must not open a tunnel.
    #[test]
    fn shared_secret_verifier_rejects_a_bad_signature() {
        let v = SharedSecretVerifier::new(key());
        // The dev-shaped token the old entrypoint accepted from anyone.
        assert_eq!(v.verify("sm-egress-v1.user_123.devsig"), None);
        // Right length, right alphabet, wrong MAC.
        assert_eq!(
            v.verify(&format!("sm-egress-v1.user_123.{}", "ab".repeat(32))),
            None
        );
        // A real token with one flipped hex digit.
        let token = v.mint("user_123");
        let mut tampered: Vec<char> = token.chars().collect();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == '0' { '1' } else { '0' };
        assert_eq!(v.verify(&tampered.into_iter().collect::<String>()), None);
        // A token minted under a different secret.
        let other = SharedSecretVerifier::new([9u8; SHARED_SECRET_BYTES]);
        assert_eq!(v.verify(&other.mint("user_123")), None);
    }

    /// Metering (§9) keys on the user id, so the MAC must cover it: taking a
    /// valid token and renaming its user must not verify.
    #[test]
    fn the_user_id_cannot_be_swapped_on_a_valid_token() {
        let v = SharedSecretVerifier::new(key());
        let token = v.mint("victim");
        let sig = token.rsplit_once('.').unwrap().1;
        assert_eq!(v.verify(&format!("sm-egress-v1.attacker.{sig}")), None);
    }

    #[test]
    fn secret_parsing_refuses_anything_but_64_lowercase_hex_characters() {
        assert!(SharedSecretVerifier::from_hex(&"ab".repeat(32)).is_ok());
        assert!(SharedSecretVerifier::from_hex("").is_err());
        assert!(SharedSecretVerifier::from_hex("abcd").is_err()); // too short
        assert!(SharedSecretVerifier::from_hex(&"ab".repeat(33)).is_err()); // too long
        assert!(SharedSecretVerifier::from_hex(&"AB".repeat(32)).is_err()); // uppercase
        assert!(SharedSecretVerifier::from_hex(&"zz".repeat(32)).is_err()); // not hex
    }
}
