import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import type { MediaItem } from "../../shared/api";
import { applyPreviewTransform, previewTransformForZoom, type NormalizedPoint, type PreviewTransform, type ZoomSegment } from "../../shared/cursor-zoom";
import { evaluateZoomForCropAt, resolveScreenShadowBlur } from "../../shared/export-plan";
import { resolveCaptionStyle, type ShapeOverlay } from "../../shared/overlays";
import type { NormalizedRect, ScreenStyle } from "../../shared/project";
import { resolveBackgroundSource } from "../data";
import { computeRendererPreviewGeometry } from "../preview-geometry";
import {
    composeCrop,
    isFullCrop,
    resizeCropRect,
    resizeScreen,
    translateScreen,
    type CanvasPoint,
    type CropHandle,
    type ResizeHandle,
    type ScreenManipulationResult,
    type ScreenTransformPatch,
} from "../screen-manipulation";
import { clipDuration, projectDuration } from "../state";
import type { EditorClip, EditorProject, EditorState } from "../types";
import { createFrameCoalescer } from "../frame-coalescer";
import { captionPreviewStyle } from "../caption-preview";
import { isSafeRedaction } from "../safe-redaction";

const FULL_CROP: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const RESIZE_HANDLES: readonly ResizeHandle[] = ["nw", "ne", "se", "sw"];
const CROP_HANDLES: readonly Exclude<CropHandle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type ScreenPointerSession = {
    kind: "move" | "resize";
    pointerId: number;
    project: EditorProject;
    bounds: PreviewPointerBounds;
    start: CanvasPoint;
    handle?: ResizeHandle;
    latest?: ScreenManipulationResult;
    moved: boolean;
};

type CropPointerSession = {
    kind: "crop";
    pointerId: number;
    handle: CropHandle;
    bounds: PreviewPointerBounds;
    start: CanvasPoint;
    selection: NormalizedRect;
    latest: NormalizedRect;
};

type ZoomPointerSession = {
    kind: "zoom";
    pointerId: number;
    bounds: PreviewPointerBounds;
    crop: NormalizedRect;
    transform: PreviewTransform;
    latest: NormalizedPoint;
};

type OverlayPointerSession = {
    kind: "overlay";
    pointerId: number;
    id: string;
    handle: CropHandle;
    bounds: PreviewPointerBounds;
    start: CanvasPoint;
    area: NormalizedRect;
    latest: NormalizedRect;
};

type PointerSession = ScreenPointerSession | CropPointerSession | ZoomPointerSession | OverlayPointerSession;

type PreviewDraftUpdate =
    | { kind: "crop"; value: NormalizedRect }
    | { kind: "screen"; value: ScreenManipulationResult }
    | { kind: "zoom"; value: NormalizedPoint }
    | { kind: "overlay"; id: string; value: NormalizedRect };

export interface EditorPreviewProps {
    state: EditorState;
    media: MediaItem | null;
    cropMode: boolean;
    onTransformCommit: (patch: ScreenTransformPatch) => void;
    onZoomFocusCommit: (focus: NormalizedPoint) => void;
    onOverlayAreaCommit: (id: string, area: NormalizedRect) => void;
    onOverlaySelect: (id: string) => void;
    onCropApply: () => void;
    onCropCancel: () => void;
}

export interface PreviewPointerBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function readPreviewPointerBounds(
    element: Pick<HTMLElement, "getBoundingClientRect">,
): PreviewPointerBounds {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
}

export function canvasPointForBounds(
    event: Pick<PointerEvent, "clientX" | "clientY">,
    bounds: PreviewPointerBounds,
    canvasWidth: number,
    canvasHeight: number,
): CanvasPoint {
    return {
        x: (event.clientX - bounds.left) / bounds.width * canvasWidth,
        y: (event.clientY - bounds.top) / bounds.height * canvasHeight,
    };
}

export function normalizedPointForBounds(
    event: Pick<PointerEvent, "clientX" | "clientY">,
    bounds: PreviewPointerBounds,
): CanvasPoint {
    return {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
    };
}

