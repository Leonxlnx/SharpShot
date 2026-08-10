import { useEffect, useMemo, useRef, useState } from "react";
import { clipDuration, formatTime, projectDuration, trimRangeForDrag, type EditorAction, type TrimSide } from "../state";
import type { Dispatch, PointerEvent as ReactPointerEvent } from "react";
import type { EditorClip, EditorState } from "../types";
import { Icon } from "./Icon";
import { RangeInput } from "./ui";
import { clipTimelineEndUs, sourceDurationToTimelineUs, trimAudioClip, type AudioClip, type AudioTimeline } from "../../shared/audio-timeline";
import { SOURCE_AUDIO_LANE_ID } from "../../shared/project-audio";
import type { ZoomSegment } from "../../shared/cursor-zoom";
import { resizeZoomSegmentRange, zoomSegmentPlacement, type ZoomEdge, type ZoomRange } from "../zoom-timeline";
import { createFrameCoalescer } from "../frame-coalescer";
import type { OverlayDocument, ShapeOverlay } from "../../shared/overlays";
import {
    resizeSafeRedactionRange,
    safeRedactions,
    setSafeRedactionRange,
    type SafeRedactionEdge,
} from "../safe-redaction";

interface TrimDrag {
    pointerId: number;
    clip: EditorClip;
    before: EditorState["project"];
    side: TrimSide;
    startX: number;
    trackWidth: number;
    duration: number;
    sourceStart: number;
    sourceEnd: number;
}

interface ZoomDrag {
    pointerId: number;
    segment: ZoomSegment;
    edge: ZoomEdge;
    latest: ZoomRange;
    bounds: HorizontalPointerBounds;
}

interface SeekDrag {
    pointerId: number;
    bounds: HorizontalPointerBounds;
}

interface RedactionDrag {
    pointerId: number;
    redaction: ShapeOverlay;
    edge: SafeRedactionEdge;
    latest: ShapeOverlay;
    bounds: HorizontalPointerBounds;
    captureTarget: HTMLButtonElement;
    before: OverlayDocument;
}

export interface HorizontalPointerBounds {
    left: number;
    width: number;
}

export interface AudioTrimDrag {
    pointerId: number;
    before: AudioTimeline;
    laneId: string;
    clip: AudioClip;
    side: TrimSide;
    startX: number;
    trackWidth: number;
    projectDurationUs: number;
    latest: AudioClip;
}

interface AudioTrimDraft {
    laneId: string;
    clipId: string;
    clip: AudioClip;
}

type TimelineDraftUpdate =
    | { kind: "seek"; time: number }
    | { kind: "trim"; value: { id: string; sourceStart: number; sourceEnd: number } }
    | { kind: "zoom"; value: { id: string; range: ZoomRange } }
    | { kind: "redaction"; value: ShapeOverlay }
    | { kind: "audio-trim"; value: AudioTrimDraft };

const MAX_TIMELINE_TICKS = 120;

export function timelineTicks(duration: number, maximumTicks = MAX_TIMELINE_TICKS): number[] {
    if (!Number.isFinite(duration) || duration <= 0) return [0];
    const limit = Math.max(2, Math.floor(maximumTicks));
    const rawStep = duration / (limit - 1);
    const step = rawStep <= 2 ? 2 : niceTimelineStep(rawStep);
    const count = Math.min(limit, Math.floor(duration / step) + 1);
    return Array.from({ length: count }, (_, index) => index * step);
}

export function readHorizontalPointerBounds(
    element: Pick<HTMLElement, "getBoundingClientRect">,
): HorizontalPointerBounds {
    const { left, width } = element.getBoundingClientRect();
    return { left, width };
}

export function horizontalValueForClientX(
    clientX: number,
    bounds: HorizontalPointerBounds,
    extent: number,
): number {
    if (!Number.isFinite(clientX) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.width)
        || bounds.width <= 0 || !Number.isFinite(extent) || extent <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return ratio * extent;
}

function niceTimelineStep(rawStep: number): number {
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return Math.max(2, multiplier * magnitude);
}

export function audioTrimForClientX(drag: AudioTrimDrag, clientX: number): AudioClip {
    if (!Number.isFinite(clientX) || !Number.isFinite(drag.trackWidth) || drag.trackWidth <= 0) return drag.latest;
    const deltaUs = Math.round((clientX - drag.startX) / drag.trackWidth * drag.projectDurationUs);
    if (deltaUs === 0) return drag.clip;

    const clipStartUs = drag.clip.timelineStartUs;
    const clipEndUs = clipTimelineEndUs(drag.clip);
    const boundedEndUs = Math.min(clipEndUs, drag.before.durationUs, drag.projectDurationUs);
    const minimumDurationUs = Math.min(
        clipEndUs - clipStartUs,
        sourceDurationToTimelineUs(1, drag.clip.playbackRate),
    );
    if (boundedEndUs < clipStartUs + minimumDurationUs) return drag.latest;

    const timelineInUs = drag.side === "start"
        ? Math.max(clipStartUs, Math.min(clipStartUs + deltaUs, boundedEndUs - minimumDurationUs))
        : clipStartUs;
    const timelineOutUs = drag.side === "end"
        ? Math.max(clipStartUs + minimumDurationUs, Math.min(clipEndUs + deltaUs, boundedEndUs))
        : boundedEndUs;
    try {
        return trimAudioClip(drag.clip, { timelineInUs, timelineOutUs });
    } catch {
        return drag.latest;
    }
}

function sameAudioTrim(left: AudioClip, right: AudioClip): boolean {
    return left.timelineStartUs === right.timelineStartUs
        && left.sourceInUs === right.sourceInUs
        && left.sourceOutUs === right.sourceOutUs
        && left.fadeInUs === right.fadeInUs
        && left.fadeOutUs === right.fadeOutUs;
}

export function audioTimelineForTrimCommit(options: {
    before: AudioTimeline;
    current: AudioTimeline | undefined;
    laneId: string;
    original: AudioClip;
    latest: AudioClip;
    commit: boolean;
}): AudioTimeline | undefined {
    if (!options.commit || options.current !== options.before || sameAudioTrim(options.original, options.latest)) return undefined;
    let replaced = false;
    const lanes = options.before.lanes.map((lane) => lane.id !== options.laneId
        ? lane
        : {
            ...lane,
            clips: lane.clips.map((clip) => {
                if (clip.id !== options.original.id) return clip;
                replaced = true;
                return options.latest;
            }),
        });
    return replaced ? { ...options.before, lanes } : undefined;
}

export function redactionDocumentForTrimCommit(options: {
    before: OverlayDocument;
    current: OverlayDocument;
    original: ShapeOverlay;
    latest: ShapeOverlay;
    commit: boolean;
}): OverlayDocument | undefined {
    if (!options.commit
        || options.current !== options.before
        || (options.original.startUs === options.latest.startUs && options.original.endUs === options.latest.endUs)) {
        return undefined;
    }
    return setSafeRedactionRange(options.before, options.latest);
}

