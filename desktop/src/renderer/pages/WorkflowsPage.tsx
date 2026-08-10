import { useEffect, useRef, useState } from "react";
import type { AfterAction, Workflow } from "../types";
import { Icon } from "../components/Icon";
import { FieldRow, IconButton, KeyChord, Segmented, Switch } from "../components/ui";
import { focusTabAt, nextTabIndex } from "../tablist-navigation";

const AFTER_ACTIONS: AfterAction[] = ["Save to Library", "Copy", "Open Editor"];

function chordFromKeyboardEvent(event: KeyboardEvent): string[] {
    const chord: string[] = [];
    if (event.metaKey) chord.push("Win");
    if (event.ctrlKey) chord.push("Ctrl");
    if (event.altKey) chord.push("Alt");
    if (event.shiftKey) chord.push("Shift");
    const modifiers = new Set(["Meta", "Control", "Alt", "Shift"]);
    if (!modifiers.has(event.key)) chord.push(event.key.length === 1 ? event.key.toUpperCase() : event.key.replace("Arrow", ""));
    return chord;
}

function ShortcutRecorder({ onAdd }: { onAdd: (chord: string[]) => void }) {
    const [recording, setRecording] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!recording) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
                setRecording(false);
                return;
            }
            const chord = chordFromKeyboardEvent(event);
            if (chord.length >= 2 && !["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
                onAdd(chord);
                setRecording(false);
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (!buttonRef.current?.contains(event.target as Node)) setRecording(false);
        };
        const onWindowBlur = () => setRecording(false);
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("blur", onWindowBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("blur", onWindowBlur);
        };
    }, [onAdd, recording]);

    return (
        <button
            aria-pressed={recording}
            className={`shortcut-recorder${recording ? " is-recording" : ""}`}
            onBlur={() => setRecording(false)}
            onClick={() => setRecording((current) => !current)}
            ref={buttonRef}
            type="button"
        >
            <Icon name={recording ? "record" : "plus"} size={16} />
            <span aria-live="polite">{recording ? "Press the new shortcut · Esc cancels" : "Add another shortcut"}</span>
        </button>
    );
}

function actionDetail(action: AfterAction): string {
    if (action === "Save to Library") return "Keep the local original";
    if (action === "Copy") return "Ready to paste immediately";
    if (action === "Open Editor") return "Continue with the full project";
    return "Continue with the full project";
}

