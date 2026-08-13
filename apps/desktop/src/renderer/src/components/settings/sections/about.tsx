/**
 * `suma://settings/about` — the version, and the one update decision.
 *
 * Everything is main's state (shared/updates.ts, via `updates:state` /
 * `updates:changed`): the updater checks, downloads, and stages entirely on
 * its own, so this page mostly just says what it is doing. The only choices
 * a person ever gets are "check now" and — once a build is staged —
 * "restart now or let the next quit install it".
 */

import { useEffect, useState } from "react";
import type { UpdateState } from "../../../../../shared/updates";
import { useSumaStore } from "../../../store";
import { Button } from "../../ui/button";
import { Group, Page, Row } from "../parts";

function useUpdateState(): UpdateState | null {
  const pushToast = useSumaStore((s) => s.pushToast);
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await window.suma.invoke("updates:state", undefined);
        if (live) setState(next);
      } catch {
        if (live) pushToast("Could not read the update status.", "error");
      }
    })();
    const off = window.suma.on("updates:changed", (next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [pushToast]);

  return state;
}

/** "just now" → "3 hours ago"; coarser than that, the exact time isn't news. */
function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${String(minutes)} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${String(hours)} hours ago`;
}

function statusLine(state: UpdateState): string {
  switch (state.phase) {
    case "unsupported":
      return "Automatic updates are off in development builds.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return state.availableVersion === null
        ? "Downloading an update…"
        : `Downloading ${state.availableVersion}…`;
    case "ready":
      return state.availableVersion === null
        ? "An update is ready."
        : `${state.availableVersion} is ready to install.`;
    case "error":
      return state.error ?? "The last check failed.";
    case "idle":
      return state.checkedAt === null
        ? "Updates are checked automatically."
        : `You're up to date. Checked ${ago(state.checkedAt)}.`;
  }
}

export function AboutPage() {
  const pushToast = useSumaStore((s) => s.pushToast);
  const state = useUpdateState();

  const check = () => {
    void window.suma.invoke("updates:check", undefined).catch(() => {
      pushToast("Could not start an update check.", "error");
    });
  };
  const install = () => {
    void window.suma.invoke("updates:install", undefined).catch(() => {
      pushToast("Could not restart into the update.", "error");
    });
  };

  return (
    <Page
      title="About & updates"
      description="What's installed, and what's on the way. Updates download in the background and install when you quit — restarting just gets you there sooner."
    >
      <Group title="This app">
        <Row label="Suma" note={state === null ? "…" : `Version ${state.currentVersion}`} />
      </Group>

      <Group title="Updates">
        <Row
          label={state === null ? "…" : statusLine(state)}
          note={
            state?.phase === "downloading" && state.percent !== null
              ? `${String(Math.round(state.percent))}% downloaded`
              : undefined
          }
        >
          {state === null || state.phase === "unsupported" ? undefined : state.phase ===
            "ready" ? (
            <Button onClick={install}>Restart to update</Button>
          ) : (
            <Button
              variant="secondary"
              disabled={state.phase === "checking" || state.phase === "downloading"}
              onClick={check}
            >
              {state.phase === "error" ? "Try again" : "Check for updates"}
            </Button>
          )}
        </Row>
      </Group>
    </Page>
  );
}
