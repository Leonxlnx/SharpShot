import { describe, expect, it, vi } from "vitest";
import { createFrameCoalescer } from "./frame-coalescer";

describe("createFrameCoalescer", () => {
    it("applies only the newest pointer draft once per frame", () => {
        const callbacks = new Map<number, FrameRequestCallback>();
        const apply = vi.fn();
        let nextFrame = 1;
        const coalescer = createFrameCoalescer<number>(
            (callback) => {
                const frame = nextFrame++;
                callbacks.set(frame, callback);
                return frame;
            },
            (frame) => callbacks.delete(frame),
            apply,
        );

        for (let value = 0; value < 100; value += 1) coalescer.schedule(value);

        expect(callbacks.size).toBe(1);
        callbacks.values().next().value?.(16);
        expect(apply).toHaveBeenCalledOnce();
        expect(apply).toHaveBeenCalledWith(99);
    });

    it("can flush the final draft or cancel it without a stale callback", () => {
        const callbacks = new Map<number, FrameRequestCallback>();
        const apply = vi.fn();
        let nextFrame = 1;
        const coalescer = createFrameCoalescer<string>(
            (callback) => {
                const frame = nextFrame++;
                callbacks.set(frame, callback);
                return frame;
            },
            (frame) => callbacks.delete(frame),
            apply,
        );

        coalescer.schedule("committed");
        coalescer.flush();
        expect(apply).toHaveBeenCalledWith("committed");
        expect(callbacks.size).toBe(0);

        coalescer.schedule("cancelled");
        coalescer.cancel();
        expect(callbacks.size).toBe(0);
        expect(apply).toHaveBeenCalledTimes(1);
    });
});
