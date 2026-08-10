import { useEffect, useRef, useState } from "react";
import type { BundledAudioTrack, MediaItem } from "../../shared/api";
import {
    clipTimelineDurationUs,
    clipTimelineEndUs,
    type AudioAsset,
} from "../../shared/audio-timeline";
import { SOURCE_AUDIO_LANE_ID } from "../../shared/project-audio";
import {
    applySelectedAudioEdit,
    ensureMusicLane,
    findAudioSelection,
    insertMusicClip,
    removeAudioClip,
    splitSelectedAudioClip,
    toggleMusicDucking,
    type SelectedAudioEdit,
} from "../audio-editor";
import { bundledMusicAsset, probedLibraryMusicAsset } from "../audio-music-assets";
import { getDesktopBridge } from "../bridge";
import { projectDurationUs, type EditorAction } from "../state";
import type { EditorState } from "../types";
import { Icon } from "./Icon";
import { IconButton, RangeField, RangeInput, Switch } from "./ui";

const MICROSECONDS_PER_SECOND = 1_000_000;
const AUDIO_FADE_PRESETS = ["None", "Quick", "Smooth"] as const;
type AudioFadePreset = typeof AUDIO_FADE_PRESETS[number];

export function audioFadePresetUs(preset: AudioFadePreset, durationUs: number): number {
    const duration = Number.isSafeInteger(durationUs) && durationUs > 0 ? durationUs : 0;
    if (preset === "None" || duration === 0) return 0;
    return preset === "Quick"
        ? Math.min(250_000, Math.floor(duration / 4))
        : Math.min(1_000_000, Math.floor(duration / 2));
}

export function audioFadePresetFor(fadeUs: number, durationUs: number): AudioFadePreset | undefined {
    return AUDIO_FADE_PRESETS.find((preset) => audioFadePresetUs(preset, durationUs) === fadeUs);
}