export function clipAtTime(state: EditorState, timelineTime: number): { clip: EditorClip; sourceTime: number } | undefined {
    let cursor = 0;
    for (const clip of state.project.clips) {
        const duration = clipDuration(clip);
        if (timelineTime < cursor + duration || clip === state.project.clips.at(-1)) {
            const local = Math.max(0, Math.min(duration, timelineTime - cursor));
            return { clip, sourceTime: clip.sourceStart + local * clip.speed };
        }
        cursor += duration;
    }
    return undefined;
}

export function previewScreenBoxShadow(shadow: ScreenStyle["shadow"], canvasWidth: number): string {
    const canvasUnit = 100 / canvasWidth;
    const { cssBlurRadiusPx } = resolveScreenShadowBlur(shadow.blurPx);
    return `${shadow.offsetX * canvasUnit}cqw ${shadow.offsetY * canvasUnit}cqw ${cssBlurRadiusPx * canvasUnit}cqw rgba(0,0,0,${shadow.opacity})`;
}

export function resolvePreviewVolume(systemVolume: number): number {
    if (!Number.isFinite(systemVolume)) return 0;
    return Math.min(1, Math.max(0, systemVolume / 100));
}

export function resolveSourceClipPreviewVolume(
    activeClip: EditorClip | undefined,
    clips: readonly EditorClip[],
    systemVolume: number,
): number {
    const baselineVolume = sourceAudioPercent(clips);
    if (activeClip?.sourceAudio === undefined
        || baselineVolume === undefined
        || systemVolume !== baselineVolume) {
        return resolvePreviewVolume(systemVolume);
    }
    if (activeClip.sourceAudio.mode === "mute") return 0;
    return Math.min(1, Math.max(0, 10 ** (activeClip.sourceAudio.gainDb / 20)));
}

export function previewZoomTransformAt(
    segments: readonly ZoomSegment[],
    timeUs: number,
    crop: NormalizedRect,
    disabled = false,
) {
    return previewTransformForZoom(evaluateZoomForCropAt(disabled ? [] : segments, timeUs, crop));
}

export function zoomFocusForPreviewPoint(
    point: NormalizedPoint,
    crop: NormalizedRect,
    transform: PreviewTransform,
): NormalizedPoint {
    const content = {
        x: (point.x - transform.translateX) / transform.scale,
        y: (point.y - transform.translateY) / transform.scale,
    };
    return {
        x: clamp01(crop.x + clamp01(content.x) * crop.width),
        y: clamp01(crop.y + clamp01(content.y) * crop.height),
    };
}

export function previewPointForZoomFocus(
    focus: NormalizedPoint,
    crop: NormalizedRect,
    transform: PreviewTransform,
): NormalizedPoint {
    return applyPreviewTransform({
        x: (focus.x - crop.x) / crop.width,
        y: (focus.y - crop.y) / crop.height,
    }, transform);
}

