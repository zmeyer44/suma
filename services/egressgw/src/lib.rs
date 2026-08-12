//! suma-egressgw — identity egress gateway (PRD §8.4).
//!
//! The gateway is **blind by construction**: it speaks HTTP CONNECT only, so
//! TLS stays end-to-end between the user's browser and the site. There is no
//! interception path in the code because there is no request parsing beyond
//! the CONNECT head — the gateway never sees a URL, a header the client sends
//! to the site, or a byte of plaintext. It is also **non-programmable**: no
//! user code, no shell, no config surface beyond per-space/per-site policy
//! delivered by the control plane (I-3 — the VM plane cannot touch this one).
//!
//! Transport: TCP in this phase. MASQUE/QUIC-native proxying is the V2 path
//! (PRD §8.4); the CONNECT semantics here carry over unchanged.

pub mod auth;
pub mod metrics;
pub mod policy;
pub mod server;
pub mod startup;
