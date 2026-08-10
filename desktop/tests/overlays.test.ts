import { describe, expect, it } from "vitest";
import {
  CAPTION_STYLE_PRESETS,
  OVERLAY_DOCUMENT_MAGIC,
  OVERLAY_DOCUMENT_SCHEMA_VERSION,
  OverlayValidationError,
  SubtitleParseError,
  canonicalizeOverlayDocument,
  createEmptyOverlayDocument,
  exportSrt,
  exportWebVtt,
  importSrt,
  importWebVtt,
  parseOverlayDocument,
  resolveCaptionStyle,
  rippleDeleteOverlayDocument,
  rippleInsertOverlayDocument,
  serializeOverlayDocument,
  splitOverlayDocumentAt,
  splitTimedItemAt,
  validateOverlayDocument,
  validateVisualOverlay,
  type ArrowOverlay,
  type BlurMaskOverlay,
  type OverlayDocument,
  type ShapeOverlay,
  type SpotlightOverlay,
  type TimedCaptionCue,
  type VisualOverlay,
} from "../src/shared/overlays.js";

function cue(
  id: string,
  startUs: number,
  endUs: number,
  text = id,
): TimedCaptionCue {
  return {
    id,
    startUs,
    endUs,
    text,
    style: { preset: "clean" },
  };
}

function arrow(
  id = "arrow-1",
  startUs = 0,
  endUs = 2_000_000,
): ArrowOverlay {
  return {
    kind: "arrow",
    id,
    startUs,
    endUs,
    opacity: 1,
    from: { x: 0.15, y: 0.2 },
    to: { x: 0.72, y: 0.65 },
    color: "#FF594DFF",
    strokeWidthPx: 8,
    headLengthPx: 24,
    lineStyle: "solid",
    animation: "draw",
  };
}

function shape(id = "shape-1", startUs = 0, endUs = 2_000_000): ShapeOverlay {
  return {
    kind: "shape",
    id,
    startUs,
    endUs,
    opacity: 0.9,
    shape: "rectangle",
    area: { x: 0.2, y: 0.25, width: 0.4, height: 0.3 },
    fillColor: "#00000000",
    strokeColor: "#69D8FFFF",
    strokeWidthPx: 6,
    cornerRadius: 0.08,
    rotationDeg: 0,
  };
}

function spotlight(
  id = "spotlight-1",
  startUs = 0,
  endUs = 2_000_000,
): SpotlightOverlay {
  return {
    kind: "spotlight",
    id,
    startUs,
    endUs,
    opacity: 1,
    shape: "ellipse",
    area: { x: 0.25, y: 0.2, width: 0.5, height: 0.55 },
    dimColor: "#050608FF",
    dimOpacity: 0.64,
    featherPx: 36,
  };
}

function blurMask(
  id = "blur-1",
  startUs = 0,
  endUs = 2_000_000,
): BlurMaskOverlay {
  return {
    kind: "blur-mask",
    id,
    startUs,
    endUs,
    opacity: 1,
    shape: "rectangle",
    area: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    blurPx: 32,
    featherPx: 12,
  };
}

function documentWith(
  captions: TimedCaptionCue[] = [],
  overlays: VisualOverlay[] = [],
): OverlayDocument {
  return {
    magic: OVERLAY_DOCUMENT_MAGIC,
    schemaVersion: OVERLAY_DOCUMENT_SCHEMA_VERSION,
    captions,
    overlays,
  };
}

describe("caption styles", () => {
  it("ships complete presets and resolves isolated nested overrides", () => {
    expect(Object.keys(CAPTION_STYLE_PRESETS)).toEqual([
      "clean",
      "boxed",
      "bold",
      "lower-third",
    ]);

    const resolved = resolveCaptionStyle({
      preset: "boxed",
      overrides: {
        color: "#FFCC00FF",
        position: { y: 0.75 },
        shadowOffset: { xPx: 4 },
      },
    });

    expect(resolved.color).toBe("#FFCC00FF");
    expect(resolved.position).toEqual({ x: 0.5, y: 0.75 });
    expect(resolved.shadowOffset).toEqual({ xPx: 4, yPx: 6 });
    resolved.position.x = 0;
    expect(CAPTION_STYLE_PRESETS.boxed.position.x).toBe(0.5);
  });

  it("rejects unknown presets, invalid overrides, and blank caption text", () => {
    const unknownPreset = cue("cue-1", 0, 1_000_000) as unknown as {
      style: { preset: string };
    };
    unknownPreset.style.preset = "random";
    expect(() => validateOverlayDocument(documentWith([unknownPreset as TimedCaptionCue])))
      .toThrow(/known caption preset/);

    const invalidOverride = cue("cue-2", 0, 1_000_000);
    invalidOverride.style.overrides = { maxWidth: 1.2 };
    expect(() => validateOverlayDocument(documentWith([invalidOverride])))
      .toThrow(/maxWidth/);

    expect(() => validateOverlayDocument(documentWith([cue("cue-3", 0, 1_000_000, " ")])))
      .toThrow(/non-empty/);
  });
});

