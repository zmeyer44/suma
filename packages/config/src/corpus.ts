/**
 * Seed supported-origin corpus (PRD §4).
 *
 * This corpus is an internal product: each origin here is expected to carry
 * automated restore tests, challenge detection, and regression alerting in
 * the compatibility pipeline. Modes below are the *starting* assignments for
 * Phase 0 measurement — never ship an untested mode fleet-wide (staged
 * rollout: one device → all devices).
 *
 * Rules of thumb encoded here:
 *  - rotatingAuth: origin rotates refresh tokens / session cookies, so cookie
 *    writes use the origin lease (single-writer); LWW would fork sessions.
 *  - sensitive: excluded from sync unless the user explicitly opts in; banks
 *    and corporate SSO are adversarial compatibility tests, not the promise.
 */

import type { OriginPolicy } from "@suma/protocol";

export const SEED_CORPUS: ReadonlyArray<OriginPolicy> = [
  // ---- Developer core ------------------------------------------------
  { domain: "github.com", label: "GitHub", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "gitlab.com", label: "GitLab", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "linear.app", label: "Linear", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "vercel.com", label: "Vercel", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "netlify.com", label: "Netlify", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "fly.io", label: "Fly.io", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "cloudflare.com", label: "Cloudflare", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "dash session rotates aggressively" },
  { domain: "npmjs.com", label: "npm", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "pypi.org", label: "PyPI", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "crates.io", label: "crates.io", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "stackoverflow.com", label: "Stack Overflow", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "huggingface.co", label: "Hugging Face", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "openai.com", label: "OpenAI", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false },
  { domain: "anthropic.com", label: "Anthropic", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false },
  { domain: "claude.ai", label: "Claude", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "Cloudflare clearance is device-bound; application cookies remain syncable" },
  { domain: "sentry.io", label: "Sentry", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "datadoghq.com", label: "Datadog", mode: "assisted", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "grafana.com", label: "Grafana Cloud", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "supabase.com", label: "Supabase", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "neon.tech", label: "Neon", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "render.com", label: "Render", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },

  // ---- Productivity --------------------------------------------------
  { domain: "google.com", label: "Google Workspace", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "device-integrity signals; expect assisted on new devices" },
  { domain: "gmail.com", label: "Gmail", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "shares Google session plumbing and anti-abuse checks" },
  { domain: "notion.so", label: "Notion", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false, localStorageSync: true },
  { domain: "figma.com", label: "Figma", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "slack.com", label: "Slack", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, localStorageSync: true },
  { domain: "discord.com", label: "Discord", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "token in localStorage; tier-2 candidate after §8.3 review" },
  { domain: "x.com", label: "X", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "linkedin.com", label: "LinkedIn", mode: "assisted", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "atlassian.net", label: "Jira / Confluence", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false },
  { domain: "asana.com", label: "Asana", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "airtable.com", label: "Airtable", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "loom.com", label: "Loom", mode: "portable", syncTier: 1, rotatingAuth: false, sensitive: false },
  { domain: "zoom.us", label: "Zoom", mode: "assisted", syncTier: 0, rotatingAuth: false, sensitive: false, notes: "native-app handoff dominates; low value to sync" },

  // ---- Media (DRM/device-bound leaning) ------------------------------
  { domain: "netflix.com", label: "Netflix", mode: "device_bound", syncTier: 0, rotatingAuth: false, sensitive: false, notes: "DRM + device checks; workspace restores, session does not" },
  { domain: "spotify.com", label: "Spotify", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false },
  { domain: "youtube.com", label: "YouTube", mode: "assisted", syncTier: 1, rotatingAuth: true, sensitive: false, notes: "shares Google session plumbing" },

  // ---- Sensitive: excluded from sync unless explicitly opted in ------
  { domain: "chase.com", label: "Chase", mode: "device_bound", syncTier: 0, rotatingAuth: true, sensitive: true },
  { domain: "bankofamerica.com", label: "Bank of America", mode: "device_bound", syncTier: 0, rotatingAuth: true, sensitive: true },
  { domain: "fidelity.com", label: "Fidelity", mode: "device_bound", syncTier: 0, rotatingAuth: true, sensitive: true },
  { domain: "stripe.com", label: "Stripe", mode: "assisted", syncTier: 0, rotatingAuth: true, sensitive: true, notes: "financial dashboard: assisted, excluded from sync by default" },
  { domain: "aws.amazon.com", label: "AWS Console", mode: "assisted", syncTier: 0, rotatingAuth: true, sensitive: true },
  { domain: "console.cloud.google.com", label: "GCP Console", mode: "assisted", syncTier: 0, rotatingAuth: true, sensitive: true },
  { domain: "okta.com", label: "Okta (corporate SSO)", mode: "device_bound", syncTier: 0, rotatingAuth: true, sensitive: true },
];

/** Domains whose traffic bypasses the identity gateway by default (§8.4):
 * high-bandwidth media burns money and adds nothing to identity stability. */
export const MEDIA_BYPASS_DOMAINS: ReadonlyArray<string> = [
  "youtube.com",
  "googlevideo.com",
  "netflix.com",
  "nflxvideo.net",
  "spotify.com",
  "scdn.co",
  "twitch.tv",
  "ttvnw.net",
  "vimeo.com",
  "cloudfront.net",
];

/** Seeded hostile-domain list: origins known to challenge datacenter IPs;
 * per-site bypass is auto-suggested on challenge detection (§8.4). */
export const SEEDED_HOSTILE_DOMAINS: ReadonlyArray<string> = [
  "ticketmaster.com",
  "nike.com",
  "bestbuy.com",
  "walmart.com",
  "target.com",
];
