import { describe, expect, it } from "vitest";
import type { ExportJobSnapshot } from "../shared/api";
import { recoverableExport } from "./export-recovery";

describe("export sheet recovery", () => {
    it.each(["queued", "running"] as const)("reattaches a %s job after close and reopen", (state) => {
        const snapshot: ExportJobSnapshot = { jobId: "job-a", fileName: "Demo.mp4", state };
        expect(recoverableExport(snapshot)).toBe(snapshot);
    });

    it.each(["completed", "completed-unindexed", "failed"] as const)("hydrates an unseen %s result", (state) => {
        const snapshot: ExportJobSnapshot = { jobId: "job-finished", fileName: "Demo.mp4", state };
        expect(recoverableExport(snapshot, "job-before")).toBe(snapshot);
    });

    it.each(["completed", "completed-unindexed", "failed"] as const)("does not replay an acknowledged %s result", (state) => {
        expect(recoverableExport(
            { jobId: "job-old", fileName: "Old.mp4", state },
            "job-old",
        )).toBeNull();
    });

    it("does not recover a cancelled job", () => {
        expect(recoverableExport({ jobId: "job-cancelled", fileName: "Old.mp4", state: "cancelled" })).toBeNull();
    });
});
