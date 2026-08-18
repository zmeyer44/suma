//! Capability tokens — the I-2 enforcement point.
//!
//! Mirrors the capability section of `packages/protocol/src/agent.ts`. The
//! capability list is deliberately closed: there is no name for device
//! enrollment, session records, key material, or egress configuration,
//! because those planes are unreachable from the VM by construction — the
//! absence of a name is the point.
//!
//! Every ctl handler calls [`check_capability`] before doing anything, and a
//! refusal is final (fail closed). The refusal strings match the TS
//! `checkCapability` byte-for-byte so both sides log identically.

use serde::{Deserialize, Serialize};

use crate::proto::AgentCtlRequest;

/// The complete set of operations a machine credential can be granted.
/// Wire names are the TS string literals (`"pty.spawn"`, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Capability {
    #[serde(rename = "pty.spawn")]
    PtySpawn,
    #[serde(rename = "pty.io")]
    PtyIo,
    #[serde(rename = "pty.resize")]
    PtyResize,
    #[serde(rename = "pty.kill")]
    PtyKill,
    #[serde(rename = "ports.list")]
    PortsList,
    #[serde(rename = "ports.forward")]
    PortsForward,
    #[serde(rename = "fetch.public")]
    FetchPublic,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "log.read")]
    LogRead,
}

impl Capability {
    /// The wire name, matching the TS `CAPABILITIES` entries.
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::PtySpawn => "pty.spawn",
            Capability::PtyIo => "pty.io",
            Capability::PtyResize => "pty.resize",
            Capability::PtyKill => "pty.kill",
            Capability::PortsList => "ports.list",
            Capability::PortsForward => "ports.forward",
            Capability::FetchPublic => "fetch.public",
            Capability::FsRead => "fs.read",
            Capability::FsWrite => "fs.write",
            Capability::LogRead => "log.read",
        }
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub const CAPABILITIES: [Capability; 10] = [
    Capability::PtySpawn,
    Capability::PtyIo,
    Capability::PtyResize,
    Capability::PtyKill,
    Capability::PortsList,
    Capability::PortsForward,
    Capability::FetchPublic,
    Capability::FsRead,
    Capability::FsWrite,
    Capability::LogRead,
];

/// Capabilities a normal interactive terminal session needs.
pub const TERMINAL_CAPABILITIES: [Capability; 7] = [
    Capability::PtySpawn,
    Capability::PtyIo,
    Capability::PtyResize,
    Capability::PtyKill,
    Capability::PortsList,
    Capability::PortsForward,
    Capability::LogRead,
];

/// Capability tokens are short-lived; the agent is re-issued them on demand.
pub const CAPABILITY_TOKEN_TTL_SECONDS: i64 = 300;

/// Claims inside an agent capability token. Deliberately narrow: bound to one
/// machine, one user, a short window, and an explicit capability list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityClaims {
    /// Machine id this token is valid for — a token cannot roam machines.
    pub mid: String,
    /// Owning user id (routing/audit only; grants nothing on its own).
    pub sub: String,
    pub caps: Vec<Capability>,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
}

pub fn has_capability(claims: &CapabilityClaims, cap: Capability) -> bool {
    claims.caps.contains(&cap)
}

/// Check a capability token against the operation being attempted. Returns
/// the reason for refusal, or `None` when allowed — callers must fail closed.
/// Refusal strings are identical to the TS `checkCapability`.
pub fn check_capability(
    claims: &CapabilityClaims,
    machine_id: &str,
    cap: Capability,
    now_seconds: i64,
) -> Option<String> {
    if claims.mid != machine_id {
        return Some("token is bound to a different machine".to_string());
    }
    if claims.exp < now_seconds {
        return Some("capability token expired".to_string());
    }
    if !has_capability(claims, cap) {
        return Some(format!("capability {cap} not granted"));
    }
    None
}

