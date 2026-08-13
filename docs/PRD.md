# Suma — V1 Product Requirements Document

**Version:** 1.1 · August 2026
**Status:** Revised after design review → build
**Name:** Suma (sumabrowser.com)

---

## 0. One-liner

**Your browser workspace and development context follow you from Mac to Mac.** Sessions and the canonical workspace restore automatically on first link where the web permits it. Each Mac continuously saves an encrypted device-scoped workspace restore point; later changes are reconciled with canonical or a distinct device copy through explicit Push, Pull, or Merge. Your terminal and files live in a personal cloud machine — but every page still renders locally at native speed.

**Thesis (unchanged):** every "cloud browser" to date streamed pixels or DOM from remote Chromium, trading away latency, fidelity, and offline resilience. Suma inverts it — **rendering stays local; only state is cloud-native.** The VM is a state store and a computer, never a renderer.

**What changed in the promise:** the durable moat is not "we copy every login cookie." Cookie portability is an eroding assumption — Chrome's Device Bound Session Credentials (DBSC) binds session renewal to a device-held private key and is already shipping on Windows; the broader direction of the web is intentionally non-portable sessions. The durable moat is **workspace restoration + identity-aware handoff + persistent compute + graceful reauthentication.** That product survives DBSC. The v1.0 product did not.

---

## 1. Problem & positioning

**Problem.** Browser state is trapped in devices. Chrome Sync moves bookmarks and passwords but not sessions or workspaces — a new machine means re-assembling your working context and re-authenticating everything from scratch. Dev environments are trapped too: your terminal, checkouts, and running processes die when the lid closes. Downloads pile up on whichever machine received them.

**Who has this worst:** developers and technical founders on macOS with ≥2 machines, living in the terminal, juggling 30+ authenticated web apps.

**Positioning:** "Arc, if Arc had been born cloud-native." One coherent object: your computing session, portable. Not a remote browser, not VDI, not a dev-env product with a browser bolted on.

**Non-goals for V1:** teams/sharing, mobile, Windows/Linux clients, detached remote tabs, AI features, Chrome Web Store parity, Finder integration (moved to V1.1), authenticated cloud fetches (moved out of V1 entirely).

---

## 2. Target user (V1)

- **Primary:** professional developers & technical founders, macOS Apple Silicon, 2+ machines, currently paying for at least one of Codespaces/cloud IDE, VPN, or Setapp-tier tooling.
- **Secondary:** power users (ops, data, design-eng) with heavy multi-account usage.

**Removed from v1.0:** the exclusion of password-manager users. That exclusion contradicted the target ICP and the 40% default-browser goal — the target user _is_ a 1Password/Bitwarden user. One credential path is now a ship blocker (§8.1).

---

## 3. Product principles

1. **Local render, cloud state.** Never stream a page that could render locally.
2. **State has one home.** Every state category has exactly one canonical location and a defined sync tier.
3. **The VM is not trusted with your sessions.** (Invariant I-1, now exception-free.)
4. **Fail loud, fail safe.** Outages are visible; defaults protect the user.
5. **Every feature survives the lid-close test.**
6. **Promise continuity, not magic.** _(New.)_ Per-origin behavior is tested, labeled, and visible in the product. Suma never claims a restore it hasn't verified.

---

## 4. Continuity model _(new section)_

Every origin in a user's workspace has a continuity mode, shown as a small indicator in the sidebar/site controls:

| Mode             | User experience                                                                         | How assigned                                                          |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Portable**     | Session restores automatically on a new device; no interaction.                         | Origin is in the tested corpus and passes automated restore checks.   |
| **Assisted**     | Tabs and app context restore; Suma invokes a passkey / normal reauth flow. One-touch. | Origin fails silent restore but supports fast reauth, or is untested. |
| **Device-bound** | Workspace restores; Suma explains the site requires a new device session.             | DBSC/device-fingerprinting detected, or user/policy exclusion.        |

**Supported-origin corpus:** a fixed set of the ~30–50 most common applications among design partners, each with automated compatibility tests run against every Suma release and continuously against origin changes. **This corpus is an internal product** — a compatibility pipeline with per-origin restore tests, challenge detection, and regression alerting. Budget it as ongoing engineering, not a one-time spreadsheet.

**Per-origin metrics:** automatic restore rate, assisted reauth rate, unexpected-challenge rate, session-corruption rate. New origins roll out staged (one device → all devices) — never propagate an untested origin fleet-wide immediately.

**Sensitive-origin exclusions:** banks, corporate SSO, and user-flagged origins default to Assisted or Device-bound and are excluded from sync unless explicitly opted in.

---

## 5. Magic moments (demo script = acceptance test)

**M-0 · "My existing workspace becomes Suma."** _(new, P0)_ On the user's existing Mac: install Suma → import spaces, tabs, bookmarks, and history locally from Chrome/Arc → guided sign-in queue for their top applications (passkey- and password-manager-integrated), with an optional explicit per-origin session import (see below) → **useful workspace in < 10 minutes.** Only then demo second-device convergence.