export function EditorPreview({
    state,
    media,
    cropMode,
    onTransformCommit,
    onZoomFocusCommit,
    onOverlayAreaCommit,
    onOverlaySelect,
    onCropApply,
    onCropCancel,
}: EditorPreviewProps) {
    const artboardRef = useRef<HTMLDivElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const activeClipId = useRef<string | null>(null);
    const pointerSession = useRef<PointerSession | null>(null);
    const [selected, setSelected] = useState(false);
    const [draft, setDraft] = useState<ScreenManipulationResult | null>(null);
    const [cropSelection, setCropSelection] = useState<NormalizedRect>(FULL_CROP);
    const [zoomFocus, setZoomFocus] = useState<NormalizedPoint | null>(null);
    const [overlayDraft, setOverlayDraft] = useState<{ id: string; area: NormalizedRect } | null>(null);
    const draftFrame = useMemo(() => createFrameCoalescer<PreviewDraftUpdate>(
        (callback) => window.requestAnimationFrame(callback),
        (frame) => window.cancelAnimationFrame(frame),
        (update) => {
            if (update.kind === "crop") setCropSelection(update.value);
            else if (update.kind === "screen") setDraft(update.value);
            else if (update.kind === "zoom") setZoomFocus(update.value);
            else setOverlayDraft({ id: update.id, area: update.value });
        },
    ), []);
    const backgroundSource = useMemo(() => resolveBackgroundSource(state.project.backgroundId), [state.project.backgroundId]);
    const geometry = useMemo(() => computeRendererPreviewGeometry(state.project), [state.project]);
    const { canvas, crop, layout } = geometry;
    const displayRect = draft?.rect ?? layout.screenRectPx;
    const displayCrop = draft?.patch.crop ?? crop;
    const draftGeometry = useMemo(() => draft === null
        ? geometry
        : computeRendererPreviewGeometry({ ...state.project, ...draft.patch }), [draft, geometry, state.project]);
    const canvasUnit = 100 / canvas.width;
    const active = clipAtTime(state, state.playhead);
    const activeId = active?.clip.id;
    const activeSpeed = active?.clip.speed;
    const activeSourceTime = active?.sourceTime;
    const timeUs = Math.max(0, Math.round(state.playhead * 1_000_000));
    const zoomMode = state.activeTool === "zoom";
    const redactMode = state.activeTool === "annotations";
    const selectedZoom = state.project.zoomSegments.find((segment) => segment.id === state.selectedZoomId);
    const previewZoomSegments = cropMode
        ? []
        : zoomFocus === null || selectedZoom === undefined
        ? state.project.zoomSegments
        : state.project.zoomSegments.map((segment) => segment.id === selectedZoom.id
            ? { ...segment, focus: zoomFocus }
            : segment);
    const zoomTransform = previewZoomTransformAt(previewZoomSegments, timeUs, displayCrop, cropMode);
    const activeCaptions = state.project.overlays.captions.filter((cue) => timeUs >= cue.startUs && timeUs < cue.endUs);
    const visualOverlays = state.project.overlays.overlays.filter((overlay) => timeUs >= overlay.startUs && timeUs < overlay.endUs);
    const mediaTransform = `translate(${zoomTransform.translateX * 100}%, ${zoomTransform.translateY * 100}%) scale(${zoomTransform.scale})`;
    const previewVolume = resolveSourceClipPreviewVolume(
        active?.clip,
        state.project.clips,
        state.project.systemVolume,
    );
    const markerFocus = zoomFocus ?? selectedZoom?.focus;
    const markerPoint = markerFocus === undefined
        ? undefined
        : previewPointForZoomFocus(markerFocus, displayCrop, zoomTransform);
    const markerPosition = markerPoint === undefined ? undefined : {
        x: clamp01(markerPoint.x),
        y: clamp01(markerPoint.y),
    };
    const layerSelected = selected || cropMode || zoomMode;

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = previewVolume;
        video.muted = previewVolume === 0;
    }, [media?.url, previewVolume]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || activeId === undefined || activeSpeed === undefined || activeSourceTime === undefined) return;
        const clipChanged = activeClipId.current !== activeId;
        activeClipId.current = activeId;
        if (video.playbackRate !== activeSpeed) video.playbackRate = activeSpeed;
        if (clipChanged || !state.playing || Math.abs(video.currentTime - activeSourceTime) > 0.35) {
            video.currentTime = Math.max(0, activeSourceTime);
        }
        if (state.playing) {
            if (video.paused) void video.play().catch(() => undefined);
        } else if (!video.paused) {
            video.pause();
        }
    }, [activeId, activeSourceTime, activeSpeed, state.playing]);

    useEffect(() => () => videoRef.current?.pause(), []);
    useEffect(() => () => draftFrame.cancel(), [draftFrame]);

    useEffect(() => {
        draftFrame.cancel();
        const session = pointerSession.current;
        const captureTarget = session?.kind === "overlay" ? artboardRef.current : shellRef.current;
        if (session !== null && captureTarget?.hasPointerCapture(session.pointerId)) {
            captureTarget.releasePointerCapture(session.pointerId);
        }
        pointerSession.current = null;
        setDraft(null);
        setZoomFocus(null);
        setOverlayDraft(null);
        setCropSelection(FULL_CROP);
        if (cropMode) setSelected(true);
    }, [cropMode, draftFrame, redactMode, zoomMode, state.selectedZoomId, state.project.crop?.x, state.project.crop?.y, state.project.crop?.width, state.project.crop?.height]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && pointerSession.current?.kind === "overlay") {
                event.preventDefault();
                cancelPointerSession();
                return;
            }
            if (isEditorShortcutTarget(event.target)) return;
            if (event.key === "Escape") {
                if (pointerSession.current === null && !cropMode) return;
                event.preventDefault();
                cancelPointerSession();
                if (cropMode) cancelCrop();
                return;
            }
            if (event.key === "Enter" && cropMode) {
                event.preventDefault();
                applyCrop();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [crop, cropMode, cropSelection, onCropApply, onCropCancel, onTransformCommit]);

    const cancelPointerSession = () => {
        draftFrame.cancel();
        const session = pointerSession.current;
        const captureTarget = session?.kind === "overlay" ? artboardRef.current : shellRef.current;
        pointerSession.current = null;
        if (session !== null && captureTarget?.hasPointerCapture(session.pointerId)) {
            captureTarget.releasePointerCapture(session.pointerId);
        }
        setDraft(null);
        if (session?.kind === "crop") setCropSelection(session.selection);
        if (session?.kind === "zoom") setZoomFocus(null);
        if (session?.kind === "overlay") setOverlayDraft(null);
    };

    const applyCrop = () => {
        cancelPointerSession();
        if (!isFullCrop(cropSelection)) onTransformCommit({ crop: composeCrop(crop, cropSelection) });
        setCropSelection(FULL_CROP);
        onCropApply();
    };

    const cancelCrop = () => {
        cancelPointerSession();
        setCropSelection(FULL_CROP);
        onCropCancel();
    };

    const beginZoomFocus = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!zoomMode || selectedZoom === undefined || event.button !== 0) return;
        const shell = shellRef.current;
        if (!shell) return;
        event.preventDefault();
        event.stopPropagation();
        shell.focus({ preventScroll: true });
        shell.setPointerCapture(event.pointerId);
        const bounds = readPreviewPointerBounds(shell);
        const latest = zoomFocusForPreviewPoint(normalizedPointForBounds(event, bounds), displayCrop, zoomTransform);
        pointerSession.current = {
            kind: "zoom",
            pointerId: event.pointerId,
            bounds,
            crop: displayCrop,
            transform: zoomTransform,
            latest,
        };
        setZoomFocus(latest);
    };

    const beginScreenMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (cropMode || event.button !== 0 || media === null) return;
        if (zoomMode) {
            beginZoomFocus(event);
            return;
        }
        const artboard = artboardRef.current;
        const shell = shellRef.current;
        if (!artboard || !shell) return;
        event.preventDefault();
        event.stopPropagation();
        setSelected(true);
        shell.focus({ preventScroll: true });
        shell.setPointerCapture(event.pointerId);
        const bounds = readPreviewPointerBounds(artboard);
        pointerSession.current = {
            kind: "move",
            pointerId: event.pointerId,
            project: state.project,
            bounds,
            start: canvasPointForBounds(event, bounds, canvas.width, canvas.height),
            moved: false,
        };
    };

    const beginResize = (handle: ResizeHandle, event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const artboard = artboardRef.current;
        const shell = shellRef.current;
        if (!artboard || !shell) return;
        event.preventDefault();
        event.stopPropagation();
        setSelected(true);
        shell.focus({ preventScroll: true });
        shell.setPointerCapture(event.pointerId);
        const bounds = readPreviewPointerBounds(artboard);
        pointerSession.current = {
            kind: "resize",
            pointerId: event.pointerId,
            project: state.project,
            bounds,
            start: canvasPointForBounds(event, bounds, canvas.width, canvas.height),
            handle,
            moved: false,
        };
    };

    const beginCrop = (handle: CropHandle, event: ReactPointerEvent<HTMLElement>) => {
        if (!cropMode || event.button !== 0) return;
        const shell = shellRef.current;
        if (!shell) return;
        event.preventDefault();
        event.stopPropagation();
        shell.focus({ preventScroll: true });
        shell.setPointerCapture(event.pointerId);
        const bounds = readPreviewPointerBounds(shell);
        pointerSession.current = {
            kind: "crop",
            pointerId: event.pointerId,
            handle,
            bounds,
            start: normalizedPointForBounds(event, bounds),
            selection: cropSelection,
            latest: cropSelection,
        };
    };

    const beginOverlay = (redaction: ShapeOverlay, handle: CropHandle, event: ReactPointerEvent<HTMLElement>) => {
        if (!redactMode || event.button !== 0) return;
        const artboard = artboardRef.current;
        if (!artboard) return;
        event.preventDefault();
        event.stopPropagation();
        onOverlaySelect(redaction.id);
        event.currentTarget.focus({ preventScroll: true });
        artboard.setPointerCapture(event.pointerId);
        const bounds = readPreviewPointerBounds(artboard);
        pointerSession.current = {
            kind: "overlay",
            pointerId: event.pointerId,
            id: redaction.id,
            handle,
            bounds,
            start: normalizedPointForBounds(event, bounds),
            area: { ...redaction.area },
            latest: { ...redaction.area },
        };
        setOverlayDraft({ id: redaction.id, area: { ...redaction.area } });
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const session = pointerSession.current;
        if (!session || session.pointerId !== event.pointerId) return;
        if (session.kind === "overlay") {
            const point = normalizedPointForBounds(event, session.bounds);
            session.latest = resizeCropRect(
                session.area,
                session.handle,
                { x: point.x - session.start.x, y: point.y - session.start.y },
                event.shiftKey,
            );
            draftFrame.schedule({ kind: "overlay", id: session.id, value: session.latest });
            return;
        }
        if (session.kind === "zoom") {
            session.latest = zoomFocusForPreviewPoint(
                normalizedPointForBounds(event, session.bounds),
                session.crop,
                session.transform,
            );
            draftFrame.schedule({ kind: "zoom", value: session.latest });
            return;
        }
        if (session.kind === "crop") {
            const point = normalizedPointForBounds(event, session.bounds);
            session.latest = resizeCropRect(
                session.selection,
                session.handle,
                { x: point.x - session.start.x, y: point.y - session.start.y },
                event.shiftKey,
            );
            draftFrame.schedule({ kind: "crop", value: session.latest });
            return;
        }
        const point = canvasPointForBounds(event, session.bounds, canvas.width, canvas.height);
        const distance = Math.hypot(point.x - session.start.x, point.y - session.start.y);
        session.moved ||= distance >= 1;
        if (!session.moved) return;
        const result = session.kind === "move"
            ? translateScreen(session.project, { x: point.x - session.start.x, y: point.y - session.start.y })
            : resizeScreen(session.project, session.handle!, point, !event.shiftKey);
        session.latest = result;
        draftFrame.schedule({ kind: "screen", value: result });
    };

    const finishPointerSession = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
        const session = pointerSession.current;
        if (!session || session.pointerId !== event.pointerId) return;
        draftFrame.cancel();
        const captureTarget = session.kind === "overlay" ? artboardRef.current : shellRef.current;
        pointerSession.current = null;
        if (captureTarget?.hasPointerCapture(event.pointerId)) captureTarget.releasePointerCapture(event.pointerId);
        if (session.kind === "overlay") {
            setOverlayDraft(null);
            const area = redactionAreaForPointerCommit(session.area, session.latest, cancelled);
            if (area !== undefined) onOverlayAreaCommit(session.id, area);
            return;
        }
        if (session.kind === "zoom") {
            setZoomFocus(null);
            if (!cancelled) onZoomFocusCommit(session.latest);
            return;
        }
        if (session.kind === "crop") {
            setCropSelection(cancelled ? session.selection : session.latest);
            return;
        }
        if (!cancelled && session.moved && session.latest) onTransformCommit(session.latest.patch);
        setDraft(null);
    };

    const handleScreenKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.repeat) return;
        if (zoomMode && selectedZoom !== undefined && event.key.startsWith("Arrow")) {
            event.preventDefault();
            const step = event.shiftKey ? 0.025 : 0.005;
            onZoomFocusCommit({
                x: clamp01(selectedZoom.focus.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)),
                y: clamp01(selectedZoom.focus.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)),
            });
            return;
        }
        if (cropMode || !selected || !event.key.startsWith("Arrow")) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const delta = {
            x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
            y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
        };
        onTransformCommit(translateScreen(state.project, delta).patch);
    };

    const handleOverlayKeyDown = (
        redaction: ShapeOverlay,
        handle: CropHandle,
        event: ReactKeyboardEvent<HTMLElement>,
    ) => {
        if (event.repeat || !event.key.startsWith("Arrow")) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.025 : 0.005;
        const area = resizeCropRect(redaction.area, handle, {
            x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
            y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
        });
        if (!normalizedRectsEqual(redaction.area, area)) onOverlayAreaCommit(redaction.id, area);
    };

    return (
        <div className="editor-stage" aria-label="Media preview">
            <div
                className="editor-artboard"
                onPointerDown={(event) => {
                    if (event.target === event.currentTarget && !cropMode && !zoomMode) setSelected(false);
                }}
                onLostPointerCapture={(event) => finishPointerSession(event, true)}
                onPointerCancel={(event) => finishPointerSession(event, true)}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerSession}
                ref={artboardRef}
                style={{
                    aspectRatio: String(canvas.width / canvas.height),
                    backgroundImage: `url(${backgroundSource})`,
                    maxHeight: "none",
                    width: `min(91cqw, 920px, calc((100cqh - 8px) * ${canvas.width / canvas.height}))`,
                }}
            >
                <div
                    aria-describedby="editor-stage-status"
                    aria-label={cropMode ? "Video crop area" : zoomMode ? "Video zoom focus. Drag to reposition the selected zoom focus." : "Video layer. Drag to reposition; use corner handles to resize."}
                    aria-selected={layerSelected}
                    className={`editor-screen-shell${layerSelected ? " is-selected" : ""}${cropMode ? " is-cropping" : ""}${zoomMode ? " is-zooming" : ""}${draft ? " is-manipulating" : ""}`}
                    onKeyDown={handleScreenKeyDown}
                    onLostPointerCapture={(event) => finishPointerSession(event, true)}
                    onPointerCancel={(event) => finishPointerSession(event, true)}
                    onPointerDown={beginScreenMove}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishPointerSession}
                    ref={shellRef}
                    role="group"
                    style={{
                        left: `${displayRect.x / canvas.width * 100}%`,
                        top: `${displayRect.y / canvas.height * 100}%`,
                        width: `${displayRect.width / canvas.width * 100}%`,
                        height: `${displayRect.height / canvas.height * 100}%`,
                        borderRadius: `${draftGeometry.layout.cornerRadiusPx * canvasUnit}cqw`,
                        border: canvas.screen.border.widthPx > 0 && canvas.screen.border.opacity > 0
                            ? `${canvas.screen.border.widthPx * canvasUnit}cqw solid color-mix(in srgb, ${canvas.screen.border.color} ${canvas.screen.border.opacity * 100}%, transparent)`
                            : "0 solid transparent",
                        boxShadow: previewScreenBoxShadow(canvas.screen.shadow, canvas.width),
                    }}
                    tabIndex={0}
                >
                    <div className="demo-recording real-media-preview">
                        <div
                            className="real-media-preview__zoom"
                            style={{ inset: 0, pointerEvents: "none", position: "absolute", transform: mediaTransform, transformOrigin: "0 0", transition: "none" }}
                        >
                            {media?.kind === "video" ? (
                                <video
                                    aria-label={`Preview of ${media.name}`}
                                    className="real-media-preview__element"
                                    draggable={false}
                                    muted={previewVolume === 0}
                                    playsInline
                                    preload="auto"
                                    ref={videoRef}
                                    src={media.url}
                                    style={{ position: "absolute", left: `${-displayCrop.x / displayCrop.width * 100}%`, top: `${-displayCrop.y / displayCrop.height * 100}%`, width: `${100 / displayCrop.width}%`, height: `${100 / displayCrop.height}%`, objectFit: "fill" }}
                                />
                            ) : media?.kind === "image" ? (
                                <img alt={`Preview of ${media.name}`} className="real-media-preview__element" draggable={false} src={media.url} style={{ position: "absolute", left: `${-displayCrop.x / displayCrop.width * 100}%`, top: `${-displayCrop.y / displayCrop.height * 100}%`, width: `${100 / displayCrop.width}%`, height: `${100 / displayCrop.height}%`, objectFit: "fill" }} />
                            ) : (
                                <div className="real-media-preview__empty"><strong>Media unavailable</strong><span>Return to the library and choose a local recording.</span></div>
                            )}
                        </div>
                    </div>

                    {zoomMode && selectedZoom && markerPosition ? (
                        <span
                            aria-hidden="true"
                            className="editor-zoom-focus"
                            style={{ left: `${markerPosition.x * 100}%`, pointerEvents: "none", position: "absolute", top: `${markerPosition.y * 100}%` }}
                        ><i /></span>
                    ) : null}

                    {selected && !cropMode && !zoomMode ? (
                        <div aria-hidden="true" className="editor-resize-controls">
                            {RESIZE_HANDLES.map((handle) => (
                                <span className="editor-resize-handle" data-handle={handle} key={handle} onPointerDown={(event) => beginResize(handle, event)} />
                            ))}
                        </div>
                    ) : null}

                    {cropMode ? (
                        <div className="editor-crop-layer">
                            <div
                                className="editor-crop-selection"
                                onPointerDown={(event) => beginCrop("move", event)}
                                style={{
                                    left: `${cropSelection.x * 100}%`,
                                    top: `${cropSelection.y * 100}%`,
                                    width: `${cropSelection.width * 100}%`,
                                    height: `${cropSelection.height * 100}%`,
                                }}
                            >
                                <span aria-hidden="true" className="editor-crop-grid" />
                                {CROP_HANDLES.map((handle) => (
                                    <span aria-hidden="true" className="editor-crop-handle" data-handle={handle} key={handle} onPointerDown={(event) => beginCrop(handle, event)} />
                                ))}
                            </div>
                            <div className="editor-crop-actions">
                                <button className="button button--secondary" onClick={cancelCrop} type="button">Cancel</button>
                                <button className="button button--primary" onClick={applyCrop} type="button"><span>Apply crop</span></button>
                            </div>
                            <span className="editor-crop-hint">Shift locks ratio</span>
                        </div>
                    ) : null}
                </div>
                <div className={`preview-overlay-layer${redactMode ? " is-redacting" : ""}`} aria-hidden={redactMode ? undefined : true}>
                    {visualOverlays.map((overlay) => {
                        if (overlay.kind === "blur-mask") return <span className="preview-overlay preview-overlay--blur" key={overlay.id} style={{ left: `${overlay.area.x * 100}%`, top: `${overlay.area.y * 100}%`, width: `${overlay.area.width * 100}%`, height: `${overlay.area.height * 100}%`, backdropFilter: `blur(${overlay.blurPx}px)`, opacity: overlay.opacity }} />;
                        if (overlay.kind === "spotlight") return <span className="preview-overlay preview-overlay--spotlight" key={overlay.id} style={{ left: `${overlay.area.x * 100}%`, top: `${overlay.area.y * 100}%`, width: `${overlay.area.width * 100}%`, height: `${overlay.area.height * 100}%`, boxShadow: `0 0 0 9999px color-mix(in srgb, ${overlay.dimColor} ${overlay.dimOpacity * overlay.opacity * 100}%, transparent)` }} />;
                        if (isSafeRedaction(overlay)) {
                            const area = overlayDraft?.id === overlay.id ? overlayDraft.area : overlay.area;
                            const selectedOverlay = redactMode && state.selectedOverlayId === overlay.id;
                            return (
                                <span
                                    aria-label="Opaque redaction. Drag to move; use handles to resize."
                                    aria-selected={selectedOverlay}
                                    className={`preview-overlay preview-overlay--redaction${selectedOverlay ? " is-selected" : ""}`}
                                    key={overlay.id}
                                    onKeyDown={(event) => handleOverlayKeyDown({ ...overlay, area }, "move", event)}
                                    onPointerDown={(event) => beginOverlay({ ...overlay, area }, "move", event)}
                                    role={redactMode ? "group" : undefined}
                                    style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%`, background: overlay.fillColor }}
                                    tabIndex={selectedOverlay ? 0 : -1}
                                >
                                    {selectedOverlay ? CROP_HANDLES.map((handle) => (
                                        <button
                                            aria-label={`Resize redaction from ${handle}`}
                                            className="editor-redaction-handle"
                                            data-handle={handle}
                                            key={handle}
                                            onKeyDown={(event) => handleOverlayKeyDown({ ...overlay, area }, handle, event)}
                                            onPointerDown={(event) => beginOverlay({ ...overlay, area }, handle, event)}
                                            type="button"
                                        />
                                    )) : null}
                                </span>
                            );
                        }
                        return null;
                    })}
                    {activeCaptions.map((caption) => {
                        const style = resolveCaptionStyle(caption.style);
                        return <span className="preview-caption" data-align={style.align} key={caption.id} style={captionPreviewStyle(style, canvas)}>{caption.text}</span>;
                    })}
                </div>
            </div>
            <div className="stage-status" id="editor-stage-status">
                <span>{state.project.aspectRatio} · {media?.name ?? "No source"}</span>
                <span>{cropMode ? "Crop · drag edges, then apply" : redactMode ? "Redact · drag to move · handles resize" : zoomMode ? selectedZoom ? "Zoom focus · click or drag on the video" : "Select or add a zoom on the timeline" : selected ? "Drag to move · corners resize · Shift frees ratio" : projectDuration(state.project) > 0 ? "Click video to transform" : "No timeline media"}</span>
            </div>
        </div>
    );
}

function sourceAudioPercent(clips: readonly EditorClip[]): number | undefined {
    if (clips.some((clip) => clip.sourceAudio === undefined)) return undefined;
    const audible = clips.flatMap((clip) => clip.sourceAudio?.mode === "mute" ? [] : [clip.sourceAudio!]);
    if (audible.length === 0) return 0;
    const averageGainDb = audible.reduce((sum, audio) => sum + audio.gainDb, 0) / audible.length;
    return Math.min(100, Math.max(0, Math.round(100 * (10 ** (averageGainDb / 20)))));
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

export function isEditorShortcutTarget(target: EventTarget | null): boolean {
    const element = target as { closest?: (selector: string) => Element | null } | null;
    return typeof element?.closest === "function"
        && element.closest("button, input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']") !== null;
}

function normalizedRectsEqual(left: NormalizedRect, right: NormalizedRect): boolean {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

export function redactionAreaForPointerCommit(
    original: NormalizedRect,
    latest: NormalizedRect,
    cancelled: boolean,
): NormalizedRect | undefined {
    return cancelled || normalizedRectsEqual(original, latest) ? undefined : { ...latest };
}
