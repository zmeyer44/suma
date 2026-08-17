//! suma-agent — the in-VM daemon (PRD §8.5, Appendix C).
//!
//! One mux connection from sumad carries labeled channels: `ctl`,
//! `pty/<id>`, `fwd/<port>`, `vfs`, `log`. The wire shapes on `ctl` are
//! defined by `packages/protocol/src/agent.ts` — that TypeScript module is
//! the source of truth and [`proto`] mirrors it field-for-field.
//!
//! Security stance (I-2): the machine credential this agent runs under is
//! near-zero-privilege. It cannot enroll devices, cannot reach the session
//! plane (no path exists — I-1), cannot touch the identity gateway (I-3).
//! Every ctl operation is authorized by a short-lived capability token, and
//! [`dispatch`] fails closed: no valid capability, no side effect. Rooting
//! the VM therefore grants nothing beyond the VM itself.

pub mod caps;
pub mod chunker;
pub mod dispatch;
pub mod fetch;
pub mod jobs;
pub mod mux;
pub mod ports;
pub mod proto;
pub mod pty;
pub mod vfs;
pub mod watch;
