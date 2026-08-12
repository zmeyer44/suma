import { describe, expect, it } from "vitest";
import {
  describeType,
  extensionOf,
  imageMimeFor,
  IMAGE_PREVIEW_MAX_BYTES,
  planPreview,
  skipExplanation,
  TEXT_PREVIEW_MAX_BYTES,
  type PreviewSubject,
} from "./preview";

function subject(
  path: string,
  sizeBytes: number,
  contentType: string | null = null,
): PreviewSubject {
  return { path, sizeBytes, contentType };
}

describe("extensionOf", () => {
  it("takes the last dotted suffix of the last segment", () => {
    expect(extensionOf("/a/b/report.PDF")).toBe("pdf");
    expect(extensionOf("/a/archive.tar.gz")).toBe("gz");
    expect(extensionOf("/a/Makefile")).toBe("");
    expect(extensionOf("/a/.gitignore")).toBe("");
    expect(extensionOf("/a/trailing.")).toBe("");
    expect(extensionOf("/dir.with.dots/file")).toBe("");
  });
});

describe("planPreview", () => {
  it("previews text inline and budgets only what it will show", () => {
    const plan = planPreview(subject("/notes/todo.md", 4096));
    expect(plan).toEqual({
      kind: "text",
      typeLabel: "Markdown",
      readBytes: 4096,
      truncated: false,
      reason: null,
    });
  });

  it("truncates long text instead of refusing it", () => {
    const plan = planPreview(subject("/logs/app.log", TEXT_PREVIEW_MAX_BYTES * 4));
    expect(plan.kind).toBe("text");
    expect(plan.readBytes).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(plan.truncated).toBe(true);
  });

  it("previews images whole, since a partial image decodes to garbage", () => {
    const plan = planPreview(subject("/design/logo.png", 2048));
    expect(plan).toMatchObject({ kind: "image", typeLabel: "PNG image", readBytes: 2048 });
    expect(imageMimeFor(subject("/design/logo.png", 2048))).toBe("image/png");
  });

  it("refuses images past the inline cap with a size reason", () => {
    const plan = planPreview(subject("/design/huge.png", IMAGE_PREVIEW_MAX_BYTES + 1));
    expect(plan).toMatchObject({ kind: "none", reason: "too_large", readBytes: 0 });
    expect(skipExplanation(plan)).toBe("Too large to preview here — download it to open it.");
  });

  it("gives everything else a type label and reads nothing", () => {
    for (const [path, label] of [
      ["/docs/spec.pdf", "PDF document"],
      ["/archives/build.zip", "ZIP archive"],
      ["/clips/demo.mp4", "MP4 video"],
      ["/music/take.flac", "FLAC audio"],
    ] as const) {
      const plan = planPreview(subject(path, 5_000_000));
      expect(plan).toMatchObject({ kind: "none", typeLabel: label, readBytes: 0, reason: "unsupported" });
    }
    expect(skipExplanation(planPreview(subject("/x/y.bin", 10)))).toBe(
      "No inline preview for this type — download it to open it.",
    );
  });

  it("calls an unrecognized file a binary file rather than guessing", () => {
    expect(describeType(subject("/x/blob", 10))).toBe("Binary file");
    expect(describeType(subject("/x/blob", 10, "application/octet-stream"))).toBe("Binary file");
    expect(describeType(subject("/x/blob", 10, "application/x-tenderfoot"))).toBe(
      "application/x-tenderfoot",
    );
    expect(imageMimeFor(subject("/x/blob", 10))).toBe(null);
  });

  it("reports empty files as empty instead of previewing nothing", () => {
    const plan = planPreview(subject("/notes/blank.txt", 0));
    expect(plan).toMatchObject({ kind: "none", reason: "empty", typeLabel: "Plain text" });
    expect(skipExplanation(plan)).toBe("This file is empty.");
  });

  it("prefers a recognized content type over the extension", () => {
    // Declared by the uploader; the extension is only a hint.
    expect(planPreview(subject("/weird/data.bin", 100, "text/plain")).kind).toBe("text");
    expect(planPreview(subject("/weird/notes.txt", 100, "image/png")).kind).toBe("image");
    expect(planPreview(subject("/weird/notes.txt", 100, "video/mp4"))).toMatchObject({
      kind: "none",
      typeLabel: "MP4 video",
    });
  });

  it("ignores content-type parameters and casing", () => {
    expect(planPreview(subject("/a/x.unknown", 100, "TEXT/PLAIN; charset=utf-8")).kind).toBe("text");
    expect(describeType(subject("/a/x.unknown", 100, "Image/PNG"))).toBe("PNG image");
  });

  it("falls back to the extension when the content type is unrecognized", () => {
    expect(planPreview(subject("/a/notes.md", 100, "application/x-unknown")).kind).toBe("text");
  });

  it("treats SVG as text, not as an image element source", () => {
    // Untrusted markup on a privileged page does not go into <img>.
    expect(planPreview(subject("/design/icon.svg", 500)).kind).toBe("text");
    expect(planPreview(subject("/design/icon.bin", 500, "image/svg+xml")).kind).toBe("text");
    expect(imageMimeFor(subject("/design/icon.svg", 500))).toBe(null);
  });

  it("has no skip explanation for a plan that does preview", () => {
    expect(skipExplanation(planPreview(subject("/a/b.txt", 10)))).toBe("");
  });
});