_Session import stance (revises v1.0 open question #3):_ selective cookie import is not inherently a dark pattern — it becomes one when hidden or indiscriminate. A trustworthy version is local-only, shows every origin, keeps decrypted material on-device, defaults sensitive origins to excluded, explains which sites will need fresh auth, and records nothing. On macOS this requires the Chrome Safe Storage Keychain item, which triggers an OS consent prompt — that prompt is a feature, not a bug. **Phase 0 spike + design-partner reaction decides inclusion;** the guided sign-in queue ships regardless.

**M-1 · "New machine, nothing to rebuild."** Fresh Mac → install → passkey sign-in → within 60 s the sidebar, spaces, and tabs are present; **Portable origins (e.g., GitHub, Linear, Gmail if in corpus) are live with no re-login; Assisted origins reauth with one passkey touch.** Measured: p95 time-to-first _authenticated-or-one-touch_ pageview < 60 s for a 1,000-cookie profile; automatic restore rate ≥ target% across the corpus. **Banks are adversarial compatibility tests, not part of the promise.**

**M-2 · "The terminal that survives disconnects."** Start `npm run build` in the Suma terminal on the laptop. Close the lid. Open the desktop. Same terminal tab, same PTY, scrollback intact, process still running — because it never ran on the laptop. Reattach p95 < 2 s. _(Long unattended training jobs are demoed only via explicit Job Mode, §8.5 — the default machine and lifecycle must genuinely support the claim.)_

**M-3 Lite · "Downloads at datacenter speed."** Click a 5 GB **public or presigned** dataset link. Suma hands the fetch to the cloud; it lands in Suma Files at datacenter bandwidth, progress and completion visible on every device, hydrated locally only if opened. _(Authenticated fetches, Finder placeholders, and two-way drive semantics are out of V1 — §8.6.)_

---

## 6. V1 scope

| Keep in V1                                                            | Modified for V1                                                                               | Deferred                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| macOS 14+ Apple Silicon, notarized DMG                                | M-1 = supported continuity + assisted reauth (was: universal session copy)                    | Tier-3 IndexedDB / generic partition-storage sync               |
| Local page rendering, per-space partitions                            | **Minimal daily-driver shell** meeting the §8.1 baseline (was: full Arc-grade parity)         | Finder File Provider (→ V1.1, demand-gated)                     |
| Spaces, sidebar, command bar, split view (2-pane), auto-archive       | **Dedicated identity egress plane**, separate from compute (was: VM egress proxy)             | Authenticated remote downloads (sealed-request design)          |
| Synced spaces, pinned tabs, archives, settings (§8.3 ownership model) | Tier-1 cookies on tested corpus + narrowly selected Tier-2 (was: all-origin 3-tier)           | Full two-way cloud drive, versioning, share links               |
| Passkey auth, device enrollment (mTLS), audit trail                   | Per-space DEK hierarchy + offline recovery code (was: PRF-as-the-key)                         | Boost resizing beyond simple stop/start; GPU                    |
| Minimal persistent terminal, PTY reattach, port forwarding            | "Survives disconnects" + process-aware lifecycle (was: "never dies" + output-silence suspend) | code-server surface, public preview URLs                        |
| Curated + pinned extension set (dev-mode gate for unpacked)           | **One supported password-manager/autofill path — ship blocker**                               | Broad extension-store compatibility                             |
| Public/presigned cloud-download fast path + Files tab                 | Explicit M-0 first-device migration (was: M4 bookmarks-only import)                           | Windows/Linux clients; general-purpose synced `$HOME` marketing |

---

## 7. System architecture

**Five planes** (was four), deliberately decoupled so each can fail, scale, and bill independently:

```
┌──────────────────────────── CLIENT (macOS) ─────────────────────────────┐
│ Suma.app (Electron, castLabs build)                                   │
│  ├─ UI: React + Tailwind + ShadCN/ui + BaseUI(sidebar, spaces, cmd bar, Files)              │
│  ├─ WebContentsView per-space persist: partitions                       │
│  └─ Session hooks: cookies 'changed', will-download, CDP DOMStorage     │
│ sumad (Rust sidecar, launchd)                                         │
│  ├─ Local CONNECT proxy → QUIC tunnel → IDENTITY EGRESS GATEWAY         │
│  ├─ QUIC client → agent (mux: PTY, ports, VFS, control)                 │
│  └─ Chunk cache (BLAKE3-addressed, LRU)                                 │
└───────┬──────────────────────┬──────────────────────┬───────────────────┘
        │ WSS (hibernatable)   │ QUIC (mTLS)          │ QUIC (mTLS, migration)
┌───────▼──────────┐  ┌────────▼───────────┐  ┌───────▼───────────────────┐
│ SESSION PLANE    │  │ IDENTITY EGRESS    │  │ COMPUTE PLANE (per user)  │
│ CF Workers + DO  │  │ PLANE (per user)   │  │ Fly Machine (Firecracker) │
│ "SessionHub" DO: │  │ Blind CONNECT only │  │ ├─ suma-agent (scoped   │
│  sealed records, │  │ Static egress IP   │  │ │   machine credential)   │
│  HLC registry,   │  │ NO user code, non- │  │ ├─ user env: Ubuntu 24.04 │
│  origin leases,  │  │ programmable, own  │  │ │   $HOME, docker,        │
│  device presence │  │ network identity   │  │ │   toolchains            │
└───────┬──────────┘  └────────────────────┘  │ └─ SEPARATE egress ident. │
        │                                     └───────┬───────────────────┘
┌───────▼──────────┐                          ┌───────▼───────────────────┐
│ CONTROL PLANE    │                          │ DATA PLANE                │
│ Hono+Drizzle+Neon│                          │ Cloudflare R2 (FastCDC +  │
│ accounts/devices │                          │ BLAKE3 chunks; $0 egress) │
│ billing/lifecycle│                          └───────────────────────────┘
└──────────────────┘
```

**Key decisions:**

- **Session sync never touches the VM — and now that claim is actually true.** v1.0 asserted "browsing never wakes the VM" while routing all browser traffic through the VM's egress proxy; both could not hold. Devices hydrate from the SessionHub DO; there is no session data path to compute, and no browser traffic path to compute either. _(The v1.0 diagram's "hydrate on wake" arrow from Session Plane → Compute Plane is deleted.)_
- **Identity egress is its own plane** because it protects the thing the product is selling — stable browser network identity. It is minimal, non-programmable, runs no user code, and holds the user's static IP. Compute abuse (a malicious npm package, a scraper container) can burn the _compute_ machine's reputation without touching the browser's. It also restores the cost model: compute hours correlate with terminal use, not browsing hours, and "native speed" isn't taxed by waking a suspended VM on first navigation.
- **Gateway topology is a Phase 0 spike.** Options: (a) per-user micro-machine (shared-cpu-1x / 256 MB) running the CONNECT proxy with a static IP — always-available or sub-second wake; (b) multi-tenant gateway fleet with per-user IP binding, if the platform supports it cleanly. Note: Fly's current guidance favors app-scoped static egress over the legacy per-machine model, at roughly $3.60/mo per IPv4 — **revalidate the "one dedicated IP per user" operational model and price rather than assuming it** (exit criterion in Phase 0).
- **Region:** both gateway and compute pin to the user's home region at signup (IP stability > latency-while-traveling). "Gateway stays home while compute follows the traveler" is a V2 idea; V1 keeps one region.
- **Vendors and the exit hatch** (unchanged from v1.0): Fly Machines for raw Firecracker suspend/resume + volumes; R2 because VFS economics die on S3 egress; all compute-plane calls behind a `SandboxProvider` interface for a V2 self-hosted-Firecracker migration.

