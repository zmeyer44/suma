//! sumad — the on-device daemon (PRD §7, §8.4).
//!
//! Chromium points each proxied space at [`proxy`], a localhost CONNECT
//! proxy. For every request the [`policy`] module — a faithful port of
//! `packages/egress-policy/src/index.ts`, the source of truth — answers
//! gateway / direct / **blocked**. Blocked means blocked: "zero silent
//! fallback to direct" is a beta gate, so when the identity gateway is down
//! the proxy answers 502 and never quietly dials the site with the user's
//! real IP.
//!
//! Also here: the thin client end of the suma-agent mux
//! ([`agent_client`]) and the BLAKE3-addressed chunk cache with Files
//! hydration ([`cache`]) — rebuilding a file from a manifest and a chunk
//! source, verifying every chunk and the whole file before it appears on
//! disk. The R2-backed chunk source itself is still to come; hydration takes
//! it as a trait so the two can land independently.

pub mod agent_client;
pub mod cache;
pub mod policy;
pub mod proxy;
