import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorInspector } from "../components/EditorInspector";
import { EditorPreview } from "../components/EditorPreview";
import { AudioPreview } from "../components/AudioPreview";
import { EditorToolPicker } from "../components/EditorToolPicker";
import { ExportSheet } from "../components/ExportSheet";
import { Icon } from "../components/Icon";
import { Timeline } from "../components/Timeline";
import { handleTitlebarDoubleClick, WindowControls } from "../components/TitleBar";
import { formatTime, projectDuration, type EditorAction } from "../state";
import type { ScreenTransformPatch } from "../screen-manipulation";
import type { EditorState } from "../types";
import type { BundledAudioTrack, MediaItem } from "../../shared/api";
import { playbackDeltaForFrame } from "../playback-clock";
import { setSafeRedactionArea } from "../safe-redaction";

export function EditorPage({
    state,
    dispatch,
    onClose,
    onRequestWindowClose,
    onNotify,
    media,
    projectId,
    onPrepareExport,
    sourceHasAudio,
    statusDetail,
    audioCatalog,
    libraryAudio,
    libraryImages,
    mutationsLocked,
    onLibraryAudioImported,
    onLibraryImagesImported,
}: {
    state: EditorState;
    dispatch: (action: EditorAction) => boolean;
    onClose: () => void;
    onRequestWindowClose: () => void;
    onNotify: (title: string, detail: string) => void;
    media: MediaItem | null;
    projectId: string | null;
    onPrepareExport: () => Promise<boolean>;
    sourceHasAudio: boolean;
    statusDetail?: string;
    audioCatalog: readonly BundledAudioTrack[];
    libraryAudio: readonly MediaItem[];
    libraryImages: readonly MediaItem[];
    mutationsLocked: boolean;
    onLibraryAudioImported: (items: MediaItem[]) => void;
    onLibraryImagesImported: (items: MediaItem[]) => void;
}) {
    const lastFrame = useRef<number | null>(null);
    const duration = useMemo(() => projectDuration(state.project), [state.project]);
    useEffect(() => {
        if (!state.playing) {
            lastFrame.current = null;
            return undefined;
        }
        let frame = 0;
        const tick = (now: number) => {
            const delta = playbackDeltaForFrame(lastFrame.current, now);
            if (lastFrame.current === null || delta !== null) lastFrame.current = now;
            if (delta !== null) dispatch({ type: "TICK", delta });
            frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(frame);
    }, [dispatch, state.playing]);

    const handleExportComplete = useCallback((fileName: string, warnings: string[]) => {
        dispatch({ type: "CLOSE_EXPORT" });
        onNotify("Export complete", warnings.length > 0 ? `${fileName} finished · ${warnings.join(" · ")}` : `${fileName} was added to your local library.`);
    }, [dispatch, onNotify]);

    const handleExportError = useCallback((detail: string) => {
        onNotify("Export failed", detail);
    }, [onNotify]);

    const handleTransformCommit = useCallback((patch: ScreenTransformPatch) => {
        dispatch({ type: "SET_SCREEN_TRANSFORM", patch });
    }, [dispatch]);

    const handleZoomFocusCommit = useCallback((focus: { x: number; y: number }) => {
        if (state.selectedZoomId === null) return;
        dispatch({
            type: "EDIT_ZOOM",
            operation: { type: "zoom.update", id: state.selectedZoomId, changes: { focus } },
        });
    }, [dispatch, state.selectedZoomId]);

    const handleOverlayAreaCommit = useCallback((id: string, area: { x: number; y: number; width: number; height: number }) => {
        dispatch({
            type: "EDIT_OVERLAYS",
            document: setSafeRedactionArea(state.project.overlays, id, area),
            selectedOverlayId: id,
        });
    }, [dispatch, state.project.overlays]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;
            const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            const deleteSelectionTarget = unmodified
                && (event.key === "Delete" || event.key === "Backspace")
                && isTimelineSelectionShortcutTarget(target);
            const splitAudioTarget = unmodified
                && event.key.toLowerCase() === "s"
                && isAudioSelectionShortcutTarget(target);
            if (state.exportOpen || event.defaultPrevented || event.isComposing || event.repeat || (isInteractiveShortcutTarget(target) && !deleteSelectionTarget && !splitAudioTarget)) return;
            if (event.code === "Space" && unmodified) {
                event.preventDefault();
                dispatch({ type: "SET_PLAYING", playing: !state.playing });
            } else if (event.key.toLowerCase() === "s" && unmodified) {
                event.preventDefault();
                dispatch({ type: "SPLIT" });
            } else if ((event.key === "Delete" || event.key === "Backspace") && unmodified) {
                event.preventDefault();
                if (state.activeTool === "zoom" && state.selectedZoomId !== null) {
                    dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.delete", id: state.selectedZoomId } });
                } else if (state.activeTool === "captions" && state.selectedCaptionId !== null) {
                    dispatch({
                        type: "EDIT_OVERLAYS",
                        document: {
                            ...state.project.overlays,
                            captions: state.project.overlays.captions.filter((cue) => cue.id !== state.selectedCaptionId),
                        },
                        selectedCaptionId: null,
                    });
                } else {
                    dispatch({ type: "REMOVE_SELECTED" });
                }
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
                event.preventDefault();
                dispatch({ type: event.shiftKey ? "REDO" : "UNDO" });
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
                event.preventDefault();
                dispatch({ type: "REDO" });
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [dispatch, state.activeTool, state.exportOpen, state.playing, state.project.overlays, state.selectedCaptionId, state.selectedOverlayId, state.selectedZoomId]);

    return (
        <div className="editor-page">
            <header className="editor-commandbar" onDoubleClick={handleTitlebarDoubleClick}>
                <div className="editor-commandbar__left">
                    <button className="editor-back" onClick={onClose} type="button"><Icon name="back" size={17} /><span>Library</span></button>
                    <span className="commandbar-divider" />
                    <div className="project-name"><strong>{state.project.name}</strong><span><i /> {statusDetail ?? "Saved locally"}</span></div>
                </div>
                <div className="editor-commandbar__center">
                    <button aria-label={state.playing ? "Pause preview" : "Play preview"} onClick={() => dispatch({ type: "SET_PLAYING", playing: !state.playing })} type="button"><Icon name={state.playing ? "pause" : "play"} size={14} /></button>
                    <span><strong>{formatTime(state.playhead, true)}</strong><small>/ {formatTime(duration, true)}</small></span>
                </div>
                <div className="editor-commandbar__right">
                    <button aria-label="Undo" disabled={state.history.length === 0} onClick={() => dispatch({ type: "UNDO" })} title="Undo (Ctrl+Z)" type="button"><Icon name="undo" size={17} /></button>
                    <button aria-label="Redo" disabled={state.future.length === 0} onClick={() => dispatch({ type: "REDO" })} title="Redo (Ctrl+Y)" type="button"><Icon name="redo" size={17} /></button>
                    <button className="button button--primary export-button" disabled={projectId === null} onClick={() => { void onPrepareExport().then((ready) => { if (ready) dispatch({ type: "OPEN_EXPORT" }); }); }} type="button"><Icon name="export" size={15} /> Export</button>
                    <WindowControls onRequestClose={onRequestWindowClose} />
                </div>
            </header>

            <div className="editor-workspace">
                <main className="editor-main">
                    <EditorPreview
                        cropMode={state.activeTool === "crop"}
                        media={media}
                        onCropApply={() => dispatch({ type: "SET_TOOL", tool: "layout" })}
                        onCropCancel={() => dispatch({ type: "SET_TOOL", tool: "layout" })}
                        onOverlayAreaCommit={handleOverlayAreaCommit}
                        onOverlaySelect={(id) => dispatch({ type: "SELECT_OVERLAY", id })}
                        onTransformCommit={handleTransformCommit}
                        onZoomFocusCommit={handleZoomFocusCommit}
                        state={state}
                    />
                    <AudioPreview audio={state.project.audio} audioCatalog={audioCatalog} libraryAudio={libraryAudio} playheadSeconds={state.playhead} playing={state.playing} />
                </main>
                <div className="editor-inspector-panel">
                    <EditorToolPicker activeTool={state.activeTool} onSelect={(tool) => dispatch({ type: "SET_TOOL", tool })} />
                    <EditorInspector
                        audioCatalog={audioCatalog}
                        dispatch={dispatch}
                        libraryAudio={libraryAudio}
                        libraryImages={libraryImages}
                        onLibraryAudioImported={onLibraryAudioImported}
                        onLibraryImagesImported={onLibraryImagesImported}
                        onNotify={onNotify}
                        onPrepareAutoZoom={onPrepareExport}
                        media={media}
                        mutationsLocked={mutationsLocked}
                        projectId={projectId}
                        state={state}
                        sourceHasAudio={sourceHasAudio}
                    />
                </div>
                <Timeline dispatch={dispatch} sourceHasAudio={sourceHasAudio} state={state} />
            </div>

            {state.exportOpen && projectId !== null ? (
                <ExportSheet
                    onClose={() => dispatch({ type: "CLOSE_EXPORT" })}
                    onComplete={handleExportComplete}
                    onError={handleExportError}
                    onPrepareExport={onPrepareExport}
                    project={state.project}
                    projectId={projectId}
                    sourceHasAudio={sourceHasAudio}
                />
            ) : null}
        </div>
    );
}

function isTimelineSelectionShortcutTarget(target: EventTarget | null): boolean {
    return target instanceof Element
        && target.closest(".caption-list__select, .redact-list__select, .timeline-caption-cue, .timeline-zoom-segment__select, .timeline-audio-clip__select, .timeline-redaction-cue") !== null;
}

function isAudioSelectionShortcutTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(".timeline-audio-clip__select") !== null;
}

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLElement && target.isContentEditable) return true;
    return target.closest([
        "a[href]",
        "audio[controls]",
        "button",
        "details",
        "embed",
        "iframe",
        "img[usemap]",
        "input",
        "label",
        "select",
        "summary",
        "textarea",
        "video[controls]",
        "[contenteditable]:not([contenteditable='false'])",
        "[role='button']",
        "[role='checkbox']",
        "[role='combobox']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='radio']",
        "[role='slider']",
        "[role='spinbutton']",
        "[role='switch']",
        "[role='tab']",
        "[role='textbox']",
        "[tabindex]:not([tabindex='-1'])",
    ].join(",")) !== null;
}
