# Suma security model (skeleton)

**Status:** working skeleton of the standalone security/privacy document
required before beta (PRD §9). It describes both what is implemented today and
what is designed but unbuilt — each section says which. The session plane,
control plane, sync engine, desktop capture/hydration, **and (Phase 1) the
device-token authentication + revocation path** exist in code; the
**identity egress gateway, compute plane, and Files are design, not yet
implemented.**

---

## 1. Invariants

Stated exactly as in PRD §9:

- **I-1 (the spine, exception-free):** Session material — cookies, tokens,
  storage — never exists on the compute plane, in any form, ever. No data path
  exists from the session plane to the VM; egress is blind CONNECT on a
  separate plane; the sealed-request carve-out is deleted.
- **I-2:** Compromise of the user workload cannot impersonate an enrolled
  device, mint credentials, or gain privileges beyond the VM itself.
  (Enforced by credential scoping — PRD §8.5.) **Phase 2 makes this concrete:**
  the agent authorizes every operation against a short-lived *capability
  token* bound to one machine and one explicit capability list
  (`packages/protocol/src/agent.ts`). The capability vocabulary deliberately
  contains no name for device enrollment, session records, key material, or
  egress configuration — there is nothing to ask for. A capability token is
  also rejected by every device/user route on the control plane, so a rooted
  VM cannot escalate into the account.
- **I-3:** Compute workload abuse cannot contaminate or control the browser's
  identity egress. (Enforced by plane separation — the gateway runs no user
  code and has its own network identity.) **Phase 2:** the gateway is a
  separate CONNECT-only service (`services/egressgw`) that the compute VM has
  no path to and no credential for; the browser's tunnel is established by the
  client sidecar, never by the agent.

## 2. Key hierarchy (implemented — `packages/protocol/src/keys.ts`)

PRD §8.2 as built:

1. **Per-space random root secret** (32 bytes — the "DEK" in PRD terms). Two
   subkeys are derived from it via HKDF-SHA-256: an AES-256-GCM **seal key**
   for session-record envelopes and an HMAC-SHA-256 **id key** producing
   pseudonymous record/origin ids. One secret to wrap, rotate, and recover per
   space.
2. **The root secret is wrapped independently for each enrolled credential**
   (`KeyWrapper`, kinds: `passkey-prf`, `recovery-code`, `hardware-key`,
   `kms`). Passkey KEKs are derived from WebAuthn PRF output via HKDF — PRF
   output is credential-associated and is **never used directly as a data
   key**, only to derive a wrapping KEK.
3. **Offline recovery code:** 160-bit Crockford-base32 code, shown once,
   PBKDF2-SHA-256 at 600,000 iterations → wrapping KEK.
4. **Rotation:** wrappers rotate on device add/revoke; the root secret itself
   rotates after a security event.
5. **KMS fallback is a visible security mode** ("Suma-managed keys" badge),
   never a silent downgrade. Zero silent E2EE→server-readable transitions is a
   beta gate. *(The `kms` wrapper kind exists in the protocol; the KMS service
   integration and UI badge are not yet built.)*

Sealed records are AES-256-GCM envelopes (`version || iv || ciphertext+tag`)
with the record identity bound as AAD. The server stores keyed deterministic
record ids (HMAC over the full cookie identity tuple) and keyed origin ids —
it sees pseudonymous ids, sizes, and timing, not origins or cookie names.
**Residual timing/activity metadata is real and documented here honestly:**
the session plane can observe when and how much a pseudonymous origin churns.

## 3. Threats and mitigations (PRD §9)