/// Capability required by each ctl operation — the agent's authorization
/// table, mirroring `CTL_CAPABILITY` in agent.ts. Note `pty.attach` requires
/// `pty.io` and `job.set` requires `pty.spawn`, exactly as the TS table says.
pub fn required_capability(req: &AgentCtlRequest) -> Capability {
    match req {
        AgentCtlRequest::PtySpawn { .. } => Capability::PtySpawn,
        AgentCtlRequest::PtyResize { .. } => Capability::PtyResize,
        AgentCtlRequest::PtyKill { .. } => Capability::PtyKill,
        AgentCtlRequest::PtyAttach { .. } => Capability::PtyIo,
        // Listing reveals what attach would reveal (cwd, command), so it
        // requires what attach requires.
        AgentCtlRequest::PtyList => Capability::PtyIo,
        AgentCtlRequest::JobSet { .. } => Capability::PtySpawn,
        AgentCtlRequest::PortsList => Capability::PortsList,
        AgentCtlRequest::FetchPublic { .. } => Capability::FetchPublic,
        // Cancelling is scoped by the same grant that starts a fetch.
        AgentCtlRequest::FetchCancel { .. } => Capability::FetchPublic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(caps: Vec<Capability>) -> CapabilityClaims {
        CapabilityClaims {
            mid: "m-1".into(),
            sub: "u-1".into(),
            caps,
            iat: 1_000,
            exp: 1_000 + CAPABILITY_TOKEN_TTL_SECONDS,
            jti: "j-1".into(),
        }
    }

    // The four outcomes of check_capability, in TS evaluation order.

    #[test]
    fn refuses_a_token_bound_to_a_different_machine() {
        let c = claims(vec![Capability::PtySpawn]);
        assert_eq!(
            check_capability(&c, "m-2", Capability::PtySpawn, 1_000),
            Some("token is bound to a different machine".to_string())
        );
    }

    #[test]
    fn refuses_an_expired_token() {
        let c = claims(vec![Capability::PtySpawn]);
        assert_eq!(
            check_capability(&c, "m-1", Capability::PtySpawn, c.exp + 1),
            Some("capability token expired".to_string())
        );
        // Mirrors TS `exp < now`: a token checked exactly at exp is valid.
        assert_eq!(
            check_capability(&c, "m-1", Capability::PtySpawn, c.exp),
            None
        );
    }

    #[test]
    fn refuses_an_ungranted_capability() {
        let c = claims(vec![Capability::PtySpawn]);
        assert_eq!(
            check_capability(&c, "m-1", Capability::FetchPublic, 1_000),
            Some("capability fetch.public not granted".to_string())
        );
    }

    #[test]
    fn allows_a_granted_in_window_capability_on_the_right_machine() {
        let c = claims(vec![Capability::PtySpawn, Capability::PortsList]);
        assert_eq!(
            check_capability(&c, "m-1", Capability::PortsList, 1_100),
            None
        );
    }

    #[test]
    fn claims_deserialize_from_the_ts_wire_shape() {
        let raw = r#"{"mid":"m-1","sub":"u-9","caps":["pty.spawn","pty.io","log.read"],"iat":1700000000,"exp":1700000300,"jti":"tok-1"}"#;
        let c: CapabilityClaims = serde_json::from_str(raw).unwrap();
        assert_eq!(c.mid, "m-1");
        assert_eq!(
            c.caps,
            vec![Capability::PtySpawn, Capability::PtyIo, Capability::LogRead]
        );
        // Unknown capability names are a hard error, not silently dropped —
        // a token naming a capability this agent doesn't know is not trusted.
        let bad = r#"{"mid":"m","sub":"u","caps":["device.enroll"],"iat":0,"exp":0,"jti":"x"}"#;
        assert!(serde_json::from_str::<CapabilityClaims>(bad).is_err());
    }

    #[test]
    fn authorization_table_matches_the_ts_ctl_capability_map() {
        use crate::proto::AgentCtlRequest as R;
        let attach: R = serde_json::from_str(r#"{"t":"pty.attach","ptyId":"a"}"#).unwrap();
        assert_eq!(required_capability(&attach), Capability::PtyIo);
        let job: R = serde_json::from_str(r#"{"t":"job.set","ptyId":"a","enabled":true}"#).unwrap();
        assert_eq!(required_capability(&job), Capability::PtySpawn);
        let ports: R = serde_json::from_str(r#"{"t":"ports.list"}"#).unwrap();
        assert_eq!(required_capability(&ports), Capability::PortsList);
    }
}
