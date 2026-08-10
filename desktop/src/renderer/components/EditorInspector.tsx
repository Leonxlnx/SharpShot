import { useEffect, useRef, useState } from "react";
import { CINEMATIC_WALLPAPERS, ORIGINAL_WALLPAPERS } from "../data";
import { getDesktopBridge, importLibraryImages, isDesktopBridgeAvailable, openExternalLink } from "../bridge";
import {
    APPLE_WALLPAPER_URL,
    BACKGROUND_PRESETS,
    backgroundDisplayName,
    registeredBackgroundImages,
} from "../background-gallery";
import { formatTime, projectDurationUs, type EditorAction } from "../state";
import type { BundledAudioTrack, MediaItem } from "../../shared/api";
import type { EditorState, Wallpaper } from "../types";
import type { ZoomSegment } from "../../shared/cursor-zoom";
import { availableZoomRangeAtPlayhead, resizeZoomSegmentRange } from "../zoom-timeline";
import {
    validateCaptionCue,
    type CaptionStylePresetId,
    type TimedCaptionCue,
} from "../../shared/overlays";
import {
    assertCaptionCueCapacity,
    runSubtitleImportTask,
    subtitleImportTaskIsCurrent,
    type SubtitleImportTaskIdentity,
} from "../caption-editor";
import { Icon } from "./Icon";
import { RangeField, RangeInput, Segmented, Switch } from "./ui";
import { AudioMusicInspector } from "./AudioMusicInspector";
import { MAX_EXPORTED_SAFE_REDACTIONS } from "../../shared/export-plan";
import {
    SAFE_REDACTION_COLORS,
    addSafeRedaction,
    deleteSafeRedaction,
    presetForSafeRedaction,
    safeRedactions,
    setSafeRedactionPreset,
    type SafeRedactionPreset,
} from "../safe-redaction";

const ZOOM_SCALE_PRESETS = [1, 1.5, 2, 3] as const;
const ZOOM_MOTION_PRESETS = ["Quick", "Smooth", "Gentle"] as const;
type ZoomMotionPreset = typeof ZOOM_MOTION_PRESETS[number];

function WallpaperPicker({
    selectedId,
    wallpapers,
    onSelect,
}: {
    selectedId: string;
    wallpapers: readonly Wallpaper[];
    onSelect: (id: string) => void;
}) {
    return (
        <div className="background-browser__images">
            {wallpapers.map((wallpaper) => {
                const selected = selectedId === wallpaper.id;
                return (
                    <button aria-pressed={selected} className={selected ? "is-active" : ""} key={wallpaper.id} onClick={() => onSelect(wallpaper.id)} type="button">
                        <span className="background-browser__image-frame"><img alt={`${wallpaper.name} background preview`} decoding="async" loading="lazy" src={wallpaper.thumbnailSource} /></span>
                        <strong>{wallpaper.name}</strong>
                        {selected ? <span className="background-browser__check"><Icon name="check" size={12} /></span> : null}
                    </button>
                );
            })}
        </div>
    );
}

