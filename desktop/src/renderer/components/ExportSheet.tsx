import { useEffect, useRef, useState } from "react";
import type { ExportEvent, ExportJobSnapshot, ExportQuality, OutputFormat } from "../../shared/api";
import { cancelExport, getDesktopBridge, requestExport } from "../bridge";
import { recoverableExport } from "../export-recovery";
import { formatTime, projectDuration } from "../state";
import type { EditorProject } from "../types";
import { SOURCE_AUDIO_LANE_ID } from "../../shared/project-audio";
import { Icon } from "./Icon";
import { safeRedactions } from "../safe-redaction";
import { Segmented, Switch } from "./ui";

const ACKNOWLEDGED_EXPORT_KEY = "sharpshot.export.acknowledged-terminal-job";

export function ExportSheet({
    project,
    projectId,
    onClose,
    onComplete,
    onError,
    onPrepareExport,
    sourceHasAudio,
}: {
    project: EditorProject;
    projectId: string;
    onClose: () => void;
    onComplete: (fileName: string, warnings: string[]) => void;
    onError: (detail: string) => void;
    onPrepareExport: () => Promise<boolean>;
    sourceHasAudio: boolean;
}) {
    const sheetRef = useRef<HTMLDivElement>(null);
    const [format, setFormat] = useState<OutputFormat>("mp4");
    const [resolution, setResolution] = useState<"1080p" | "1440p" | "4K">("1080p");
    const [fps, setFps] = useState<"30" | "60">("60");
    const [quality, setQuality] = useState<ExportQuality>("high");
    const hasMusic = projectHasMusic(project);
    const hasAnyAudio = exportHasAnyAudio(project, sourceHasAudio);
    const [includeAudio, setIncludeAudio] = useState(hasAnyAudio);
    const [jobId, setJobId] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [progress, setProgress] = useState(0);
    const [phase, setPhase] = useState("Ready");
    const [error, setError] = useState<string | null>(null);
    const settledJobRef = useRef<string | null>(null);
    const startPendingRef = useRef(false);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const duration = projectDuration(project);
    const dimensions = exportDimensions(project.aspectRatio, resolution);
    const busy = starting || jobId !== null;

    const acknowledgeTerminal = (settledJobId: string) => {
        settledJobRef.current = settledJobId;
        try {
            window.localStorage.setItem(ACKNOWLEDGED_EXPORT_KEY, settledJobId);
        } catch {
            // Recovery remains best-effort if browser storage is unavailable.
        }
    };

    const surfaceTerminalSnapshot = (snapshot: ExportJobSnapshot) => {
        if (settledJobRef.current === snapshot.jobId) return;
        if (snapshot.state !== "completed" && snapshot.state !== "completed-unindexed" && snapshot.state !== "failed") return;
        acknowledgeTerminal(snapshot.jobId);
        setJobId(null);
        if (snapshot.state === "completed" && snapshot.media) {
            setProgress(1);
            setPhase("Complete");
            onComplete(snapshot.media.name, snapshot.warnings ?? []);
            return;
        }
        const message = snapshot.error?.message ?? "The export could not be completed.";
        setPhase(snapshot.state === "completed-unindexed" ? "Rendered, library update failed" : "Failed");
        setError(message);
        onError(snapshot.state === "completed-unindexed" ? `${snapshot.fileName} rendered, but ${message}` : message);
    };

    useEffect(() => {
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const firstControl = sheetRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])");
        (firstControl ?? sheetRef.current)?.focus();
        return () => previousFocusRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !busy) onClose();
            if (event.key !== "Tab") return;
            const sheet = sheetRef.current;
            if (!sheet) return;
            const focusable = Array.from(sheet.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
            if (focusable.length === 0) {
                event.preventDefault();
                sheet.focus();
                return;
            }
            const first = focusable[0]!;
            const last = focusable.at(-1)!;
            if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [busy, onClose]);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) return;
        let cancelled = false;
        void bridge.exporter.status().then((result) => {
            if (cancelled || !result.ok) return;
            let acknowledgedJobId: string | null = null;
            try {
                acknowledgedJobId = window.localStorage.getItem(ACKNOWLEDGED_EXPORT_KEY);
            } catch {
                // Treat an unavailable acknowledgement store as empty.
            }
            const snapshot = recoverableExport(result.value, acknowledgedJobId);
            if (snapshot === null) return;
            if (snapshot.state === "completed" || snapshot.state === "completed-unindexed" || snapshot.state === "failed") {
                surfaceTerminalSnapshot(snapshot);
                return;
            }
            setJobId(snapshot.jobId);
            setProgress(snapshot.progress?.fraction ?? 0);
            setPhase(snapshot.progress ? snapshot.progress.phase.charAt(0).toUpperCase() + snapshot.progress.phase.slice(1) : "Reattached");
        });
        return () => { cancelled = true; };
    }, [onComplete, onError]);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) return undefined;
        return bridge.exporter.onEvent((event: ExportEvent) => {
            if (event.jobId !== jobId) return;
            if (event.type === "progress") {
                setProgress(Math.max(0, Math.min(1, event.fraction)));
                setPhase(event.phase.charAt(0).toUpperCase() + event.phase.slice(1));
            } else if (event.type === "completed") {
                acknowledgeTerminal(event.jobId);
                setProgress(1);
                setPhase("Complete");
                setJobId(null);
                onComplete(event.media.name, event.warnings);
            } else if (event.type === "cancelled") {
                settledJobRef.current = event.jobId;
                setJobId(null);
                setProgress(0);
                setPhase("Cancelled");
            } else if (event.type === "completed-unindexed") {
                acknowledgeTerminal(event.jobId);
                setJobId(null);
                setPhase("Rendered, library update failed");
                setError(event.error.message);
                onError(`${event.fileName} rendered, but ${event.error.message}`);
            } else {
                acknowledgeTerminal(event.jobId);
                setJobId(null);
                setPhase("Failed");
                setError(event.error.message);
                onError(event.error.message);
            }
        });
    }, [jobId, onComplete, onError]);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge || jobId === null) return;
        void bridge.exporter.status(jobId).then((result) => {
            if (!result.ok || result.value === null) return;
            const snapshot = result.value;
            if (snapshot.state === "completed" || snapshot.state === "completed-unindexed" || snapshot.state === "failed") {
                surfaceTerminalSnapshot(snapshot);
            } else if (snapshot.state === "cancelled" && settledJobRef.current !== snapshot.jobId) {
                settledJobRef.current = snapshot.jobId;
                setJobId(null);
                setProgress(0);
                setPhase("Cancelled");
            } else if (snapshot.progress) {
                setProgress(snapshot.progress.fraction);
                setPhase(snapshot.progress.phase.charAt(0).toUpperCase() + snapshot.progress.phase.slice(1));
            }
        });
    }, [jobId, onComplete, onError]);

    const beginExport = async () => {
        if (startPendingRef.current || jobId !== null) return;
        startPendingRef.current = true;
        setStarting(true);
        setError(null);
        settledJobRef.current = null;
        setPhase("Preparing");
        try {
            const prepared = await prepareExportRequest(onPrepareExport, () => requestExport({
                    projectId,
                    format,
                    width: dimensions[0],
                    height: dimensions[1],
                    fps: Number(fps) as 30 | 60,
                    quality,
                    includeAudio: format === "mp4" && hasAnyAudio && includeAudio,
                    suggestedName: project.name,
                }));
            if (!prepared.prepared) {
                const message = "Save the latest project before exporting.";
                setPhase("Save failed");
                setError(message);
                onError(message);
                return;
            }
            const result = prepared.result;
            if (result === undefined) {
                const message = "Export is available in the installed SharpShot app.";
                setPhase("Unavailable");
                setError(message);
                onError(message);
                return;
            }
            if (!result.ok) {
                setPhase("Failed");
                setError(result.error.message);
                onError(result.error.message);
                return;
            }
            if (!result.value.started) {
                setPhase("Cancelled");
                return;
            }
            setJobId(result.value.jobId);
            setProgress(0);
            setPhase("Preparing");
        } catch (exportError) {
            const message = exportError instanceof Error ? exportError.message : "SharpShot could not start the export.";
            setPhase("Failed");
            setError(message);
            onError(message);
        } finally {
            startPendingRef.current = false;
            setStarting(false);
        }
    };

    const stopExport = async () => {
        if (jobId === null) return;
        const result = await cancelExport(jobId);
        if (result !== undefined && !result.ok) {
            setError(result.error.message);
            onError(result.error.message);
        }
    };

    return (
        <div className="export-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
            <div aria-labelledby="export-title" aria-modal="true" className="export-sheet" ref={sheetRef} role="dialog" tabIndex={-1}>
                <header><div><span className="export-icon"><Icon name="export" size={18} /></span><div><h2 id="export-title">Export project</h2><p>{project.name} · {formatTime(duration)}</p></div></div><button aria-label="Close export" disabled={busy} onClick={onClose} type="button"><Icon name="close" size={17} /></button></header>
                <div className="export-preview"><div><Icon name="play" size={18} /></div><span>{project.aspectRatio} · {resolution} · {fps} fps</span></div>
                <div className="export-fields">
                    <label className="select-field"><span>Format</span><select disabled={busy} onChange={(event) => setFormat(event.currentTarget.value as OutputFormat)} value={format}><option value="mp4">MP4</option><option value="gif">GIF</option></select></label>
                    <label className="select-field"><span>Resolution</span><select disabled={busy} onChange={(event) => setResolution(event.currentTarget.value as typeof resolution)} value={resolution}><option>1080p</option><option>1440p</option><option>4K</option></select></label>
                    <div aria-disabled={busy} className="export-field"><span>Frame rate</span><Segmented<"30" | "60"> label="Export frame rate" onChange={(value) => { if (!busy) setFps(value); }} options={["30", "60"]} value={fps} /></div>
                    <label className="select-field"><span>Quality</span><select disabled={busy} onChange={(event) => setQuality(event.currentTarget.value as ExportQuality)} value={quality}><option value="balanced">Balanced</option><option value="high">High</option><option value="lossless-ish">Maximum</option></select></label>
                    <div aria-disabled={busy} className="export-toggle"><span><strong>Include audio mix</strong><small>{format === "gif" ? "GIF does not support audio" : hasMusic && sourceHasAudio ? "Source audio, music, fades, and ducking" : hasMusic ? "Music, fades, and level changes" : sourceHasAudio ? "Use the source video’s audio track" : "No audio is available"}</small></span>{hasAnyAudio && format === "mp4" ? <Switch checked={includeAudio} label="Include audio mix" onChange={(value) => { if (!busy) setIncludeAudio(value); }} /> : <span>Off</span>}</div>
                </div>
                <div className="export-destination"><Icon name="folder" size={16} /><span><small>Save to</small><strong>Choose a file when export starts</strong></span></div>
                {jobId !== null ? <div className="export-progress" aria-live="polite"><span><i style={{ width: `${progress * 100}%` }} /></span><strong>{phase} · {Math.round(progress * 100)}%</strong></div> : null}
                {error ? <p className="inline-note" role="alert"><Icon name="info" size={14} /> {error}</p> : null}
                <p className="inline-note"><Icon name="info" size={14} /> {exportSummary(project, format, format === "mp4" && hasAnyAudio && includeAudio)}</p>
                <footer>
                    <span>{jobId === null ? starting ? "Choosing destination…" : "Ready · runs locally on this device" : `Job ${jobId.slice(0, 8)}`}</span>
                    {jobId === null ? <button className="button button--primary" disabled={starting} onClick={() => void beginExport()} type="button"><Icon name="export" size={16} /> {starting ? "Starting…" : format === "gif" ? "Export GIF" : "Export MP4"}</button> : <button className="button button--secondary" onClick={() => void stopExport()} type="button">Cancel export</button>}
                </footer>
            </div>
        </div>
    );
}

