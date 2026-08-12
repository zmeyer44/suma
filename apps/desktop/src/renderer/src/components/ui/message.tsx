/**
 * shadcn/ui Message (2026-06 chat components), ported to Suma's tokens.
 *
 * A conversation row: optional avatar beside a content column that holds the
 * header, the bubbles, and the footer. `data-align="end"` flips the row for
 * the user's own turns — the reversal lives here rather than in the bubble so
 * a grouped run of bubbles flips as one.
 */

import { cn } from "../../lib/cn";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-[12.5px] data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      // Bottom-aligned, upstream's chat convention — lifted by the footer's
      // height when the row has one, so it tracks the bubble's last line
      // instead of dropping level with the footer buttons.
      className={cn(
        "flex size-5 w-fit min-w-5 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-ink/8 text-muted group-has-[[data-slot=message-footer]]/message:-translate-y-5",
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 break-words group-data-[align=end]/message:*:data-slot:self-end",
        className,
      )}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex max-w-full min-w-0 items-center gap-1.5 px-1 text-[10.5px] font-medium text-faint",
        className,
      )}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-full min-w-0 items-center gap-1 px-1 text-[10.5px] font-medium text-faint group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader };
