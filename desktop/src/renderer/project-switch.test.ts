import { describe, expect, it, vi } from "vitest";
import { MutationLock } from "./mutation-lock";
import { runLockedProjectSwitch } from "./project-switch";

describe("locked native project switch", () => {
    it("locks before the final snapshot so a concurrent late edit cannot escape the saved project", async () => {
        const lock = new MutationLock();
        const calls: string[] = [];
        let projectDocument = "A-before-route";
        let savedDocument = "";
        let finishSave: (() => void) | undefined;
        const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });

        const transition = runLockedProjectSwitch({
            acquire: () => lock.acquire(),
            currentProjectId: "project-a",
            sameMedia: false,
            persistCurrent: async () => {
                savedDocument = projectDocument;
                calls.push(`save:${savedDocument}`);
                await saveGate;
                return true;
            },
            flushCurrent: async (id) => { calls.push(`flush:${id}`); return true; },
            continueSwitch: async () => { calls.push("load:B"); return "B"; },
        });

        expect(lock.run(() => { projectDocument = "A-late-edit"; })).toBe(false);
        finishSave?.();
        await expect(transition).resolves.toEqual({ kind: "completed", value: "B" });
        expect(savedDocument).toBe("A-before-route");
        expect(calls).toEqual(["save:A-before-route", "flush:project-a", "load:B"]);
        expect(lock.locked).toBe(false);
    });

    it("durably saves a same-media route that arrives before the 420 ms autosave, without reloading", async () => {
        const lock = new MutationLock();
        const persistCurrent = vi.fn(async () => true);
        const flushCurrent = vi.fn(async () => true);
        const continueSwitch = vi.fn(async () => "reloaded");

        await expect(runLockedProjectSwitch({
            acquire: () => lock.acquire(),
            currentProjectId: "project-a",
            sameMedia: true,
            persistCurrent,
            flushCurrent,
            continueSwitch,
        })).resolves.toEqual({ kind: "same-media" });

        expect(persistCurrent).toHaveBeenCalledOnce();
        expect(flushCurrent).toHaveBeenCalledWith("project-a");
        expect(continueSwitch).not.toHaveBeenCalled();
        expect(lock.locked).toBe(false);
    });

    it("keeps the current project and unlocks when its save or flush fails", async () => {
        const lock = new MutationLock();
        const continueSwitch = vi.fn(async () => undefined);

        await expect(runLockedProjectSwitch({
            acquire: () => lock.acquire(),
            currentProjectId: "project-a",
            sameMedia: false,
            persistCurrent: async () => true,
            flushCurrent: async () => false,
            continueSwitch,
        })).resolves.toEqual({ kind: "blocked" });

        expect(continueSwitch).not.toHaveBeenCalled();
        expect(lock.locked).toBe(false);
    });
});
