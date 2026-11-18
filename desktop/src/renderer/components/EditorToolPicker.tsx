import type { EditorState } from "../types";
import { Icon, type IconName } from "./Icon";

export const EDITOR_TOOLS: ReadonlyArray<{
    id: EditorState["activeTool"];
    label: string;
    icon: IconName;
    available: boolean;
}> = [
    { id: "canvas", label: "Canvas", icon: "canvas", available: true },
    { id: "background", label: "Background", icon: "background", available: true },
    { id: "layout", label: "Layout", icon: "layout", available: true },
    { id: "crop", label: "Crop", icon: "crop", available: true },
    { id: "zoom", label: "Zoom", icon: "zoom", available: true },
    { id: "audio", label: "Audio", icon: "audio", available: true },
    { id: "captions", label: "Captions", icon: "captions", available: true },
    { id: "annotations", label: "Redact", icon: "redact", available: true },
];

export function EditorToolPicker({
    activeTool,
    onSelect,
}: {
    activeTool: EditorState["activeTool"];
    onSelect: (tool: EditorState["activeTool"]) => void;
}) {
    const active = EDITOR_TOOLS.find((tool) => tool.id === activeTool);

    return (
        <div className="editor-toolrail" role="group" aria-label="Editor tool picker">
            <Icon className="editor-toolrail__icon" name={active?.icon ?? "canvas"} size={18} />
            <label className="editor-toolpicker">
                <span>Tool</span>
                <select value={activeTool} onChange={(event) => onSelect(event.currentTarget.value as EditorState["activeTool"])}>
                    {EDITOR_TOOLS.map((tool) => <option disabled={!tool.available} key={tool.id} value={tool.id}>{tool.label}{tool.available ? "" : " · Soon"}</option>)}
                </select>
            </label>
        </div>
    );
}
