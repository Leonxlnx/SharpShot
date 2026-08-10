import type { AppRoute, CaptureItem, Workflow } from "../types";
import { Icon, type IconName } from "../components/Icon";
import { MediaThumbnail } from "../components/MediaThumbnail";

type LaunchMode = "screenshot" | "quick" | "studio";

const CAPTURE_MODES: ReadonlyArray<{
    id: LaunchMode;
    title: string;
    icon: IconName;
}> = [
    { id: "screenshot", title: "Screenshot", icon: "capture" },
    { id: "quick", title: "Quick video", icon: "video" },
    { id: "studio", title: "Studio video", icon: "edit" },
];

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
    const launch = (mode: LaunchMode) => {
        const target = modeLaunches[mode];
        if (target.kind === "run") onRunWorkflow(target.workflow);
        else if (target.kind === "edit") onEditWorkflow(target.workflow);
        else onNavigate("workflows");
    };

    return (
        <div className="page home-page">
            <header className="home-header">
                <h1>Capture</h1>
            </header>

            <section className="capture-actions" aria-label="Capture actions">
                {CAPTURE_MODES.map((captureMode) => {
                    const target = modeLaunches[captureMode.id];
                    const workflow = target.kind === "configure" ? undefined : target.workflow;
                    const runnable = target.kind === "run";
                    const shortcut = workflow?.shortcuts[0] ?? [];
                    const shortcutLabel = shortcut.length > 0 ? shortcut.join(" + ") : target.kind === "run" ? "No shortcut" : "Configure";
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
                            </span>
                            <span className="capture-action__meta">
                                <span aria-label={shortcut.length > 0 ? shortcut.join(" plus ") : shortcutLabel} className="capture-action__shortcut">{shortcutLabel}</span>
                            </span>
                        </button>
                    );
                })}
            </section>

            <section className="home-section home-section--recent" aria-labelledby="home-recent-heading">
                <div className="home-section-heading">
                    <h2 id="home-recent-heading">Recent</h2>
                    <button className="text-button" onClick={() => onNavigate("library")} type="button">View all <Icon name="chevronRight" size={14} /></button>
                </div>
                <div className="home-recent-grid">
                    {captures.length === 0 ? (
                        <div className="home-empty">
                            <span className="home-empty__icon"><Icon name="capture" size={21} /></span>
                            <strong>No captures yet</strong>
                        </div>
                    ) : captures.slice(0, 3).map((capture) => (
                        <button className="home-recent" key={capture.id} onClick={capture.kind === "video" ? () => onOpenEditor(capture.id) : () => onNavigate("library")} type="button">
                            <span className="home-recent__visual"><MediaThumbnail capture={capture} />{capture.duration ? <em>{capture.duration}</em> : null}</span>
                            <span className="home-recent__copy"><strong title={capture.name}>{capture.kind === "screenshot" ? "Screenshot" : capture.name}</strong><small>{capture.createdLabel}</small></span>
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}
