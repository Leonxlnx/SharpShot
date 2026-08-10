import { describe, expect, it } from "vitest";
import { isProjectOperationCurrent, projectDocument, type ProjectOperationToken } from "./project-operation";

describe("project operation epochs", () => {
    const projectA: ProjectOperationToken = { epoch: 4, projectId: "project-a" };

    it("accepts only the project and epoch that started the operation", () => {
        expect(isProjectOperationCurrent(projectA, 4, "project-a")).toBe(true);
        expect(isProjectOperationCurrent(projectA, 5, "project-a")).toBe(false);
        expect(isProjectOperationCurrent(projectA, 4, "project-b")).toBe(false);
        expect(isProjectOperationCurrent(projectA, 4, null)).toBe(false);
    });

    it("rejects a late save from project A after project B opens", () => {
        const current = { epoch: 5, projectId: "project-b" };
        expect(isProjectOperationCurrent(projectA, current.epoch, current.projectId)).toBe(false);
    });

    it("gives a stable document marker for no-op autosave suppression", () => {
        const loaded = { canvas: { width: 1_700, height: 1_000 }, clips: [{ id: "clip-a" }] };
        expect(projectDocument({ ...loaded, canvas: { ...loaded.canvas } })).toBe(projectDocument(loaded));
        expect(projectDocument({ ...loaded, canvas: { ...loaded.canvas, width: 1_920 } })).not.toBe(projectDocument(loaded));
    });

    it("detects nested audio edits for the existing autosave path", () => {
        const loaded = {
            clips: [{ id: "clip-a" }],
            audio: { lanes: [{ id: "music", gainDb: 0, clips: [{ id: "music-clip", fadeInUs: 0 }] }] },
        };
        const edited = structuredClone(loaded);
        edited.audio.lanes[0]!.clips[0]!.fadeInUs = 750_000;

        expect(projectDocument(edited)).not.toBe(projectDocument(loaded));
        expect(projectDocument(structuredClone(loaded))).toBe(projectDocument(loaded));
    });
});
