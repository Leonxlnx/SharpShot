import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EDITOR_TOOLS, EditorToolPicker } from "./EditorToolPicker";

describe("editor tool picker", () => {
    it("keeps every tool in order with its availability exposed by the native select", () => {
        const html = renderToStaticMarkup(<EditorToolPicker activeTool="layout" onSelect={vi.fn()} />);
        let cursor = -1;

        for (const tool of EDITOR_TOOLS) {
            const option = `<option value="${tool.id}"${tool.id === "layout" ? " selected=\"\"" : ""}${tool.available ? "" : " disabled=\"\""}>${tool.label}${tool.available ? "" : " · Soon"}</option>`;
            const index = html.indexOf(option);
            expect(index).toBeGreaterThan(cursor);
            cursor = index;
        }
        expect(html).toContain('role="group" aria-label="Editor tool picker"');
        expect(html).toContain("<span>Tool</span>");
    });

    it("dispatches the selected tool through the picker callback", () => {
        const dispatch = vi.fn();
        const picker = EditorToolPicker({ activeTool: "layout", onSelect: (tool) => dispatch({ type: "SET_TOOL", tool }) });
        const label = Children.toArray(picker.props.children)[1];
        expect(isValidElement(label)).toBe(true);
        const select = Children.toArray((label as ReactElement<{ children: ReactNode }>).props.children)[1];
        expect(isValidElement(select)).toBe(true);

        (select as ReactElement<{ onChange: (event: { currentTarget: { value: string } }) => void }>).props.onChange({ currentTarget: { value: "zoom" } });

        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith({ type: "SET_TOOL", tool: "zoom" });
    });
});
