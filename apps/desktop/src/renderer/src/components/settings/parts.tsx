/**
 * The `suma://settings` page's layout primitives.
 *
 * A settings PAGE is not a settings panel with more room: the old overlay
 * stacked every group into one scroller, so every heading had to compete and
 * they all shrank to the same 10px eyebrow. Here a page has one title, its
 * groups are cards, and a row is allowed to be a readable size — which is the
 * point of moving off the modal.
 */

export function Page({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[660px] px-7 py-7 @max-md:px-4">
      <header className="mb-5">
        <h1 className="text-[19px] leading-tight font-semibold tracking-[-0.01em] text-text">
          {title}
        </h1>
        <p className="mt-1 text-[12px] leading-snug text-faint">{description}</p>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

/** A titled card. `title` omitted ⇒ a bare card, for a page with one group. */
export function Group({
  title,
  note,
  children,
}: {
  title?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      {title === undefined ? null : (
        <h2 className="mb-1.5 px-0.5 text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">
          {title}
        </h2>
      )}
      {note === undefined ? null : (
        <p className="mb-2 px-0.5 text-[11.5px] leading-snug text-faint">{note}</p>
      )}
      <div className="overflow-hidden rounded-xl border border-hairline bg-ink/[0.025]">
        {children}
      </div>
    </section>
  );
}

/**
 * One setting. The control is right-aligned and never shrinks; the label and
 * its explanation take the slack, because the explanation is the part that
 * stops a security switch from being flipped blind.
 */
export function Row({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-5 border-t border-hairline px-3.5 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-[13px] leading-snug text-text">{label}</p>
        {note === undefined ? null : (
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">{note}</p>
        )}
      </div>
      {children === undefined ? null : (
        <div className="shrink-0 pt-0.5">{children}</div>
      )}
    </div>
  );
}

/** A row whose content is a full-width block rather than a trailing control. */
export function Block({
  label,
  note,
  children,
}: {
  label?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-hairline px-3.5 py-3 first:border-t-0">
      {label === undefined ? null : (
        <p className="text-[13px] leading-snug text-text">{label}</p>
      )}
      {note === undefined ? null : (
        <p className="mt-1 mb-2.5 text-[11.5px] leading-relaxed text-faint">{note}</p>
      )}
      {children}
    </div>
  );
}
