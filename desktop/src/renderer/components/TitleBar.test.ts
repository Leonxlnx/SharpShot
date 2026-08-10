import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar, WindowControls } from "./TitleBar";

describe("window chrome", () => {
    it("reuses the same accessible window controls in shell and editor chrome", () => {
        const controls = renderToStaticMarkup(createElement(WindowControls));
        const titlebar = renderToStaticMarkup(createElement(TitleBar, { title: "Capture" }));

        for (const label of ["Minimize window", "Maximize or restore window", "Close window"]) {
            expect(controls).toContain(`aria-label="${label}"`);
            expect(titlebar).toContain(`aria-label="${label}"`);
        }
        expect(controls.match(/<button/g)).toHaveLength(3);
        expect(titlebar.match(/<button/g)).toHaveLength(3);
    });
});
