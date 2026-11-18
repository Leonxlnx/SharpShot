import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";

describe("workspace skeleton", () => {
    it("exposes a polite busy editor status while keeping its geometry decorative", () => {
        const html = renderToStaticMarkup(createElement(WorkspaceSkeleton, { variant: "editor" }));

        expect(html).toContain('role="status"');
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain('aria-label="Preparing your recording…"');
        expect(html).toContain('class="workspace-skeleton workspace-skeleton--editor"');
        expect(html).toContain('class="workspace-skeleton__workspace"');
        expect(html).toContain('class="workspace-skeleton__inspector"');
        expect(html).toContain('class="workspace-skeleton__inspector-picker"');
        expect(html).toContain('class="workspace-skeleton__bone workspace-skeleton__picker-field"');
        expect(html).not.toContain('class="workspace-skeleton__inspector-tabs"');
        expect(html).toContain('class="workspace-skeleton__timeline"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('aria-label="Minimize window"');
        expect(html).toContain('aria-label="Maximize or restore window"');
        expect(html).toContain('aria-label="Close window"');
        expect(html).not.toContain('workspace-skeleton__command-group--center');
        expect(html).not.toContain('aria-hidden="true" class="workspace-skeleton__commandbar"');
    });

    it("renders the compact shell variant with a caller-supplied status", () => {
        const html = renderToStaticMarkup(createElement(WorkspaceSkeleton, { label: "Loading library", variant: "shell" }));

        expect(html).toContain('aria-label="Loading library"');
        expect(html).toContain('class="workspace-skeleton workspace-skeleton--shell"');
        expect(html).toContain('class="workspace-skeleton__shell-page"');
        expect(html).toContain('workspace-skeleton__shell-card--primary');
        expect(html).not.toContain('workspace-skeleton__shell-copy');
        expect(html).not.toContain('class="workspace-skeleton__workspace"');
    });

    it("shows a settled visible error while preserving editor window chrome", () => {
        const html = renderToStaticMarkup(createElement(WorkspaceSkeleton, { error: true, label: "Startup failed", variant: "editor" }));

        expect(html).toContain('aria-busy="false"');
        expect(html).toContain('workspace-skeleton--error');
        expect(html).toContain('role="alert"');
        expect(html).toContain("SharpShot could not initialize.");
        expect(html).toContain('aria-label="Close window"');
    });
});
