import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Child-view order is the whole subject here: the chrome view carries every
 * modal and its backdrop, the tab views cover the content hole, and the
 * floating overlay panel (audio player + save previews) must end up above
 * ALL of it after every re-top. Electron paints the last-added child on
 * top; this fake records that order (addChildView re-tops an already-added
 * view, as Electron's does) so the tests can assert who covers whom.
 */
const childOrder: unknown[] = [];

class FakeContentView {
  addChildView(view: unknown): void {
    const at = childOrder.indexOf(view);
    if (at !== -1) childOrder.splice(at, 1);
    childOrder.push(view);
  }
  removeChildView(view: unknown): void {
    const at = childOrder.indexOf(view);
    if (at !== -1) childOrder.splice(at, 1);
  }
}

class FakeWebContentsView {
  webContents = {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(),
    isDestroyed: (): boolean => false,
    id: 0,
  };
  bounds: { x: number; y: number; width: number; height: number } | null = null;
  visible = true;
  setBackgroundColor(): void {}
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  getVisible(): boolean {
    return this.visible;
  }
}

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: false },
  BaseWindow: class {
    contentView = new FakeContentView();
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      // Screen coordinates: the shell's content area sits offset on screen.
      // The overlay view's bounds must stay window-relative regardless.
      return { x: 400, y: 60, width: 1280, height: 820 };
    }
    on(): void {}
    setBackgroundColor(): void {}
    setVibrancy(): void {}
  },
  WebContentsView: FakeWebContentsView,
}));

const { WebContentsView } = await import("electron");
const { savePreviewBounds, SAVE_PREVIEW_MARGIN, SAVE_PREVIEW_WIDTH, ShellWindow } =
  await import("../src/main/shell-window");

function makeShell(): {
  shell: InstanceType<typeof ShellWindow>;
  chrome: unknown;
  preview: FakeWebContentsView;
  tab: InstanceType<typeof WebContentsView>;
} {
  const shell = new ShellWindow();
  // The constructor adds the chrome view first, then the overlay view
  // (hidden until it has content) on top of it.
  const chrome = childOrder[0];
  const preview = childOrder[1] as FakeWebContentsView;
  shell.setContentBounds({ x: 0, y: 48, width: 1280, height: 772 });
  return { shell, chrome, preview, tab: new WebContentsView({}) };
}

const top = (): unknown => childOrder[childOrder.length - 1];

describe("ShellWindow overlay layering", () => {
  beforeEach(() => {
    childOrder.length = 0;
  });

  it("puts the chrome above the tab views while a modal is open", () => {
    const { shell, chrome, preview, tab } = makeShell();
    shell.attachTabView(tab);
    // The hidden floating panel rides on top even before it has content —
    // order is maintained unconditionally so showing it never needs a
    // re-sort. The tab is the topmost VISIBLE surface.
    expect(top()).toBe(preview);
    expect(childOrder[childOrder.length - 2]).toBe(tab);

    shell.setOverlayActive(true);
    expect(childOrder[childOrder.length - 2]).toBe(chrome);
  });

  it("keeps the chrome above re-attached tab views while a modal is open", () => {
    const { shell, chrome, tab } = makeShell();
    shell.attachTabView(tab);
    shell.setOverlayActive(true);

    // What refreshWorkspace() does on every sync push: syncVisibility →
    // showActive → attachTabView for each visible tab. Before the overlay
    // state was latched this re-topped the page over the open modal.
    shell.attachTabView(tab);
    expect(childOrder[childOrder.length - 2]).toBe(chrome);

    // Split view attaches two views; the chrome has to end up above both.
    const split = new WebContentsView({});
    shell.attachTabView(tab, "left");
    shell.attachTabView(split, "right");
    expect(childOrder[childOrder.length - 2]).toBe(chrome);
  });

  it("lets the tab views come back on top once the modal closes", () => {
    const { shell, chrome, preview, tab } = makeShell();
    shell.attachTabView(tab);
    shell.setOverlayActive(true);
    shell.setOverlayActive(false);
    expect(childOrder[childOrder.length - 2]).toBe(chrome);

    // Closing hands the way back down to TabManager.syncVisibility; the
    // floating panel stays above the returning tab.
    shell.attachTabView(tab);
    expect(childOrder[childOrder.length - 2]).toBe(tab);
    expect(top()).toBe(preview);
  });
});