| Threat | Mitigation | Status |
|---|---|---|
| Malicious code in VM reads sessions | I-1; nothing to read — zero exceptions | Holds by construction: the agent's capability vocabulary has no name for session state, and no code path carries session records to the compute plane |
| VM abuse burns browser IP reputation | I-3: separate egress identities; compute abuse throttles/suspends compute only | Implemented (Phase 2): the gateway is a separate service with its own identity; the VM holds no gateway credential. Per-user abuse caps live in the control plane |
| VM impersonates user's devices | I-2: near-zero-privilege machine credential; no device certs in VM | Implemented (Phase 2): machine-bound, short-TTL capability tokens; capability tokens are refused by device/user routes |
| Gateway used as an SSRF pivot into Suma's own infrastructure | The CONNECT proxy refuses loopback and private-range targets, and refuses port 25 (spam-egress abuse, §9) | Implemented (Phase 2, `services/egressgw`) |
| Proxied browsing silently leaks the real IP | QUIC **and** WebRTC UDP are disabled when any space is proxied (a CONNECT proxy tunnels TCP only, so Chromium would otherwise race HTTP/3 or STUN past it); local/private/VPN traffic is bypassed by rule, never tunnelled; a degraded gateway **fails closed** rather than falling back to direct, in the client *and* in sumad itself | Implemented (Phase 2, `packages/egress-policy` + client wiring + `sidecar`) |
| A rooted VM inflates its own egress figures to throttle the browser | Egress metering is plane-split: agent-authenticated samples may carry compute/storage only and are refused (403) if they carry proxied bytes; egress totals come from a separately-authenticated gateway source, and every numeric field is bounded | Implemented (Phase 2, `services/control`) |
| A live job is silently suspended, freezing the user's work | The suspend guard defaults to **keeping the machine awake**: no activity snapshot, or a stale one, refuses an auto-suspend; only an explicit user-initiated suspend forces it | Implemented (Phase 2, §8.5) |
| Rogue/stolen device injects or resurrects cookies | Device-signed mutations, causal-ancestry resurrection guard, durable tombstones (≥ 30 days) with deletion causes, per-origin rollback, mass-overwrite rate limits | Implemented in protocol + sync engine + SessionHub. Record signature *verification* on receipt runs through `RecordVerifier`; the client registry is seeded with the local device and, in Phase 1, the hub authenticates every connection with a control-signed device token (below) so an unenrolled/revoked device cannot even connect. Populating the client-side registry with all enrolled devices' public keys (so a peer record's signature is checked against its claimed device) is the remaining Phase-1.x hardening; the hook and reject policy exist and are tested. |
| Malicious extension harvests cross-origin sessions | Curated+pinned list, per-release regression tests, dev-mode gate + scare-screen, per-space scoping | Design (extension surface not yet shipped) |
| Web content escalates into privileged UI | Hardened separate WebContents for `suma://` pages, strict CSP/navigation rules | Partial (desktop shell; privileged pages beyond the shell land with their features) |
| Hostile page abuses `window.open` (popunders, popup floods, spoofed sign-in windows) | Requests are classified (`popup-policy.ts`): only auth ceremonies and Chromium-reported popup dispositions become real windows, in the opener's own space session; popups show the live origin as their title as an anti-phishing signal, close with their opener, and are rate-limited per source tab. Everything else becomes a tab or is denied. | Implemented — see [`docs/auth-flows.md`](auth-flows.md) |
| Page requests a capability it shouldn't have | Permission handler fails closed by default; camera/mic/screen-share require an attributable tab or popup plus user approval, and only storage-access and clipboard-sanitized-write (needed by federated sign-in and "copy your backup code") are additionally granted (`permission-policy.ts`). | Implemented |
| Insider / DO breach reads sessions | Client-side sealed records under per-space keys; pseudonymous record ids; KMS mode visibly labeled + access-audited | Sealing + pseudonymous ids implemented; KMS labeling/audit not yet built |
| Insider reads files | Stated openly: `$HOME` not E2EE in V1; access-controlled + audited; roadmap item | Implemented as stated (Phase 3): chunks are stored in R2 unencrypted, and the Files app says so rather than implying otherwise. Client-side encryption for `~/cloud` remains a roadmap item |
| A download's credentials reach the compute plane | `cloudFetchEligibility` (§8.6) fails closed: cookies, Authorization headers, client certs, and URL userinfo all keep a download on the Mac. v1.0's "sealed one-shot request" is deleted, not reimplemented, and the transfer record has no field a credential could occupy | Implemented (Phase 3) |
| One account's chunks are read or claimed by another | Chunks are keyed and stored per user (`chunks/<userId>/<hash>`), so a content hash is never a cross-account existence oracle or claim ticket — the classic convergent-dedup attack. Cross-account dedup is given up deliberately | Implemented (Phase 3) |
| Device theft | Keychain-protected local store; revocation ≤ 60 s with honest contract (§5 below) | Partial: revocation propagation constant + control-plane model exist; full flow lands with device enrollment UX |
| Plane MITM / supply chain / spam-egress abuse | Pinned mTLS everywhere; signed builds + SLSA; port-25 block, rate caps, AUP tooling, payment-verified accounts | Design |

