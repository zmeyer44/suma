//! mint-egress-token — operator utility for the Phase-0 spike
//! (docs/egress-spike.md): prints one `sm-egress-v1.<user>.<mac>` token.
//!
//! Interim by design, like the shared secret itself: once the control plane
//! mints tokens (asymmetric scheme, expiry in-token), this bin goes away.
//! Until then this is the ONLY issuing path outside the tests, so the spike
//! never needs the secret pasted anywhere but the gateway's environment and
//! the operator's shell.
//!
//!     SUMA_EGRESS_TOKEN_SECRET=<64 hex> cargo run -p suma-egressgw \
//!         --bin mint-egress-token -- <user-id>

use suma_egressgw::auth::{SharedSecretVerifier, TokenVerifier};
use suma_egressgw::startup::SECRET_VAR;

fn main() -> anyhow::Result<()> {
    let user = std::env::args().nth(1).ok_or_else(|| {
        anyhow::anyhow!("usage: mint-egress-token <user-id>   (reads {SECRET_VAR})")
    })?;
    let secret = std::env::var(SECRET_VAR)
        .map_err(|_| anyhow::anyhow!("{SECRET_VAR} must be set (64 lowercase hex characters)"))?;
    let verifier = SharedSecretVerifier::from_hex(&secret)?;

    // Mint, then verify our own output: a user id the gateway's parser would
    // reject (dots, spaces, uppercase…) must fail HERE, not as a mystery 407
    // half way through the spike.
    let token = verifier.mint(&user);
    if verifier.verify(&token).as_deref() != Some(user.as_str()) {
        anyhow::bail!(
            "user id {user:?} does not survive the token round-trip — \
             use only ASCII letters, digits, '-' and '_'"
        );
    }
    println!("{token}");
    Ok(())
}
