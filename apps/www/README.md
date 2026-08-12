# @suma/www

The Suma marketing site. Next.js 16 (App Router, Turbopack), Tailwind v4,
shadcn/ui, statically prerendered — there is no server data and no runtime
secret.

```sh
pnpm --filter @suma/www dev          # http://localhost:3000
pnpm --filter @suma/www build
pnpm --filter @suma/www lint
pnpm --filter @suma/www check-types
```

## Design system

The page is set like a technical document, not a landing page: a hard grid,
hairline rules, **zero border radius and zero drop shadows** on content. The
only rounded, floating objects on the whole site are the two navigation pills.
If you find yourself reaching for a rounded card with a shadow, that is the
signal to reach for a rule and a column instead.

Three colours, defined once in `src/app/globals.css`:

| Token | Value | Used for |
|---|---|---|
| `--paper` | bone white | page background |
| `--ink` | near-black | text, the terminal, the closing band |
| `--royal` | royal blue | the single accent — the mosaic, live dots, Portable |

There is deliberately no second accent colour. Type is
[Host Grotesk](https://fonts.google.com/specimen/Host+Grotesk) — uppercase and
very large for the two poster moments, sentence case for section headings — with
IBM Plex Mono for every label, figure caption and running head. Both load
through `next/font/google` and are self-hosted at build time.

Three utilities carry the whole page: `.display` (headline type), `.label`
(the one label style: mono, uppercase, tracked) and `.graph` (the graph-paper
background on `<body>`). Layout comes from `Shell`, `Rule`, `BandHead` and
`Spread` in `src/components/section.tsx` — `Spread` is the heading-left,
prose-right block that almost every band is built from.

shadcn/ui is configured in `components.json` (new-york, neutral base, CSS
variables) with the radius tokens zeroed, so
`pnpm dlx shadcn@latest add <component>` drops in already on-palette and
already square.

## Page structure

Five parts, and that is the budget: hero, three numbered bands, closing. Adding
a sixth band is a decision, not a default — the architecture and specification
content was deliberately folded into band 01 and the footer rather than given
sections of its own.

| | |
|---|---|
| Hero | Poster headline, running head, the pixel mosaic |
| 01 · The workspace | What it is, the `Fig. 1` plate, the four planes |
| 02 · Continuity | The differentiator, as a specification table |
| 03 · Compute | The machine that stays awake |
| Closing | Ink band: the form and what a seat includes |

## The pixel work

Two separate canvases, both reading `--royal` off the cascade so they can never
drift from the palette:

**`pixel-mosaic.tsx`** — the hero. Stamps the Suma mark with `Path2D`, samples
it into a grid, and springs each pixel into place left-to-right on load. The
silhouette disperses sideways across the band, and the cursor pushes pixels out
of the way.

The mark itself is a lightning bolt struck top to bottom, passing behind a
meridian globe. Its geometry lives in `suma-mark.tsx` as exported constants
(`MARK_BOX`, `MARK_BOLT`, `MARK_GLOBE`, …) which the mosaic imports — edit it
once and the wordmark and the poster stay in step. Two things the composition
depends on: the bolt's offset waist sits *above* the globe, where it is visible,
because that jog is what makes it read as a bolt rather than a taper; and the
globe's whole **disc** is knocked out of the bolt, not just its strokes, so the
globe reads as a solid object in front instead of a wireframe with slivers of
bolt showing through its gaps. The mark is taller than it is wide — size it with
`h-… w-auto`, never `size-…`, and give the hero band enough height to carry the
bolt from tip to tip.

**`pixel-field.tsx`** — the site-wide cursor trail, on a 28px pitch matching the
graph paper so lit cells land inside its squares. Three things make it feel
physical rather than like a lagged copy of the pointer:

1. **The brush is a mass on a spring**, not the pointer. `STIFFNESS`/`DAMPING`
   sit under critical damping, so it trails on a fast sweep, overshoots when you
   stop and swings wide through a corner.
2. **Heat is stamped along the path the brush actually travelled**, at a
   constant rate *per unit length* — so a quick flick and a slow drag lay down
   the same density of trail, and neither breaks into dots.
3. **Each cell renders its own heat** as size, alpha and colour, burning through
   royal to ink at the core. Heat cools to 2% per second, so the trail contracts
   to a point behind you instead of switching off.

Note that a `<canvas>` is a replaced element: `inset-0` alone leaves it at its
intrinsic 300×150. `size-full` is what stretches it — and sizing it in CSS
rather than from `innerWidth` is what keeps a classic scrollbar from pushing the
layer past the viewport and giving the page a horizontal scroll.

Both canvases sit out entirely under `prefers-reduced-motion` (the mosaic still
draws, settled).

## Content claims

Copy follows the PRD's sixth principle — *promise continuity, not magic*. The
continuity band is a specification table describing Portable / Assisted /
Device-bound as measured per-origin behaviour, not a blanket "your logins follow
you" claim, and the access band says pricing is not set rather than inventing a
number. Keep it that way when editing.

## Waitlist form

`src/components/sections/waitlist.tsx` POSTs `{ email, ref? }` to this app's
own `/api/waitlist`, which stores the line in a `waitlist` table in the same
Railway Postgres the control plane uses (project **Suma**). `/api/waitlist`
returns a referral code and position; `/r/:code` is the shareable link.

Set `WAITLIST_DATABASE_URL` to Railway's **public** proxy URL
(`sakura.proxy.rlwy.net:26654`) — Vercel cannot resolve the
`postgres.railway.internal` host the control plane uses. The connection is
TLS-only; see the comment in `src/lib/waitlist-store.ts`.

A local SQLite file lived here previously. It cannot work on Vercel, whose
filesystem is read-only outside `/tmp`: every production signup returned 500
while local dev looked fine. Anything storing waitlist state must be a
network database for that reason.

Operator promotion (`/api/waitlist/promote`) stays closed unless
`WAITLIST_ADMIN_TOKEN` is set, and mints invites through the control plane
using `SUMA_CONTROL_URL` + `INVITE_ADMIN_TOKEN`.
