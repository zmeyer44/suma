import { ImageResponse } from "next/og";

import { MARK_BOX, MARK_PATH } from "@/components/suma-mark";

export const alt = "Suma — the browser that remembers where you left off";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The palette, flattened out of the OKLCH tokens in `globals.css`. Satori has
 * no `oklch()` parser and no cascade to read custom properties from, so the
 * values are converted once and named here. Keep them in step with `:root`.
 */
const PAPER = "#F5F3ED"; // --paper
const INK = "#111316"; // --ink
const ROYAL = "#2E5CD4"; // --royal
const MUTED = "#55585F"; // --muted-foreground
const RULE = "rgba(17, 19, 22, 0.14)"; // --border
const GRAPH = "rgba(17, 19, 22, 0.05)"; // the graph paper, a touch above .graph

/** The pixel lattice, doubled — one graph square, as on the page. */
const CELL = 30;

const PAD = 56;

/**
 * Every character the card can render, uppercase included: the faces are
 * fetched as `text=` subsets, and `textTransform` asks Satori for glyphs the
 * source strings never contain.
 */
const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,'’—·&/%:()-";

/**
 * Host Grotesk and IBM Plex Mono, fetched as TrueType.
 *
 * The page sets its headlines in Industry, and this card cannot: the licensed
 * files are woff2, which Satori does not parse, and they are not in the
 * repository anyway (see `scripts/fetch-fonts.mjs`). Host Grotesk is already
 * the next face in `--font-display`, so the card falls back exactly the way
 * the page would. Asking Google for the CSS without a browser `User-Agent` —
 * which is what Node sends — gets TrueType back rather than woff2.
 */
