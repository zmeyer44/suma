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
const PAPER = "#FFFFFF"; // --paper
const INK = "#1A1C21"; // --ink
const MUTED = "#6B6E75"; // --muted-foreground
const RULE = "rgba(26, 28, 33, 0.14)"; // --border

const PAD = 64;

/**
 * Every character the card can render, uppercase included: the faces are
 * fetched as `text=` subsets, and `textTransform` asks Satori for glyphs the
 * source strings never contain.
 */
const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,'’—·&/%:()-";

/**
 * Host Grotesk, fetched as TrueType.
 *
 * The page sets its headlines in Vanguardia, and this card cannot: the
 * licensed file is woff2, which Satori does not parse. The medium cut of the
 * body grotesk is the closest thing on hand, so the card approximates rather
 * than drifts. Asking Google for the CSS without a browser `User-Agent` —
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
 * The faces, or none. A social card is not worth failing a build over, so a
 * fetch that goes wrong drops to the font Satori ships with rather than
 * throwing — the layout holds either way.
 */
async function loadFonts() {
  try {
    const [regular, medium] = await Promise.all([
      googleFont("Host Grotesk", 400),
      googleFont("Host Grotesk", 500),
    ]);

    return [
      { name: "Host Grotesk", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "Host Grotesk", data: medium, weight: 500 as const, style: "normal" as const },
    ];
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
        {/* Running head: mark and wordmark on a hairline, like the page. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${RULE}`,
            paddingBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg
              width={38}
              height={31}
              viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
            >
              <path d={MARK_PATH} fill={INK} />
            </svg>
            <span
              style={{
                fontSize: 24,
                fontWeight: 500,
                color: INK,
                letterSpacing: "-0.02em",
              }}
            >
              Suma
            </span>
          </div>

          <span style={label(13)}>Open source · Private beta</span>
        </div>

        {/* The headline, set in the display serif as on the page. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            gap: 30,
          }}
        >
          <span
            style={{
              fontFamily: "Host Grotesk",
              fontWeight: 500,
              fontSize: 86,
              lineHeight: 1.02,
              letterSpacing: "-0.025em",
              color: INK,
              maxWidth: 940,
            }}
          >
            The browser that remembers where you left off
          </span>

          <span
            style={{
              fontSize: 21,
              lineHeight: 1.55,
              color: MUTED,
              maxWidth: 560,
            }}
          >
            Sign in once and your spaces, tabs, sign-ins and files follow you to
            any machine.
          </span>
        </div>

        {/* Bottom bar — the domain, and what is in the box. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${RULE}`,
            paddingTop: 24,
          }}
        >
          <span style={label(13)}>sumabrowser.com</span>
          <div style={{ display: "flex", gap: 26 }}>
            {[
              "Split view",
              "Assistant",
              "Read aloud",
              "Terminal & IDE",
              "Nostr",
            ].map((tag) => (
              <span key={tag} style={label(12)}>
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

/** The one label style on the site: tracked, uppercase grotesk. */
function label(fontSize: number) {
  return {
    fontFamily: "Host Grotesk",
    fontWeight: 500,
    fontSize,
    color: MUTED,
    textTransform: "uppercase" as const,
    letterSpacing: "0.14em",
    whiteSpace: "nowrap" as const,
  };
}
