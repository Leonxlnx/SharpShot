import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue";

describe("SerialTaskQueue", () => {
    it("keeps a close-time flush behind an in-flight debounce write", async () => {
        const queue = new SerialTaskQueue();
        const order: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const first = queue.run(async () => {
            order.push("debounce:start");
            await gate;
            order.push("debounce:end");
        });
        const closeFlush = queue.run(async () => {
            order.push("close:flush");
            return true;
        });
        await Promise.resolve();
        expect(order).toEqual(["debounce:start"]);
        releaseFirst?.();
        await expect(closeFlush).resolves.toBe(true);
        await first;
        expect(order).toEqual(["debounce:start", "debounce:end", "close:flush"]);
    });

    it("continues after a failed write", async () => {
        const queue = new SerialTaskQueue();
        await expect(queue.run(async () => { throw new Error("disk busy"); })).rejects.toThrow("disk busy");
        await expect(queue.run(async () => "saved")).resolves.toBe("saved");
    });
});