## 4. Files: the honest statement (PRD §8.6)

I-1 answers "can Suma read my sessions," not "can Suma read my code." In
V1, **`$HOME` volume contents and snapshots are not end-to-end encrypted** —
Suma operators could technically access them. This is stated plainly here
and in onboarding, with access controls, audit logging, and SSH-key/secrets
guidance. Only `~/cloud` is cloud-native (canonical in R2); client-side
encryption for `~/cloud` is a roadmap item. "The data is not the business
model" is a posture, not an access-control design — this document says which
is which.

## 5. Device revocation: the honest contract (PRD §8.2)

Revocation kills Suma certs and DO sessions within 60 s
(`REVOCATION_PROPAGATION_MS` in `packages/config`). **It cannot invalidate
third-party sessions already copied to an offline stolen Mac.** The UI
therefore provides: "Stop future Suma access" (immediate) · "Purge on
reconnect" · a list of affected third-party origins · guidance for remotely
terminating those sessions at the origin (Google, GitHub, etc.).

**Implemented today (Phase 1):** devices authenticate with short-lived
EdDSA device tokens (`packages/protocol/src/token.ts`) minted by the control
plane after a device-key or passkey login and verified by the SessionHub
against the control plane's public key (`CONTROL_PUBLIC_KEY`). Revoking a
device (a) invalidates its token for every control-plane API call, (b) is
pushed to the SessionHub's admin endpoint, which **closes the device's live
WebSockets (close code 4003) and refuses its reconnects** within the §8.2
≤ 60 s contract, and (c) short token TTL (10 min) bounds any window where a
token minted just before revocation could still be presented.

Two hardening properties close the review's findings:

- **No forgeable bootstrap credential.** The unsigned `hbr_dev_<userId>` stub
  is a dev-only convenience. Both planes reject it once real signing keys are
  configured — the hub when `CONTROL_PUBLIC_KEY` is set
  (`services/sessionhub/src/auth.ts`), and the control plane when
  `CONTROL_TOKEN_SK/PK` are set (`services/control/src/auth.ts` +
  `keys-provider.ts` `envProvided`). Production signup instead issues a
  **signed, short-lived bootstrap token** (unforgeable from a known userId)
  that lets the first device enroll before it has a device credential.
- **Durable revocation propagation.** If the hub notification fails or the hub
  isn't yet reachable, the revocation is queued in a `revocation_outbox` table
  and retried — opportunistically on the next revoke and by a periodic drain
  in the control server (`services/control/src/outbox.ts`), so one failed HTTP
  call never leaves a revoked device syncing. As defense in depth the hub
  **re-checks revocation on every frame**, not just at connect, so an
  already-open socket is terminated on its next message even if the
  socket-close was missed.

**Not yet implemented:** true mutual-TLS device certificates (the token scheme
is the V1 software analogue) and purge-on-reconnect wiping of a stolen Mac's
local store. Third-party sessions already on an offline stolen Mac remain
outside Suma's reach — the honest contract above stands.

## 6. Privacy posture

- No browsing-content telemetry.
- Connection-level proxy logs (bytes/duration) retained **7 days** for abuse
  handling, publicly documented. The gateway's metrics type carries no
  hostname or URL field at all, so "we don't log what you browse" is a
  property of the data structure rather than a promise about how it is used.
