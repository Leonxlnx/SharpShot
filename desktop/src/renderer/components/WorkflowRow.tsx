import type { Workflow } from "../types";
import { Icon } from "./Icon";
import { IconButton, KeyChord } from "./ui";

function workflowSummary(workflow: Workflow): string {
    if (workflow.kind === "screenshot") {
        return `${workflow.target} · ${workflow.quality ?? "Lossless"}`;
    }
    return `${workflow.target} · ${workflow.fps ?? 60} fps · ${workflow.quality ?? "High"}`;
}

export function WorkflowRow({
    workflow,
    onRun,
    onEdit,
}: {
    workflow: Workflow;
    onRun: (workflow: Workflow) => void;
    onEdit: (workflow: Workflow) => void;
}) {
    return (
        <article className={`workflow-row${workflow.enabled ? "" : " is-disabled"}`}>
            <button className="workflow-row__main" onClick={() => onRun(workflow)} type="button">
                <span className={`workflow-icon workflow-icon--${workflow.kind}`}>
                    <Icon name={workflow.kind === "video" ? "video" : "image"} />
                </span>
                <span className="workflow-row__identity">
                    <strong>{workflow.name}</strong>
                    <small>{workflow.description}</small>
                </span>
                <span className="workflow-row__summary">
                    <span>{workflowSummary(workflow)}</span>
                    <small>→ {workflow.after.join(" + ")}</small>
                </span>
                <span className="workflow-row__shortcut">
                    <KeyChord keys={workflow.shortcuts[0] ?? []} compact />
                    {workflow.shortcuts.length > 1 ? <small>+{workflow.shortcuts.length - 1}</small> : null}
                </span>
            </button>
            <IconButton icon="edit" label={`Edit ${workflow.name}`} onClick={() => onEdit(workflow)} />
        </article>
    );
}
