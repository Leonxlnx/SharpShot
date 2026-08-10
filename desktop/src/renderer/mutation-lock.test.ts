import { describe, expect, it, vi } from "vitest";
import { MutationLock } from "./mutation-lock";

describe("MutationLock", () => {
    it("rejects late editor and workflow mutations for the whole async exit save", async () => {
        const lock = new MutationLock();
        const editorMutation = vi.fn();
        const workflowMutation = vi.fn();
        let finishSave: (() => void) | undefined;
        const save = new Promise<void>((resolve) => { finishSave = resolve; });

        const release = lock.acquire();
        const exit = save.finally(release);

        expect(lock.run(editorMutation)).toBe(false);
        expect(lock.run(workflowMutation)).toBe(false);
        expect(editorMutation).not.toHaveBeenCalled();
        expect(workflowMutation).not.toHaveBeenCalled();

        finishSave?.();
        await exit;

        expect(lock.run(editorMutation)).toBe(true);
        expect(editorMutation).toHaveBeenCalledOnce();
    });

    it("stays locked until overlapping leave and native-close owners both release", () => {
        const lock = new MutationLock();
        const releaseLeave = lock.acquire();
        const releaseNativeClose = lock.acquire();

        releaseLeave();
        expect(lock.locked).toBe(true);
        releaseNativeClose();
        expect(lock.locked).toBe(false);
    });
});
