/**
 * Markdown for chat bubbles (react-markdown + GFM).
 *
 * Rendered as React elements, never as injected HTML — react-markdown drops
 * raw HTML by default, which is exactly right for model output that may be
 * echoing untrusted page content, and it keeps the chrome's `script-src
 * 'self'` CSP undisturbed.
 *
 * Two chat-specific decisions:
 *  - The type scale is the bubble's (12.5px body), not the document's: a
 *    model that answers with an H1 should not shout across the sidebar, so
 *    headings compress to a small ladder.
 *  - Links NEVER navigate this document. The chrome renderer IS the browser
 *    UI — a real <a href> click would replace the whole chrome with the
 *    target page — so links surface through `onLinkClick` (the sidebar opens
 *    a tab) and only http(s) targets are actionable at all.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";

const REMARK_PLUGINS = [remarkGfm];

function isHttpUrl(href: string | undefined): href is string {
  return href !== undefined && /^https?:\/\//i.test(href);
}

function buildComponents(onLinkClick?: (url: string) => void): Components {
  return {
    p: ({ children }) => (
      <p className="my-1 leading-relaxed first:mt-0 last:mb-0">{children}</p>
    ),
    a: ({ href, children }) =>
      isHttpUrl(href) ? (
        <a
          href={href}
          title={href}
          onClick={(e) => {
            e.preventDefault();
            onLinkClick?.(href);
          }}
          className="cursor-pointer text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {children}
        </a>
      ) : (
        // Non-web schemes stay inert text — nothing in a bubble may reach
        // suma://, file://, or javascript: territory.
        <span>{children}</span>
      ),
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del className="opacity-70">{children}</del>,
    h1: ({ children }) => (
      <h3 className="mt-2.5 mb-1 text-[13px] font-semibold first:mt-0">{children}</h3>
    ),
    h2: ({ children }) => (
      <h4 className="mt-2.5 mb-1 text-[12.5px] font-semibold first:mt-0">{children}</h4>
    ),
    h3: ({ children }) => (
      <h5 className="mt-2 mb-0.5 text-[12px] font-semibold first:mt-0">{children}</h5>
    ),
    h4: ({ children }) => (
      <h6 className="mt-2 mb-0.5 text-[12px] font-semibold first:mt-0">{children}</h6>
    ),
    h5: ({ children }) => (
      <h6 className="mt-2 mb-0.5 text-[12px] font-semibold first:mt-0">{children}</h6>
    ),
    h6: ({ children }) => (
      <h6 className="mt-2 mb-0.5 text-[12px] font-semibold first:mt-0">{children}</h6>
    ),
    ul: ({ children }) => (
      <ul className="my-1 list-disc space-y-0.5 pl-4 first:mt-0 last:mb-0">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-1 list-decimal space-y-0.5 pl-4 first:mt-0 last:mb-0">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-1.5 border-l-2 border-ink/20 pl-2 text-muted">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-2 border-hairline" />,
    // Never auto-fetch an image a model chose to embed: an <img src> fires a
    // network request from the CHROME renderer the moment it renders, which
    // would let injected page content exfiltrate through a crafted URL — and
    // arbitrary remote images wreck the bubble's layout besides. The image
    // surfaces as a link the user can choose to open as a tab. (Screenshots
    // the assistant takes render as real images via their own tool part.)
    img: ({ src, alt }) => {
      const href = typeof src === "string" ? src : undefined;
      const label = alt !== undefined && alt !== "" ? alt : "image";
      return isHttpUrl(href) ? (
        <a
          href={href}
          title={href}
          onClick={(e) => {
            e.preventDefault();
            onLinkClick?.(href);
          }}
          className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded bg-ink/8 px-1.5 py-0.5 text-[11px] text-accent hover:bg-ink/12"
        >
          <span aria-hidden="true">🖼</span>
          <span className="truncate underline underline-offset-2">{label}</span>
        </a>
      ) : (
        <span className="text-muted">[{label}]</span>
      );
    },
    // `code` covers both inline code and the inside of fenced blocks; the
    // block case is recognizable by its `pre` parent and styled there.
    code: ({ children, className }) => (
      <code
        className={cn(
          "rounded bg-ink/8 px-1 py-px font-mono text-[11px]",
          className,
        )}
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-1.5 overflow-x-auto rounded-lg bg-ink/6 p-2 font-mono text-[11px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0 first:mt-0 last:mb-0">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-1.5 overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-hairline bg-ink/4 px-1.5 py-1 text-left font-semibold">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-hairline px-1.5 py-1 align-top">{children}</td>
    ),
  };
}

export function Markdown({
  children,
  onLinkClick,
  className,
}: {
  children: string;
  /** Where a clicked http(s) link goes — the caller decides (a new tab). */
  onLinkClick?: (url: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 [word-break:break-word]", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={buildComponents(onLinkClick)}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
