import { useEffect, useState } from "react";
import { ArrowRightLeft, Check, ChevronRight, Shield } from "lucide-react";
import type { MigrationResult, MigrationSource, SignInQueueItem } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { useSumaStore } from "../store";
import { MODE_LABEL } from "./ContinuityDot";
import { Favicon, googleFavicon } from "./Favicon";
import { Button } from "./ui/button";
import { Modal, ModalBody, ModalContent, ModalFooter } from "./ui/modal";

type Step =
  | { name: "sources"; sources: MigrationSource[] | null }
  | { name: "importing"; source: MigrationSource }
  | { name: "summary"; result: MigrationResult }
  | { name: "queue" };

function StepDots({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "h-[4px] rounded-full transition-all",
            i === index ? "w-5 bg-accent" : i < index ? "w-2.5 bg-accent/50" : "w-2.5 bg-ink/12",
          )}
        />
      ))}
    </div>
  );
}

function BrowserBadge({ browser }: { browser: "chrome" | "arc" }) {
  return (
    <span
      className="grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white/95"
      style={{ background: browser === "chrome" ? "#4c8bf5" : "#c94d6d" }}
    >
      {browser === "chrome" ? "C" : "A"}
    </span>
  );
}

function modeBadgeClass(item: SignInQueueItem): string {
  if (item.mode === "portable") return "bg-ok/12 text-ok";
  if (item.mode === "assisted") return "bg-warn/12 text-warn";
  return "bg-ink/8 text-muted";
}