---

## 8. Feature specifications

### 8.1 Browser core

Built on Electron (castLabs ECS build → Widevine + VMP for Netflix/Spotify). **Note: BrowserView is deprecated — all embedding uses WebContentsView.**

**Daily-driver baseline** _(new — "Arc-grade shell" covered a fraction of what makes a browser dependable; each item is a beta gate or an explicit documented exclusion):_
password/passkey autofill · camera/mic/notifications/screen-share permission UI · downloads & uploads · printing & PDF viewing · certificate-error UI · crash recovery & tab discard · default-browser and universal-link handling · accessibility (VoiceOver pass) · media DRM · DevTools · pop-up/window behavior · Chromium security-update SLA (published cadence for shipping Electron/Chromium patch releases).

**Credential management — ship blocker.** The v1.0 framing ("MV2 works, curated list") is not a credential answer: **1Password, Bitwarden, and iCloud Passwords browser extensions are all MV3-only.** The MV3 gap therefore blocks _every_ mainstream password manager, for exactly the target user. V1 must ship at least one reliable path, decided in Phase 0:

1. **1Password native integration** (SDK / CLI / native-messaging path without the store extension) — likely strongest ICP fit;
2. **Bitwarden path** (CLI/API-backed native integration);
3. **Suma-native autofill** backed by macOS Passwords — a whole additional product; last resort;
4. **Sponsoring/patching MV3 support in Electron or pulling the Chromium fork forward** — largest lever, largest cost; the fork's scope was already "extensions, MV3, deeper storage hooks."

**Extensions:** curated MV2 list (uBlock Origin, Dark Reader, Vimium, React DevTools), **pinned versions, permission-reviewed, regression-tested per release** — a tested compatibility matrix replaces "MV2 works." Unpacked loading requires an explicit developer mode with a scare-screen: a malicious extension in Suma can reach pages across many valuable authenticated sessions. Extension permissions scoped per Space where the platform allows.

**Privileged pages:** `suma://terminal` and `suma://files` run in separate hardened WebContents and sessions — no Node integration, strict CSP, strict navigation rules; site content can never navigate into, embed, or overlay privileged UI.

**Built-in content blocker:** Ghostery engine + EasyList (unchanged). **Sidebar / Spaces / command bar / split view / downloads UI / updater:** unchanged from v1.0 except reduced polish expectations ("minimal shell," not Arc parity).

### 8.2 Identity, devices, and keys

**Passkey-first auth** and **Secure Enclave device enrollment with short-lived mTLS certs** — unchanged.

**Key hierarchy** _(redesigned — PRF output is credential-associated and must not be the one permanent data key):_

1. Generate a **random data-encryption key (DEK) per Space**; session envelopes encrypt under it.
2. **Wrap the DEK independently for each enrolled credential** — per-passkey KEKs derived via WebAuthn PRF (Apple exposes PRF for exactly this symmetric-key-derivation use).
3. **Offline recovery code** (high-entropy, shown once, user-stored) wraps the DEK; optional hardware security key as an additional wrapper.
4. **Rotate wrappers** on device add/revoke; **rotate the DEK itself** after a security event.
5. **KMS fallback is a visible security mode** ("Suma-managed keys" badge in settings and onboarding), never a silent downgrade. Zero silent E2EE→server-readable transitions is a beta gate.

**Recovery scenarios the design must answer (Phase 0 exit criterion):** lost iCloud Keychain access · deleted passkey · credential without PRF support · multiple passkeys · Apple-account change · last device lost · PRF behavioral differences across authenticators.

**Device revocation — corrected contract.** Revocation kills Suma certs and DO sessions ≤ 60 s. **It cannot invalidate third-party sessions already copied to an offline stolen Mac.** The UI provides: "Stop future Suma access" (immediate) · "Purge on reconnect" · a list of affected third-party origins · links/guidance for remotely terminating those sessions at the origin (Google, GitHub, etc.).

### 8.3 Session sync engine

**Tiers (revised):**

