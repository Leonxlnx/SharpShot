import { describe, expect, it, vi } from "vitest";
import { prepareWindowClose } from "./close-preparation";

describe("window close preparation", () => {
    it.each(["custom X", "Alt+F4", "taskbar close", "tray Quit"])("flushes workflows, project save, and project storage for %s", async () => {
        const calls: string[] = [];
        await expect(prepareWindowClose({
            editorActive: true,
            projectId: "project-a",
            persistWorkflows: async () => { calls.push("workflows"); return true; },
            persistProject: async () => { calls.push("project"); return true; },
            flushProject: async (id) => { calls.push(`flush:${id}`); return true; },
        })).resolves.toBe(true);
        expect(calls).toEqual(["workflows", "project", "flush:project-a"]);
    });

    it("allows a corrupt/failed editor open with no project to remain closable", async () => {
        const flushProject = vi.fn(async () => true);
        await expect(prepareWindowClose({
            editorActive: true,
            projectId: null,
            persistWorkflows: async () => true,
            persistProject: async () => true,
            flushProject,
        })).resolves.toBe(true);
        expect(flushProject).not.toHaveBeenCalled();
    });

    it("does not acknowledge close when any durable write fails", async () => {
        await expect(prepareWindowClose({
            editorActive: true,
            projectId: "project-a",
            persistWorkflows: async () => true,
            persistProject: async () => false,
            flushProject: async () => true,
        })).resolves.toBe(false);
    });

    it("withholds the close acknowledgement when a workflow transaction is rejected", async () => {
        const persistProject = vi.fn(async () => true);
        const flushProject = vi.fn(async () => true);
        await expect(prepareWindowClose({
            editorActive: true,
            projectId: "project-a",
            persistWorkflows: async () => false,
            persistProject,
            flushProject,
        })).resolves.toBe(false);
        expect(persistProject).not.toHaveBeenCalled();
        expect(flushProject).not.toHaveBeenCalled();
    });
});
