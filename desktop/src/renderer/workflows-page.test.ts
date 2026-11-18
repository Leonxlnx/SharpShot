import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "./types";
import { WorkflowsPage } from "./pages/WorkflowsPage";

describe("workflow recipe appearance", () => {
    it("exposes the selected workflow kind without adding interactive decoration", () => {
        const workflow = (id: string, kind: Workflow["kind"]): Workflow => ({
            id,
            name: `${kind} workflow`,
            description: "Test workflow",
            kind,
            target: "Region",
            shortcuts: [["Win", "Shift", kind === "video" ? "A" : "D"]],
            enabled: true,
            fps: 60,
            quality: "High",
            cursor: true,
            systemAudio: false,
            microphone: false,
            countdown: 0,
            after: ["Save to Library", "Copy"],
        });
        const workflows = [workflow("screenshot", "screenshot"), workflow("video", "video")];
        const render = (selectedId: string) => renderToStaticMarkup(createElement(WorkflowsPage, {
            workflows,
            selectedId,
            onSelect: vi.fn(),
            onUpdate: vi.fn(),
            onDuplicate: vi.fn(),
            onCreate: vi.fn(),
            onDelete: vi.fn(),
            quickVideoAudioMux: true,
        }));
        expect(render("screenshot")).toContain('class="recipe-editor recipe-editor--screenshot"');
        expect(render("video")).toContain('class="recipe-editor recipe-editor--video"');
    });
});
