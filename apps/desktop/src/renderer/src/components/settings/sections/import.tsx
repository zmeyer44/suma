/** `suma://settings/import` — bring a workspace over from another browser. */

import { useSumaStore } from "../../../store";
import { Button } from "../../ui/button";
import { Group, Page, Row } from "../parts";

export function ImportPage() {
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const signInQueue = useSumaStore((s) => s.signInQueue);
  const pending = signInQueue.filter((item) => !item.done).length;

  return (
    <Page
      title="Import & migrate"
      description="Bring your spaces, pinned tabs, and bookmarks over from Chrome or Arc, then work through a guided sign-in queue."
    >
      <Group>
        <Row
          label="Import from Chrome or Arc"
          note="Reads the profiles already on this Mac. Nothing is imported until you pick one — and passwords are never read; you sign in through the queue instead."
        >
          <Button variant="soft" onClick={() => setOverlay("migration")}>
            Start migration
          </Button>
        </Row>
        {signInQueue.length === 0 ? null : (
          <Row
            label="Sign-in queue"
            note={
              pending === 0
                ? "Every imported site has been signed in on this Mac."
                : `${pending} of ${signInQueue.length} imported sites still need a sign-in, most-used first.`
            }
          >
            <Button variant="secondary" onClick={() => setOverlay("migration")}>
              {pending === 0 ? "Review" : "Continue"}
            </Button>
          </Row>
        )}
      </Group>
    </Page>
  );
}
