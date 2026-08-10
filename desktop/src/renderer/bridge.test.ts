import { describe, expect, it } from "vitest";
import type { WorkflowStore } from "../shared/api";
import { rendererWorkflowsToStore } from "./bridge";
import type { Workflow } from "./types";

const emptyStore: WorkflowStore = { schemaVersion: 1, workflows: [], shortcutBindings: [] };
const quickAudio: Workflow = {
    id: "quick-audio",
    name: "Quick audio",
    description: "Test",
    kind: "video",
    target: "Region",
    shortcuts: [],
    enabled: true,
    fps: 60,
    quality: "High",
    cursor: true,
    systemAudio: true,
    microphone: true,
    countdown: 3,
    after: ["Save to Library", "Copy"],
};

describe("renderer workflow persistence", () => {
    it("persists file Copy for quick audio only when native mux is available", () => {
        expect(rendererWorkflowsToStore([quickAudio], emptyStore).workflows[0]?.finish.clipboard).toBe("none");
        expect(rendererWorkflowsToStore([quickAudio], emptyStore, { quickVideoAudioMux: true }).workflows[0]?.finish.clipboard).toBe("file");
    });

    it("keeps Studio audio stems separate even when quick mux is available", () => {
        const studio = { ...quickAudio, after: ["Save to Library", "Copy", "Open Editor"] as Workflow["after"] };
        const stored = rendererWorkflowsToStore([studio], emptyStore, { quickVideoAudioMux: true }).workflows[0];
        expect(stored?.finish).toMatchObject({ clipboard: "none", afterCapture: "open-editor" });
    });
});
