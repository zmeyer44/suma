/**
 * `suma://settings` — the settings PAGE (§8.1 privileged pages).
 *
 * It replaces the settings modal, which had grown to eleven sections in one
 * 560px scroller and had started launching further modals (Appearance, Audit)
 * on top of itself. A page has room to give each of those its own title and
 * its own breathing space, and — because it is addressed rather than
 * summoned — it can be linked to: ⌘, lands on General, the origin popover
 * lands on Identity IP, the command bar lands on Devices.
 *
 * Rendered by the CHROME renderer into the content hole, not by a document in
 * a WebContents of its own (see shared/internal-pages.ts for why). The
 * consequence worth knowing: it paints its own opaque surface, because the
 * hole it fills is transparent — there is no tab view under it.
 *
 * `@container`, not viewport breakpoints: this page can be half of a split
 * view, so its layout has to answer to the pane it is in rather than to the
 * window. Below @md the rail keeps working as an icon-only strip.
 */

import type { SettingsSection } from "../../../../shared/internal-pages";
import { settingsUrl, SETTINGS_URL } from "../../../../shared/internal-pages";
import { useSumaStore } from "../../store";
import { SumaMark } from "../ui/suma-mark";
import { SettingsNav } from "./SettingsNav";
import { AppearancePage } from "./sections/appearance";
import { AssistantPage } from "./sections/assistant";
import {
  AccountPage,
  DevicesPage,
  RecoveryPage,
  SyncPage,
} from "./sections/account";
import { FavoritesPage } from "./sections/favorites";
import { GeneralPage } from "./sections/general";
import { ImportPage } from "./sections/import";
import { NostrPage } from "./sections/nostr";
import { VoicePage } from "./sections/voice";
import {
  AuditPage,
  EgressPage,
  HistoryPage,
  SignInPage,
} from "./sections/privacy";

const PAGES: Record<SettingsSection, () => React.ReactElement> = {
  "": GeneralPage,
  appearance: AppearancePage,
  favorites: FavoritesPage,
  voice: VoicePage,
  assistant: AssistantPage,
  privacy: SignInPage,
  nostr: NostrPage,
  "privacy/history": HistoryPage,
  "privacy/egress": EgressPage,
  "privacy/audit": AuditPage,
  account: AccountPage,
  "account/devices": DevicesPage,
  "account/sync": SyncPage,
  "account/recovery": RecoveryPage,
  import: ImportPage,
};

export function SettingsPage({
  section,
  tabId,
}: {
  section: SettingsSection;
  tabId: string;
}) {
  const navigate = useSumaStore((s) => s.navigate);
  const Section = PAGES[section];

  return (
    <div className="@container absolute inset-0 flex bg-panel text-text">
      <aside className="flex w-[214px] shrink-0 flex-col border-r border-hairline bg-bg @max-md:w-[46px] @max-xl:w-[186px]">
        {/* The same mark/wordmark lockup the marketing nav opens with, in the
            accent the user picked rather than a fixed brand color — every
            other tinted glyph in the chrome follows the accent, and a mark
            that did not would read as pasted on. Collapsed to the icon rail
            the mark is the whole header, which is what keeps the rail from
            starting with an empty band. */}
        <header className="flex shrink-0 items-center gap-2 px-3 pt-3.5 pb-2 @max-md:justify-center @max-md:px-0">
          <SumaMark className="h-5 text-accent" />
          <span className="min-w-0 @max-md:hidden">
            <span className="block text-[13px] leading-tight font-semibold tracking-[-0.01em] text-text">
              Settings
            </span>
            {/* The address, stated. This page IS a URL — showing it is how the
                user learns they can type it, ⌘L to it, or pin it. */}
            <span
              title={SETTINGS_URL}
              className="block truncate font-mono text-[10px] text-faint"
            >
              {SETTINGS_URL}
            </span>
          </span>
        </header>
        <SettingsNav
          section={section}
          onNavigate={(next) => void navigate(tabId, settingsUrl(next))}
        />
      </aside>
      {/* min-w-0 so a long unbroken string in a section cannot push the rail
          off the pane; the scroller is the content column, not the page. */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Section />
      </main>
    </div>
  );
}