describe("visual overlays", () => {
  it("validates arrows, shapes, spotlights, and blur masks", () => {
    const overlays: VisualOverlay[] = [arrow(), shape(), spotlight(), blurMask()];
    expect(() => validateOverlayDocument(documentWith([], overlays))).not.toThrow();
    overlays.forEach((overlay) => expect(() => validateVisualOverlay(overlay)).not.toThrow());
  });

  it("rejects zero-length arrows, out-of-bounds masks, and unknown fields", () => {
    const zeroArrow = arrow();
    zeroArrow.to = { ...zeroArrow.from };
    expect(() => validateVisualOverlay(zeroArrow)).toThrow(/endpoints must differ/);

    const outside = blurMask();
    outside.area = { x: 0.8, y: 0.1, width: 0.3, height: 0.2 };
    expect(() => validateVisualOverlay(outside)).toThrow(/canvas width/);

    const withUnknown = { ...shape(), accidental: true };
    expect(() => validateVisualOverlay(withUnknown)).toThrow(/accidental: is not supported/);
  });

  it("requires IDs to be unique across caption and visual tracks", () => {
    expect(() => validateOverlayDocument(documentWith(
      [cue("shared-id", 0, 1_000_000)],
      [arrow("shared-id")],
    ))).toThrow(/unique across captions and overlays/);
  });
});

describe("subtitle interchange", () => {
  it("imports BOM/CRLF SRT, multiline text, offsets, and a selected preset", () => {
    const source = [
      "\uFEFF1",
      "00:00:01,250 --> 00:00:03,500",
      "First line",
      "second line",
      "",
      "2",
      "00:01:04.010 --> 00:01:05.020",
      "Next cue",
      "",
    ].join("\r\n");

    const cues = importSrt(source, {
      idPrefix: "imported",
      offsetUs: 250_000,
      style: { preset: "boxed" },
    });

    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      id: "imported-0001",
      startUs: 1_500_000,
      endUs: 3_750_000,
      text: "First line\nsecond line",
      style: { preset: "boxed" },
    });
    expect(cues[1]).toMatchObject({ startUs: 64_260_000, endUs: 65_270_000 });
  });

  it("exports deterministic SRT and retains timing and text through re-import", () => {
    const cues = [
      cue("late", 2_000_400, 3_000_499, "Later"),
      cue("early", 1_234_567, 1_700_000, "Hello\nworld"),
    ];

    const srt = exportSrt(cues);
    expect(srt).toBe(
      "1\n00:00:01,235 --> 00:00:01,700\nHello\nworld\n\n" +
      "2\n00:00:02,000 --> 00:00:03,000\nLater\n",
    );
    const imported = importSrt(srt);
    expect(imported.map(({ startUs, endUs, text }) => ({ startUs, endUs, text }))).toEqual([
      { startUs: 1_235_000, endUs: 1_700_000, text: "Hello\nworld" },
      { startUs: 2_000_000, endUs: 3_000_000, text: "Later" },
    ]);
  });

  it("imports WebVTT identifiers and settings while ignoring metadata blocks", () => {
    const source = [
      "WEBVTT SharpShot transcript",
      "",
      "NOTE generated locally",
      "do not show this",
      "",
      "intro",
      "00:01.500 --> 00:04.000 position:50% align:middle",
      "Welcome",
      "",
      "intro",
      "01:02:03.004 --> 01:02:05.500",
      "Duplicate IDs safely fall back",
      "",
    ].join("\n");

    const cues = importWebVtt(source, { idPrefix: "fallback" });
    expect(cues[0]).toMatchObject({ id: "intro", startUs: 1_500_000, endUs: 4_000_000 });
    expect(cues[1]).toMatchObject({
      id: "fallback-0002",
      startUs: 3_723_004_000,
      endUs: 3_725_500_000,
    });

    const exported = exportWebVtt(cues);
    expect(exported).toContain("WEBVTT\n\nintro\n00:00:01.500 --> 00:00:04.000\nWelcome");
    expect(importWebVtt(exported)).toEqual(cues);
  });

  it("keeps generated WebVTT IDs unique when source identifiers collide with them", () => {
    const cues = importWebVtt([
      "WEBVTT",
      "",
      "vtt-0002",
      "00:00.000 --> 00:01.000",
      "Reserved-looking explicit ID",
      "",
      "vtt-0002",
      "00:02.000 --> 00:03.000",
      "Duplicate",
    ].join("\n"));

    expect(cues.map((item) => item.id)).toEqual(["vtt-0002", "vtt-0002-2"]);
    expect(() => validateOverlayDocument(documentWith(cues))).not.toThrow();
  });

  it("reports the source line for malformed subtitle timing", () => {
    expect(() => importSrt("1\n00:70:00,000 --> 00:00:02,000\nBad\n"))
      .toThrow(SubtitleParseError);
    expect(() => importSrt("1\n00:70:00,000 --> 00:00:02,000\nBad\n"))
      .toThrow(/SRT line 2/);
    expect(() => importWebVtt("00:00.000 --> 00:02.000\nNo header\n"))
      .toThrow(/missing WEBVTT header/);
  });

  it("rejects offsets that place a subtitle before zero", () => {
    expect(() => importSrt(
      "1\n00:00:00,500 --> 00:00:01,000\nToo early\n",
      { offsetUs: -600_000 },
    )).toThrow(/before time zero/);
  });
});