export function Timeline({ state, dispatch, sourceHasAudio }: { state: EditorState; dispatch: Dispatch<EditorAction>; sourceHasAudio: boolean }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const seekDrag = useRef<SeekDrag | null>(null);
    const trimDrag = useRef<TrimDrag | null>(null);
    const zoomDrag = useRef<ZoomDrag | null>(null);
    const redactionDrag = useRef<RedactionDrag | null>(null);
    const audioTrimDrag = useRef<AudioTrimDrag | null>(null);
    const [zoom, setZoom] = useState(100);
    const [trimDraft, setTrimDraft] = useState<{ id: string; sourceStart: number; sourceEnd: number } | null>(null);
    const [zoomDraft, setZoomDraft] = useState<{ id: string; range: ZoomRange } | null>(null);
    const [redactionDraft, setRedactionDraft] = useState<ShapeOverlay | null>(null);
    const [audioTrimDraft, setAudioTrimDraft] = useState<AudioTrimDraft | null>(null);
    const draftFrame = useMemo(() => createFrameCoalescer<TimelineDraftUpdate>(
        (callback) => window.requestAnimationFrame(callback),
        (frame) => window.cancelAnimationFrame(frame),
        (update) => {
            if (update.kind === "seek") dispatch({ type: "SET_PLAYHEAD", time: update.time });
            else if (update.kind === "trim") setTrimDraft(update.value);
            else if (update.kind === "zoom") setZoomDraft(update.value);
            else if (update.kind === "redaction") setRedactionDraft(update.value);
            else setAudioTrimDraft(update.value);
        },
    ), [dispatch]);
    useEffect(() => () => draftFrame.cancel(), [draftFrame]);
    const duration = Math.max(projectDuration(state.project), 0.001);
    const durationUs = Math.max(1, Math.round(duration * 1_000_000));
    const showCaptionTrack = state.activeTool === "captions" || state.project.overlays.captions.length > 0;
    const redactions = safeRedactions(state.project.overlays);
    const showRedactionTrack = state.activeTool === "annotations" || redactions.length > 0;
    const audioTimeline = state.project.audio;
    const savedAudioLanes = audioTimeline?.lanes.filter((lane) => lane.id !== SOURCE_AUDIO_LANE_ID) ?? [];
    const audioRowCount = (sourceHasAudio ? 1 : 0) + savedAudioLanes.length;
    const trackRows = `25px 60px 34px${showCaptionTrack ? " 34px" : ""}${showRedactionTrack ? " 34px" : ""}${audioRowCount > 0 ? ` ${Array.from({ length: audioRowCount }, () => "29px").join(" ")}` : ""}`;
    const trackHeight = 119 + (showCaptionTrack ? 34 : 0) + (showRedactionTrack ? 34 : 0) + audioRowCount * 29;
    const ticks = useMemo(() => timelineTicks(duration), [duration]);

    const seekFromClientX = (clientX: number, bounds: HorizontalPointerBounds, immediate = false) => {
        const time = horizontalValueForClientX(clientX, bounds, duration);
        if (immediate) dispatch({ type: "SET_PLAYHEAD", time });
        else draftFrame.schedule({ kind: "seek", time });
    };

    const beginSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("[data-clip-control]")) return;
        const bounds = readHorizontalPointerBounds(event.currentTarget);
        seekDrag.current = { pointerId: event.pointerId, bounds };
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromClientX(event.clientX, bounds, true);
    };

    const moveSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = seekDrag.current;
        if (drag === null || drag.pointerId !== event.pointerId || event.buttons !== 1) return;
        seekFromClientX(event.clientX, drag.bounds);
    };

    const finishSeek = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
        const drag = seekDrag.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        if (commit) {
            draftFrame.schedule({ kind: "seek", time: horizontalValueForClientX(event.clientX, drag.bounds, duration) });
            draftFrame.flush();
        } else {
            draftFrame.cancel();
        }
        seekDrag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const beginTrim = (event: ReactPointerEvent<HTMLButtonElement>, clip: EditorClip, side: TrimSide) => {
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0) return;
        const trackWidth = trackRef.current?.getBoundingClientRect().width ?? 1;
        trimDrag.current = {
            pointerId: event.pointerId,
            clip,
            before: state.project,
            side,
            startX: event.clientX,
            trackWidth,
            duration,
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveTrim = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const drag = trimDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const range = trimRangeForDrag(drag.clip, drag.side, drag.startX, event.clientX, drag.trackWidth, drag.duration);
        drag.sourceStart = range.sourceStart;
        drag.sourceEnd = range.sourceEnd;
        draftFrame.schedule({ kind: "trim", value: { id: drag.clip.id, ...range } });
    };

    const finishTrim = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
        event.stopPropagation();
        const drag = trimDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        draftFrame.cancel();
        trimDrag.current = null;
        if (commit) {
            const range = trimRangeForDrag(drag.clip, drag.side, drag.startX, event.clientX, drag.trackWidth, drag.duration);
            drag.sourceStart = range.sourceStart;
            drag.sourceEnd = range.sourceEnd;
            dispatch({ type: "COMMIT_TRIM_CLIP", before: drag.before, id: drag.clip.id, side: drag.side, sourceStart: drag.sourceStart, sourceEnd: drag.sourceEnd });
        }
        setTrimDraft(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const beginZoomResize = (event: ReactPointerEvent<HTMLButtonElement>, segment: ZoomSegment, edge: ZoomEdge) => {
        event.preventDefault();
        event.stopPropagation();
        const track = trackRef.current;
        if (!track) return;
        const latest = {
            startUs: segment.startUs,
            endUs: segment.endUs,
            easeInUs: segment.easeInUs,
            easeOutUs: segment.easeOutUs,
        };
        zoomDrag.current = {
            pointerId: event.pointerId,
            segment,
            edge,
            latest,
            bounds: readHorizontalPointerBounds(track),
        };
        setZoomDraft({ id: segment.id, range: latest });
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveZoomResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const drag = zoomDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const requestedUs = horizontalValueForClientX(event.clientX, drag.bounds, durationUs);
        const range = resizeZoomSegmentRange(
            state.project.zoomSegments,
            drag.segment.id,
            drag.edge,
            requestedUs,
            durationUs,
        );
        if (range === undefined) return;
        drag.latest = range;
        draftFrame.schedule({ kind: "zoom", value: { id: drag.segment.id, range } });
    };

    const finishZoomResize = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
        event.preventDefault();
        event.stopPropagation();
        const drag = zoomDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        draftFrame.cancel();
        zoomDrag.current = null;
        setZoomDraft(null);
        if (commit && (
            drag.latest.startUs !== drag.segment.startUs
            || drag.latest.endUs !== drag.segment.endUs
            || drag.latest.easeInUs !== drag.segment.easeInUs
            || drag.latest.easeOutUs !== drag.segment.easeOutUs
        )) {
            dispatch({
                type: "EDIT_ZOOM",
                operation: { type: "zoom.update", id: drag.segment.id, changes: drag.latest },
            });
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const beginRedactionResize = (event: ReactPointerEvent<HTMLButtonElement>, redaction: ShapeOverlay, edge: SafeRedactionEdge) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0 || !trackRef.current) return;
        redactionDrag.current = {
            pointerId: event.pointerId,
            redaction,
            edge,
            latest: redaction,
            bounds: readHorizontalPointerBounds(trackRef.current),
            captureTarget: event.currentTarget,
            before: state.project.overlays,
        };
        dispatch({ type: "SET_TOOL", tool: "annotations" });
        dispatch({ type: "SELECT_OVERLAY", id: redaction.id });
        setRedactionDraft(redaction);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveRedactionResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const drag = redactionDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.latest = resizeSafeRedactionRange(
            drag.redaction,
            drag.edge,
            horizontalValueForClientX(event.clientX, drag.bounds, durationUs),
            durationUs,
        );
        draftFrame.schedule({ kind: "redaction", value: drag.latest });
    };

    const finishRedactionResize = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
        event.preventDefault();
        event.stopPropagation();
        const drag = redactionDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        draftFrame.cancel();
        redactionDrag.current = null;
        setRedactionDraft(null);
        if (commit) {
            drag.latest = resizeSafeRedactionRange(
                drag.redaction,
                drag.edge,
                horizontalValueForClientX(event.clientX, drag.bounds, durationUs),
                durationUs,
            );
            const document = redactionDocumentForTrimCommit({
                before: drag.before,
                current: state.project.overlays,
                original: drag.redaction,
                latest: drag.latest,
                commit: true,
            });
            if (document !== undefined) {
                dispatch({
                    type: "EDIT_OVERLAYS",
                    document,
                    selectedOverlayId: drag.redaction.id,
                });
            }
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    useEffect(() => {
        const cancelRedactionTrim = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || redactionDrag.current === null) return;
            event.preventDefault();
            draftFrame.cancel();
            const drag = redactionDrag.current;
            redactionDrag.current = null;
            setRedactionDraft(null);
            if (drag.captureTarget.hasPointerCapture(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
        };
        window.addEventListener("keydown", cancelRedactionTrim);
        return () => window.removeEventListener("keydown", cancelRedactionTrim);
    }, [draftFrame]);

    const beginAudioTrim = (event: ReactPointerEvent<HTMLButtonElement>, laneId: string, clip: AudioClip, side: TrimSide) => {
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0 || audioTimeline === undefined) return;
        audioTrimDrag.current = {
            pointerId: event.pointerId,
            before: audioTimeline,
            laneId,
            clip,
            side,
            startX: event.clientX,
            trackWidth: trackRef.current?.getBoundingClientRect().width ?? 1,
            projectDurationUs: durationUs,
            latest: clip,
        };
        dispatch({ type: "SET_TOOL", tool: "audio" });
        dispatch({ type: "SELECT_AUDIO_CLIP", id: clip.id });
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveAudioTrim = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const drag = audioTrimDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.latest = audioTrimForClientX(drag, event.clientX);
        draftFrame.schedule({
            kind: "audio-trim",
            value: { laneId: drag.laneId, clipId: drag.clip.id, clip: drag.latest },
        });
    };

    const finishAudioTrim = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
        event.stopPropagation();
        const drag = audioTrimDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        draftFrame.cancel();
        audioTrimDrag.current = null;
        if (commit) drag.latest = audioTrimForClientX(drag, event.clientX);
        setAudioTrimDraft(null);
        const timeline = audioTimelineForTrimCommit({
            before: drag.before,
            current: state.project.audio,
            laneId: drag.laneId,
            original: drag.clip,
            latest: drag.latest,
            commit,
        });
        if (timeline !== undefined) {
            dispatch({ type: "EDIT_AUDIO", timeline, selectedAudioClipId: drag.clip.id });
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const selectedZoom = state.activeTool === "zoom"
        ? state.project.zoomSegments.find((segment) => segment.id === state.selectedZoomId)
        : undefined;
    const selectedCaption = state.activeTool === "captions"
        ? state.project.overlays.captions.find((cue) => cue.id === state.selectedCaptionId)
        : undefined;
    const selectedRedaction = state.activeTool === "annotations"
        ? redactions.find((redaction) => redaction.id === state.selectedOverlayId)
        : undefined;
    const selectedAudio = state.activeTool === "audio"
        ? savedAudioLanes.filter((lane) => lane.kind === "music").flatMap((lane) => lane.clips).find((clip) => clip.id === state.selectedAudioClipId)
        : undefined;
    const deleteSelection = () => {
        if (state.activeTool === "audio" || selectedRedaction !== undefined) {
            dispatch({ type: "REMOVE_SELECTED" });
        } else if (selectedZoom !== undefined) {
            dispatch({ type: "EDIT_ZOOM", operation: { type: "zoom.delete", id: selectedZoom.id } });
        } else if (selectedCaption !== undefined) {
            dispatch({
                type: "EDIT_OVERLAYS",
                document: {
                    ...state.project.overlays,
                    captions: state.project.overlays.captions.filter((cue) => cue.id !== selectedCaption.id),
                },
                selectedCaptionId: null,
            });
        } else {
            dispatch({ type: "REMOVE_SELECTED" });
        }
    };
    const renderedZoomSegments = state.project.zoomSegments.map((segment) => zoomDraft?.id === segment.id
        ? { ...segment, ...zoomDraft.range }
        : segment);
    const renderedClips = state.project.clips.map((clip) => trimDraft?.id === clip.id
        ? { ...clip, sourceStart: trimDraft.sourceStart, sourceEnd: trimDraft.sourceEnd }
        : clip);
    const renderedRedactions = redactions.map((redaction) => redactionDraft?.id === redaction.id ? redactionDraft : redaction);

    return (
        <section className="timeline" aria-label="Timeline editor">
            <div className="timeline-toolbar">
                <div className="transport-controls">
                    <button className="transport-play" aria-label={state.playing ? "Pause" : "Play"} onClick={() => dispatch({ type: "SET_PLAYING", playing: !state.playing })} type="button"><Icon name={state.playing ? "pause" : "play"} size={15} /></button>
                    <span className="timecode"><strong>{formatTime(state.playhead, true)}</strong><small>/ {formatTime(duration, true)}</small></span>
                </div>
                <div className="edit-controls">
                    <button onClick={() => dispatch({ type: "SPLIT" })} title="Split at playhead (S)" type="button"><Icon name="split" size={16} /> Split</button>
                    <button disabled={state.activeTool === "audio" ? selectedAudio === undefined : selectedZoom === undefined && selectedCaption === undefined && selectedRedaction === undefined && state.project.clips.length <= 1} onClick={deleteSelection} title={selectedAudio !== undefined ? "Delete selected audio (Delete)" : selectedZoom !== undefined ? "Delete selected zoom (Delete)" : selectedCaption !== undefined ? "Delete selected caption (Delete)" : selectedRedaction !== undefined ? "Delete selected redaction (Delete)" : "Ripple delete (Delete)"} type="button"><Icon name="trash" size={15} /> Delete</button>
                </div>
                <div className="timeline-zoom"><Icon name="minimize" size={13} /><RangeInput ariaLabel="Timeline zoom" min={100} max={220} onChange={setZoom} value={zoom} /><Icon name="plus" size={13} /></div>
            </div>

            <div className="timeline-body">
                <div className="track-labels" aria-hidden="true" style={{ gridTemplateRows: trackRows, height: `${trackHeight}px` }}>
                    <div className="ruler-label">Time</div>
                    <div><span className="track-type-icon"><Icon name="video" size={13} /></span><span><strong>Screen</strong><small>Main recording</small></span></div>
                    <div><span className="track-type-icon"><Icon name="zoom" size={13} /></span><span><strong>Zoom</strong><small>Focus moves</small></span></div>
                    {showCaptionTrack ? <div><span className="track-type-icon"><Icon name="captions" size={13} /></span><span><strong>Captions</strong><small>Burned in</small></span></div> : null}
                    {showRedactionTrack ? <div><span className="track-type-icon"><Icon name="redact" size={13} /></span><span><strong>Redact</strong><small>Opaque</small></span></div> : null}
                    {sourceHasAudio ? <div><span className="track-type-icon"><Icon name="waveform" size={13} /></span><span><strong>Source</strong><small>Embedded audio</small></span></div> : null}
                    {savedAudioLanes.map((lane) => <div key={lane.id}><span className="track-type-icon"><Icon name="audio" size={13} /></span><span><strong>{lane.name}</strong><small>{lane.kind === "music" ? "Imported music" : `${lane.kind === "microphone" ? "Microphone" : "System audio"} · read-only`}</small></span></div>)}
                </div>
                <div className="timeline-viewport" ref={viewportRef}>
                    <div className="timeline-tracks" ref={trackRef} style={{ width: `${zoom}%`, gridTemplateRows: trackRows, height: `${trackHeight}px` }} onLostPointerCapture={(event) => finishSeek(event, false)} onPointerCancel={(event) => finishSeek(event, false)} onPointerDown={beginSeek} onPointerMove={moveSeek} onPointerUp={(event) => finishSeek(event, true)}>
                        <div className="timeline-ruler">
                            {ticks.map((tick) => <span key={tick} style={{ left: `${tick / duration * 100}%` }}><i />{formatTime(tick)}</span>)}
                        </div>
                        <div className="video-track">
                            {renderedClips.map((clip) => {
                                const width = clipDuration(clip) / duration * 100;
                                const selected = clip.id === state.selectedClipId;
                                return (
                                    <div className={`timeline-clip${selected ? " is-selected" : ""}`} data-clip-control key={clip.id} onClick={(event) => { event.stopPropagation(); dispatch({ type: "SELECT_CLIP", id: clip.id }); }} style={{ width: `${width}%`, "--clip-accent": clip.color } as React.CSSProperties}>
                                        <button className="trim-handle trim-handle--start" aria-label={`Trim start of ${clip.name}`} data-clip-control onLostPointerCapture={(event) => finishTrim(event, false)} onPointerCancel={(event) => finishTrim(event, false)} onPointerDown={(event) => beginTrim(event, clip, "start")} onPointerMove={moveTrim} onPointerUp={(event) => finishTrim(event, true)} type="button"><i /></button>
                                        <div className="clip-thumbnails clip-thumbnails--source" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>
                                        <span className="clip-label"><strong>{clip.name}</strong>{clip.speed !== 1 ? <em>{clip.speed}×</em> : null}</span>
                                        <button className="trim-handle trim-handle--end" aria-label={`Trim end of ${clip.name}`} data-clip-control onLostPointerCapture={(event) => finishTrim(event, false)} onPointerCancel={(event) => finishTrim(event, false)} onPointerDown={(event) => beginTrim(event, clip, "end")} onPointerMove={moveTrim} onPointerUp={(event) => finishTrim(event, true)} type="button"><i /></button>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="zoom-track">
                            {renderedZoomSegments.map((segment) => {
                                const placement = zoomSegmentPlacement(segment, durationUs);
                                const selected = segment.id === state.selectedZoomId;
                                return (
                                    <div
                                        aria-label={`${segment.scale.toFixed(1)} times zoom from ${formatTime(segment.startUs / 1_000_000)} to ${formatTime(segment.endUs / 1_000_000)}`}
                                        className={`timeline-zoom-segment${selected ? " is-selected" : ""}`}
                                        data-clip-control
                                        key={segment.id}
                                        style={{ left: `${placement.leftPercent}%`, position: "absolute", width: `${placement.widthPercent}%` }}
                                    >
                                        <button aria-label="Adjust zoom start" className="zoom-trim-handle zoom-trim-handle--start" data-clip-control onLostPointerCapture={(event) => finishZoomResize(event, false)} onPointerCancel={(event) => finishZoomResize(event, false)} onPointerDown={(event) => beginZoomResize(event, segment, "start")} onPointerMove={moveZoomResize} onPointerUp={(event) => finishZoomResize(event, true)} type="button"><i /></button>
                                        <button
                                            aria-pressed={selected}
                                            className="timeline-zoom-segment__select"
                                            data-clip-control
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                dispatch({ type: "SET_TOOL", tool: "zoom" });
                                                dispatch({ type: "SELECT_ZOOM", id: segment.id });
                                                dispatch({ type: "SET_PLAYHEAD", time: (segment.startUs + segment.endUs) / 2_000_000 });
                                            }}
                                            type="button"
                                        ><Icon name="zoom" size={12} /> {segment.scale.toFixed(1)}×</button>
                                        <button aria-label="Adjust zoom end" className="zoom-trim-handle zoom-trim-handle--end" data-clip-control onLostPointerCapture={(event) => finishZoomResize(event, false)} onPointerCancel={(event) => finishZoomResize(event, false)} onPointerDown={(event) => beginZoomResize(event, segment, "end")} onPointerMove={moveZoomResize} onPointerUp={(event) => finishZoomResize(event, true)} type="button"><i /></button>
                                    </div>
                                );
                            })}
                        </div>
                        {showCaptionTrack ? (
                            <div className="zoom-track caption-track">
                                {state.project.overlays.captions.filter((cue) => cue.endUs > 0 && cue.startUs < durationUs).map((cue) => {
                                    const startUs = Math.max(0, cue.startUs);
                                    const endUs = Math.min(durationUs, cue.endUs);
                                    const leftPercent = startUs / durationUs * 100;
                                    const widthPercent = Math.max(0.35, (endUs - startUs) / durationUs * 100);
                                    const selected = cue.id === state.selectedCaptionId;
                                    return (
                                        <div className={`timeline-zoom-segment timeline-caption-cue${selected ? " is-selected" : ""}`} data-clip-control key={cue.id} style={{ left: `${leftPercent}%`, position: "absolute", width: `${widthPercent}%` }}>
                                            <button
                                                aria-label={`Caption ${cue.text} from ${formatTime(cue.startUs / 1_000_000)} to ${formatTime(cue.endUs / 1_000_000)}`}
                                                aria-pressed={selected}
                                                className="timeline-zoom-segment__select"
                                                data-clip-control
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    dispatch({ type: "SET_TOOL", tool: "captions" });
                                                    dispatch({ type: "SELECT_CAPTION", id: cue.id });
                                                    dispatch({ type: "SET_PLAYHEAD", time: (cue.startUs + cue.endUs) / 2_000_000 });
                                                }}
                                                title={cue.text}
                                                type="button"
                                            ><Icon name="captions" size={12} /><span>{cue.text}</span></button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                        {showRedactionTrack ? (
                            <div className="zoom-track redaction-track">
                                {renderedRedactions.filter((redaction) => redaction.endUs > 0 && redaction.startUs < durationUs).map((redaction, index) => {
                                    const startUs = Math.max(0, redaction.startUs);
                                    const endUs = Math.min(durationUs, redaction.endUs);
                                    const selected = redaction.id === state.selectedOverlayId;
                                    return (
                                        <div
                                            className={`timeline-zoom-segment timeline-redaction-cue${selected ? " is-selected" : ""}`}
                                            data-clip-control
                                            key={redaction.id}
                                            style={{ left: `${startUs / durationUs * 100}%`, position: "absolute", width: `${Math.max(0.35, (endUs - startUs) / durationUs * 100)}%`, "--redaction-color": redaction.fillColor } as React.CSSProperties}
                                        >
                                            <button aria-label={`Trim start of redaction ${index + 1}`} className="zoom-trim-handle zoom-trim-handle--start redaction-trim-handle" data-clip-control onLostPointerCapture={(event) => finishRedactionResize(event, false)} onPointerCancel={(event) => finishRedactionResize(event, false)} onPointerDown={(event) => beginRedactionResize(event, redaction, "start")} onPointerMove={moveRedactionResize} onPointerUp={(event) => finishRedactionResize(event, true)} type="button"><i /></button>
                                            <button
                                                aria-label={`Redaction ${index + 1} from ${formatTime(redaction.startUs / 1_000_000)} to ${formatTime(redaction.endUs / 1_000_000)}`}
                                                aria-pressed={selected}
                                                className="timeline-zoom-segment__select timeline-redaction-cue__select"
                                                data-clip-control
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    dispatch({ type: "SET_TOOL", tool: "annotations" });
                                                    dispatch({ type: "SELECT_OVERLAY", id: redaction.id });
                                                    dispatch({ type: "SET_PLAYHEAD", time: (redaction.startUs + redaction.endUs) / 2_000_000 });
                                                }}
                                                type="button"
                                            ><Icon name="redact" size={12} /><span>Redaction {index + 1}</span></button>
                                            <button aria-label={`Trim end of redaction ${index + 1}`} className="zoom-trim-handle zoom-trim-handle--end redaction-trim-handle" data-clip-control onLostPointerCapture={(event) => finishRedactionResize(event, false)} onPointerCancel={(event) => finishRedactionResize(event, false)} onPointerDown={(event) => beginRedactionResize(event, redaction, "end")} onPointerMove={moveRedactionResize} onPointerUp={(event) => finishRedactionResize(event, true)} type="button"><i /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                        {sourceHasAudio ? <div className="audio-track audio-track--system audio-track--status"><span>Embedded source audio</span></div> : null}
                        {savedAudioLanes.map((lane) => (
                            <div className={`audio-track timeline-audio-track timeline-audio-track--${lane.kind}`} key={lane.id} style={{ padding: 0, position: "relative" }}>
                                {lane.clips.map((clip) => {
                                    const renderedClip = audioTrimDraft?.laneId === lane.id && audioTrimDraft.clipId === clip.id
                                        ? audioTrimDraft.clip
                                        : clip;
                                    const clipStartUs = Math.max(0, renderedClip.timelineStartUs);
                                    const clipEndUs = Math.min(durationUs, clipTimelineEndUs(renderedClip));
                                    if (clipStartUs >= durationUs || clipEndUs <= clipStartUs) return null;
                                    const selected = renderedClip.id === state.selectedAudioClipId;
                                    const assetName = audioTimeline?.assets[renderedClip.assetId]?.name ?? lane.name;
                                    const placement = { left: `${clipStartUs / durationUs * 100}%`, position: "absolute", width: `${(clipEndUs - clipStartUs) / durationUs * 100}%` } as const;
                                    if (lane.kind !== "music") {
                                        return (
                                            <div
                                                aria-label={`${assetName}, read-only audio from ${formatTime(renderedClip.timelineStartUs / 1_000_000)} to ${formatTime(clipTimelineEndUs(renderedClip) / 1_000_000)}`}
                                                className="timeline-zoom-segment timeline-audio-clip timeline-audio-clip--read-only"
                                                key={renderedClip.id}
                                                style={{ ...placement, gridTemplateColumns: "minmax(0, 1fr)" }}
                                                title={`${assetName} · read-only`}
                                            ><span className="timeline-audio-clip__label">{assetName}</span></div>
                                        );
                                    }
                                    return (
                                        <div
                                            className={`timeline-zoom-segment timeline-audio-clip${selected ? " is-selected" : ""}`}
                                            data-clip-control
                                            key={renderedClip.id}
                                            style={placement}
                                        >
                                            <button aria-label={`Trim start of ${assetName}`} className="zoom-trim-handle zoom-trim-handle--start audio-trim-handle audio-trim-handle--start" data-clip-control onClick={(event) => event.stopPropagation()} onLostPointerCapture={(event) => finishAudioTrim(event, false)} onPointerCancel={(event) => finishAudioTrim(event, false)} onPointerDown={(event) => beginAudioTrim(event, lane.id, clip, "start")} onPointerMove={moveAudioTrim} onPointerUp={(event) => finishAudioTrim(event, true)} type="button"><i /></button>
                                            <button
                                                aria-label={`${assetName} from ${formatTime(renderedClip.timelineStartUs / 1_000_000)} to ${formatTime(clipTimelineEndUs(renderedClip) / 1_000_000)}`}
                                                aria-pressed={selected}
                                                className="timeline-zoom-segment__select timeline-audio-clip__select"
                                                data-clip-control
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    dispatch({ type: "SET_TOOL", tool: "audio" });
                                                    dispatch({ type: "SELECT_AUDIO_CLIP", id: renderedClip.id });
                                                    dispatch({ type: "SET_PLAYHEAD", time: renderedClip.timelineStartUs / 1_000_000 });
                                                }}
                                                title={assetName}
                                                type="button"
                                            ><Icon name="audio" size={12} /><span>{assetName}</span></button>
                                            <button aria-label={`Trim end of ${assetName}`} className="zoom-trim-handle zoom-trim-handle--end audio-trim-handle audio-trim-handle--end" data-clip-control onClick={(event) => event.stopPropagation()} onLostPointerCapture={(event) => finishAudioTrim(event, false)} onPointerCancel={(event) => finishAudioTrim(event, false)} onPointerDown={(event) => beginAudioTrim(event, lane.id, clip, "end")} onPointerMove={moveAudioTrim} onPointerUp={(event) => finishAudioTrim(event, true)} type="button"><i /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        <div className="timeline-playhead" aria-hidden="true" style={{ left: `${state.playhead / duration * 100}%` }}><i /><span /></div>
                    </div>
                </div>
            </div>
        </section>
    );
}