export function exportSummary(project: EditorProject, format: OutputFormat, includeAudio: boolean): string {
    const captions = project.overlays.captions.length;
    const redactions = safeRedactions(project.overlays).length;
    const audioSummary = format === "gif"
        ? "GIF exports are silent."
        : includeAudio
            ? "Audio mix included."
            : "Audio excluded.";
    return `Export includes trim, split, speed, crop, placement, presentation, backgrounds, zoom focus moves, ${captions} burned-in caption${captions === 1 ? "" : "s"}, and ${redactions} opaque redaction${redactions === 1 ? "" : "s"}. ${audioSummary}`;
}

export function projectHasMusic(project: EditorProject): boolean {
    return project.audio?.lanes.some((lane) =>
        lane.id !== SOURCE_AUDIO_LANE_ID && lane.kind === "music" && lane.clips.length > 0) ?? false;
}

export function exportHasAnyAudio(project: EditorProject, sourceHasAudio: boolean): boolean {
    return sourceHasAudio || projectHasMusic(project);
}

export async function prepareExportRequest<T>(
    prepare: () => Promise<boolean>,
    request: () => Promise<T>,
): Promise<{ prepared: false } | { prepared: true; result: T }> {
    if (!await prepare()) return { prepared: false };
    return { prepared: true, result: await request() };
}

function exportDimensions(aspect: EditorProject["aspectRatio"], resolution: "1080p" | "1440p" | "4K"): readonly [number, number] {
    const height = resolution === "4K" ? 2160 : resolution === "1440p" ? 1440 : 1080;
    if (aspect === "1:1") return [height, height];
    if (aspect === "9:16") return [Math.round(height * 9 / 16 / 2) * 2, height];
    if (aspect === "4:5") return [Math.round(height * 4 / 5 / 2) * 2, height];
    if (aspect === "4:3") return [Math.round(height * 4 / 3 / 2) * 2, height];
    if (aspect === "16:10") return [Math.round(height * 16 / 10 / 2) * 2, height];
    return [Math.round(height * 16 / 9 / 2) * 2, height];
}
