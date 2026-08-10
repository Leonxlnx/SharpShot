import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

describe("sidebar navigation", () => {
    it("keeps every destination named and exposes exactly one current page", () => {
        const html = renderToStaticMarkup(createElement(Sidebar, { route: "library", onNavigate: vi.fn() }));

        for (const label of ["Capture", "Library", "Workflows", "Settings"]) {
            expect(html).toContain(`aria-label="${label}"`);
            expect(html).toContain(`title="${label}"`);
        }
        expect(html).not.toContain('sidebar__index');
        expect(html.match(/aria-current="page"/g)).toHaveLength(1);
        expect(html).toContain('aria-label="Application settings"');
    });
});