describe("timing transforms", () => {
  it("splits one timed item without changing its content or subtype", () => {
    const original = spotlight("focus", 1_000_000, 5_000_000);
    const [left, right] = splitTimedItemAt(original, 3_000_000, "focus-right");

    expect(left).toEqual({ ...original, endUs: 3_000_000 });
    expect(right).toEqual({ ...original, id: "focus-right", startUs: 3_000_000 });
    expect(() => splitTimedItemAt(original, 1_000_000, "bad-right"))
      .toThrow(/strictly inside/);
  });

  it("splits all spanning tracks with collision-safe deterministic IDs", () => {
    const document = documentWith(
      [cue("words", 0, 4_000_000), cue("words-split", 6_000_000, 7_000_000)],
      [arrow("pointer", 1_000_000, 5_000_000)],
    );
    const split = splitOverlayDocumentAt(document, 2_000_000);

    expect(split.captions.map(({ id, startUs, endUs }) => ({ id, startUs, endUs }))).toEqual([
      { id: "words", startUs: 0, endUs: 2_000_000 },
      { id: "words-split-2", startUs: 2_000_000, endUs: 4_000_000 },
      { id: "words-split", startUs: 6_000_000, endUs: 7_000_000 },
    ]);
    expect(split.overlays.map(({ id, startUs, endUs }) => ({ id, startUs, endUs }))).toEqual([
      { id: "pointer", startUs: 1_000_000, endUs: 2_000_000 },
      { id: "pointer-split", startUs: 2_000_000, endUs: 5_000_000 },
    ]);
  });

  it("keeps collision suffixes valid for maximum-length source IDs", () => {
    const longId = `a${"b".repeat(127)}`;
    const reservedId = `${longId.slice(0, 122)}-split`;
    const document = documentWith([
      cue(longId, 0, 4_000_000),
      cue(reservedId, 6_000_000, 7_000_000),
    ]);

    const result = splitOverlayDocumentAt(document, 2_000_000);
    const splitId = result.captions.find((item) => item.startUs === 2_000_000)!.id;
    expect(splitId.length).toBeLessThanOrEqual(128);
    expect(splitId.endsWith("-2")).toBe(true);
    expect(() => validateOverlayDocument(result)).not.toThrow();
  });

  it("ripple-deletes inside, partial, spanning, and later items", () => {
    const document = documentWith(
      [
        cue("before", 0, 1_000_000),
        cue("left", 1_000_000, 4_000_000),
        cue("span", 2_000_000, 8_000_000),
        cue("inside", 3_500_000, 5_000_000),
        cue("right", 5_000_000, 9_000_000),
        cue("later", 8_000_000, 9_000_000),
      ],
      [blurMask("mask", 6_000_000, 7_000_000)],
    );

    const result = rippleDeleteOverlayDocument(document, 3_000_000, 6_000_000);
    const byId = Object.fromEntries(result.captions.map((item) => [item.id, item]));
    expect(byId.before).toMatchObject({ startUs: 0, endUs: 1_000_000 });
    expect(byId.left).toMatchObject({ startUs: 1_000_000, endUs: 3_000_000 });
    expect(byId.span).toMatchObject({ startUs: 2_000_000, endUs: 5_000_000 });
    expect(byId.inside).toBeUndefined();
    expect(byId.right).toMatchObject({ startUs: 3_000_000, endUs: 6_000_000 });
    expect(byId.later).toMatchObject({ startUs: 5_000_000, endUs: 6_000_000 });
    expect(result.overlays[0]).toMatchObject({ id: "mask", startUs: 3_000_000, endUs: 4_000_000 });
  });

  it("ripple-inserts by shifting later items and splitting spanning items around the gap", () => {
    const document = documentWith(
      [
        cue("ends-at-cut", 0, 3_000_000),
        cue("spans-cut", 1_000_000, 5_000_000),
        cue("after", 3_000_000, 4_000_000),
      ],
      [shape("visual-span", 2_000_000, 4_000_000)],
    );

    const result = rippleInsertOverlayDocument(document, 3_000_000, 2_000_000);
    expect(result.captions.map(({ id, startUs, endUs }) => ({ id, startUs, endUs }))).toEqual([
      { id: "ends-at-cut", startUs: 0, endUs: 3_000_000 },
      { id: "spans-cut", startUs: 1_000_000, endUs: 3_000_000 },
      { id: "after", startUs: 5_000_000, endUs: 6_000_000 },
      { id: "spans-cut-split", startUs: 5_000_000, endUs: 7_000_000 },
    ]);
    expect(result.overlays.map(({ id, startUs, endUs }) => ({ id, startUs, endUs }))).toEqual([
      { id: "visual-span", startUs: 2_000_000, endUs: 3_000_000 },
      { id: "visual-span-split", startUs: 5_000_000, endUs: 6_000_000 },
    ]);
  });
});