| Tier | State                                          | Scope                                               | Capture                               | Latency   | Conflict policy                                                                   |
| ---- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| 1    | Cookies (incl. HttpOnly)                       | **Tested corpus + staged rollout** (not all-origin) | `cookies.on('changed')` → delta to DO | p95 < 2 s | LWW+HLC for ordinary cookies; **single-writer handoff for rotating-auth origins** |
| 2    | localStorage                                   | **Selected origins where proven necessary**         | CDP DOMStorage events on active tabs  | p95 < 5 s | LWW per (origin, key), HLC                                                        |
| —    | IndexedDB / partition storage                  | **Deferred**                                        | —                                     | —         | —                                                                                 |
| —    | Service workers, HTTP cache, extension storage | Not synced (documented)                             | —                                     | —         | —                                                                                 |

**Tier-3 deferral rationale:** copying live LevelDB directories fights background/service-worker writes, cross-device browser-version skew, snapshot-consistency-while-open, unpredictable first-navigation stalls on large origin DBs, and confusing lease semantics. If a specific corpus origin _needs_ IndexedDB for continuity, build an origin-specific restore — not a generic tier.

**Cookie identity — corrected.** v1.0 keyed cookies by `(space, eTLD+1 origin, name, path)`, which merges cookies that Chromium treats as distinct. The record identity is now the full tuple: **space · host key (preserving exact domain vs. host-only scope) · name · path · partition key (CHIPS) · source scheme.** Reconstruction preserves complete Chromium metadata (expiry, SameSite, secure, httpOnly, session/persistent, priority).