describe("glance view hosting", () => {
  beforeEach(() => {
    childOrder.length = 0;
  });

  it("registers hidden and shows only once the frame reports its hole", () => {
    const { shell } = makeShell();
    const glance = new WebContentsView({});
    const fake = glance as unknown as FakeWebContentsView;
    shell.setOverlayActive(true);
    shell.setGlanceView(glance);
    expect(fake.visible).toBe(false);

    shell.setGlanceBounds({ x: 200, y: 100, width: 800, height: 600 });
    expect(fake.visible).toBe(true);
    expect(fake.bounds).toEqual({ x: 200, y: 100, width: 800, height: 600 });
  });

  it("stays above the raised chrome, below the floating panel", () => {
    const { shell, chrome, preview, tab } = makeShell();
    shell.attachTabView(tab);
    shell.setOverlayActive(true);
    const glance = new WebContentsView({});
    shell.setGlanceView(glance);
    shell.setGlanceBounds({ x: 200, y: 100, width: 800, height: 600 });

    expect(top()).toBe(preview);
    expect(childOrder.indexOf(glance)).toBeGreaterThan(childOrder.indexOf(chrome));

    // A sync push re-attaching the tab (the raiseChrome path) must not bury
    // the page under the frame that is supposed to surround it.
    shell.attachTabView(tab);
    expect(childOrder.indexOf(chrome)).toBeGreaterThan(childOrder.indexOf(tab));
    expect(childOrder.indexOf(glance)).toBeGreaterThan(childOrder.indexOf(chrome));
  });

  it("unhosts the view on close and on the sign-out reset", () => {
    const { shell } = makeShell();
    const glance = new WebContentsView({});
    shell.setGlanceView(glance);
    shell.setGlanceView(null);
    expect(childOrder.includes(glance)).toBe(false);

    shell.setGlanceView(glance);
    void shell.resetToChrome();
    expect(childOrder.includes(glance)).toBe(false);
  });
});

describe("save-preview overlay view", () => {
  beforeEach(() => {
    childOrder.length = 0;
  });

  it("shows the view at the hole's top-right, in window coordinates", () => {
    const { shell, preview } = makeShell();
    expect(preview.visible).toBe(false);

    shell.setSavePreviewSize(120);
    expect(preview.visible).toBe(true);
    // Hole-relative placement, NOT offset by the window's screen origin —
    // a child view moves with the window for free.
    expect(preview.bounds).toEqual({ x: 918, y: 58, width: 352, height: 120 });
  });

  it("tracks the content hole as sidebars narrow it", () => {
    const { shell, preview } = makeShell();
    shell.setSavePreviewSize(120);
    shell.setContentBounds({ x: 0, y: 48, width: 920, height: 772 });
    expect(preview.bounds?.x).toBe(920 - SAVE_PREVIEW_WIDTH - SAVE_PREVIEW_MARGIN);
  });

  it("hides outright once the stack empties", () => {
    const { shell, preview } = makeShell();
    shell.setSavePreviewSize(120);
    shell.setSavePreviewSize(0);
    expect(preview.visible).toBe(false);
  });

  it("narrows to a reported width and re-anchors it to the right edge", () => {
    // The collapsed audio pill: a ~100px sliver must not keep a full
    // card-width of the page dead under an invisible view.
    const { shell, preview } = makeShell();
    shell.setSavePreviewSize(64, 104);
    expect(preview.visible).toBe(true);
    expect(preview.bounds).toEqual({
      x: 1280 - 104 - SAVE_PREVIEW_MARGIN,
      y: 58,
      width: 104,
      height: 64,
    });
    // Back to cards: an omitted width means the classic full card width.
    shell.setSavePreviewSize(120);
    expect(preview.bounds?.width).toBe(SAVE_PREVIEW_WIDTH);
  });

  it("stays above tab attaches and raised modals alike", () => {
    const { shell, preview, tab } = makeShell();
    shell.setSavePreviewSize(120);
    shell.attachTabView(tab);
    expect(top()).toBe(preview);

    // A modal raises the chrome — playback controls still outrank it, as
    // they did when the panel was its own always-above window.
    shell.setOverlayActive(true);
    expect(top()).toBe(preview);
  });
});

describe("savePreviewBounds", () => {
  const hole = { x: 0, y: 48, width: 1280, height: 772 };

  it("anchors to the hole's top-right and hides at zero height", () => {
    expect(savePreviewBounds(hole, 0)).toBeNull();
    const bounds = savePreviewBounds(hole, 140);
    expect(bounds).toEqual({
      x: 1280 - SAVE_PREVIEW_WIDTH - SAVE_PREVIEW_MARGIN,
      y: 48 + SAVE_PREVIEW_MARGIN,
      width: SAVE_PREVIEW_WIDTH,
      height: 140,
    });
  });

  it("moves with the hole and never overflows it", () => {
    // A sidebar open on the right narrows the hole; the cards move with it.
    const narrowed = savePreviewBounds({ ...hole, width: 920 }, 140);
    expect(narrowed?.x).toBe(920 - SAVE_PREVIEW_WIDTH - SAVE_PREVIEW_MARGIN);
    // A stack taller than the hole is clamped rather than spilling off it.
    const clamped = savePreviewBounds({ ...hole, height: 100 }, 400);
    expect(clamped?.height).toBe(100 - SAVE_PREVIEW_MARGIN * 2);
  });

  it("honors a narrower reported width, still hugging the top-right", () => {
    expect(savePreviewBounds(hole, 64, 0)).toBeNull();
    const pill = savePreviewBounds(hole, 64, 104);
    expect(pill).toEqual({
      x: 1280 - 104 - SAVE_PREVIEW_MARGIN,
      y: 48 + SAVE_PREVIEW_MARGIN,
      width: 104,
      height: 64,
    });
  });
});
