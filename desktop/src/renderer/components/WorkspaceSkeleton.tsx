import "../styles/workspace-skeleton.css";
import { WindowControls } from "./TitleBar";

export type WorkspaceSkeletonProps = {
    variant: "shell" | "editor";
    label?: string;
    error?: boolean;
    onRequestWindowClose?: () => void;
};

function Bone({ className = "" }: { className?: string }) {
    return <span aria-hidden="true" className={`workspace-skeleton__bone ${className}`} />;
}

export function WorkspaceSkeleton({ variant, label, error = false, onRequestWindowClose }: WorkspaceSkeletonProps) {
    const status = label ?? (variant === "editor" ? "Preparing your recording…" : "Starting SharpShot…");

    return (
        <section
            aria-busy={error ? "false" : "true"}
            aria-label={status}
            className={`workspace-skeleton workspace-skeleton--${variant}${error ? " workspace-skeleton--error" : ""}`}
            role="status"
        >
            <span className="workspace-skeleton__status">{status}</span>
            {variant === "editor" ? <EditorSkeleton onRequestWindowClose={onRequestWindowClose} /> : <ShellSkeleton />}
            {error ? <div className="workspace-skeleton__error" role="alert"><strong>SharpShot could not initialize.</strong><span>Restart the desktop app. Your local captures and projects were not changed.</span></div> : null}
        </section>
    );
}

function EditorSkeleton({ onRequestWindowClose }: { onRequestWindowClose?: () => void }) {
    return (
        <>
            <header className="workspace-skeleton__commandbar">
                <div className="workspace-skeleton__command-group">
                    <Bone className="workspace-skeleton__icon" />
                    <Bone className="workspace-skeleton__project" />
                </div>
                <div className="workspace-skeleton__command-group workspace-skeleton__command-group--end">
                    <Bone className="workspace-skeleton__icon" />
                    <Bone className="workspace-skeleton__icon" />
                    <Bone className="workspace-skeleton__export" />
                    <WindowControls onRequestClose={onRequestWindowClose} />
                </div>
            </header>

            <div aria-hidden="true" className="workspace-skeleton__workspace">
                <main className="workspace-skeleton__main">
                    <section className="workspace-skeleton__stage">
                        <div className="workspace-skeleton__stage-toolbar">
                            <Bone className="workspace-skeleton__control workspace-skeleton__control--wide" />
                            <Bone className="workspace-skeleton__control" />
                        </div>
                        <Bone className="workspace-skeleton__canvas" />
                        <div className="workspace-skeleton__stage-footer">
                            <Bone className="workspace-skeleton__line workspace-skeleton__line--short" />
                            <Bone className="workspace-skeleton__line" />
                        </div>
                    </section>
                </main>

                <aside className="workspace-skeleton__inspector">
                    <div className="workspace-skeleton__inspector-picker">
                        <Bone className="workspace-skeleton__picker-icon" />
                        <Bone className="workspace-skeleton__picker-label" />
                        <Bone className="workspace-skeleton__picker-field" />
                    </div>
                    <div className="workspace-skeleton__inspector-content">
                        <Bone className="workspace-skeleton__heading" />
                        <div className="workspace-skeleton__option-grid">
                            {Array.from({ length: 6 }, (_, index) => <Bone className="workspace-skeleton__option" key={index} />)}
                        </div>
                        <Bone className="workspace-skeleton__heading workspace-skeleton__heading--small" />
                        <Bone className="workspace-skeleton__inspector-preview" />
                        <Bone className="workspace-skeleton__line" />
                    </div>
                </aside>

                <section className="workspace-skeleton__timeline">
                    <div className="workspace-skeleton__timeline-toolbar">
                        <Bone className="workspace-skeleton__icon" />
                        <Bone className="workspace-skeleton__line workspace-skeleton__line--short" />
                        <Bone className="workspace-skeleton__line workspace-skeleton__line--short" />
                    </div>
                    <div className="workspace-skeleton__timeline-body">
                        <div className="workspace-skeleton__track-labels">
                            <Bone className="workspace-skeleton__track-label" />
                            <Bone className="workspace-skeleton__track-label" />
                        </div>
                        <div className="workspace-skeleton__tracks">
                            <Bone className="workspace-skeleton__ruler" />
                            <Bone className="workspace-skeleton__track workspace-skeleton__track--primary" />
                            <Bone className="workspace-skeleton__track" />
                        </div>
                    </div>
                </section>
            </div>
        </>
    );
}

function ShellSkeleton() {
    return (
        <div aria-hidden="true" className="workspace-skeleton__shell-page">
            <header className="workspace-skeleton__shell-header">
                <Bone className="workspace-skeleton__shell-title" />
            </header>
            <div className="workspace-skeleton__shell-actions">
                {Array.from({ length: 3 }, (_, index) => (
                    <div className={`workspace-skeleton__shell-card${index === 0 ? " workspace-skeleton__shell-card--primary" : ""}`} key={index}>
                        <Bone className="workspace-skeleton__shell-card-icon" />
                        <Bone className="workspace-skeleton__heading" />
                        <Bone className="workspace-skeleton__shell-shortcut" />
                    </div>
                ))}
            </div>
            <Bone className="workspace-skeleton__heading workspace-skeleton__heading--small" />
            <div className="workspace-skeleton__shell-recents">
                {Array.from({ length: 3 }, (_, index) => (
                    <div className="workspace-skeleton__shell-recent" key={index}>
                        <Bone className="workspace-skeleton__shell-thumbnail" />
                        <Bone className="workspace-skeleton__line" />
                    </div>
                ))}
            </div>
        </div>
    );
}
