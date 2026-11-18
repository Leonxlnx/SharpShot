import { describe, expect, it } from "vitest";
import { createEmptyOverlayDocument, type TimedCaptionCue } from "../shared/overlays";
import { identityOutputTimelineTransform } from "./output-timeline-transform";
import { remapOverlayDocument, remapOverlayDocumentForClips } from "./overlay-time-remap";
import type { EditorClip } from "./types";

const first: EditorClip = { id: "first", name: "First", sourceStart: 0, sourceEnd: 5, speed: 1, color: "#fff" };
const second: EditorClip = { id: "second", name: "Second", sourceStart: 5, sourceEnd: 10, speed: 1, color: "#fff" };

function cue(id: string, startUs: number, endUs: number): TimedCaptionCue {
  return { id, startUs, endUs, text: id, style: { preset: "clean" } };
}

describe("overlay clip-time remapping", () => {
  it("clips a cue in removed trim content and ripples later captions", () => {
    const document = createEmptyOverlayDocument();
    document.captions = [cue("trimmed", 1_000_000, 3_000_000), cue("later", 6_000_000, 7_000_000)];

    const remapped = remapOverlayDocumentForClips(document, [first, second], [{ ...first, sourceStart: 2 }, second]);

    expect(remapped.captions).toEqual([
      cue("trimmed", 0, 1_000_000),
      cue("later", 4_000_000, 5_000_000),
    ]);
  });

  it("rescales captions inside a speed change and shifts following content", () => {
    const document = createEmptyOverlayDocument();
    document.captions = [cue("inside", 2_000_000, 4_000_000), cue("later", 6_000_000, 7_000_000)];

    const remapped = remapOverlayDocumentForClips(document, [first, second], [{ ...first, speed: 2 }, second]);

    expect(remapped.captions).toEqual([
      cue("inside", 1_000_000, 2_000_000),
      cue("later", 3_500_000, 4_500_000),
    ]);
  });

  it("ripples captions after a deleted clip and preserves visual overlay fields", () => {
    const document = createEmptyOverlayDocument();
    document.captions = [cue("later", 6_000_000, 7_000_000)];
    document.overlays = [{
      id: "spotlight",
      kind: "spotlight",
      startUs: 6_500_000,
      endUs: 8_000_000,
      opacity: 0.8,
      shape: "ellipse",
      area: { x: 0.2, y: 0.3, width: 0.4, height: 0.3 },
      dimColor: "#000000FF",
      dimOpacity: 0.6,
      featherPx: 12,
    }];

    const remapped = remapOverlayDocumentForClips(document, [first, second], [second]);

    expect(remapped.captions).toEqual([cue("later", 1_000_000, 2_000_000)]);
    expect(remapped.overlays[0]).toMatchObject({
      id: "spotlight",
      startUs: 1_500_000,
      endUs: 3_000_000,
      opacity: 0.8,
      shape: "ellipse",
      dimOpacity: 0.6,
    });
  });

  it("preserves the cut boundary as deterministic adjacent fragments", () => {
    const third: EditorClip = { ...first, id: "third" };
    const document = createEmptyOverlayDocument();
    document.captions = [cue("across-cut", 4_000_000, 11_000_000)];

    const remapped = remapOverlayDocumentForClips(document, [first, second, third], [first, third]);

    expect(remapped.captions).toEqual([
      cue("across-cut", 4_000_000, 5_000_000),
      { ...cue("across-cut", 5_000_000, 6_000_000), id: "across-cut.part2" },
    ]);
  });

  it("shifts but does not discard imported cues beyond the current output", () => {
    const document = createEmptyOverlayDocument();
    document.captions = [cue("future", 11_000_000, 12_000_000)];

    const remapped = remapOverlayDocumentForClips(document, [first, second], [{ ...first, speed: 2 }, second]);

    expect(remapped.captions).toEqual([cue("future", 8_500_000, 9_500_000)]);
  });

  it("keeps every reordered fragment with deterministic ids in the shared namespace", () => {
    const a: EditorClip = { ...first, id: "a", sourceEnd: 3 };
    const b: EditorClip = { ...first, id: "b", sourceEnd: 2 };
    const document = createEmptyOverlayDocument();
    document.captions = [cue("reordered", 2_000_000, 4_000_000)];
    document.overlays = [{
      id: "reordered.part2",
      kind: "blur-mask",
      startUs: 0,
      endUs: 1_000_000,
      opacity: 1,
      shape: "rectangle",
      area: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      blurPx: 8,
      featherPx: 2,
    }];

    const remapped = remapOverlayDocumentForClips(document, [a, b], [b, a]);

    expect(remapped.captions).toEqual([
      cue("reordered", 0, 1_000_000),
      { ...cue("reordered", 4_000_000, 5_000_000), id: "reordered.part2.2" },
    ]);
    expect(remapped.overlays).toHaveLength(1);
    expect(new Set([
      ...remapped.captions.map((item) => item.id),
      ...remapped.overlays.map((item) => item.id),
    ]).size).toBe(3);
  });

  it("uses an explicit identity transform for duration-neutral clip splits", () => {
    const document = createEmptyOverlayDocument();
    document.captions = [cue("split-safe", 2_000_000, 4_000_000)];

    const remapped = remapOverlayDocument(document, identityOutputTimelineTransform(10_000_000));

    expect(remapped).toEqual(document);
    expect(remapped).not.toBe(document);
  });
});
