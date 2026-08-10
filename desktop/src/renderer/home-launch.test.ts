import { describe, expect, it } from "vitest";
import type { Workflow } from "./types";
import { resolveCaptureLaunch, workflowMatchesLaunchMode } from "./pages/HomePage";

function videoWorkflow(id: string, after: Workflow["after"], enabled = true): Workflow {
    return {
        id,
        name: id,
        description: "Test workflow",
        kind: "video",
        target: "Region",
        shortcuts: [],
        enabled,
        fps: 60,
        quality: "High",
        cursor: true,
        systemAudio: false,
        microphone: false,
        countdown: 0,
        after,
    };
}

describe("Home capture CTA routing", () => {
    it("matches modes independently of enabled state", () => {
        const quick = videoWorkflow("quick", ["Save to Library", "Copy"]);
        const disabledStudio = videoWorkflow("studio", ["Save to Library", "Open Editor"], false);

        expect(workflowMatchesLaunchMode(disabledStudio, "studio")).toBe(true);
        expect(workflowMatchesLaunchMode(disabledStudio, "quick")).toBe(false);
        expect(workflowMatchesLaunchMode(quick, "quick")).toBe(true);
    });

    it("runs enabled matches, edits disabled matches, and configures a missing mode", () => {
        const quick = videoWorkflow("quick", ["Save to Library", "Copy"]);
        const disabledStudio = videoWorkflow("studio", ["Save to Library", "Open Editor"], false);
        const disabledQuick = videoWorkflow("disabled-quick", ["Save to Library", "Copy"], false);

        expect(resolveCaptureLaunch([disabledQuick, quick, disabledStudio], "quick")).toEqual({ kind: "run", workflow: quick });
        expect(resolveCaptureLaunch([quick, disabledStudio], "studio")).toEqual({ kind: "edit", workflow: disabledStudio });
        expect(resolveCaptureLaunch([quick, disabledStudio], "screenshot")).toEqual({ kind: "configure" });
    });
});