export function WorkflowsPage({
    workflows,
    selectedId,
    onSelect,
    onUpdate,
    onDuplicate,
    onCreate,
    onDelete,
    quickVideoAudioMux,
}: {
    workflows: Workflow[];
    selectedId: string;
    onSelect: (id: string) => void;
    onUpdate: (workflow: Workflow) => void;
    onDuplicate: (id: string) => void;
    onCreate: (kind: "screenshot" | "video") => void;
    onDelete: (id: string) => void;
    quickVideoAudioMux: boolean;
}) {
    const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0];
    if (!selected) return null;
    const afterActions = selected.kind === "screenshot" ? AFTER_ACTIONS.slice(0, 2) : AFTER_ACTIONS;

    const update = (change: Partial<Workflow>) => onUpdate({ ...selected, ...change });
    const toggleAfter = (action: AfterAction) => {
        if (action === "Save to Library" || (action === "Open Editor" && selected.kind === "screenshot")) return;
        let after = selected.after.includes(action)
            ? selected.after.filter((item) => item !== action)
            : AFTER_ACTIONS.filter((item) => item === action || selected.after.includes(item));
        if (action === "Open Editor" && !selected.after.includes(action) && (selected.systemAudio || selected.microphone)) {
            after = after.filter((item) => item !== "Copy");
        }
        update({ after });
    };

    return (
        <div className="page workflows-page workflows-page--recipes">
            <header className="page-header page-header--workflows">
                <div>
                    <h1>Workflows</h1>
                    <p>Set what each shortcut captures and what happens when it finishes.</p>
                </div>
                <div className="workflow-create-actions">
                    <button className="button button--secondary" onClick={() => onCreate("screenshot")} type="button"><Icon name="capture" size={17} /> Screenshot</button>
                    <button className="button button--primary" onClick={() => onCreate("video")} type="button"><Icon name="plus" size={17} /> Video workflow</button>
                </div>
            </header>

            <div className="workflow-gallery" role="tablist" aria-label="Workflows">
                {workflows.map((workflow, index) => (
                    <button
                        aria-selected={workflow.id === selected.id}
                        className={workflow.id === selected.id ? "is-active" : ""}
                        key={workflow.id}
                        onClick={() => onSelect(workflow.id)}
                        onKeyDown={(event) => { const next = nextTabIndex(event.key, index, workflows.length); if (next === null) return; event.preventDefault(); onSelect(workflows[next]!.id); focusTabAt(event.currentTarget.parentElement!, next); }}
                        role="tab"
                        tabIndex={workflow.id === selected.id ? 0 : -1}
                        type="button"
                    >
                        <span><Icon name={workflow.kind === "video" ? "video" : "capture"} size={18} /></span>
                        <strong>{workflow.name}</strong>
                        <small>{workflow.shortcuts[0]?.join(" + ") ?? "Launch from Home"}</small>
                        {!workflow.enabled ? <em>Off</em> : null}
                    </button>
                ))}
            </div>

            <main className={`recipe-editor recipe-editor--${selected.kind}`}>
                <header className="recipe-editor__header">
                    <div className="recipe-title-inputs">
                        <input aria-label="Workflow name" className="recipe-name-input" onChange={(event) => update({ name: event.currentTarget.value })} value={selected.name} />
                        <p className="recipe-description-input">{selected.description}</p>
                    </div>
                    <label className="recipe-enabled"><span>{selected.enabled ? "Enabled" : "Paused"}</span><Switch checked={selected.enabled} label="Enable workflow" onChange={(enabled) => update({ enabled })} /></label>
                </header>

                <section className="recipe-core" aria-label="Workflow essentials">
                    <div className="recipe-block recipe-block--when">
                        <h2>Shortcuts</h2>
                        <p>Add one or more global shortcuts for this workflow.</p>
                        <div className="shortcut-stack">
                            {selected.shortcuts.map((shortcut, index) => (
                                <div className="shortcut-entry" key={`${shortcut.join("-")}-${index}`}>
                                    <span><KeyChord keys={shortcut} /><small>{index === 0 ? "Primary" : `Alternative ${index}`}</small></span>
                                    <IconButton icon="close" label={`Remove ${shortcut.join(" plus ")}`} onClick={() => update({ shortcuts: selected.shortcuts.filter((_, itemIndex) => itemIndex !== index) })} />
                                </div>
                            ))}
                            <ShortcutRecorder onAdd={(chord) => update({ shortcuts: [...selected.shortcuts, chord] })} />
                        </div>
                    </div>

                    <div className="recipe-block recipe-block--then">
                        <h2>After capture</h2>
                        <p>Choose what happens when the capture finishes.</p>
                        <div className="after-action-list">
                            {afterActions.map((action) => {
                                const active = selected.after.includes(action);
                                const hasAudioStems = selected.kind === "video" && (selected.systemAudio || selected.microphone);
                                const blockedByAudio = action === "Copy" && hasAudioStems && (!quickVideoAudioMux || selected.after.includes("Open Editor"));
                                const required = action === "Save to Library";
                                return (
                                    <button aria-pressed={active} className={`${active ? "is-active" : ""}${required ? " is-required" : ""}`} disabled={blockedByAudio || required} key={action} onClick={() => toggleAfter(action)} title={required ? "Originals are always saved locally." : blockedByAudio ? "Audio is saved as separate stems, so a complete video cannot be copied yet." : undefined} type="button">
                                        <span className="after-action-check">{active ? <Icon name="check" size={14} /> : null}</span>
                                        <span><strong>{required ? "Save locally" : action}</strong><small>{required ? "Required · keeps the original on this device" : blockedByAudio ? "Studio keeps separate stems; Quick Copy only" : action === "Copy" && hasAudioStems ? "Merge audio locally, then copy the video" : actionDetail(action)}</small></span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>

                <div className="recipe-disclosures">
                    <details open>
                        <summary><span><Icon name="capture" size={17} /><span><strong>Capture quality</strong><small>{selected.target} · {selected.kind === "video" ? `${selected.fps ?? 60} fps · ${selected.quality}` : "Lossless PNG"}</small></span></span><Icon name="chevronRight" size={16} /></summary>
                        <div className="recipe-fields">
                            <FieldRow label="Capture area" detail="Window and display capture are coming later"><span><strong>Region</strong></span></FieldRow>
                            {selected.kind === "video" ? <FieldRow label="Frame rate" detail="60 fps is ideal for motion-heavy product demos"><Segmented<"30" | "60"> label="Frame rate" onChange={(fps) => update({ fps: Number(fps) as 30 | 60 })} options={["30", "60"]} value={String(selected.fps ?? 60) as "30" | "60"} /></FieldRow> : null}
                            {selected.kind === "video" ? <FieldRow label="Encoding quality" detail="Maximum uses the highest practical H.264 bitrate"><select aria-label="Recording quality" onChange={(event) => update({ quality: event.currentTarget.value as Workflow["quality"] })} value={selected.quality}><option>Balanced</option><option>High</option><option>Maximum</option></select></FieldRow> : null}
                            {selected.kind === "video" ? <FieldRow label="Show cursor" detail="Include the pointer directly in the recording"><Switch checked={selected.cursor} label="Show cursor" onChange={(cursor) => update({ cursor })} /></FieldRow> : null}
                        </div>
                    </details>

                    {selected.kind === "video" ? (
                        <details>
                            <summary><span><Icon name="microphone" size={17} /><span><strong>Audio & countdown</strong><small>{selected.systemAudio ? "System audio" : "No system audio"} · {selected.microphone ? "Microphone" : "No microphone"} · {selected.countdown ? `${selected.countdown}s` : "No countdown"}</small></span></span><Icon name="chevronRight" size={16} /></summary>
                            <div className="recipe-fields">
                                <FieldRow label="System audio" detail={quickVideoAudioMux ? "Quick Copy merges this locally; Studio preserves the separate stem" : "Save sound as a separate local stem"}><Switch checked={selected.systemAudio} label="Capture system audio" onChange={(systemAudio) => update({ systemAudio, after: systemAudio && (!quickVideoAudioMux || selected.after.includes("Open Editor")) ? selected.after.filter((action) => action !== "Copy") : selected.after })} /></FieldRow>
                                <FieldRow label="Microphone" detail={quickVideoAudioMux ? "Quick Copy merges this locally; Studio preserves the separate stem" : "Save voice as a separate local stem"}><Switch checked={selected.microphone} label="Capture microphone" onChange={(microphone) => update({ microphone, after: microphone && (!quickVideoAudioMux || selected.after.includes("Open Editor")) ? selected.after.filter((action) => action !== "Copy") : selected.after })} /></FieldRow>
                                <FieldRow label="Countdown" detail="Start immediately or after a three-second pause"><Segmented<"Off" | "3s"> label="Countdown" onChange={(value) => update({ countdown: value === "Off" ? 0 : 3 })} options={["Off", "3s"]} value={selected.countdown === 0 ? "Off" : "3s"} /></FieldRow>
                            </div>
                        </details>
                    ) : null}
                </div>

                <footer className="recipe-editor__footer">
                    <button className="button button--ghost button--danger" disabled={workflows.length <= 1} onClick={() => onDelete(selected.id)} type="button"><Icon name="trash" size={16} /> Delete</button>
                    <button className="button button--secondary" onClick={() => onDuplicate(selected.id)} type="button"><Icon name="duplicate" size={16} /> Duplicate</button>
                </footer>
            </main>
        </div>
    );
}
