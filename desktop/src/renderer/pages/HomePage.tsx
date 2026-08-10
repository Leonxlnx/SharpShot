import type { AppRoute, CaptureItem, Workflow } from "../types";
import { Icon, type IconName } from "../components/Icon";
import { KeyChord } from "../components/ui";
import { MediaThumbnail } from "../components/MediaThumbnail";
import {
    QUICK_SCREENSHOT_WORKFLOW_ID,
    QUICK_VIDEO_WORKFLOW_ID,
    VIDEO_STUDIO_WORKFLOW_ID,
} from "../../shared/workflows";

type LaunchMode = "screenshot" | "quick" | "studio";

const CAPTURE_MODES: ReadonlyArray<{
    id: LaunchMode;
    title: string;
    detail: string;
    icon: IconName;
}> = [
    { id: "screenshot", title: "Screenshot", detail: "Save a lossless PNG and copy it", icon: "capture" },
    { id: "quick", title: "Quick video", detail: "Record, save, and copy the file", icon: "video" },
    { id: "studio", title: "Studio video", detail: "Record and open the editor", icon: "edit" },
];

const DEFAULT_WORKFLOW_IDS = new Set([
    QUICK_SCREENSHOT_WORKFLOW_ID,
    QUICK_VIDEO_WORKFLOW_ID,
    VIDEO_STUDIO_WORKFLOW_ID,
]);

export function workflowMatchesLaunchMode(workflow: Workflow, mode: LaunchMode): boolean {
    if (mode === "screenshot") return workflow.kind === "screenshot";
    if (mode === "quick") return workflow.kind === "video" && !workflow.after.includes("Open Editor");
    return workflow.kind === "video" && workflow.after.includes("Open Editor");
}

export type CaptureLaunch =
    | { kind: "run" | "edit"; workflow: Workflow }
    | { kind: "configure" };

export function resolveCaptureLaunch(workflows: readonly Workflow[], mode: LaunchMode): CaptureLaunch {
    const workflow = workflows.find((item) => item.enabled && workflowMatchesLaunchMode(item, mode))
        ?? workflows.find((item) => workflowMatchesLaunchMode(item, mode));
    if (!workflow) return { kind: "configure" };
    return { kind: workflow.enabled ? "run" : "edit", workflow };
}