describe("deterministic overlay documents", () => {
  it("creates a valid empty document", () => {
    const document = createEmptyOverlayDocument();
    expect(document).toEqual({
      magic: OVERLAY_DOCUMENT_MAGIC,
      schemaVersion: OVERLAY_DOCUMENT_SCHEMA_VERSION,
      captions: [],
      overlays: [],
    });
    expect(() => validateOverlayDocument(document)).not.toThrow();
  });

  it("sorts equivalent documents and emits canonical JSON with a final newline", () => {
    const late = cue("late", 5_000_000, 6_000_000);
    late.style = {
      preset: "clean",
      overrides: { uppercase: true, color: "#ABCDEF88", position: { y: 0.7, x: 0.4 } },
    };
    const early = cue("early", 1_000_000, 2_000_000);
    const first = documentWith([late, early], [spotlight("z", 3_000_000, 4_000_000), arrow("a")]);
    const second = documentWith([early, late], [arrow("a"), spotlight("z", 3_000_000, 4_000_000)]);

    expect(serializeOverlayDocument(first)).toBe(serializeOverlayDocument(second));
    expect(serializeOverlayDocument(first).endsWith("\n")).toBe(true);
    expect(canonicalizeOverlayDocument(first).captions.map((item) => item.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("parses into canonical order and rejects invalid JSON/schema data", () => {
    const serialized = JSON.stringify(documentWith(
      [cue("later", 2_000_000, 3_000_000), cue("first", 0, 1_000_000)],
      [arrow()],
    ));
    expect(parseOverlayDocument(serialized).captions.map((item) => item.id)).toEqual([
      "first",
      "later",
    ]);
    expect(() => parseOverlayDocument("{")).toThrow(OverlayValidationError);

    const unsupported = createEmptyOverlayDocument() as unknown as { schemaVersion: number };
    unsupported.schemaVersion = 99;
    expect(() => validateOverlayDocument(unsupported)).toThrow(/unsupported version 99/);
  });
});
