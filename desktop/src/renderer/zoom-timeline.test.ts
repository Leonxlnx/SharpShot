import { describe, expect, it } from "vitest";
import type { ZoomSegment } from "../shared/cursor-zoom";
import {
    availableZoomRangeAtPlayhead,
    resizeZoomSegmentRange,
    zoomSegmentPlacement,
} from "./zoom-timeline";

const segments: ZoomSegment[] = [
    { id: "first", startUs: 1_000_000, endUs: 3_000_000, focus: { x: 0.4, y: 0.4 }, scale: 2, easeInUs: 600_000, easeOutUs: 600_000, source: "manual" },
    { id: "second", startUs: 4_000_000, endUs: 6_000_000, focus: { x: 0.7, y: 0.6 }, scale: 2.5, easeInUs: 200_000, easeOutUs: 200_000, source: "manual" },
];

describe("zoom timeline geometry", () => {
    it("places a segment against the complete output timeline", () => {
        expect(zoomSegmentPlacement(segments[0]!, 8_000_000)).toEqual({ leftPercent: 12.5, widthPercent: 25 });
    });

    it("adds only inside free space without replacing an existing zoom", () => {
        expect(availableZoomRangeAtPlayhead(segments, 2_000_000, 8_000_000)).toBeUndefined();
        expect(availableZoomRangeAtPlayhead(segments, 3_000_000, 8_000_000)).toEqual({
            startUs: 3_000_000,
            endUs: 4_000_000,
            easeInUs: 180_000,
            easeOutUs: 220_000,
        });
    });

    it("clamps handles to neighbors and keeps easing valid", () => {
        expect(resizeZoomSegmentRange(segments, "second", "start", 2_000_000, 8_000_000)).toEqual({
            startUs: 3_000_000,
            endUs: 6_000_000,
            easeInUs: 200_000,
            easeOutUs: 200_000,
        });
        expect(resizeZoomSegmentRange(segments, "first", "end", 3_950_000, 8_000_000)).toEqual({
            startUs: 1_000_000,
            endUs: 3_950_000,
            easeInUs: 600_000,
            easeOutUs: 600_000,
        });
        expect(resizeZoomSegmentRange(segments, "first", "end", 1_050_000, 8_000_000)).toEqual({
            startUs: 1_000_000,
            endUs: 1_100_000,
            easeInUs: 100_000,
            easeOutUs: 0,
        });
    });
});