export function AudioMusicInspector({
    state,
    dispatch,
    sourceHasAudio,
    audioCatalog,
    libraryAudio,
    mutationsLocked,
    onLibraryAudioImported,
    onNotify,
}: {
    state: EditorState;
    dispatch: (action: EditorAction) => boolean;
    sourceHasAudio: boolean;
    audioCatalog: readonly BundledAudioTrack[];
    libraryAudio: readonly MediaItem[];
    mutationsLocked: boolean;
    onLibraryAudioImported: (items: MediaItem[]) => void;
    onNotify: (title: string, detail: string) => void;
}) {
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [libraryPage, setLibraryPage] = useState(0);
    const busyRef = useRef(false);
    const generationRef = useRef(0);
    const taskProjectRef = useRef<EditorState["project"] | null>(null);
    const stateRef = useRef(state);
    const mutationsLockedRef = useRef(mutationsLocked);
    stateRef.current = state;
    mutationsLockedRef.current = mutationsLocked;

    useEffect(() => {
        generationRef.current += 1;
        busyRef.current = false;
        taskProjectRef.current = null;
        setBusyKey(null);
    }, [mutationsLocked, state.continuousEditStart, state.exportOpen, state.project]);

    useEffect(() => () => {
        generationRef.current += 1;
        busyRef.current = false;
        taskProjectRef.current = null;
    }, []);

    const audio = state.project.audio;
    const musicLane = audio?.lanes.find((lane) => lane.kind === "music");
    const selected = audio !== undefined && musicLane !== undefined && state.selectedAudioClipId !== null
        ? findAudioSelection(audio, { laneId: musicLane.id, clipId: state.selectedAudioClipId })
        : undefined;
    const selectedClip = selected?.clip;
    const selectedAsset = selectedClip === undefined ? undefined : audio?.assets[selectedClip.assetId];
    const libraryTracks = libraryAudio.filter((item) => item.kind === "audio");
    const libraryPageCount = Math.max(1, Math.ceil(libraryTracks.length / 12));
    const visibleLibraryPage = Math.min(libraryPage, libraryPageCount - 1);
    const visibleLibraryTracks = libraryTracks.slice(visibleLibraryPage * 12, (visibleLibraryPage + 1) * 12);
    const duckingEnabled = audio !== undefined && musicLane !== undefined && audio.ducking.some((rule) =>
        rule.triggerLaneId === SOURCE_AUDIO_LANE_ID && rule.targetLaneId === musicLane.id);
    const positiveGainPreviewCapped = (musicLane?.gainDb ?? 0) > 0
        || (musicLane?.clips.some((clip) => clip.gainDb > 0) ?? false);
    const canSplit = selectedClip !== undefined
        && Math.round(state.playhead * MICROSECONDS_PER_SECOND) > selectedClip.timelineStartUs
        && Math.round(state.playhead * MICROSECONDS_PER_SECOND) < clipTimelineEndUs(selectedClip);
    const continuousEditProps = {
        onInteractionStart: () => dispatch({ type: "BEGIN_CONTINUOUS_EDIT" }),
        onInteractionCommit: () => dispatch({ type: "COMMIT_CONTINUOUS_EDIT" }),
        onInteractionCancel: () => dispatch({ type: "CANCEL_CONTINUOUS_EDIT" }),
    };

    const beginTask = (key: string): number | undefined => {
        if (busyRef.current
            || mutationsLockedRef.current
            || stateRef.current.continuousEditStart !== null
            || stateRef.current.exportOpen) return undefined;
        busyRef.current = true;
        taskProjectRef.current = stateRef.current.project;
        const generation = ++generationRef.current;
        setBusyKey(key);
        return generation;
    };

    const taskIsCurrent = (generation: number): boolean => audioTaskIsCurrent(
        generation,
        generationRef.current,
        taskProjectRef.current,
        stateRef.current,
        mutationsLockedRef.current,
    );

    const finishTask = (generation: number) => {
        if (!taskIsCurrent(generation)) return;
        busyRef.current = false;
        taskProjectRef.current = null;
        setBusyKey(null);
    };

    const addAssetAtPlayhead = (asset: AudioAsset): boolean => {
        const latest = stateRef.current;
        if (mutationsLockedRef.current) return false;
        if (latest.continuousEditStart !== null) {
            throw new Error("Finish the current slider edit before adding music.");
        }
        if (latest.exportOpen) {
            throw new Error("Close Export before adding music.");
        }
        const latestDurationUs = projectDurationUs(latest.project);
        const playheadUs = Math.round(latest.playhead * MICROSECONDS_PER_SECOND);
        if (playheadUs >= latestDurationUs) {
            throw new Error("Move the playhead before the end of the project, then add the track again.");
        }
        const inserted = insertMusicClip({
            timeline: latest.project.audio,
            durationUs: latestDurationUs,
            asset,
            playheadUs,
        });
        return dispatch({
            type: "EDIT_AUDIO",
            timeline: inserted.timeline,
            selectedAudioClipId: inserted.selection.clipId,
        });
    };

    const addBundledTrack = (track: BundledAudioTrack) => {
        try {
            if (!addAssetAtPlayhead(bundledMusicAsset(track))) return;
            onNotify("Music added", `${track.title} starts at the playhead.`);
        } catch (error) {
            onNotify("Music not added", errorMessage(error, "The bundled track could not be added."));
        }
    };

    const addLibraryTrack = async (item: MediaItem) => {
        const bridge = getDesktopBridge();
        if (bridge === undefined) {
            onNotify("Audio unavailable", "Library audio can only be checked in the desktop app.");
            return;
        }
        const generation = beginTask(`library:${item.id}`);
        if (generation === undefined) return;
        try {
            const result = await bridge.exporter.probe(item.id);
            if (!taskIsCurrent(generation)) return;
            if (!result.ok) {
                onNotify("Audio check failed", result.error.message);
                return;
            }
            const asset = probedLibraryMusicAsset(item, result.value);
            if (!addAssetAtPlayhead(asset)) return;
            onNotify("Music added", `${asset.name} was verified and starts at the playhead.`);
        } catch (error) {
            if (taskIsCurrent(generation)) {
                onNotify("Music not added", errorMessage(error, "The library track could not be verified."));
            }
        } finally {
            finishTask(generation);
        }
    };

    const importMusic = async () => {
        const bridge = getDesktopBridge();
        if (bridge === undefined) {
            onNotify("Audio import unavailable", "Import music from the installed desktop app.");
            return;
        }
        const generation = beginTask("import");
        if (generation === undefined) return;
        try {
            const result = await bridge.library.import();
            if (!taskIsCurrent(generation)) return;
            if (!result.ok) {
                onNotify("Audio import failed", result.error.message);
                return;
            }
            const candidates = result.value.filter((item) => item.kind === "audio");
            if (candidates.length === 0) {
                onNotify("No audio imported", "Choose an audio file in the desktop picker.");
                return;
            }

            onLibraryAudioImported(candidates);
            const first = candidates[0]!;
            const probe = await bridge.exporter.probe(first.id);
            if (!taskIsCurrent(generation)) return;
            if (!probe.ok) {
                onNotify("Audio imported, not added", `${probe.error.message} The files remain in Library and are checked when added.`);
                return;
            }
            const asset = probedLibraryMusicAsset(first, probe.value);
            try {
                if (!addAssetAtPlayhead(asset)) return;
            } catch (error) {
                onNotify(
                    "Audio imported, not added",
                    `${errorMessage(error, "Move the playhead and add it from Library.")} The verified file remains in Library.`,
                );
                return;
            }
            onNotify(
                "Music imported",
                `${candidates.length} audio file${candidates.length === 1 ? "" : "s"} added to Library; ${asset.name} was verified and starts at the playhead.`,
            );
        } catch (error) {
            if (taskIsCurrent(generation)) {
                onNotify("Audio import failed", errorMessage(error, "The desktop picker could not import audio."));
            }
        } finally {
            finishTask(generation);
        }
    };

    const editMusicLane = (edit: Extract<SelectedAudioEdit, { type: "lane.gain" | "lane.mute" }>) => {
        try {
            const latest = stateRef.current;
            const base = latest.continuousEditStart === null
                ? latest.project.audio
                : latest.continuousEditStart.audio;
            const ensured = ensureMusicLane(base, projectDurationUs(latest.project));
            const timeline = applySelectedAudioEdit(ensured.timeline, { laneId: ensured.laneId }, edit);
            dispatch({ type: "EDIT_AUDIO", timeline });
        } catch (error) {
            onNotify("Music bus not changed", errorMessage(error, "The music bus could not be edited."));
        }
    };

    const editSelectedClip = (edit: Exclude<SelectedAudioEdit, { type: "lane.gain" | "lane.mute" }>) => {
        try {
            const latest = stateRef.current;
            const base = latest.continuousEditStart === null
                ? latest.project.audio
                : latest.continuousEditStart.audio;
            if (base === undefined || latest.selectedAudioClipId === null) throw new Error("Select a music clip first.");
            const lane = base.lanes.find((candidate) =>
                candidate.kind === "music" && candidate.clips.some((clip) => clip.id === latest.selectedAudioClipId));
            if (lane === undefined) throw new Error("The selected music clip no longer exists.");
            const timeline = applySelectedAudioEdit(base, {
                laneId: lane.id,
                clipId: latest.selectedAudioClipId,
            }, edit);
            dispatch({ type: "EDIT_AUDIO", timeline });
        } catch (error) {
            onNotify("Music clip not changed", errorMessage(error, "The selected clip could not be edited."));
        }
    };

    const splitSelected = () => {
        const latest = stateRef.current;
        const timeline = latest.project.audio;
        if (timeline === undefined || latest.selectedAudioClipId === null) return;
        const lane = timeline.lanes.find((candidate) =>
            candidate.kind === "music" && candidate.clips.some((clip) => clip.id === latest.selectedAudioClipId));
        if (lane === undefined) return;
        try {
            const result = splitSelectedAudioClip(
                timeline,
                { laneId: lane.id, clipId: latest.selectedAudioClipId },
                Math.round(latest.playhead * MICROSECONDS_PER_SECOND),
            );
            dispatch({ type: "EDIT_AUDIO", timeline: result.timeline, selectedAudioClipId: result.rightClipId });
        } catch (error) {
            onNotify("Music not split", errorMessage(error, "Place the playhead inside the selected clip."));
        }
    };

    const deleteSelected = () => {
        const latest = stateRef.current;
        if (latest.project.audio === undefined || latest.selectedAudioClipId === null) return;
        try {
            dispatch({
                type: "EDIT_AUDIO",
                timeline: removeAudioClip(latest.project.audio, latest.selectedAudioClipId),
                selectedAudioClipId: null,
            });
        } catch (error) {
            onNotify("Music not deleted", errorMessage(error, "The selected clip could not be deleted."));
        }
    };

    const toggleDucking = () => {
        if (!sourceHasAudio) {
            onNotify("Ducking unavailable", "This source has no embedded audio to trigger ducking.");
            return;
        }
        try {
            const latest = stateRef.current;
            const result = toggleMusicDucking(latest.project.audio, projectDurationUs(latest.project));
            dispatch({ type: "EDIT_AUDIO", timeline: result.timeline });
        } catch (error) {
            onNotify("Ducking not changed", errorMessage(error, "The ducking rule could not be changed."));
        }
    };

    const selectedDurationUs = selectedClip === undefined ? 0 : clipTimelineDurationUs(selectedClip);
    const setFadePreset = (edge: "in" | "out", preset: AudioFadePreset) => {
        if (selectedClip === undefined) return;
        const fadeUs = audioFadePresetUs(preset, selectedDurationUs);
        editSelectedClip({
            type: "clip.fades",
            fadeInUs: edge === "in" ? fadeUs : selectedClip.fadeInUs,
            fadeOutUs: edge === "out" ? fadeUs : selectedClip.fadeOutUs,
        });
    };
    const setExactFade = (edge: "in" | "out", seconds: number) => {
        if (selectedClip === undefined || !Number.isFinite(seconds)) return;
        const fadeUs = Math.min(selectedDurationUs, Math.max(0, toMicroseconds(seconds)));
        editSelectedClip({
            type: "clip.fades",
            fadeInUs: edge === "in" ? fadeUs : selectedClip.fadeInUs,
            fadeOutUs: edge === "out" ? fadeUs : selectedClip.fadeOutUs,
        });
    };

    return (
        <section className="inspector-section audio-music-inspector">
            <div className="inspector-section__heading audio-music-heading">
                <div><h3>Music</h3><p>Add a soundtrack and shape the final mix</p></div>
                <button
                    className="button button--secondary audio-music-import"
                    disabled={busyKey !== null}
                    onClick={() => void importMusic()}
                    type="button"
                >
                    <Icon name="download" size={14} /> {busyKey === "import" ? "Importing…" : "Import"}
                </button>
            </div>

            {selectedClip !== undefined ? (
                <div className="audio-music-editor">
                    <header className="audio-music-editor__header">
                        <span><Icon name="waveform" size={15} /><span><strong>{selectedAsset?.name ?? "Selected music"}</strong><small>{formatDuration(selectedDurationUs)} clip</small></span></span>
                        <Switch
                            checked={!selectedClip.muted}
                            label="Selected music clip"
                            onChange={(enabled) => editSelectedClip({ type: "clip.mute", muted: !enabled })}
                        />
                    </header>
                    <RangeField
                        {...continuousEditProps}
                        label="Clip gain"
                        max={24}
                        min={-96}
                        onChange={(gainDb) => editSelectedClip({ type: "clip.gain", gainDb })}
                        suffix=" dB"
                        value={selectedClip.gainDb}
                    />
                    {(["in", "out"] as const).map((edge) => {
                        const label = `Fade ${edge}`;
                        const value = edge === "in" ? selectedClip.fadeInUs : selectedClip.fadeOutUs;
                        const activePreset = audioFadePresetFor(value, selectedDurationUs);
                        return (
                            <div aria-label={`${label} preset`} className="audio-fade-control" key={edge} role="group">
                                <div className="audio-fade-control__heading"><span>{label}</span><output>{activePreset ?? `${formatPreciseDuration(value)} custom`}</output></div>
                                <div className="audio-fade-presets">
                                    {AUDIO_FADE_PRESETS.map((preset) => (
                                        <button
                                            aria-label={`Set ${label.toLowerCase()} to ${preset.toLowerCase()}`}
                                            aria-pressed={activePreset === preset}
                                            className={activePreset === preset ? "is-active" : ""}
                                            key={preset}
                                            onClick={() => setFadePreset(edge, preset)}
                                            type="button"
                                        >{preset}</button>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                    <details className="audio-fade-exact">
                        <summary>Exact timing <Icon name="chevronDown" size={14} /></summary>
                        <div className="clip-time-fields">
                            <label><span>Fade in</span><input aria-label="Exact fade in" max={secondsValue(selectedDurationUs)} min="0" onChange={(event) => setExactFade("in", Number.parseFloat(event.currentTarget.value))} step="0.05" type="number" value={secondsValue(selectedClip.fadeInUs)} /></label>
                            <label><span>Fade out</span><input aria-label="Exact fade out" max={secondsValue(selectedDurationUs)} min="0" onChange={(event) => setExactFade("out", Number.parseFloat(event.currentTarget.value))} step="0.05" type="number" value={secondsValue(selectedClip.fadeOutUs)} /></label>
                        </div>
                    </details>
                    <div className="audio-music-editor__actions">
                        <button className="button button--secondary" disabled={!canSplit} onClick={splitSelected} type="button"><Icon name="split" size={14} /> Split at playhead</button>
                        <IconButton className="button--danger" icon="trash" label="Delete selected music clip" onClick={deleteSelected} />
                    </div>
                </div>
            ) : <p className="inline-note"><Icon name="info" size={14} /> Add or select a timeline clip to edit its fades and level.</p>}

            {musicLane !== undefined && musicLane.clips.length > 0 ? (
                <div className="audio-music-group">
                    <div className="audio-music-group__heading"><strong>On timeline</strong><span>{musicLane.clips.length} clip{musicLane.clips.length === 1 ? "" : "s"}</span></div>
                    <div aria-label="Music clips on timeline" className="audio-music-clips">
                        {musicLane.clips.map((clip) => {
                            const asset = audio?.assets[clip.assetId];
                            const isSelected = clip.id === state.selectedAudioClipId;
                            return (
                                <button
                                    aria-pressed={isSelected}
                                    className={`audio-music-clip${isSelected ? " is-selected" : ""}`}
                                    key={clip.id}
                                    onClick={() => dispatch({ type: "SELECT_AUDIO_CLIP", id: clip.id })}
                                    type="button"
                                >
                                    <Icon name="waveform" size={14} />
                                    <span><strong>{asset?.name ?? "Music clip"}</strong><small>{formatDuration(clip.timelineStartUs)} – {formatDuration(clipTimelineEndUs(clip))}</small></span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <div className="audio-channel audio-music-bus">
                <header>
                    <span><Icon name="audio" size={15} /><strong>Music bus</strong></span>
                    <span>
                        <output>{musicLane?.muted ? "Muted" : formatDb(musicLane?.gainDb ?? 0)}</output>
                        <Switch
                            checked={!(musicLane?.muted ?? false)}
                            label="Music bus"
                            onChange={(enabled) => editMusicLane({ type: "lane.mute", muted: !enabled })}
                        />
                    </span>
                </header>
                <RangeInput
                    {...continuousEditProps}
                    ariaLabel="Music bus gain"
                    max={24}
                    min={-96}
                    onChange={(gainDb) => editMusicLane({ type: "lane.gain", gainDb })}
                    value={musicLane?.gainDb ?? 0}
                />
            </div>

            <div className="audio-music-duck">
                <span><strong>Duck music under source</strong><small>{sourceHasAudio ? "Lower music while source audio is active" : "No source audio is available"}</small></span>
                {sourceHasAudio ? <Switch checked={duckingEnabled} label="Duck music under source audio" onChange={toggleDucking} /> : <span className="audio-music-unavailable">Unavailable</span>}
            </div>

            <div className="audio-music-group">
                <div className="audio-music-group__heading"><strong>Included tracks</strong><span>CC0 1.0</span></div>
                {audioCatalog.length > 0 ? (
                    <div aria-label="Included CC0 music" className="audio-music-cards">
                        {audioCatalog.slice(0, 3).map((track) => (
                            <article className="audio-music-card" key={track.id}>
                                <span className="audio-music-card__icon"><Icon name="waveform" size={15} /></span>
                                <span className="audio-music-card__copy">
                                    <strong>{track.title}</strong>
                                    <small>{track.creator} · {formatDuration(track.durationUs)} · CC0 1.0</small>
                                </span>
                                <button
                                    aria-label={`Add ${track.title} at the playhead`}
                                    className="button button--ghost audio-music-card__add"
                                    disabled={busyKey !== null}
                                    onClick={() => addBundledTrack(track)}
                                    type="button"
                                ><Icon name="plus" size={13} /> Add</button>
                            </article>
                        ))}
                    </div>
                ) : <p className="inline-note"><Icon name="info" size={14} /> Included tracks are unavailable in this installation.</p>}
            </div>

            <div className="audio-music-group">
                <div className="audio-music-group__heading"><strong>Library audio</strong><span>{libraryTracks.length} track{libraryTracks.length === 1 ? "" : "s"}</span></div>
                {libraryTracks.length > 0 ? (
                    <div aria-label="Audio in Library" className="audio-music-cards audio-music-cards--library">
                        {visibleLibraryTracks.map((item) => (
                            <article className="audio-music-card" key={item.id}>
                                <span className="audio-music-card__icon"><Icon name="audio" size={15} /></span>
                                <span className="audio-music-card__copy"><strong>{item.name}</strong><small>Library · {formatBytes(item.byteLength)}</small></span>
                                <button
                                    aria-label={`Verify and add ${item.name} at the playhead`}
                                    className="button button--ghost audio-music-card__add"
                                    disabled={busyKey !== null}
                                    onClick={() => void addLibraryTrack(item)}
                                    type="button"
                                ><Icon name="plus" size={13} /> {busyKey === `library:${item.id}` ? "Checking…" : "Add"}</button>
                            </article>
                        ))}
                        {libraryPageCount > 1 ? (
                            <div className="audio-music-pagination" aria-label="Library audio pages">
                                <button disabled={visibleLibraryPage === 0} onClick={() => setLibraryPage(visibleLibraryPage - 1)} type="button">Previous</button>
                                <span>{visibleLibraryPage + 1} / {libraryPageCount}</span>
                                <button disabled={visibleLibraryPage >= libraryPageCount - 1} onClick={() => setLibraryPage(visibleLibraryPage + 1)} type="button">Next</button>
                            </div>
                        ) : null}
                    </div>
                ) : <p className="inline-note"><Icon name="info" size={14} /> Import audio to keep it in Library and add it here.</p>}
            </div>
            <p className="inline-note"><Icon name="info" size={14} /> Browser preview does not reproduce dynamic ducking. Export applies the accurate source-to-music sidechain mix.</p>
            {positiveGainPreviewCapped ? <p className="inline-note"><Icon name="info" size={14} /> Positive gain is capped in browser preview; export keeps the selected dB value.</p> : null}
        </section>
    );
}

export function audioTaskIsCurrent(
    taskGeneration: number,
    currentGeneration: number,
    taskProject: EditorState["project"] | null,
    currentState: Pick<EditorState, "project" | "continuousEditStart" | "exportOpen">,
    mutationsLocked: boolean,
): boolean {
    return taskGeneration === currentGeneration
        && taskProject === currentState.project
        && currentState.continuousEditStart === null
        && !currentState.exportOpen
        && !mutationsLocked;
}

function secondsValue(timeUs: number): number {
    return Math.round(timeUs / 10_000) / 100;
}

function toMicroseconds(seconds: number): number {
    return Math.round(seconds * MICROSECONDS_PER_SECOND);
}

function formatDuration(timeUs: number): string {
    const seconds = Math.max(0, Math.round(timeUs / MICROSECONDS_PER_SECOND));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatPreciseDuration(timeUs: number): string {
    return `${secondsValue(timeUs).toFixed(2)} s`;
}

function formatDb(gainDb: number): string {
    return `${gainDb > 0 ? "+" : ""}${gainDb} dB`;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1_024) return `${Math.round(bytes)} B`;
    if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim() ? error.message : fallback;
}
