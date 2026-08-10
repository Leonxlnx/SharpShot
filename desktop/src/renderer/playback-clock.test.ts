import { describe, expect, it } from "vitest";
import { playbackDeltaForFrame } from "./playback-clock";

describe("playbackDeltaForFrame", () => {
    it("bounds editor-state updates to display-rate work on high-refresh monitors", () => {
        let previous = 0;
        let updates = 0;
        for (let frame = 1; frame <= 240; frame += 1) {
            const now = frame * (1_000 / 240);
            const delta = playbackDeltaForFrame(previous, now);
            if (delta === null) continue;
            updates += 1;
            previous = now;
        }

        expect(updates).toBeGreaterThanOrEqual(59);
        expect(updates).toBeLessThanOrEqual(61);
    });

    it("drops invalid timestamps and caps a resumed frame", () => {
        expect(playbackDeltaForFrame(null, 10)).toBeNull();
        expect(playbackDeltaForFrame(10, 10)).toBeNull();
        expect(playbackDeltaForFrame(10, Number.NaN)).toBeNull();
        expect(playbackDeltaForFrame(10, 5_000)).toBe(.1);
    });
});