async function googleFont(family: string, weight: number) {
  const url =
    `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}` +
    `:wght@${weight}&text=${encodeURIComponent(GLYPHS)}`;

  const css = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url} → ${response.status}`);
    return response.text();
  });

  const src = /src: url\((?<url>[^)]+)\) format\('(?:truetype|opentype)'\)/.exec(
    css,
  )?.groups?.url;
  if (!src) throw new Error(`no TrueType source for ${family} ${weight}`);

  return fetch(src).then((response) => {
    if (!response.ok) throw new Error(`${src} → ${response.status}`);
    return response.arrayBuffer();
  });
}

/**
 * The four faces, or none. A social card is not worth failing a build over, so
 * a fetch that goes wrong drops to the font Satori ships with rather than
 * throwing — the layout holds either way.
 */
async function loadFonts() {
  try {
    const [regular, medium, semibold, mono] = await Promise.all([
      googleFont("Host Grotesk", 400),
      googleFont("Host Grotesk", 500),
      googleFont("Host Grotesk", 600),
      googleFont("IBM Plex Mono", 500),
    ]);

    return [
      { name: "Host Grotesk", data: regular, weight: 400 as const },
      { name: "Host Grotesk", data: medium, weight: 500 as const },
      { name: "Host Grotesk", data: semibold, weight: 600 as const },
      { name: "IBM Plex Mono", data: mono, weight: 500 as const },
    ].map((font) => ({ ...font, style: "normal" as const }));
  } catch (error) {
    console.error("opengraph-image: falling back to the default face —", error);
    return undefined;
  }
}

export default async function Image() {
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: PAPER,
          padding: PAD,
          fontFamily: "Host Grotesk",
        }}
      >
        {graphPaper()}

        {/* Top bar — the nav's mark and wordmark, and the standing caveat. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg
              width={42}
              height={35}
              viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
            >
              <path d={MARK_PATH} fill={ROYAL} />
            </svg>
            <span
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-0.02em",
              }}
            >
              Suma
            </span>
          </div>

          <span
            style={{
              ...label(11),
              border: `1px solid ${RULE}`,
              borderRadius: 999,
              padding: "8px 16px",
            }}
          >
            Open source · Private beta
          </span>
        </div>

        {/* The hero, restated: caption and headline on the left plate, the
            promise card on the right. */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            gap: 44,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 22,
            }}
          >
            <span style={label(12)}>Any device, anytime, anywhere</span>

            <span
              style={{
                fontSize: 62,
                fontWeight: 600,
                lineHeight: 1.02,
                letterSpacing: "-0.025em",
                color: INK,
                // Narrower than the plate, to break the line into three even
                // ones rather than two full and an orphan.
                maxWidth: 620,
              }}
            >
              The browser that remembers where you left off
            </span>

            <span
              style={{
                fontSize: 18,
                lineHeight: 1.55,
                color: MUTED,
                maxWidth: 480,
              }}
            >
              Sign in once and your spaces, tabs, sign-ins and files follow you
              to any machine.
            </span>
          </div>

          {promiseCard()}
        </div>

        {/* Bottom bar — the domain, and what is in the box. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${RULE}`,
            paddingTop: 20,
          }}
        >
          <span style={label(12)}>sumabrowser.com</span>
          <div style={{ display: "flex", gap: 22 }}>
            {[
              "Split view",
              "Assistant",
              "Read aloud",
              "Terminal & IDE",
              "Nostr",
            ].map((tag) => (
              <span key={tag} style={label(11)}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}

/** The one label style on the site: mono, uppercase, widely tracked. */
function label(fontSize: number) {
  return {
    fontFamily: "IBM Plex Mono",
    fontWeight: 500,
    fontSize,
    color: MUTED,
    textTransform: "uppercase" as const,
    letterSpacing: "0.16em",
    whiteSpace: "nowrap" as const,
  };
}

/**
 * `.graph` from `globals.css`, drawn as rules rather than as a repeating
 * background — Satori tiles gradients unreliably, and the lattice is the one
 * thing on the card that has to land on exact pixel boundaries.
 */
function graphPaper() {
  const columns = Math.ceil(size.width / CELL);
  const rows = Math.ceil(size.height / CELL);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
      }}
    >
      {Array.from({ length: columns }, (_, index) => (
        <div
          key={`c${index}`}
          style={{
            position: "absolute",
            left: index * CELL,
            top: 0,
            width: 1,
            height: size.height,
            backgroundColor: GRAPH,
          }}
        />
      ))}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={`r${index}`}
          style={{
            position: "absolute",
            left: 0,
            top: index * CELL,
            width: size.width,
            height: 1,
            backgroundColor: GRAPH,
          }}
        />
      ))}
    </div>
  );
}

/**
 * The hero's promise card, meter and all. It is the one royal surface on the
 * page and it does the same job here — the block of colour that survives a
 * timeline thumbnail at a fifth of this size.
 */
function promiseCard() {
  const filled = 0.68;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 372,
        flexShrink: 0,
        backgroundColor: ROYAL,
        borderRadius: 20,
        padding: "26px 28px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 20,
        }}
      >
        <span
          style={{
            fontSize: 36,
            fontWeight: 600,
            lineHeight: 0.98,
            letterSpacing: "-0.015em",
            textTransform: "uppercase",
            color: PAPER,
            maxWidth: 190,
          }}
        >
          Your work follows you
        </span>
        {/* Two lines, stacked rather than wrapped — Satori collapses a newline
            inside a run of text the same way the browser would. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            ...label(10),
            color: "rgba(245, 243, 237, 0.6)",
          }}
        >
          <span>Suma</span>
          <span>promise</span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 34,
        }}
      >
        <div
          style={{
            display: "flex",
            flex: 1,
            height: 4,
            backgroundColor: "rgba(245, 243, 237, 0.3)",
          }}
        >
          <div
            style={{
              width: `${filled * 100}%`,
              height: 4,
              backgroundColor: PAPER,
            }}
          />
        </div>
        <span
          style={{
            fontFamily: "IBM Plex Mono",
            fontWeight: 500,
            fontSize: 11,
            color: "rgba(245, 243, 237, 0.6)",
          }}
        >
          {Math.round(filled * 100)}%
        </span>
      </div>
    </div>
  );
}
