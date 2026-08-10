import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "./types";
import { HomePage, resolveCaptureLaunch, workflowMatchesLaunchMode } from "./pages/HomePage";

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

    it("keeps the landing surface concise and action-led", () => {
        const screenshot: Workflow = {
            ...videoWorkflow("screenshot", ["Save to Library", "Copy"]),
            kind: "screenshot",
            shortcuts: [["Win", "Shift", "D"]],
        };
        const html = renderToStaticMarkup(createElement(HomePage, {
            workflows: [screenshot],
            captures: [],
            onRunWorkflow: vi.fn(),
            onEditWorkflow: vi.fn(),
            onNavigate: vi.fn(),
            onOpenEditor: vi.fn(),
        }));

        expect(html).toContain("<h1>Capture</h1>");
        expect(html.match(/class="capture-action /g)).toHaveLength(3);
        expect(html).toContain("capture-action--screenshot");
        expect(html).toContain('aria-keyshortcuts="Meta+Shift+D"');
        expect(html).toContain('class="capture-action__art"');
        expect(html).toContain('aria-hidden="true" class="capture-action__shortcut"');
        expect(html).toContain(">Recent<");
        expect(html).toContain("No captures yet");
        expect(html).not.toContain("Manage workflows");
        expect(html).not.toContain("home-subtitle");
        expect(html).not.toContain("Save to Library");
        expect(html).not.toContain("capture-action__detail");

        const disabledHtml = renderToStaticMarkup(createElement(HomePage, {
            workflows: [{ ...screenshot, enabled: false }],
            captures: [],
            onRunWorkflow: vi.fn(),
            onEditWorkflow: vi.fn(),
            onNavigate: vi.fn(),
            onOpenEditor: vi.fn(),
        }));
        expect(disabledHtml).not.toContain("aria-keyshortcuts");
    });
});