- Server-visible sync metadata is pseudonymous (see §2), with the residual
  timing caveat stated above.

## 7. External audit

An independent security audit before GA is **budgeted, not aspirational**
(PRD §9, §14.6). Scope: invariants, key hierarchy, sync deletion semantics,
revocation, and the egress plane once built.

## 7b. Known limitations of the Phase 2 planes (stated, not hidden)

An adversarial review of Phase 2 produced ten findings; the exploitable ones
are fixed and regression-tested. What remains is written down here rather than
left for a reader to discover:

- **The gateway does not yet verify token signatures.** Its verifier is a seam
  with a development implementation that checks token *shape* only. That
  implementation now refuses to run unless an explicit opt-in environment
  variable is set, and in that mode it binds loopback only — so a
  misconfiguration cannot quietly publish an open proxy on a user's identity
  IP. A signing-key-backed verifier, and TLS/mTLS termination for the
  listener, are required before the gateway faces the internet.
- **QUIC and WebRTC are disabled process-wide, not per space.** Chromium
  decides both at process scope, so a workspace mixing proxied and direct
  spaces applies the restriction to all of them. Over-restricting is the safe
  direction; narrowing this is follow-up work.
- **A space switched to the identity IP mid-session is not routed until
  relaunch,** because `--disable-quic` can only be applied before startup.
  The space browses direct in the meantime and the UI says so explicitly.
- **The in-VM agent does not yet report activity to the control plane,** so
  the process-aware suspend decision has no live input. The guard therefore
  refuses every automatic suspend until a snapshot arrives; only an explicit
  user action suspends. This is the safe failure direction (§8.5) but it means
  idle machines are not yet being suspended to save money.
- **Sample-count is unbounded.** Per-sample values are range-checked, but a
  compromised VM can still inflate its *own* compute total by posting many
  valid samples. That is visible on the user's own cost meter and has no
  cross-plane effect; a per-period dedupe is the fix.
- **The gateway authenticates to the control plane with a shared secret.** A
  signed gateway identity would be stronger once the gateway fleet grows
  beyond one.

## 7c. Known limitations of the Files plane (Phase 3)

An adversarial review of Phase 3 produced ten findings; the exploitable ones
are fixed and regression-tested. What remains is recorded here:

- **`fetch.public` is confined but not additionally capability-gated.** A
  holder of a `fetch.public` token can write anywhere *inside* `~/cloud` — the
  same root every `vfs` operation is confined to — without also holding
  `fs.write`. That matches what the capability names; splitting them would
  mean changing the shared capability table.
- **A presigned chunk-upload URL can be reused within its TTL.** Signing
  `content-length` stops a size-inflation attack, but replacing a chunk's
  bytes with *different bytes of the same length* inside the 15-minute window
  is not prevented. Closing it needs a one-shot upload token or server-side
  hash verification.
- **Object deletion has a narrow post-commit window.** Chunk rows are released
  transactionally, but the R2 delete happens after commit (an object store has
  no rollback) with a recheck. A row re-claimed in between is always inserted
  with `storedAt = NULL`, which forces a re-upload rather than serving missing
  bytes.
- **Cross-account deduplication is deliberately given up.** Chunks are keyed
  `chunks/<userId>/<hash>`, so a content hash can never act as an existence
  oracle or a claim ticket for another account's data. This costs storage.
- **Neither `$HOME` nor `~/cloud` is end-to-end encrypted in V1.** Chunks are
  stored in R2 unencrypted and Suma operators could technically read them.
  The Files app states this rather than implying otherwise; client-side
  encryption for `~/cloud` remains a roadmap item.
- **The in-VM agent still performs no per-request token verification** (see
  §7b) — one configured capability set applies to every connection reaching
  its port. The Files work inherits that limitation.

## 8. Sections owed before beta (per PRD §9, not yet written)

Local + remote threat models in full · data lifecycle (account deletion +
cryptographic erasure, a hard beta gate) · incident response.