export function EditorInspector({
    state,
    dispatch,
    onNotify,
    media,
    projectId,
    onPrepareAutoZoom,
    sourceHasAudio,
    audioCatalog,
    libraryAudio,
    libraryImages,
    mutationsLocked,
    onLibraryAudioImported,
    onLibraryImagesImported,
}: {
    state: EditorState;
    dispatch: (action: EditorAction) => boolean;
    onNotify: (title: string, detail: string) => void;
    media: MediaItem | null;
    projectId: string | null;
    onPrepareAutoZoom: () => Promise<boolean>;
    sourceHasAudio: boolean;
    audioCatalog: readonly BundledAudioTrack[];
    libraryAudio: readonly MediaItem[];
    libraryImages: readonly MediaItem[];
    mutationsLocked: boolean;
    onLibraryAudioImported: (items: MediaItem[]) => void;
    onLibraryImagesImported: (items: MediaItem[]) => void;
}) {
    const [captionStyle, setCaptionStyle] = useState<CaptionStyleOption>("Clean");
    const [captionText, setCaptionText] = useState("");
    const [captionStart, setCaptionStart] = useState("0.00");
    const [captionEnd, setCaptionEnd] = useState("3.00");
    const [autoZoomBusy, setAutoZoomBusy] = useState(false);
    const backgroundImportGeneration = useRef(0);
    const backgroundImportCurrent = useRef({
        state,
        projectId,
        mediaId: media?.id ?? null,
        mutationsLocked,
    });
    const autoZoomGeneration = useRef(0);
    const autoZoomCurrent = useRef({
        state,
        projectId,
        mediaId: media?.id ?? null,
        mutationsLocked,
    });
    const captionImportGeneration = useRef(0);
    const captionImportCurrent = useRef({
        state,
        projectId,
        mediaId: media?.id ?? null,
        mutationsLocked,
    });
    const subtitleInput = useRef<HTMLInputElement>(null);
    const lastAudibleSystemVolume = useRef(state.project.systemVolume > 0 ? state.project.systemVolume : 100);
    const canImport = isDesktopBridgeAvailable();
    const userBackgrounds = registeredBackgroundImages(libraryImages);
    const selectedClip = state.project.clips.find((clip) => clip.id === state.selectedClipId) ?? state.project.clips[0];
    const zoomSegments = state.project.zoomSegments;
    const selectedZoom = zoomSegments.find((segment) => segment.id === state.selectedZoomId);
    const selectedZoomMotion = selectedZoom === undefined ? undefined : zoomMotionPresetFor(selectedZoom);
    const overlays = state.project.overlays;
    const selectedCaption = overlays.captions.find((cue) => cue.id === state.selectedCaptionId);
    const captionListCues = captionWindow(overlays.captions, state.selectedCaptionId);
    const redactions = safeRedactions(overlays);
    const selectedRedaction = redactions.find((redaction) => redaction.id === state.selectedOverlayId);
    const redactionCapacityReached = overlays.overlays.length >= MAX_EXPORTED_SAFE_REDACTIONS;
    const tool = state.activeTool;
    const durationUs = projectDurationUs(state.project);
    const continuousEditProps = {
        onInteractionStart: () => dispatch({ type: "BEGIN_CONTINUOUS_EDIT" }),
        onInteractionCommit: () => dispatch({ type: "COMMIT_CONTINUOUS_EDIT" }),
        onInteractionCancel: () => dispatch({ type: "CANCEL_CONTINUOUS_EDIT" }),
    };
    backgroundImportCurrent.current = { state, projectId, mediaId: media?.id ?? null, mutationsLocked };
    autoZoomCurrent.current = { state, projectId, mediaId: media?.id ?? null, mutationsLocked };
    captionImportCurrent.current = { state, projectId, mediaId: media?.id ?? null, mutationsLocked };

    useEffect(() => {
        backgroundImportGeneration.current += 1;
        autoZoomGeneration.current += 1;
        captionImportGeneration.current += 1;
        setAutoZoomBusy(false);
        return () => {
            backgroundImportGeneration.current += 1;
            autoZoomGeneration.current += 1;
            captionImportGeneration.current += 1;
        };
    }, [media?.id, projectId]);

    useEffect(() => {
        backgroundImportGeneration.current += 1;
        captionImportGeneration.current += 1;
    }, [mutationsLocked, state.continuousEditStart, state.exportOpen, state.project]);

    useEffect(() => {
        if (selectedCaption === undefined) return;
        setCaptionText(selectedCaption.text);
        setCaptionStyle(captionStyleOption(selectedCaption.style.preset));
        setCaptionStart((selectedCaption.startUs / 1_000_000).toFixed(2));
        setCaptionEnd((selectedCaption.endUs / 1_000_000).toFixed(2));
    }, [selectedCaption]);

    if (state.continuousEditStart === null && state.project.systemVolume > 0) lastAudibleSystemVolume.current = state.project.systemVolume;

    const importBackground = async () => {
        const task: BackgroundImportTask = {
            generation: ++backgroundImportGeneration.current,
            project: state.project,
            projectId,
            mediaId: media?.id ?? null,
        };
        const taskIsCurrent = () => backgroundImportTaskIsCurrent(task, {
            generation: backgroundImportGeneration.current,
            ...backgroundImportCurrent.current,
        });
        if (!taskIsCurrent()) return;
        const items = await importLibraryImages();
        if (!taskIsCurrent()) return;
        const imported = items[0];
        if (!imported) {
            onNotify("No image imported", "Choose a PNG, JPEG, WebP, or GIF image in the desktop picker.");
            return;
        }
        onLibraryImagesImported(items);
        if (!applyBackgroundImportTaskResult(task, {
            generation: backgroundImportGeneration.current,
            ...backgroundImportCurrent.current,
        }, imported, dispatch)) return;
        onNotify("Background imported", `${imported.name} is now applied to this project.`);
    };

    const addManualZoom = () => {
        const range = availableZoomRangeAtPlayhead(zoomSegments, state.playhead * 1_000_000, durationUs);
        if (range === undefined) {
            onNotify("Zoom not added", "Move the playhead to at least 0.25 seconds of empty timeline space.");
            return;
        }
        const crop = state.project.crop ?? { x: 0, y: 0, width: 1, height: 1 };
        const segment: ZoomSegment = {
            id: `manual-zoom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            ...range,
            focus: { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 },
            scale: 2,
            source: "manual",
        };
        dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.add", segment } });
    };

    const generateAutoZoom = async () => {
        const bridge = getDesktopBridge();
        if (!bridge || projectId === null || media?.kind !== "video") return;
        if (!media.cursorMetadataAvailable) {
            onNotify("Click data unavailable", "This recording does not include recorded click data.");
            return;
        }
        const generation = ++autoZoomGeneration.current;
        const requestProjectId = projectId;
        const requestAssetId = media.id;
        const task: AutoZoomTask = {
            generation,
            project: state.project,
            projectId: requestProjectId,
            mediaId: requestAssetId,
        };
        const taskIsCurrent = () => autoZoomTaskIsCurrent(task, {
            generation: autoZoomGeneration.current,
            ...autoZoomCurrent.current,
        });
        if (!taskIsCurrent()) return;
        setAutoZoomBusy(true);
        try {
            if (!await onPrepareAutoZoom()) return;
            if (!taskIsCurrent()) return;
            const result = await bridge.projects.generateAutoZoom({ projectId: requestProjectId, assetId: requestAssetId });
            if (!taskIsCurrent()) return;
            if (!result.ok) {
                onNotify("Click zoom unavailable", result.error.message);
                return;
            }
            if (!applyAutoZoomTaskResult(task, {
                generation: autoZoomGeneration.current,
                ...autoZoomCurrent.current,
            }, result.value, dispatch)) return;
            onNotify(
                result.value.length === 0 ? "No click zooms found" : "Click zooms generated",
                result.value.length === 0
                    ? "No supported click events were found in this recording."
                    : `${result.value.length} zoom${result.value.length === 1 ? "" : "s"} added from local click data.`,
            );
        } catch (error) {
            if (taskIsCurrent()) {
                onNotify("Click zoom unavailable", error instanceof Error ? error.message : "Click zoom generation failed.");
            }
        } finally {
            if (generation === autoZoomGeneration.current) setAutoZoomBusy(false);
        }
    };

    const updateZoomBoundary = (edge: "start" | "end", seconds: number) => {
        if (selectedZoom === undefined || !Number.isFinite(seconds)) return;
        const range = resizeZoomSegmentRange(
            zoomSegments,
            selectedZoom.id,
            edge,
            seconds * 1_000_000,
            durationUs,
        );
        if (range !== undefined) {
            dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.update", id: selectedZoom.id, changes: range } });
        }
    };

    const applyFrameAction = (action: "center" | "reset") => {
        if (!dispatch({ type: "BEGIN_CONTINUOUS_EDIT" })) return;
        const changes: EditorAction[] = [
            ...(action === "reset" ? [{ type: "SET_SCALE", value: 100 } as const] : []),
            { type: "SET_OFFSET_X", value: 0 },
            { type: "SET_OFFSET_Y", value: 0 },
        ];
        for (const change of changes) {
            if (dispatch(change)) continue;
            dispatch({ type: "CANCEL_CONTINUOUS_EDIT" });
            return;
        }
        dispatch({ type: "COMMIT_CONTINUOUS_EDIT" });
    };

    const applyZoomMotion = (preset: ZoomMotionPreset) => {
        if (selectedZoom === undefined || !dispatch({ type: "BEGIN_CONTINUOUS_EDIT" })) return;
        const applied = dispatch({
            type: "EDIT_ZOOM",
            operation: {
                type: "zoom.update",
                id: selectedZoom.id,
                changes: zoomMotionPresetChanges(preset, selectedZoom.endUs - selectedZoom.startUs),
            },
        });
        dispatch({ type: applied ? "COMMIT_CONTINUOUS_EDIT" : "CANCEL_CONTINUOUS_EDIT" });
    };

    const importSubtitles = async (file: File) => {
        const generation = ++captionImportGeneration.current;
        const task: SubtitleImportTaskIdentity = {
            generation,
            project: state.project,
            projectId,
            mediaId: media?.id ?? null,
        };
        const taskIsCurrent = () => subtitleImportTaskIsCurrent(task, {
            generation: captionImportGeneration.current,
            ...captionImportCurrent.current,
        });
        try {
            const result = await runSubtitleImportTask({
                file,
                preset: captionPreset(captionStyle),
                idPrefix: `caption-${crypto.randomUUID()}`,
                isCurrent: taskIsCurrent,
                currentDocument: () => captionImportCurrent.current.state.project.overlays,
                commit: (document, selectedCaptionId, playheadSeconds) => {
                    if (!taskIsCurrent() || !dispatch({ type: "EDIT_OVERLAYS", document, selectedCaptionId })) return false;
                    if (playheadSeconds !== null) dispatch({ type: "SET_PLAYHEAD", time: playheadSeconds });
                    return true;
                },
            });
            if (result.status === "stale") return;
            onNotify("Captions imported", `${result.cueCount} cue${result.cueCount === 1 ? "" : "s"} saved and ready to burn into export.`);
        } catch (error) {
            if (!taskIsCurrent()) return;
            onNotify("Caption import failed", error instanceof Error ? error.message : "The subtitle file is invalid.");
        }
    };

    const addCaption = () => {
        const startUs = Math.min(Math.round(state.playhead * 1_000_000), Math.max(0, durationUs - 1));
        const endUs = Math.min(durationUs, startUs + 3_000_000);
        if (!captionText.trim() || endUs <= startUs) {
            onNotify("Caption not added", "Enter caption text first.");
            return;
        }
        const cue: TimedCaptionCue = {
            id: `caption-${crypto.randomUUID()}`,
            startUs,
            endUs,
            text: captionText.trim(),
            style: { preset: captionPreset(captionStyle) },
        };
        try {
            assertCaptionCueCapacity(overlays.captions.length, 1);
            validateCaptionCue(cue);
            const next = { ...overlays, captions: [...overlays.captions, cue] };
            dispatch({ type: "EDIT_OVERLAYS", document: next, selectedCaptionId: cue.id });
        } catch (error) {
            onNotify("Caption not added", error instanceof Error ? error.message : "The caption is invalid.");
        }
    };

    const saveCaption = () => {
        if (selectedCaption === undefined) return;
        const text = captionText.trim();
        const startUs = Math.round(Number.parseFloat(captionStart) * 1_000_000);
        const endUs = Math.round(Number.parseFloat(captionEnd) * 1_000_000);
        if (!text) {
            onNotify("Caption not saved", "Enter caption text first.");
            return;
        }
        if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || startUs < 0 || endUs <= startUs) {
            onNotify("Caption not saved", "Use a valid start time and an end time after it.");
            return;
        }
        const preset = captionPreset(captionStyle);
        const updated: TimedCaptionCue = {
            ...selectedCaption,
            startUs,
            endUs,
            text,
            style: preset === selectedCaption.style.preset ? selectedCaption.style : { preset },
        };
        try {
            validateCaptionCue(updated);
        } catch (error) {
            onNotify("Caption not saved", error instanceof Error ? error.message : "The caption is invalid.");
            return;
        }
        dispatch({
            type: "EDIT_OVERLAYS",
            document: {
                ...overlays,
                captions: overlays.captions.map((cue) => cue.id === updated.id ? updated : cue),
            },
            selectedCaptionId: updated.id,
        });
    };

    const deleteCaption = (id: string) => {
        const index = overlays.captions.findIndex((cue) => cue.id === id);
        const captions = overlays.captions.filter((cue) => cue.id !== id);
        const nextSelected = state.selectedCaptionId === id
            ? captions[Math.min(Math.max(0, index), captions.length - 1)]?.id ?? null
            : state.selectedCaptionId;
        dispatch({ type: "EDIT_OVERLAYS", document: { ...overlays, captions }, selectedCaptionId: nextSelected });
    };

    const addRedaction = () => {
        try {
            const added = addSafeRedaction({
                document: overlays,
                playheadUs: state.playhead * 1_000_000,
                projectDurationUs: durationUs,
            });
            dispatch({ type: "EDIT_OVERLAYS", document: added.document, selectedOverlayId: added.redaction.id });
            dispatch({ type: "SET_PLAYHEAD", time: added.redaction.startUs / 1_000_000 });
        } catch (error) {
            onNotify("Redaction not added", error instanceof Error ? error.message : "The redaction is invalid.");
        }
    };

    const removeRedaction = (id: string) => {
        const index = redactions.findIndex((redaction) => redaction.id === id);
        const remaining = redactions.filter((redaction) => redaction.id !== id);
        const nextSelected = state.selectedOverlayId === id
            ? remaining[Math.min(Math.max(0, index), remaining.length - 1)]?.id ?? null
            : state.selectedOverlayId;
        dispatch({
            type: "EDIT_OVERLAYS",
            document: deleteSafeRedaction(overlays, id),
            selectedOverlayId: nextSelected,
        });
    };

    const selectRedaction = (id: string, startUs: number) => {
        dispatch({ type: "SELECT_OVERLAY", id });
        dispatch({ type: "SET_PLAYHEAD", time: startUs / 1_000_000 });
    };

    const applyRedactionPreset = (preset: SafeRedactionPreset) => {
        if (selectedRedaction === undefined) return;
        dispatch({
            type: "EDIT_OVERLAYS",
            document: setSafeRedactionPreset(overlays, selectedRedaction.id, preset),
            selectedOverlayId: selectedRedaction.id,
        });
    };

    return (
        <aside aria-labelledby="inspector-tool-title" className="editor-inspector">
            <div className="inspector-header">
                <h2 id="inspector-tool-title">{tool === "annotations" ? "Redact" : tool.charAt(0).toUpperCase() + tool.slice(1)}</h2>
            </div>

            {tool === "background" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section background-browser">
                    <p className="inspector-section__intro">Set the mood behind your recording</p>

                    <section className="background-browser__group" aria-labelledby="background-colors-heading">
                        <header><h4 id="background-colors-heading">Color</h4><span>Solid and gradient</span></header>
                        <div className="background-browser__presets">
                            {BACKGROUND_PRESETS.map((preset) => {
                                const selected = state.project.backgroundId === preset.id;
                                return (
                                    <button aria-pressed={selected} className={selected ? "is-active" : ""} key={preset.id} onClick={() => dispatch({ type: "SET_BACKGROUND", id: preset.id })} type="button">
                                        <span className="background-browser__preset-visual" style={{ backgroundImage: `url(${preset.source})` }} />
                                        <span><strong>{preset.name}</strong><small>{preset.kind === "solid" ? "Solid" : "Gradient"}</small></span>
                                        {selected ? <span className="background-browser__check"><Icon name="check" size={12} /></span> : null}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section className="background-browser__group" aria-labelledby="background-originals-heading">
                        <header><h4 id="background-originals-heading">SharpShot originals</h4><span>{ORIGINAL_WALLPAPERS.length} included</span></header>
                        <WallpaperPicker onSelect={(id) => dispatch({ type: "SET_BACKGROUND", id })} selectedId={state.project.backgroundId} wallpapers={ORIGINAL_WALLPAPERS} />
                    </section>

                    <section className="background-browser__group" aria-labelledby="background-cinematic-heading">
                        <header><h4 id="background-cinematic-heading">Cinematic landscapes</h4><span>{CINEMATIC_WALLPAPERS.length} · CC0</span></header>
                        <WallpaperPicker onSelect={(id) => dispatch({ type: "SET_BACKGROUND", id })} selectedId={state.project.backgroundId} wallpapers={CINEMATIC_WALLPAPERS} />
                    </section>

                    <section className="background-browser__group" aria-labelledby="background-library-heading">
                        <header><h4 id="background-library-heading">Your images</h4><span>{userBackgrounds.length > 0 ? `${userBackgrounds.length} in library` : "Local only"}</span></header>
                        {userBackgrounds.length > 0 ? (
                            <div className="background-browser__images">
                                {userBackgrounds.map((image) => {
                                    const selected = state.project.backgroundId === image.url;
                                    const name = backgroundDisplayName(image.name);
                                    return (
                                        <button aria-pressed={selected} className={selected ? "is-active" : ""} key={image.id} onClick={() => dispatch({ type: "SET_BACKGROUND", id: image.url })} type="button">
                                            <span className="background-browser__image-frame"><img alt={`${name} background preview`} decoding="async" loading="lazy" src={image.url} /></span>
                                            <strong>{name}</strong>
                                            {selected ? <span className="background-browser__check"><Icon name="check" size={12} /></span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : <p className="background-browser__empty">Import an image to keep it in your local library and use it here.</p>}
                        <button className="background-browser__import" disabled={!canImport} onClick={() => void importBackground()} title={canImport ? "Choose images from your device" : "Available in the installed desktop app"} type="button">
                            <Icon name="plus" size={15} /> {canImport ? "Import images…" : "Import images · desktop only"}
                        </button>
                    </section>

                    <div className="background-browser__apple">
                        <button
                            disabled={!canImport}
                            onClick={() => void openExternalLink(APPLE_WALLPAPER_URL).then((opened) => {
                                if (!opened) onNotify("Link blocked", "SharpShot only opens approved secure links.");
                            })}
                            title={canImport ? "Open the official Apple wallpaper guide" : "Available in the installed desktop app"}
                            type="button"
                        ><span><strong>Get Apple wallpapers</strong><small>Open the official Apple guide</small></span><span aria-hidden="true">↗</span></button>
                        <p>Apple artwork is never downloaded or bundled by SharpShot.</p>
                    </div>
                    <RangeField {...continuousEditProps} label="Canvas padding" max={96} min={0} onChange={(value) => dispatch({ type: "SET_PADDING", value })} suffix=" px" value={state.project.padding} />
                </section>
            ) : null}

            {tool === "canvas" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section">
                    <p className="inspector-section__intro">Output frame and presentation</p>
                    <label className="select-field"><span>Aspect ratio</span><select value={state.project.aspectRatio} onChange={(event) => dispatch({ type: "SET_ASPECT", value: event.currentTarget.value as EditorState["project"]["aspectRatio"] })}><option>16:9</option><option>16:10</option><option>4:3</option><option>1:1</option><option>9:16</option><option>4:5</option></select></label>
                    <RangeField {...continuousEditProps} label="Padding" max={96} min={0} onChange={(value) => dispatch({ type: "SET_PADDING", value })} suffix=" px" value={state.project.padding} />
                    <RangeField {...continuousEditProps} label="Corner radius" max={36} min={0} onChange={(value) => dispatch({ type: "SET_CORNER_RADIUS", value })} suffix=" px" value={state.project.cornerRadius} />
                    <RangeField {...continuousEditProps} label="Shadow" max={100} min={0} onChange={(value) => dispatch({ type: "SET_SHADOW", value })} suffix="%" value={state.project.shadow} />
                    <button className="inspector-reset" onClick={() => { dispatch({ type: "BEGIN_CONTINUOUS_EDIT" }); dispatch({ type: "SET_PADDING", value: 46 }); dispatch({ type: "SET_CORNER_RADIUS", value: 16 }); dispatch({ type: "SET_SHADOW", value: 52 }); dispatch({ type: "COMMIT_CONTINUOUS_EDIT" }); }} type="button">Reset presentation</button>
                </section>
            ) : null}

            {tool === "layout" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section">
                    <p className="inspector-section__intro">Frame the recording directly on the canvas</p>
                    <div className="layout-mode-grid"><button aria-label="Fit recording inside canvas" aria-pressed={state.project.fitMode === "fit"} className={state.project.fitMode === "fit" ? "is-active" : ""} onClick={() => dispatch({ type: "SET_FIT_MODE", value: "fit" })} type="button"><Icon name="fit" /><span><strong>Fit</strong><small>Show everything</small></span></button><button aria-label="Fill canvas with recording" aria-pressed={state.project.fitMode === "fill"} className={state.project.fitMode === "fill" ? "is-active" : ""} onClick={() => dispatch({ type: "SET_FIT_MODE", value: "fill" })} type="button"><Icon name="fill" /><span><strong>Fill</strong><small>Crop to canvas</small></span></button></div>
                    <div aria-label="Frame quick actions" className="frame-quick-actions" role="group">
                        <button onClick={() => applyFrameAction("center")} type="button"><Icon name="canvas" size={15} /> Center</button>
                        <button onClick={() => applyFrameAction("reset")} type="button"><Icon name="undo" size={15} /> Reset frame</button>
                    </div>
                    <p className="inline-note"><Icon name="info" size={14} /> Drag the recording to move it, use the corner handles to resize, or press the arrow keys to nudge. Hold Shift for larger nudges.</p>
                    {selectedClip ? (
                        <details className="inspector-advanced inspector-section--clip">
                            <summary>Clip timing <Icon name="chevronDown" size={14} /></summary>
                            <header><div><span className="clip-color" style={{ background: selectedClip.color }} /><span><strong>{selectedClip.name}</strong><small>Screen recording</small></span></div><Icon name="video" size={15} /></header>
                            <div className="clip-time-fields">
                                <label><span>In</span><input aria-label="Clip in point" onChange={(event) => dispatch({ type: "TRIM_CLIP", id: selectedClip.id, sourceStart: Number(event.currentTarget.value), sourceEnd: selectedClip.sourceEnd })} step="0.1" type="number" value={selectedClip.sourceStart.toFixed(1)} /></label>
                                <label><span>Out</span><input aria-label="Clip out point" onChange={(event) => dispatch({ type: "TRIM_CLIP", id: selectedClip.id, sourceStart: selectedClip.sourceStart, sourceEnd: Number(event.currentTarget.value) })} step="0.1" type="number" value={selectedClip.sourceEnd.toFixed(1)} /></label>
                            </div>
                            <div className="speed-control"><span><Icon name="speed" size={14} /> Speed</span><div>{[0.25, 0.5, 1, 1.5, 2, 4, 8].map((speed) => <button aria-pressed={selectedClip.speed === speed} className={selectedClip.speed === speed ? "is-active" : ""} key={speed} onClick={() => dispatch({ type: "SET_SPEED", speed })} type="button">{speed}×</button>)}</div></div>
                        </details>
                    ) : null}
                </section>
            ) : null}

            {tool === "crop" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section">
                    <p className="inspector-section__intro">Trim the visible source area</p>
                    <p className="inline-note"><Icon name="info" size={14} /> Drag the crop handles in the preview. The crop is non-destructive and included in export.</p>
                    <button className="inspector-reset" onClick={() => dispatch({ type: "SET_SCREEN_TRANSFORM", patch: { crop: { x: 0, y: 0, width: 1, height: 1 } } })} type="button">Reset crop</button>
                </section>
            ) : null}

            {tool === "zoom" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section">
                    <p className="inspector-section__intro">Add a focus move at the playhead</p>
                    <button className="inspector-upload" onClick={addManualZoom} type="button"><Icon name="plus" size={15} /> Add zoom at playhead</button>
                    {canImport && projectId !== null && media?.kind === "video" ? (
                        <button className="button button--secondary button--full" disabled={autoZoomBusy || !media.cursorMetadataAvailable} onClick={() => void generateAutoZoom()} title={media.cursorMetadataAvailable ? "Replace zooms using locally recorded click data" : "This recording has no recorded click data"} type="button">
                            <Icon name="zoom" size={15} /> {autoZoomBusy ? "Generating…" : media.cursorMetadataAvailable ? "Generate from clicks" : "No click data"}
                        </button>
                    ) : null}
                    {zoomSegments.map((segment) => (
                        <div className={`cursor-style-current zoom-segment-row${segment.id === state.selectedZoomId ? " is-selected" : ""}`} key={segment.id}>
                            <button className="zoom-segment-select" onClick={() => {
                                dispatch({ type: "SELECT_ZOOM", id: segment.id });
                                dispatch({ type: "SET_PLAYHEAD", time: (segment.startUs + segment.endUs) / 2_000_000 });
                            }} type="button">
                                <Icon name="zoom" size={14} />
                                <span><strong>{segment.scale.toFixed(1)}× zoom</strong><small>{formatTime(segment.startUs / 1_000_000)} – {formatTime(segment.endUs / 1_000_000)}</small></span>
                            </button>
                            <button aria-label="Delete zoom" onClick={() => dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.delete", id: segment.id } })} type="button"><Icon name="trash" size={14} /></button>
                        </div>
                    ))}
                    {selectedZoom ? (
                        <div className="zoom-editor-fields">
                            <div aria-label="Zoom magnification" className="zoom-preset-control" role="group">
                                <div className="zoom-preset-control__header"><span>Magnification</span><output>{isZoomScalePreset(selectedZoom.scale) ? formatZoomScale(selectedZoom.scale) : `Custom · ${formatZoomScale(selectedZoom.scale)}`}</output></div>
                                <div className="zoom-preset-row">
                                    {ZOOM_SCALE_PRESETS.map((scale) => <button aria-label={`Set zoom magnification to ${formatZoomScale(scale)}`} aria-pressed={selectedZoom.scale === scale} className={selectedZoom.scale === scale ? "is-active" : ""} key={scale} onClick={() => dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.update", id: selectedZoom.id, changes: { scale } } })} type="button">{formatZoomScale(scale)}</button>)}
                                </div>
                            </div>
                            <div aria-label="Zoom motion" className="zoom-preset-control" role="group">
                                <div className="zoom-preset-control__header"><span>Motion</span><output>{selectedZoomMotion ?? "Custom"}</output></div>
                                <div className="zoom-preset-row zoom-preset-row--motion">
                                    {ZOOM_MOTION_PRESETS.map((preset) => <button aria-label={`Use ${preset.toLowerCase()} zoom motion`} aria-pressed={selectedZoomMotion === preset} className={selectedZoomMotion === preset ? "is-active" : ""} key={preset} onClick={() => applyZoomMotion(preset)} type="button">{preset}</button>)}
                                </div>
                            </div>
                            <details className="zoom-advanced">
                                <summary>Exact timing <Icon name="chevronDown" size={14} /></summary>
                                <div className="clip-time-fields">
                                    <label><span>Start</span><input aria-label="Zoom start" min="0" onChange={(event) => updateZoomBoundary("start", Number.parseFloat(event.currentTarget.value))} step="0.05" type="number" value={(selectedZoom.startUs / 1_000_000).toFixed(2)} /></label>
                                    <label><span>End</span><input aria-label="Zoom end" max={durationUs / 1_000_000} onChange={(event) => updateZoomBoundary("end", Number.parseFloat(event.currentTarget.value))} step="0.05" type="number" value={(selectedZoom.endUs / 1_000_000).toFixed(2)} /></label>
                                </div>
                            </details>
                        </div>
                    ) : <p className="inline-note"><Icon name="info" size={14} /> Select a zoom in this list or on the timeline to edit it.</p>}
                    <p className="inline-note"><Icon name="info" size={14} /> Click or drag on the preview to place the focus; arrow keys nudge it. Zooms are saved and included in export.</p>
                </section>
            ) : null}

            {tool === "audio" ? (
                <section aria-label="Embedded audio" className="inspector-section">
                    <p className="inspector-section__intro">Set the recorded source volume in preview and export</p>
                    {sourceHasAudio ? (
                        <div className="audio-channel">
                            <header>
                                <span><Icon name="audio" size={15} /><strong>Source audio</strong></span>
                                <span>
                                    <output>{state.project.systemVolume === 0 ? "Muted" : `${state.project.systemVolume}%`}</output>
                                    <Switch
                                        checked={state.project.systemVolume > 0}
                                        label="Embedded source audio"
                                        onChange={(enabled) => dispatch({ type: "SET_SYSTEM_VOLUME", value: enabled ? lastAudibleSystemVolume.current : 0 })}
                                    />
                                </span>
                            </header>
                            <RangeInput {...continuousEditProps} ariaLabel="Embedded source audio volume" min={0} max={100} value={state.project.systemVolume} onChange={(value) => dispatch({ type: "SET_SYSTEM_VOLUME", value })} />
                        </div>
                    ) : <p className="inline-note"><Icon name="info" size={14} /> This source has no embedded audio.</p>}
                </section>
            ) : null}

            {tool === "audio" ? (
                <AudioMusicInspector
                    audioCatalog={audioCatalog}
                    dispatch={dispatch}
                    libraryAudio={libraryAudio}
                    mutationsLocked={mutationsLocked}
                    onLibraryAudioImported={onLibraryAudioImported}
                    onNotify={onNotify}
                    sourceHasAudio={sourceHasAudio}
                    state={state}
                />
            ) : null}

            {tool === "captions" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section">
                    <div className="inspector-section__intro inspector-section__intro--counted"><span>Timed text, saved with the project</span><span aria-label={`${overlays.captions.length} captions`}>{overlays.captions.length}</span></div>
                    <div className="caption-toolbar">
                        <button className="button button--secondary" onClick={addCaption} type="button"><Icon name="plus" size={14} /> Add at playhead</button>
                        <button className="inspector-upload" onClick={() => subtitleInput.current?.click()} type="button"><Icon name="captions" size={14} /> Import SRT/VTT</button>
                    </div>
                    <input accept=".srt,.vtt,text/vtt,application/x-subrip" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importSubtitles(file); event.currentTarget.value = ""; }} ref={subtitleInput} type="file" />
                    {overlays.captions.length > 0 ? (
                        <div className="caption-list" aria-label="Project captions">
                            {captionListCues.map((cue) => (
                                <div className={`caption-list__row${cue.id === state.selectedCaptionId ? " is-selected" : ""}`} key={cue.id}>
                                    <button className="caption-list__select" onClick={() => {
                                        dispatch({ type: "SELECT_CAPTION", id: cue.id });
                                        dispatch({ type: "SET_PLAYHEAD", time: cue.startUs / 1_000_000 });
                                    }} type="button">
                                        <span>{cue.text}</span>
                                        <small>{formatTime(cue.startUs / 1_000_000)} – {formatTime(cue.endUs / 1_000_000)}</small>
                                    </button>
                                    <button aria-label={`Delete caption ${cue.text}`} onClick={() => deleteCaption(cue.id)} type="button"><Icon name="trash" size={14} /></button>
                                </div>
                            ))}
                            {captionListCues.length < overlays.captions.length ? <p className="caption-list__limit">Showing {captionListCues.length} captions around the selection</p> : null}
                        </div>
                    ) : <p className="inline-note"><Icon name="info" size={14} /> Add a caption at the playhead or import an SRT/VTT file.</p>}
                    <label className="caption-textarea"><span>{selectedCaption ? "Caption text" : "New caption text"}</span><textarea onChange={(event) => setCaptionText(event.currentTarget.value)} placeholder="Type what should appear on screen" rows={3} value={captionText} /></label>
                    <Segmented<CaptionStyleOption> label="Style" onChange={setCaptionStyle} options={["Clean", "Boxed", "Bold", "Lower third"]} value={captionStyle} />
                    {selectedCaption ? (
                        <div className="clip-time-fields">
                            <label><span>Start</span><input aria-label="Caption start" min="0" onChange={(event) => setCaptionStart(event.currentTarget.value)} step="0.05" type="number" value={captionStart} /></label>
                            <label><span>End</span><input aria-label="Caption end" min="0" onChange={(event) => setCaptionEnd(event.currentTarget.value)} step="0.05" type="number" value={captionEnd} /></label>
                        </div>
                    ) : null}
                    <div className="caption-actions">
                        <button className="button button--primary" disabled={selectedCaption === undefined} onClick={saveCaption} type="button"><Icon name="check" size={14} /> Save caption</button>
                        {selectedCaption ? <button className="button button--secondary" onClick={() => deleteCaption(selectedCaption.id)} type="button"><Icon name="trash" size={14} /> Delete</button> : null}
                    </div>
                    <p className="inline-note"><Icon name="info" size={14} /> Captions are saved locally and burned into MP4 and GIF exports.</p>
                </section>
            ) : null}

            {tool === "annotations" ? (
                <section aria-labelledby="inspector-tool-title" className="inspector-section redact-inspector">
                    <div className="inspector-section__intro inspector-section__intro--counted">
                        <span>Opaque rectangles, saved with the project</span>
                        <span aria-label={`${redactions.length} redactions`}>{redactions.length}/{MAX_EXPORTED_SAFE_REDACTIONS}</span>
                    </div>
                    <button className="button button--primary button--full" disabled={redactionCapacityReached || durationUs < 1} onClick={addRedaction} type="button">
                        <Icon name="redact" size={15} /> Add redaction
                    </button>
                    {redactionCapacityReached ? <p className="inline-note inline-note--warning"><Icon name="info" size={14} /> Maximum {MAX_EXPORTED_SAFE_REDACTIONS} redactions reached.</p> : null}
                    {durationUs < 1 ? <p className="inline-note"><Icon name="info" size={14} /> Add timeline media before creating a redaction.</p> : null}
                    {redactions.length > 0 ? (
                        <div aria-label="Project redactions" className="redact-list">
                            {redactions.map((redaction, index) => (
                                <div className={`redact-list__row${redaction.id === state.selectedOverlayId ? " is-selected" : ""}`} key={redaction.id}>
                                    <button className="redact-list__select" onClick={() => selectRedaction(redaction.id, redaction.startUs)} type="button">
                                        <span className="redact-list__swatch" style={{ background: redaction.fillColor }} />
                                        <span><strong>Redaction {index + 1}</strong><small>{formatTime(redaction.startUs / 1_000_000)} – {formatTime(redaction.endUs / 1_000_000)}</small></span>
                                    </button>
                                    <button aria-label={`Delete redaction ${index + 1}`} onClick={() => removeRedaction(redaction.id)} type="button"><Icon name="trash" size={14} /></button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {selectedRedaction ? (
                        <div aria-label="Redaction color" className="redact-preset-control" role="group">
                            <span>Color</span>
                            <div>
                                {(["black", "dark", "white"] as const).map((preset) => (
                                    <button aria-label={`${preset.charAt(0).toUpperCase() + preset.slice(1)} redaction`} aria-pressed={presetForSafeRedaction(selectedRedaction) === preset} className={presetForSafeRedaction(selectedRedaction) === preset ? "is-active" : ""} key={preset} onClick={() => applyRedactionPreset(preset)} type="button">
                                        <span style={{ background: SAFE_REDACTION_COLORS[preset] }} />{preset.charAt(0).toUpperCase() + preset.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <p className="inline-note"><Icon name="info" size={14} /> Drag on preview · trim on timeline · opaque in export</p>
                </section>
            ) : null}
        </aside>
    );
}

export interface AutoZoomTask {
    generation: number;
    project: EditorState["project"];
    projectId: string;
    mediaId: string;
}

export interface BackgroundImportTask {
    generation: number;
    project: EditorState["project"];
    projectId: string | null;
    mediaId: string | null;
}

export interface BackgroundImportCurrent {
    generation: number;
    state: Pick<EditorState, "project" | "continuousEditStart" | "exportOpen">;
    projectId: string | null;
    mediaId: string | null;
    mutationsLocked: boolean;
}

export function backgroundImportTaskIsCurrent(
    task: BackgroundImportTask,
    current: BackgroundImportCurrent,
): boolean {
    return task.generation === current.generation
        && task.project === current.state.project
        && task.projectId === current.projectId
        && task.mediaId === current.mediaId
        && current.state.continuousEditStart === null
        && !current.state.exportOpen
        && !current.mutationsLocked;
}

export function applyBackgroundImportTaskResult(
    task: BackgroundImportTask,
    current: BackgroundImportCurrent,
    imported: MediaItem,
    dispatch: (action: EditorAction) => boolean,
): boolean {
    return backgroundImportTaskIsCurrent(task, current)
        && dispatch({ type: "SET_BACKGROUND", id: imported.url });
}

export interface AutoZoomCurrent {
    generation: number;
    state: Pick<EditorState, "project" | "continuousEditStart" | "exportOpen">;
    projectId: string | null;
    mediaId: string | null;
    mutationsLocked: boolean;
}

export function autoZoomTaskIsCurrent(task: AutoZoomTask, current: AutoZoomCurrent): boolean {
    return task.generation === current.generation
        && task.project === current.state.project
        && task.projectId === current.projectId
        && task.mediaId === current.mediaId
        && current.state.continuousEditStart === null
        && !current.state.exportOpen
        && !current.mutationsLocked;
}

export function applyAutoZoomTaskResult(
    task: AutoZoomTask,
    current: AutoZoomCurrent,
    segments: readonly ZoomSegment[],
    dispatch: (action: EditorAction) => boolean,
): boolean {
    return autoZoomTaskIsCurrent(task, current)
        && dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.replace", segments } });
}

type CaptionStyleOption = "Clean" | "Boxed" | "Bold" | "Lower third";

function captionPreset(option: CaptionStyleOption): CaptionStylePresetId {
    if (option === "Boxed") return "boxed";
    if (option === "Bold") return "bold";
    if (option === "Lower third") return "lower-third";
    return "clean";
}

function captionStyleOption(preset: CaptionStylePresetId): CaptionStyleOption {
    if (preset === "boxed") return "Boxed";
    if (preset === "bold") return "Bold";
    if (preset === "lower-third") return "Lower third";
    return "Clean";
}

export function zoomMotionPresetChanges(
    preset: ZoomMotionPreset,
    durationUs: number,
): Pick<ZoomSegment, "easeInUs" | "easeOutUs"> {
    const requested = preset === "Quick"
        ? { easeInUs: 100_000, easeOutUs: 120_000 }
        : preset === "Gentle"
            ? { easeInUs: 320_000, easeOutUs: 380_000 }
            : { easeInUs: 180_000, easeOutUs: 220_000 };
    const duration = Number.isFinite(durationUs) ? Math.max(0, Math.floor(durationUs)) : 0;
    const maximumPerEdge = Math.floor(duration * (preset === "Quick" ? 0.18 : preset === "Smooth" ? 0.32 : 0.5));
    const easeInUs = Math.min(requested.easeInUs, maximumPerEdge);
    return { easeInUs, easeOutUs: Math.min(requested.easeOutUs, maximumPerEdge, duration - easeInUs) };
}

export function zoomMotionPresetFor(
    segment: Pick<ZoomSegment, "startUs" | "endUs" | "easeInUs" | "easeOutUs">,
): ZoomMotionPreset | undefined {
    const durationUs = segment.endUs - segment.startUs;
    return ZOOM_MOTION_PRESETS.find((preset) => {
        const easing = zoomMotionPresetChanges(preset, durationUs);
        return easing.easeInUs === segment.easeInUs && easing.easeOutUs === segment.easeOutUs;
    });
}

function isZoomScalePreset(scale: number): boolean {
    return ZOOM_SCALE_PRESETS.some((preset) => preset === scale);
}

function formatZoomScale(scale: number): string {
    return `${Number(scale.toFixed(2))}×`;
}

function captionWindow(captions: readonly TimedCaptionCue[], selectedId: string | null): readonly TimedCaptionCue[] {
    const limit = 200;
    if (captions.length <= limit) return captions;
    const selectedIndex = Math.max(0, captions.findIndex((cue) => cue.id === selectedId));
    const start = Math.min(captions.length - limit, Math.max(0, selectedIndex - Math.floor(limit / 2)));
    return captions.slice(start, start + limit);
}
