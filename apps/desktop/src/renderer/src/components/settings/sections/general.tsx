/** `suma://settings` — the landing page: what a tab does and where it goes. */

import { useState } from "react";
import { DEFAULT_WORKSPACE_SETTINGS } from "@suma/protocol";
import { isProbablyUrl, normalizeUrlInput } from "../../../lib/url";
import { useSumaStore } from "../../../store";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Group, Page, Row } from "../parts";

const ARCHIVE_HOURS = [6, 12, 24, 48];
const ARCHIVE_ITEMS = ARCHIVE_HOURS.map((h) => ({ value: h, label: `${String(h)} hours` }));

/**
 * The page ⌘T (and every other new tab) opens. Committed on Enter/blur rather
 * than per keystroke — a half-typed address is not a setting. Bare input is
 * normalized the same way the URL bar normalizes it, so "google.com" is a
 * perfectly good answer; anything that isn't a web address is refused out
 * loud instead of being quietly stored and ignored at open time.
 */
function NewTabPageRow() {
  const configured = useSumaStore((s) => s.settings.newTabUrl);
  const updateSettings = useSumaStore((s) => s.updateSettings);
  const pushToast = useSumaStore((s) => s.pushToast);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === configured) return;
    if (raw.length === 0) {
      void updateSettings({ newTabUrl: "" });
      return;
    }
    const url = isProbablyUrl(raw) ? normalizeUrlInput(raw) : "";
    if (!/^https?:\/\//i.test(url)) {
      pushToast("A new tab page has to be a web address, like google.com", "warning");
      return;
    }
    void updateSettings({ newTabUrl: url });
  };

  return (
    <Row
      label="New tab page"
      note={`Where ⌘T lands. Leave it empty for a blank tab. Default: ${DEFAULT_WORKSPACE_SETTINGS.newTabUrl}`}
    >
      <Input
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-label="New tab page"
        placeholder="Blank page"
        value={draft ?? configured}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        className="w-[240px] font-mono placeholder:font-sans @max-md:w-[150px]"
      />
    </Row>
  );
}

export function GeneralPage() {
  const settings = useSumaStore((s) => s.settings);
  const updateSettings = useSumaStore((s) => s.updateSettings);

  return (
    <Page
      title="General"
      description="How tabs open, and how long they stay before the archive takes them."
    >
      <Group title="Tabs">
        <NewTabPageRow />
        <Row
          label="Auto-archive Today tabs"
          note="Untouched tabs move to the archive after this long. Archived tabs keep their address — nothing is closed out from under you."
        >
          <Select
            value={settings.autoArchiveAfterHours}
            items={ARCHIVE_ITEMS}
            onValueChange={(hours: number) =>
              void updateSettings({ autoArchiveAfterHours: hours })
            }
          >
            <SelectTrigger aria-label="Auto-archive hours" className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ARCHIVE_HOURS.map((h) => (
                <SelectItem key={h} value={h}>
                  {h} hours
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Group>
    </Page>
  );
}