**Deletion semantics — LWW alone resurrects logged-out sessions** (Device A logs out and deletes the refresh cookie; offline Device B later refreshes the old session; B's later timestamp wins; Suma resurrects a session the user explicitly killed). Fixes:

- **Durable tombstones** with explicit retention (≥ 30 days) and a **deletion cause** on every mutation: `EXPLICIT` (user/site logout) · `EXPIRED` · `OVERWRITE` · `EVICTED` · `HYDRATION_ECHO`.
- **Hydration echo suppression:** bulk `cookies.set` during hydration tags resulting change events so they are never re-published as user mutations.
- **Device-signed mutations with causal ancestry** (each record references the HLC/hash it supersedes); an `EXPLICIT` deletion beats a later write whose causal history predates it.
- **Rotating-auth origins** (refresh-token rotation, aggressive session security) are flagged in the corpus and use the **origin lease / single-writer handoff** for cookie writes — LWW is reserved for origins where it's provably safe.
- **Rotating-auth freshness on passive devices:** rotated records are **applied live on arrival**, not staged behind the explicit Sync control — the server retires the previous cookie generation on rotation, so a device holding a staged record is signed out on its next request. Deletions are **writer-scoped**: only the lease holder propagates them; on a passive device a rotating-auth cookie deletion is treated as the server killing a stale generation — it stays local and `EXPLICIT` demotes to `EXPIRED` (no resurrection fence), so the healthy device's live session wins back by LWW. A manual "push this Mac's state" carries explicit intent and bypasses the guard. Residual risk (documented honestly): a signed-out server response that *overwrites* rather than clears an auth cookie on a stale device is indistinguishable from a rotation and can still propagate.
- **Per-origin last-known-good restore point, rollback, and kill switch.** Worst-case UX (logged-out-everywhere) must be recoverable per-origin without nuking the jar.

**Server-visible metadata minimized:** the DO stores **keyed deterministic record IDs** (HMAC over the identity tuple) plus a keyed origin ID for lease/rollback scoping, and a **sealed full record** (host key, name, path, value, metadata all encrypted). The server sees pseudonymous IDs, sizes, and timing — not origin or cookie names. (Residual timing/activity metadata is documented honestly in the security doc.)

**Workspace-state synchronization** _(new — v1.0 promised the sidebar syncs but never specified semantics; without ownership rules, two active Macs constantly rearrange and archive each other's workspace):_

| State                                                       | Ownership                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Spaces, archives, settings                                  | Globally synchronized (independent LWW+HLC registers)                                                       |
| Open-tab presence, each tab's URL/order, active/split focus | Device-local with an automatic per-device restore point; canonical changes only through explicit Push/Merge |
| Authentication state                                        | Automatic first-link hydrate; later remote records staged for manual sync                                   |
| Browsing history                                            | User-configurable encrypted sync (off by default)                                                           |

**Hydration flow and offline queue:** DO WSS → streamed encrypted jar → decrypt → bulk insert before first WebContentsView attaches. The offline queue keeps only the newest HLC winner per record before draining; device clocks remain untrusted.

**Workspace restore points:** SessionHub stores one atomic sealed tab/focus snapshot per device in addition to the canonical attachment registers. Peers cannot overwrite another device's snapshot. The sync chooser offers canonical Push/Pull/Merge plus Pull/Merge from device snapshots that differ from both canonical and the current Mac. A snapshot identical to canonical is suppressed. A newly linked account inherits canonical automatically (or the newest device snapshot once when migrating an account that predates canonical records), after session hydration closes the first-navigation barrier.

### 8.4 Identity egress gateway

- **Topology:** Electron `session.setProxy` per space → `sumad` localhost proxy → QUIC tunnel (mTLS, connection migration — WiFi→hotspot flips survive) → **identity egress gateway** → internet via the user's static IP. The compute VM is not in this path.
- **Blind by construction:** CONNECT-only; TLS end-to-end client↔site; no interception, ever.
- **Non-programmable:** no user code, no shell, no config surface beyond per-space/per-site policy set through the control plane.
- **QUIC/HTTP3:** a CONNECT proxy tunnels TCP only — Chromium will otherwise race QUIC over UDP straight past the proxy, leaking the real IP. **V1 disables QUIC on proxied spaces** (documented perf tradeoff); MASQUE-native proxying is the V2 path.
- **Per-space policy:** Work → via identity IP; Personal → direct; per-site bypass with a seeded hostile-domain list and auto-suggest on challenge detection. **High-bandwidth media domains bypass by default** (configurable) — video through the gateway burns money and adds nothing to identity stability.
- **Local/private traffic never proxied:** localhost, RFC1918, corporate VPN routes bypass by rule; detection of an active corporate VPN surfaces a "browsing direct on this network" notice.
- **Failure mode:** fail-closed with banner + one-click per-space "browse direct for now" (resets on reconnect). Zero _silent_ fallback to direct is a beta gate.
- **Required tests (Phase 0/2):** added page-load and TTFB latency vs. direct · first request after gateway idle · DNS resolution through tunnel · WebRTC (`disable_non_proxied_udp`) · QUIC leak verification · localhost/private/VPN bypass · WiFi↔hotspot migration · intercontinental travel · media-domain bypass behavior.

### 8.5 Terminal & compute

**Contract:** _"A terminal that survives device disconnects and ordinary handoffs."_ Not "never dies" — the infrastructure cannot guarantee that: Fly suspend applies only ≤ 2 GB with no swap, resumed machines can wake with skewed clocks, and a suspended machine **may cold-boot if its snapshot can't restore** — a cold-start recovery path is mandatory, and the UI surfaces whether a PTY was _resumed_ or _reconstructed_.

**Lifecycle — process-aware (replaces v1.0's output-silence rule).** The old rule (`no client AND no PTY output AND no download/port for 5 min → suspend`) fails twice: a quiet long-running job produces no output (silence ≠ idleness), and **suspend freezes wall-clock progress** — a suspended build makes no progress until something wakes it, so v1.0's "training job still running" demo was false under its own policy. New rules:

- **Never auto-suspend while a non-shell user process tree is alive**, unless the user opted that workload into suspend.
- **Job Mode:** explicit "keep running" per command/tab with a visible cost meter ("~$0.0X/hr while awake"). This is the only supported story for long unattended jobs, and the only way they appear in demos.
- Suspend an idle shell freely; wake-on-connect p95 < 2 s.
- **Scrollback (100k lines/PTY), working directory, command history, and terminal metadata persist independently of the memory snapshot** — cold boot loses the process, never the context.

**Sizing:** default shared-cpu-2x / 2 GB (the suspend ceiling) — but Ubuntu + dockerd + agent + modern JS tooling can exhaust 2 GB with no swap. **Phase 0 benchmarks several real design-partner repos and Docker workloads, including OOM behavior** — not one mid-size Next.js repo. Boost mode (stop/start to 4–8 GB, "resume takes ~10 s" expectation-setting) unchanged.

**Agent security (I-2, refined from review):** the review proposed separate microVMs for agent vs. workload; that roughly doubles per-user compute and breaks the 2 GB suspend path. V1 instead makes VM compromise _worthless beyond the VM_:

- The **machine credential is near-zero-privilege**: it cannot enroll or impersonate devices, cannot write to the session plane (no path exists — I-1), cannot touch the identity gateway (separate plane, separate identity — I-3), and authorizes only its own PTY/VFS/port/fetch operations via narrowly scoped capability tokens.
- **No device certs, user keys, or session material ever exist in the VM.**
- Docker remains available (the target user demands it) with the honest consequence stated: root in your own dev VM means you can tamper with the in-guest agent — and gain nothing you don't already own.
- Rootless-container / subordinate-sandbox isolation of the user env is a Phase 0 spike, adopted only if it doesn't wreck Docker DX.

Terminal client (xterm.js + WebGL), agent internals (portable-pty, quinn mux, port watcher), port forwarding chips: unchanged.

### 8.6 Files (V1 = M-3 Lite)

**In V1:**

- **Cloud fetch of public and presigned URLs** (plus deliberately scoped short-lived download tokens): `will-download` intercept → policy (>50 MB or "always cloud") → agent fetches → lands in Suma Files → all devices notified with progress/completion.
- **In-browser Files app** (`suma://files`): browse, preview, upload (chunked → R2), download (hydrate via chunk cache), quota meter. Quotas: Pro 100 GB, soft-block at limit.
- **Authenticated downloads stay local.** The v1.0 "sealed one-shot request" decrypted the user's URL + Cookie header _inside the VM the user can root_ — "memory-only, single-use, audited" are application properties, not security boundaries, when the attacker controls the decrypting environment. It violated the spirit of I-1 and is removed. A future hardened fetch service _outside_ user compute, with a disclosed trust model that structurally cannot retain credentials, may revisit this — and must not be marketed as preserving I-1 unless that's true by construction.

**Deferred to V1.1+ (demand-gated):** Finder File Provider extension, dataless placeholders, two-way local editing, versioning, share links.

**Terminology precision:** only `~/cloud` is cloud-native (JuiceFS-backed, canonical in R2). `$HOME` is a Fly NVMe volume with continuous incremental snapshots (FastCDC/BLAKE3, RPO ≤ 5 min). **Do not market the whole home directory as having one cloud-native canonical location.** Option A/B layout gate (npm ci + fio benchmark) unchanged, runs in Phase 0.

**Files threat model** _(new — I-1 answers "can Suma read my sessions," not "can Suma read my code"):_ in V1, `$HOME` volume contents and snapshots are **not** end-to-end encrypted — Suma operators could technically access them. This is stated plainly in the security doc and onboarding, with access controls, audit logging, and an SSH-key/secrets guidance page. Client-side encryption for `~/cloud` is on the roadmap; "the data is not the business model" is a posture, not an access-control design, and the product says which is which.

### 8.7 Trust controls _(new)_

Sensitive state is visible and controllable in the browser chrome, not buried in settings:

per-origin "sync across devices / never sync / these devices only" · continuity-mode indicator (Portable / Assisted / Device-bound) · per-space "browse through Suma identity IP / browse direct" toggle · new-device approval notification on all enrolled devices · per-origin session history + rollback · degraded-mode banners for session/egress/compute outages · key-mode badge (E2EE vs. Suma-managed).

These are a product advantage, not compliance chores — they're the visible form of the trust the product asks for.

### 8.8 Spaces: the trust boundary, defined honestly

V1 Spaces are **browser-identity containers**: separate cookie jars, separate sync scopes, separate egress policy, separate extension permissions (where possible). **They do not isolate compute or files — there is one VM and one `$HOME` per account,** and the UI must never imply a Work space and Personal space are isolated at the terminal/files layer. The V2 direction (Space owns encryption key, allowed devices, continuity policy, egress identity, audit history, and eventually its own compute/file namespace — the path to client and team Spaces) informs naming and navigation now; open question §15.1 stands.

---

## 9. Security model

**I-1 (the spine, now exception-free):** Session material — cookies, tokens, storage — never exists on the compute plane, in any form, ever. No data path exists from the session plane to the VM; egress is blind CONNECT on a separate plane; the sealed-request carve-out is deleted.

**I-2** _(new)_: Compromise of the user workload cannot impersonate an enrolled device, mint credentials, or gain privileges beyond the VM itself. (Enforced by credential scoping — §8.5.)

**I-3** _(new)_: Compute workload abuse cannot contaminate or control the browser's identity egress. (Enforced by plane separation — the gateway runs no user code and has its own network identity.)

**Threats & mitigations (delta from v1.0):**

| Threat                                             | Mitigation                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Malicious code in VM reads sessions                | I-1; nothing to read — now with zero exceptions                                                                                      |
| VM abuse burns browser IP reputation               | I-3: separate egress identities; compute abuse throttles/suspends compute only                                                       |
| VM impersonates user's devices                     | I-2: near-zero-privilege machine credential; no device certs in VM                                                                   |
| Rogue/stolen device injects or resurrects cookies  | Device-signed mutations, causal ancestry, tombstones, per-origin rollback, mass-overwrite rate limits                                |
| Malicious extension harvests cross-origin sessions | Curated+pinned list, per-release regression tests, dev-mode gate + scare-screen for unpacked, per-space scoping                      |
| Web content escalates into privileged UI           | Hardened separate WebContents for `suma://` pages, strict CSP/navigation rules                                                     |
| Insider / DO breach reads sessions                 | Client-side sealed records under per-space DEKs; pseudonymous record IDs; KMS mode visibly labeled + access-audited                  |
| Insider reads files                                | Stated openly (§8.6): not E2EE in V1; access-controlled + audited; roadmap item                                                      |
| Device theft                                       | Keychain-protected local store; revocation ≤ 60 s with honest contract (§8.2)                                                        |
| Plane MITM / supply chain / spam-egress abuse      | Unchanged from v1.0 (pinned mTLS everywhere; signed builds + SLSA; port-25 block, rate caps, AUP tooling, payment-verified accounts) |

**Privacy posture:** no browsing-content telemetry; connection-level proxy logs (bytes/duration) retained 7 days for abuse handling, publicly documented. **Independent security audit before GA — budgeted, not aspirational.**

**Before beta, security/privacy design ships as its own document** (invariants, key hierarchy, local + remote threat models, files data-access statement, data lifecycle, incident response). The PRD stays unified for build velocity; the security doc splits out because users and auditors need it standalone.

---

## 10. Failure-mode matrix _(new — "fail loud, fail safe" needs specifics)_

| Plane down                         | User can still                                                           | User cannot                                            | UI                                         |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| Session plane (CF/DO)              | Browse normally with local state; queue mutations offline                | Hydrate a new device; see other devices' changes       | "Sync paused" pill; queue depth            |
| Identity egress                    | Browse direct after one-click override (per-space)                       | Present stable IP                                      | Fail-closed banner + override              |
| Compute (VM)                       | Browse, sync sessions                                                    | Terminal, ports, cloud fetch                           | VM status pill: error + retry/cold-boot    |
| Compute cold-boots (snapshot lost) | Reattach to a _reconstructed_ shell with scrollback/history/cwd restored | Recover the dead process                               | Explicit "restored from cold start" notice |
| Control plane                      | Everything already provisioned                                           | Enroll devices, billing changes, machine lifecycle ops | Degraded-mode banner                       |
| Data plane (R2)                    | Browse, terminal                                                         | Files app, snapshots, cloud fetch                      | Files: retry state                         |
| Local sidecar (sumad)            | Basic browsing (direct egress after fail-closed prompt)                  | Proxy, terminal, files                                 | Sidecar restart prompt                     |

Every transition emits events consumed by the client UI. Documented user journeys required for: first install · second-device enrollment · a Portable restore · an Assisted reauth · simultaneous-use conflict · lost/stolen device · deleted passkey · each outage row above · account export & deletion · a corporate app pinned to one approved device.

---

## 11. Unit economics (per active Pro user / month — to be re-derived from Phase 0 data)

| Item                                                                                         | Est.                                   |
| -------------------------------------------------------------------------------------------- | -------------------------------------- |
| Compute VM (2 GB, resumed hours ≈ **terminal** use only, now that browsing doesn't touch it) | $1.50–3.50                             |
| **Identity egress gateway** (micro-machine or fleet share)                                   | $1–2.50 _(spike)_                      |
| Static egress IPv4                                                                           | ~$3.60 _(revalidate app-scoped model)_ |
| Volume (30 GB NVMe)                                                                          | ~$4.50                                 |
| R2 (100 GB + ops; $0 egress)                                                                 | ~$1.60                                 |
| Workers/DO                                                                                   | < $1                                   |
| Proxied bandwidth (NA/EU $0.02/GB; media bypass default cuts volume)                         | ~$0.50–1                               |
| **Total active**                                                                             | **≈ $13–17**                           |
| Idle-month floor                                                                             | ≈ $9–12                                |

**Before pricing is fixed, model:** p50/p90/p99 active compute hours **and** proxied GB (means hide the users who kill margins) · video-heavy and large-download users · volume + snapshot growth · R2 request costs from small-file chunking · abuse costs · support minutes/user · licensing (castLabs, extension lib) + security-audit amortization · 30/60/90-day-idle users.

**Pricing structure to test with design partners** (willingness-to-pay research decides, not anchoring):

| Plan                                                                                            | Contents                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Sync                                                                                            | Workspace + session continuity, no VM, no static IP                     |
| Pro ($25–40 hypothesis; margin at $25 is 40–55% _before_ support/fraud/audit — likely too thin) | Identity egress, terminal, modest compute/storage, fair Boost allowance |
| Compute add-on                                                                                  | Larger machines, metered active hours                                   |
| Reserved identity IP                                                                            | Optional add-on if IP economics require it                              |

**Beta is invitation-only and paid.** No free tier at launch: it reduces abuse (free accounts + egress IPs + VMs is an abuse magnet), produces clean demand signal, and a sync-only free tier is maximum-honeypot with zero revenue. Revisit free tier post-GA with self-hosted compute economics.

---

## 12. Execution plan (2 engineers + agent-assisted coding + targeted security/platform help)

Agent-assisted coding compresses implementation, **not** compatibility testing, browser QA, threat modeling, sync-correctness verification, or incident prep. The 18-week plan is retired. **Target: ~6–7 months to a defensible private beta of the narrowed scope.**

**Phase 0 — Product & kill-risk validation (wk 1–6).** Recruit 15–20 design partners from the exact ICP; collect their top 30 web apps, required extensions, password managers, device combos, corporate policy limits, current spend, willingness to pay. **Technical exit criteria (each is go/kill):**

- Measured compatibility matrix for the top origins (restore/challenge behavior)
- Cookie fidelity harness proving host-only/domain/partition/scheme correctness + tombstone semantics
- **Password-manager path chosen and demonstrated** (§8.1 — hard gate)
- First-device migration working (import + guided sign-in; session-import go/no-go)
- Key recovery demonstrated after loss of the original device; PRF-in-Electron verified
- I-2 credential scoping demonstrated; rootless-sandbox spike result
- Identity gateway spiked: topology chosen, latency and cost measured, QUIC handling verified
- Fly suspend limits + **cold-start fallback** demonstrated; 2 GB memory benchmarks on real partner workloads
- FS layout Option A/B decided; M-3 Lite components confirmed in/out

**Phase 1 — Portable browser alpha (wk 7–16).** Minimal shell meeting the daily-driver baseline · workspace metadata sync with ownership model · passkeys, enrollment, recovery, revocation · Tier-1 continuity on the corpus with continuity-mode UI · M-0 migration · credential path integrated. **Exit: 10 design partners using Suma across two Macs; both engineers daily-driving.**

**Phase 2 — Compute & identity beta (wk 17–28).** Identity egress GA (fail-closed UX, leak tests, travel tests) · terminal with process-aware lifecycle + Job Mode · port forwarding · billing + abuse controls · audit trail UI · security review vs. §9 + external audit scheduled. **Exit: 25–50 private beta users; M-0/M-1/M-2 performed live by a beta user, unassisted.**

**Phase 3 — Files (post-beta / V1.1).** Public/presigned cloud fetch + Files tab (if not landed in Phase 2 slack) → then, **only after usage confirms demand**, File Provider and fuller VFS semantics.

---

## 13. Success metrics

| Category             | Primary metric                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| First-use activation | Time from install → useful migrated workspace (M-0), p50/p90                                             |
| Core activation      | First successful cross-device convergence within 24–48 h of second-device enrollment                     |
| Compatibility        | Automatic authenticated restore rate by corpus origin                                                    |
| Graceful fallback    | Automatic-or-one-touch continuity rate (Portable + Assisted combined)                                    |
| Trust engagement     | % of users configuring Space/device/origin controls                                                      |
| Sync reliability     | Convergence latency (T1 p95 < 2 s), lost mutations = 0, session resurrections = 0, cross-space leaks = 0 |
| Compute              | PTY reattach > 99.5%, Job Mode survival rate, cold-start recovery rate, resume p95 < 2 s                 |
| Habit                | Weekly multi-device sessions per retained user                                                           |
| Retention            | Share of work browsing performed in Suma (default-browser status tracked as secondary)                 |
| Economics            | p90 infra cost and gross margin per retained user within §11                                             |

**Hard beta gates (absolute, not targets):** zero cross-user or cross-space session leakage · zero silent egress fallback to direct · zero silent E2EE→KMS downgrade · no unexplained session resurrection after logout · tested account deletion + cryptographic erasure · tested recovery from a lost original device.

---

## 14. Risks (re-ranked)

1. **Password managers / MV3.** All mainstream password-manager extensions are MV3-only; Electron supports a subset of extension APIs by design and MV3 remains unlanded upstream. This blocks the target user's daily-driver adoption outright. _Mitigation:_ §8.1 ship-blocker decision in Phase 0; the Chromium fork's forcing function may arrive earlier than V2.
2. **Session-portability erosion (DBSC and device-bound auth).** Chrome's DBSC direction makes copied cookies increasingly worthless per-origin over time. _Mitigation:_ the continuity model _is_ the mitigation — the product promise no longer depends on universal cookie portability; corpus pipeline detects binding changes per origin.
3. **Datacenter IP hostility.** Some anti-fraud stacks challenge/block DC ranges regardless of stability. _Mitigation:_ per-site bypass with auto-suggest, seeded hostile list, challenge-rate measurement in beta; V2: residential/ISP partners or user home-relay exit.
4. **Cookie-sync correctness.** Logged-out-everywhere or resurrection bugs are worse than no sync. _Mitigation:_ §8.3 model, property-based tests + jar-diff fuzzing in CI, staged rollout, per-origin rollback/kill switch, hard beta gates.
5. **Daily-driver QA surface.** The §8.1 baseline is a lot of browser to make dependable with two engineers. _Mitigation:_ minimal-shell scope, corpus-driven prioritization, published Chromium-patch SLA, longer timeline.
6. **Honeypot optics/reality.** "All my sessions in your cloud" requires the standalone security doc + external audit before GA — budgeted.
7. **Egress abuse/legal (mini-ISP problem).** §9 controls; ToS review; Fly AUP compliance check before marketing the proxy.
8. **Fly suspend constraints.** ≤ 2 GB / no swap / possible cold boot / clock skew. _Mitigation:_ process-aware lifecycle, cold-start recovery path, context persistence outside snapshots, memory benchmarking gate.
9. **Vendor concentration (Fly + Cloudflare)** — SandboxProvider interface, portable DO logic, S3-compatible R2.
10. **Licensing line items** (castLabs, electron-chrome-extensions commercial license) — confirm terms in Phase 1.

---

## 15. Open questions

1. **Spaces ↔ compute cardinality (V2):** do team/client Spaces imply per-space VMs and file namespaces? Leaning yes — informs naming/UI now (§8.8).
2. **Gateway topology:** per-user micro-machine vs. multi-tenant fleet with per-user IP binding; also revalidate Fly's app-scoped static egress model and pricing. _(Phase 0.)_
3. **Session import depth in M-0:** import + guided sign-in ships regardless; per-origin cookie import is a Phase 0 go/no-go on partner reaction + optics review. _(Replaces v1.0 Q3's flat "no.")_
4. **PRF-only vs. dual-mode keys:** dual-mode with the KMS path as a _visible_ labeled mode is the current answer; confirm recovery UX makes PRF-only viable later.
5. **Travel story:** temporary region relocation (new IP, warned) vs. home-region latency — beta data decides. V1 pins home region.
6. **Name.** "Suma" collides; shortlist before beta.

---

## 16. Appendix

**A. Repo layout (Turborepo)** — v1.0 plus one service:

```
suma/
  apps/desktop        # Electron + React shell
  apps/files          # suma://files UI
  services/control    # Hono + Drizzle (Neon)
  services/sessionhub # CF Worker + Durable Object
  services/egressgw   # identity egress gateway (Rust, CONNECT-only)   ← new
  agent/              # suma-agent (VM, scoped credential)
  sidecar/            # sumad (client daemon)
  packages/protocol   # protobuf → TS + Rust
  packages/config
  infra/
  # fp-extension/ returns in V1.1
```

**B. Sync protocol sketch (revised):**

```protobuf
message CookieRecord {
  string space_id      = 1;
  bytes  record_id     = 2;  // HMAC(identity tuple) — server-visible, pseudonymous
  bytes  origin_id     = 3;  // HMAC(host key) — for leases/rollback scoping
  bytes  sealed_record = 4;  // enc: host_key, host_only, name, path,
                             //      partition_key, source_scheme, value,
                             //      expiry, same_site, secure, http_only, persistent
  Hlc    hlc           = 5;  // {physical_ms, logical, device_id}
  bytes  causal_parent = 6;  // record_id+hlc this supersedes
  bytes  device_sig    = 7;
  Cause  cause         = 8;  // WRITE | EXPLICIT_DELETE | EXPIRED | OVERWRITE
                             // | EVICTED | HYDRATION_ECHO
}
message LeaseRequest   { string space_id = 1; bytes origin_id = 2; bool force = 3; }
message HydrateRequest { string space_id = 1; uint64 since_hlc = 2; }
message RollbackRequest{ string space_id = 1; bytes origin_id = 2; uint64 to_hlc = 3; }
```

**C. Agent mux channels:** `ctl` (spawn/resize/kill PTY, list ports, `fetch(public_or_presigned_url)`, fs ops — all under capability tokens), `pty/<id>`, `fwd/<port>`, `vfs`, `log`. _(Sealed-header fetch removed.)_

**D. Machine lifecycle:** `provisioning → running → suspending → suspended → resuming | cold_booting → running`, plus `boosting → boosted (stop/start) → shrinking`. All transitions emit client-visible events; `cold_booting` surfaces the "reconstructed" notice (§8.5).

**E. Fast-follows (V1.1+):** File Provider / Finder integration → code-server "Open in IDE" behind flag → public preview URLs → shared spaces read-only → Linux client → `~/cloud` client-side encryption → MASQUE-native proxy.