export function HomePage({
    workflows,
    captures,
    onRunWorkflow,
    onEditWorkflow,
    onNavigate,
    onOpenEditor,
}: {
    workflows: Workflow[];
    captures: CaptureItem[];
    onRunWorkflow: (workflow: Workflow) => void;
    onEditWorkflow: (workflow: Workflow) => void;
    onNavigate: (route: AppRoute) => void;
    onOpenEditor: (mediaId?: string) => void;
}) {
    const modeLaunches: Record<LaunchMode, CaptureLaunch> = {
        screenshot: resolveCaptureLaunch(workflows, "screenshot"),
        quick: resolveCaptureLaunch(workflows, "quick"),
        studio: resolveCaptureLaunch(workflows, "studio"),
    };
    const customWorkflows = workflows.filter((workflow) => !DEFAULT_WORKFLOW_IDS.has(workflow.id));

    const launch = (mode: LaunchMode) => {
        const target = modeLaunches[mode];
        if (target.kind === "run") onRunWorkflow(target.workflow);
        else if (target.kind === "edit") onEditWorkflow(target.workflow);
        else onNavigate("workflows");
    };

    return (
        <div className="page home-page">
            <header className="home-header">
                <div>
                    <h1>Capture</h1>
                    <p>Choose a capture action or use one of your global shortcuts.</p>
                </div>
                <button className="button button--secondary" onClick={() => onNavigate("workflows")} type="button">
                    <Icon name="workflow" size={17} /> Manage workflows
                </button>
            </header>

            <section className="capture-actions" aria-label="Capture actions">
                {CAPTURE_MODES.map((captureMode) => {
                    const target = modeLaunches[captureMode.id];
                    const workflow = target.kind === "configure" ? undefined : target.workflow;
                    const runnable = target.kind === "run";
                    const output = target.kind === "run"
                        ? `${target.workflow.target} · ${target.workflow.after.join(" + ")}`
                        : target.kind === "edit" ? "Disabled · Configure workflow" : "Configure workflow";
                    return (
                        <button
                            aria-label={`${runnable ? "Start" : "Configure"} ${captureMode.title.toLowerCase()}`}
                            className={`capture-action capture-action--${captureMode.id}`}
                            key={captureMode.id}
                            onClick={() => launch(captureMode.id)}
                            type="button"
                        >
                            <span className="capture-action__icon" aria-hidden="true"><Icon name={captureMode.icon} size={20} /></span>
                            <span className="capture-action__copy">
                                <strong>{captureMode.title}</strong>
                                <small>{captureMode.detail}</small>
                            </span>
                            <span className="capture-action__meta">
                                <KeyChord keys={workflow?.shortcuts[0] ?? []} compact />
                                <small>{output}</small>
                            </span>
                            <Icon className="capture-action__arrow" name="chevronRight" size={16} />
                        </button>
                    );
                })}
            </section>

            {customWorkflows.length > 0 ? (
                <section className="home-section home-section--shortcuts" aria-labelledby="home-shortcuts-heading">
                    <div className="home-section-heading">
                        <h2 id="home-shortcuts-heading">Custom workflows</h2>
                        <button className="text-button" onClick={() => onNavigate("workflows")} type="button">Manage <Icon name="chevronRight" size={14} /></button>
                    </div>
                    <div className="home-shortcut-grid">
                        {customWorkflows.slice(0, 3).map((workflow) => (
                        <article key={workflow.id} className={`home-shortcut${workflow.enabled ? "" : " is-disabled"}`}>
                            <button aria-label={`${workflow.enabled ? "Run" : "Configure"} ${workflow.name}`} className="home-shortcut__run" onClick={() => workflow.enabled ? onRunWorkflow(workflow) : onEditWorkflow(workflow)} type="button">
                                <span className="home-shortcut__icon"><Icon name={workflow.kind === "video" ? "video" : "capture"} size={18} /></span>
                                <span className="home-shortcut__copy">
                                    <strong>{workflow.name}</strong>
                                    <small>{workflow.target} {workflow.kind} · {workflow.after.join(" + ")}</small>
                                </span>
                                <KeyChord keys={workflow.shortcuts[0] ?? []} compact />
                            </button>
                            <button className="home-shortcut__edit" aria-label={`Edit ${workflow.name}`} onClick={() => onEditWorkflow(workflow)} type="button"><Icon name="edit" size={15} /></button>
                        </article>
                        ))}
                    </div>
                </section>
            ) : null}

            <section className="home-section home-section--recent" aria-labelledby="home-recent-heading">
                <div className="home-section-heading">
                    <h2 id="home-recent-heading">Recent captures</h2>
                    <button className="text-button" onClick={() => onNavigate("library")} type="button">Open library <Icon name="chevronRight" size={14} /></button>
                </div>
                <div className="home-recent-grid">
                    {captures.length === 0 ? (
                        <div className="home-empty">
                            <span className="home-empty__icon"><Icon name="capture" size={21} /></span>
                            <strong>No captures yet</strong>
                            <span>Your first local screenshot or recording will appear here.</span>
                        </div>
                    ) : captures.slice(0, 3).map((capture) => (
                        <button className="home-recent" key={capture.id} onClick={capture.kind === "video" ? () => onOpenEditor(capture.id) : () => onNavigate("library")} type="button">
                            <span className="home-recent__visual"><MediaThumbnail capture={capture} />{capture.duration ? <em>{capture.duration}</em> : null}</span>
                            <span className="home-recent__copy"><strong>{capture.name}</strong><small>{capture.createdLabel} · {capture.dimensions}</small></span>
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}
