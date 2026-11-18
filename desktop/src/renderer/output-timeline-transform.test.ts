import { describe, expect, it } from "vitest";
import {
  deriveTimedFragmentId,
  identityOutputTimelineTransform,
  isIdentityOutputTimelineTransform,
  mapOutputTimedRange,
  outputTimelineTransformForClips,
  validateOutputTimelineTransform,
  type OutputTimelineClip,
  type OutputTimelineTransform,
} from "./output-timeline-transform";

const seconds = (value: number): number => value * 1_000_000;
const clip = (id: string, sourceStart: number, sourceEnd: number, speed = 1): OutputTimelineClip => ({
  id,
  sourceStart,
  sourceEnd,
  speed,
});

describe("output timeline transform", () => {
  it("preserves identity and gives split reducers an exact no-op contract", () => {
    const transform = identityOutputTimelineTransform(seconds(8));

    expect(isIdentityOutputTimelineTransform(transform)).toBe(true);
    expect(mapOutputTimedRange({ startUs: seconds(2), endUs: seconds(5) }, transform)).toEqual([{
      oldStartUs: seconds(2),
      oldEndUs: seconds(5),
      startUs: seconds(2),
      endUs: seconds(5),
      retainsOriginalStart: true,
      retainsOriginalEnd: true,
      index: 0,
    }]);
    expect(isIdentityOutputTimelineTransform(identityOutputTimelineTransform(0))).toBe(true);
  });

  it("ripples later ranges through a trim and a deleted clip", () => {
    const before = [clip("a", 0, 5), clip("b", 5, 10)];
    const trimmed = outputTimelineTransformForClips(before, [clip("a", 0, 3), before[1]!]);
    const deleted = outputTimelineTransformForClips(before, [before[1]!]);

    expect(mapOutputTimedRange({ startUs: seconds(6), endUs: seconds(8) }, trimmed)[0])
      .toMatchObject({ startUs: seconds(4), endUs: seconds(6) });
    expect(mapOutputTimedRange({ startUs: seconds(6), endUs: seconds(8) }, deleted)[0])
      .toMatchObject({ startUs: seconds(1), endUs: seconds(3) });
    expect(mapOutputTimedRange({ startUs: seconds(1), endUs: seconds(2) }, deleted)).toEqual([]);
  });

  it("affinely retimes ranges inside a speed change and shifts following content", () => {
    const before = [clip("a", 0, 4), clip("b", 4, 8)];
    const transform = outputTimelineTransformForClips(before, [clip("a", 0, 4, 2), before[1]!]);

    expect(mapOutputTimedRange({ startUs: seconds(1), endUs: seconds(3) }, transform)[0])
      .toMatchObject({ startUs: seconds(0.5), endUs: seconds(1.5) });
    expect(mapOutputTimedRange({ startUs: seconds(5), endUs: seconds(7) }, transform)[0])
      .toMatchObject({ startUs: seconds(3), endUs: seconds(5) });
  });

  it("preserves both sides of a closed deletion gap for consumer-specific easing", () => {
    const transform: OutputTimelineTransform = {
      oldDurationUs: seconds(5),
      newDurationUs: seconds(4),
      slices: [
        { oldStartUs: 0, oldEndUs: seconds(2), newStartUs: 0, newEndUs: seconds(2) },
        { oldStartUs: seconds(3), oldEndUs: seconds(5), newStartUs: seconds(2), newEndUs: seconds(4) },
      ],
      trailing: "shift-by-duration-delta",
    };

    expect(mapOutputTimedRange({ startUs: seconds(1), endUs: seconds(4) }, transform)).toEqual([
      {
        oldStartUs: seconds(1),
        oldEndUs: seconds(2),
        startUs: seconds(1),
        endUs: seconds(2),
        retainsOriginalStart: true,
        retainsOriginalEnd: false,
        index: 0,
      },
      {
        oldStartUs: seconds(3),
        oldEndUs: seconds(4),
        startUs: seconds(2),
        endUs: seconds(3),
        retainsOriginalStart: false,
        retainsOriginalEnd: true,
        index: 1,
      },
    ]);
  });

  it("keeps reordered cross-boundary fragments instead of merging or dropping one", () => {
    const transform: OutputTimelineTransform = {
      oldDurationUs: seconds(5),
      newDurationUs: seconds(5),
      slices: [
        { oldStartUs: 0, oldEndUs: seconds(3), newStartUs: seconds(2), newEndUs: seconds(5) },
        { oldStartUs: seconds(3), oldEndUs: seconds(5), newStartUs: 0, newEndUs: seconds(2) },
      ],
      trailing: "shift-by-duration-delta",
    };

    expect(mapOutputTimedRange({ startUs: seconds(2), endUs: seconds(4) }, transform)).toEqual([
      {
        oldStartUs: seconds(3),
        oldEndUs: seconds(4),
        startUs: 0,
        endUs: seconds(1),
        retainsOriginalStart: false,
        retainsOriginalEnd: true,
        index: 0,
      },
      {
        oldStartUs: seconds(2),
        oldEndUs: seconds(3),
        startUs: seconds(4),
        endUs: seconds(5),
        retainsOriginalStart: true,
        retainsOriginalEnd: false,
        index: 1,
      },
    ]);
  });

  it("represents inserted output as a new-time gap", () => {
    const transform: OutputTimelineTransform = {
      oldDurationUs: seconds(4),
      newDurationUs: seconds(6),
      slices: [
        { oldStartUs: 0, oldEndUs: seconds(2), newStartUs: 0, newEndUs: seconds(2) },
        { oldStartUs: seconds(2), oldEndUs: seconds(4), newStartUs: seconds(4), newEndUs: seconds(6) },
      ],
      trailing: "shift-by-duration-delta",
    };

    expect(mapOutputTimedRange({ startUs: seconds(1), endUs: seconds(3) }, transform))
      .toMatchObject([{ startUs: seconds(1), endUs: seconds(2) }, { startUs: seconds(4), endUs: seconds(5) }]);
  });

  it("shifts intentional cues beyond the old output by the duration delta", () => {
    const transform = outputTimelineTransformForClips(
      [clip("a", 0, 5), clip("b", 5, 10)],
      [clip("a", 0, 5, 2), clip("b", 5, 10)],
    );

    expect(mapOutputTimedRange({ startUs: seconds(11), endUs: seconds(12) }, transform)[0])
      .toMatchObject({ startUs: seconds(8.5), endUs: seconds(9.5) });
  });

  it("uses half-open boundaries without duplicating a boundary-only range", () => {
    const transform: OutputTimelineTransform = {
      oldDurationUs: seconds(4),
      newDurationUs: seconds(4),
      slices: [
        { oldStartUs: 0, oldEndUs: seconds(2), newStartUs: seconds(2), newEndUs: seconds(4) },
        { oldStartUs: seconds(2), oldEndUs: seconds(4), newStartUs: 0, newEndUs: seconds(2) },
      ],
      trailing: "shift-by-duration-delta",
    };

    expect(mapOutputTimedRange({ startUs: seconds(2), endUs: seconds(3) }, transform)).toHaveLength(1);
    expect(mapOutputTimedRange({ startUs: seconds(2), endUs: seconds(3) }, transform)[0])
      .toMatchObject({ startUs: 0, endUs: seconds(1) });
  });

  it("builds reordered clip slices from retained source positions", () => {
    const before = [clip("a", 0, 3), clip("b", 3, 5)];
    const transform = outputTimelineTransformForClips(before, [before[1]!, before[0]!]);

    expect(transform.slices).toEqual([
      { oldStartUs: 0, oldEndUs: seconds(3), newStartUs: seconds(2), newEndUs: seconds(5) },
      { oldStartUs: seconds(3), oldEndUs: seconds(5), newStartUs: 0, newEndUs: seconds(2) },
    ]);
  });

  it("matches canonical per-clip rounding without fractional cursor accumulation", () => {
    const clips = Array.from({ length: 9 }, (_, index) => clip(String(index), index, index + 1, 3));
    const transform = outputTimelineTransformForClips(clips, clips);

    expect(transform.oldDurationUs).toBe(2_999_997);
    expect(transform.newDurationUs).toBe(2_999_997);
    expect(isIdentityOutputTimelineTransform(transform)).toBe(true);
  });

  it("keeps an odd-microsecond endpoint aligned with canonical speed rounding", () => {
    const before = [clip("a", 0, 1.000001)];
    const transform = outputTimelineTransformForClips(before, [clip("a", 0, 1.000001, 2)]);

    expect(transform.oldDurationUs).toBe(1_000_001);
    expect(transform.newDurationUs).toBe(500_001);
    expect(mapOutputTimedRange({ startUs: 0, endUs: 1_000_001 }, transform)).toEqual([{
      oldStartUs: 0,
      oldEndUs: 1_000_001,
      startUs: 0,
      endUs: 500_001,
      retainsOriginalStart: true,
      retainsOriginalEnd: true,
      index: 0,
    }]);
  });

  it("rejects overlapping or malformed transforms and ambiguous clip IDs", () => {
    const oldOverlap: OutputTimelineTransform = {
      oldDurationUs: 10,
      newDurationUs: 10,
      slices: [
        { oldStartUs: 0, oldEndUs: 6, newStartUs: 0, newEndUs: 6 },
        { oldStartUs: 5, oldEndUs: 10, newStartUs: 6, newEndUs: 10 },
      ],
      trailing: "shift-by-duration-delta",
    };
    const newOverlap: OutputTimelineTransform = {
      oldDurationUs: 10,
      newDurationUs: 10,
      slices: [
        { oldStartUs: 0, oldEndUs: 5, newStartUs: 0, newEndUs: 6 },
        { oldStartUs: 5, oldEndUs: 10, newStartUs: 5, newEndUs: 10 },
      ],
      trailing: "shift-by-duration-delta",
    };

    expect(() => validateOutputTimelineTransform(oldOverlap)).toThrow(/old slices must not overlap/u);
    expect(() => validateOutputTimelineTransform(newOverlap)).toThrow(/new slices must not overlap/u);
    expect(() => mapOutputTimedRange({ startUs: 1, endUs: 1 }, identityOutputTimelineTransform(1))).toThrow(/positive/u);
    expect(() => outputTimelineTransformForClips(
      [clip("same", 0, 1), clip("same", 1, 2)],
      [],
    )).toThrow(/unique/u);
  });

  it("derives deterministic unique bounded IDs through repeated fragmentation", () => {
    const baseId = `z${"x".repeat(127)}`;
    const occupied = new Set<string>();
    const ids = Array.from({ length: 40 }, (_, index) => {
      const id = deriveTimedFragmentId(baseId, index + 1, occupied);
      occupied.add(id);
      return id;
    });

    expect(new Set(ids).size).toBe(40);
    expect(ids.every((id) => id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))).toBe(true);
    expect(deriveTimedFragmentId("cue", 2)).toBe("cue.part2");
    expect(deriveTimedFragmentId("cue", 2, new Set(["cue.part2"]))).toBe("cue.part2.2");
  });
});
