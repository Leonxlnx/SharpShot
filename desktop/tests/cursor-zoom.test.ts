import { describe, expect, it } from "vitest";
import {
  createCursorSidecar,
  cursorRenderStateAt,
  evaluateCursorZoomPreview,
  evaluateZoomAt,
  generateAutoZoomSegments,
  parseCursorSidecar,
  prepareCursorTrack,
  previewTransformForZoom,
  reduceZoomSegments,
  serializeCursorSidecar,
  type CursorEvent,
  type ZoomSegment,
} from "../src/shared/cursor-zoom.js";

function sidecar(events: readonly CursorEvent[], durationUs = 4_000_000) {
  return createCursorSidecar({
    durationUs,
    capture: { width: 1920, height: 1080, originX: -1920, originY: 0, scaleFactor: 1.25 },
    events,
  });
}

describe("cursor sidecar", () => {
  it("round-trips a strict, normalized multi-monitor format", () => {
    const input = sidecar([
      { kind: "move", timeUs: 10_000, x: 0.1, y: 0.2 },
      { kind: "button", timeUs: 20_000, x: 0.1, y: 0.2, button: "left", state: "down" },
      { kind: "button", timeUs: 30_000, x: 0.1, y: 0.2, button: "left", state: "up" },
    ]);

    expect(parseCursorSidecar(serializeCursorSidecar(input))).toEqual(input);
    expect(input.capture.originX).toBe(-1920);
  });

  it("rejects out-of-order timestamps and out-of-bounds points", () => {
    expect(() =>
      sidecar([
        { kind: "move", timeUs: 20, x: 0.2, y: 0.2 },
        { kind: "move", timeUs: 10, x: 0.3, y: 0.3 },
      ]),
    ).toThrow(/monotonic/);
    expect(() => sidecar([{ kind: "move", timeUs: 20, x: 1.1, y: 0.2 }])).toThrow(
      /between 0 and 1/,
    );
  });
});

describe("cursor motion and presentation", () => {
  it("filters jitter, preserves click targets, and never overshoots a segment", () => {
    const input = sidecar([
      { kind: "move", timeUs: 0, x: 0.1, y: 0.1 },
      { kind: "move", timeUs: 20_000, x: 0.45, y: 0.8 },
      { kind: "move", timeUs: 40_000, x: 0.5, y: 0.5 },
      { kind: "button", timeUs: 60_000, x: 0.7, y: 0.6, button: "left", state: "down" },
      { kind: "button", timeUs: 80_000, x: 0.7, y: 0.6, button: "left", state: "up" },
    ]);
    const track = prepareCursorTrack(input, { strength: 1, responseUs: 50_000 });

    expect(track.keyframes[1]!.y).toBeLessThan(0.8);
    expect(track.keyframes[3]).toMatchObject({ x: 0.7, y: 0.6, clickAnchor: true });
    const preview = evaluateCursorZoomPreview(track, [], 50_000);
    expect(preview.cursor!.x).toBeGreaterThanOrEqual(track.keyframes[2]!.x);
    expect(preview.cursor!.x).toBeLessThanOrEqual(track.keyframes[3]!.x);
  });

  it("does not invent motion across a long idle gap", () => {
    const track = prepareCursorTrack(
      sidecar([
        { kind: "move", timeUs: 0, x: 0.1, y: 0.1 },
        { kind: "move", timeUs: 1_000_000, x: 0.9, y: 0.9 },
      ]),
      { maxGapUs: 200_000 },
    );

    expect(evaluateCursorZoomPreview(track, [], 700_000).cursor).toMatchObject({ x: 0.1, y: 0.1 });
    expect(evaluateCursorZoomPreview(track, [], 1_000_000).cursor).toMatchObject({ x: 0.9, y: 0.9 });
  });

  it("emphasizes a click, tracks held buttons, then fades an idle cursor", () => {
    const track = prepareCursorTrack(
      sidecar([
        { kind: "move", timeUs: 0, x: 0.4, y: 0.4 },
        { kind: "button", timeUs: 100_000, x: 0.4, y: 0.4, button: "left", state: "down" },
        { kind: "button", timeUs: 180_000, x: 0.4, y: 0.4, button: "left", state: "up" },
      ]),
    );

    expect(cursorRenderStateAt(track, 120_000)?.pressedButtons).toEqual(["left"]);
    expect(cursorRenderStateAt(track, 150_000)?.click?.intensity).toBeGreaterThan(0.5);
    expect(
      cursorRenderStateAt(track, 1_300_000, { idleDelayUs: 500_000, idleFadeUs: 200_000 })
        ?.opacity,
    ).toBe(0);
  });
});

describe("automatic and editable zoom", () => {
  it("merges nearby clicks and separates a distant target", () => {
    const input = sidecar([
      { kind: "button", timeUs: 500_000, x: 0.2, y: 0.3, button: "left", state: "down" },
      { kind: "button", timeUs: 800_000, x: 0.24, y: 0.32, button: "left", state: "down" },
      { kind: "button", timeUs: 2_200_000, x: 0.85, y: 0.8, button: "left", state: "down" },
    ]);
    const zooms = generateAutoZoomSegments(input);

    expect(zooms).toHaveLength(2);
    expect(zooms[0]!.focus.x).toBeCloseTo(0.22);
    expect(zooms[0]!.endUs).toBeLessThanOrEqual(zooms[1]!.startUs);
    expect(zooms[1]!.focus).toEqual({ x: 0.85, y: 0.8 });
  });

  it("updates immutably and rejects overlapping editor segments", () => {
    const first = zoom("first", 0, 1_000_000, 0.3, 0.4);
    const second = zoom("second", 1_200_000, 2_200_000, 0.7, 0.6);
    const changed = reduceZoomSegments(
      [first, second],
      { type: "zoom.update", id: "first", changes: { scale: 3, focus: { x: 0.4, y: 0.4 } } },
      4_000_000,
    );

    expect(changed[0]).toMatchObject({ scale: 3, focus: { x: 0.4, y: 0.4 } });
    expect(first).toMatchObject({ scale: 2, focus: { x: 0.3, y: 0.4 } });
    expect(() =>
      reduceZoomSegments(
        [first, second],
        { type: "zoom.update", id: "second", changes: { startUs: 900_000 } },
        4_000_000,
      ),
    ).toThrow(/overlaps/);
  });

  it("uses smooth ramps and edge-safe preview transforms", () => {
    const segment = zoom("edge", 0, 1_000_000, 0.98, 0.05);
    const start = evaluateZoomAt([segment], 0);
    const middle = evaluateZoomAt([segment], 500_000);
    const transform = previewTransformForZoom(middle);

    expect(start.scale).toBe(1);
    expect(middle.scale).toBe(2);
    expect(transform.centerX).toBe(0.75);
    expect(transform.centerY).toBe(0.25);
    expect(transform.translateX).toBe(-1);
    expect(transform.translateY).toBe(0);
  });
});

function zoom(
  id: string,
  startUs: number,
  endUs: number,
  x: number,
  y: number,
): ZoomSegment {
  return {
    id,
    startUs,
    endUs,
    focus: { x, y },
    scale: 2,
    easeInUs: 200_000,
    easeOutUs: 200_000,
    source: "manual",
  };
}