/** M-0 migration flow: pick source → import → summary → guided sign-in queue. */
export function MigrationWizard() {
  const open = useSumaStore((s) => s.overlay === "migration");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const signInQueue = useSumaStore((s) => s.signInQueue);
  const refreshSignInQueue = useSumaStore((s) => s.refreshSignInQueue);
  const markSignedIn = useSumaStore((s) => s.markSignedIn);
  const createTab = useSumaStore((s) => s.createTab);
  const pushToast = useSumaStore((s) => s.pushToast);

  const [step, setStep] = useState<Step>({ name: "sources", sources: null });

  useEffect(() => {
    if (!open) return;
    setStep({ name: "sources", sources: null });
    void (async () => {
      try {
        const sources = await window.suma.invoke("migration:detectSources", undefined);
        setStep((s) => (s.name === "sources" ? { name: "sources", sources } : s));
      } catch (err) {
        pushToast(`migration:detectSources failed — ${err instanceof Error ? err.message : String(err)}`, "error");
        setStep({ name: "sources", sources: [] });
      }
    })();
  }, [open, pushToast]);

  const close = () => setOverlay("none");
  const stepIndex = step.name === "sources" ? 0 : step.name === "queue" ? 2 : 1;

  const runImport = async (source: MigrationSource) => {
    setStep({ name: "importing", source });
    try {
      const result = await window.suma.invoke("migration:import", {
        profilePath: source.profilePath,
        browser: source.browser,
      });
      useSumaStore.setState({ signInQueue: result.signInQueue });
      setStep({ name: "summary", result });
    } catch (err) {
      pushToast(`migration:import failed — ${err instanceof Error ? err.message : String(err)}`, "error");
      setStep({ name: "sources", sources: [source] });
    }
  };

  const enterQueue = () => {
    setStep({ name: "queue" });
    void refreshSignInQueue();
  };

  const doneCount = signInQueue.filter((i) => i.done).length;
  const orderedQueue = [...signInQueue].sort((a, b) =>
    a.done === b.done ? a.rank - b.rank : a.done ? 1 : -1,
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setOverlay("none");
      }}
    >
      <ModalContent
        title="Bring your workspace to Suma"
        width={600}
        height="max-h-[80vh]"
        actions={<StepDots index={stepIndex} />}
        description={
          step.name === "queue"
            ? "Step 3 · Guided sign-in — most-used first"
            : step.name === "sources"
              ? "Step 1 · Choose what to import"
              : "Step 2 · Import"
        }
        icon={
          <ArrowRightLeft className="size-3.5" aria-hidden="true" />
        }
      >
        <ModalBody className="px-5 py-4">
          {step.name === "sources" ? (
            step.sources === null ? (
              <p className="py-10 text-center text-[12px] text-faint">Looking for Chrome and Arc profiles…</p>
            ) : step.sources.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-[13px] text-muted">No Chrome or Arc profiles found on this Mac.</p>
                <p className="mt-1 text-[11.5px] text-faint">You can start fresh — nothing to import.</p>
                <Button variant="secondary" size="lg" onClick={close} className="mt-4">
                  Skip migration
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {step.sources.map((src) => (
                  <button
                    key={src.profilePath}
                    type="button"
                    onClick={() => void runImport(src)}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-hairline bg-ink/3 px-3.5 py-3 text-left hover:border-accent/40 hover:bg-accent/8"
                  >
                    <BrowserBadge browser={src.browser} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium">
                        {src.browser === "chrome" ? "Chrome" : "Arc"} · {src.profileName}
                      </span>
                      <span className="block truncate text-[11px] text-faint">
                        {src.bookmarkCount.toLocaleString()} bookmarks · {src.profilePath}
                      </span>
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                  </button>
                ))}
                <p className="mt-1 text-[10.5px] leading-snug text-faint">
                  Import runs entirely on this Mac. Sensitive origins default to excluded from sync.
                </p>
              </div>
            )
          ) : null}

          {step.name === "importing" ? (
            <div className="py-10 text-center">
              <p className="text-[13px] text-muted">
                Importing from {step.source.browser === "chrome" ? "Chrome" : "Arc"} ·{" "}
                {step.source.profileName}…
              </p>
              <div className="mx-auto mt-4 h-[5px] w-64 overflow-hidden rounded-full bg-ink/8">
                <div
                  className="animate-shimmer h-full w-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, var(--color-accent) 45%, var(--color-accent) 55%, transparent)",
                    backgroundSize: "200% 100%",
                  }}
                />
              </div>
              <p className="mt-3 text-[11px] text-faint">Local-only — nothing leaves this Mac unencrypted.</p>
            </div>
          ) : null}

          {step.name === "summary" ? (
            <div className="py-4">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Spaces created", value: step.result.spacesCreated },
                  { label: "Tabs pinned", value: step.result.pinnedTabsCreated },
                  { label: "Bookmarks archived", value: step.result.bookmarksImported },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-xl border border-hairline bg-ink/3 px-3 py-3.5 text-center">
                    <p className="text-[22px] font-semibold text-text">{stat.value.toLocaleString()}</p>
                    <p className="mt-0.5 text-[10.5px] text-faint">{stat.label}</p>
                  </div>
                ))}
              </div>
              <Button size="lg" onClick={enterQueue} className="mt-4 w-full">
                Continue to guided sign-in ({step.result.signInQueue.length})
              </Button>
            </div>
          ) : null}

          {step.name === "queue" ? (
            orderedQueue.length === 0 ? (
              <p className="py-10 text-center text-[12px] text-faint">
                Nothing in the sign-in queue — you&apos;re all set.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {orderedQueue.map((item) => (
                  <div
                    key={item.domain}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border border-hairline px-3 py-2.5",
                      item.done ? "bg-ok/5 opacity-55" : "bg-ink/3",
                    )}
                  >
                    <Favicon src={googleFavicon(item.domain)} seed={item.domain} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{item.label}</span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold",
                            modeBadgeClass(item),
                          )}
                        >
                          {MODE_LABEL[item.mode]}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 truncate text-[10.5px] text-faint">
                        {item.domain}
                        {item.sensitive ? (
                          <span className="flex shrink-0 items-center gap-0.5 text-warn/80">
                            <Shield className="size-2.5" fill="currentColor" aria-hidden="true" />
                            excluded from sync
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {item.done ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok">
                        <Check className="size-3" aria-hidden="true" />
                        Signed in
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="soft"
                          onClick={() => void createTab(`https://${item.domain}`)}
                        >
                          Open sign-in
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void markSignedIn(item.domain)}>
                          Done
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : null}
        </ModalBody>

        {step.name === "queue" ? (
          <ModalFooter>
            <p className="mr-auto text-[11.5px] text-faint">
              {doneCount} of {signInQueue.length} signed in
            </p>
            <Button variant={doneCount === signInQueue.length ? "default" : "secondary"} onClick={close}>
              {doneCount === signInQueue.length ? "Finish" : "Finish later"}
            </Button>
          </ModalFooter>
        ) : null}
      </ModalContent>
    </Modal>
  );
}
