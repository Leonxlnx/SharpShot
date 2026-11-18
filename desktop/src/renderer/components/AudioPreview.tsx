import { useEffect, useMemo, useRef } from "react";
import type { BundledAudioTrack, MediaItem } from "../../shared/api";
import {
    clipTimelineDurationUs,
    playbackRateAsNumber,
    type AudioAsset,
    type AudioClip,
    type AudioLane,
    type AudioTimeline,
} from "../../shared/audio-timeline";
import { SOURCE_AUDIO_LANE_ID } from "../../shared/project-audio";

export type AudioClipPreviewState = {
    sourceSeconds: number;
    playbackRate: number;
    preservesPitch: boolean;
    volume: number;
};

export type AudioPreviewMediaElement = Pick<
    HTMLAudioElement,
    "currentTime" | "pause" | "paused" | "play" | "playbackRate" | "preservesPitch" | "volume"
>;

const MAX_PREVIEW_CLIPS_PER_LANE = 2;

export function audioClipPreviewAt(
    clip: AudioClip,
    lane: Pick<AudioLane, "gainDb" | "muted">,
    playheadSeconds: number,
): AudioClipPreviewState | null {
    if (!Number.isFinite(playheadSeconds)) return null;
    const offsetUs = playheadSeconds * 1_000_000 - clip.timelineStartUs;
    const durationUs = clipTimelineDurationUs(clip);
    if (offsetUs < 0 || offsetUs >= durationUs) return null;

    const playbackRate = playbackRateAsNumber(clip.playbackRate);
    const fadeIn = clip.fadeInUs === 0 ? 1 : Math.min(1, offsetUs / clip.fadeInUs);
    const fadeOut = clip.fadeOutUs === 0 ? 1 : Math.min(1, (durationUs - offsetUs) / clip.fadeOutUs);
    const gain = lane.muted || clip.muted
        ? 0
        : 10 ** ((lane.gainDb + clip.gainDb) / 20) * fadeIn * fadeOut;

    return {
        sourceSeconds: Math.min(
            clip.sourceOutUs,
            clip.sourceInUs + offsetUs * playbackRate,
        ) / 1_000_000,
        playbackRate,
        preservesPitch: clip.speedMode === "preserve-pitch",
        volume: Math.min(1, Math.max(0, gain)),
    };
}

export function audioLanePreviewClipsAt(
    clips: readonly AudioClip[],
    playheadSeconds: number,
): AudioClip[] {
    if (!Number.isFinite(playheadSeconds)) return [];
    const playheadUs = playheadSeconds * 1_000_000;
    const ordered = [...clips].sort((left, right) =>
        left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id));
    const active = ordered.find((clip) => {
        const offsetUs = playheadUs - clip.timelineStartUs;
        return offsetUs >= 0 && offsetUs < clipTimelineDurationUs(clip);
    });
    const upcoming = ordered.find((clip) => clip.timelineStartUs > playheadUs);
    const selected: AudioClip[] = [];
    if (active !== undefined) selected.push(active);
    if (upcoming !== undefined && selected.length < MAX_PREVIEW_CLIPS_PER_LANE) selected.push(upcoming);
    return selected;
}

export function syncAudioPreviewElement(
    element: AudioPreviewMediaElement,
    preview: AudioClipPreviewState | null,
    playing: boolean,
): Promise<void> | undefined {
    if (preview === null) {
        if (!element.paused) element.pause();
        return undefined;
    }

    const wasPaused = element.paused;
    element.playbackRate = preview.playbackRate;
    element.preservesPitch = preview.preservesPitch;
    element.volume = preview.volume;
    if (!playing || wasPaused || Math.abs(element.currentTime - preview.sourceSeconds) > 0.08) {
        element.currentTime = preview.sourceSeconds;
    }
    if (!playing) {
        if (!element.paused) element.pause();
        return undefined;
    }
    return element.paused ? element.play().catch(() => undefined) : undefined;
}

export function AudioPreview({
    audio,
    playheadSeconds,
    playing,
    libraryAudio,
    audioCatalog,
}: {
    audio?: AudioTimeline;
    playheadSeconds: number;
    playing: boolean;
    libraryAudio: readonly MediaItem[];
    audioCatalog: readonly BundledAudioTrack[];
}) {
    const candidates = useMemo(() => {
        if (audio === undefined) return [];
        const libraryById = new Map(libraryAudio.map((item) => [item.id, item]));
        const catalogById = new Map(audioCatalog.map((track) => [track.id, track]));

        return audio.lanes.flatMap((lane) => {
            if (lane.id === SOURCE_AUDIO_LANE_ID || lane.kind === "system") return [];
            const clips = lane.clips.flatMap((clip) => {
                const asset = audio.assets[clip.assetId];
                const url = asset === undefined ? undefined : resolveAudioUrl(asset, libraryById, catalogById);
                return url === undefined ? [] : [{ clip, url }];
            });
            return clips.length === 0 ? [] : [{ lane, clips }];
        });
    }, [audio, audioCatalog, libraryAudio]);
    const clips = useMemo(() => candidates.flatMap(({ lane, clips: laneClips }) =>
        audioLanePreviewClipsAt(laneClips.map(({ clip }) => clip), playheadSeconds).map((clip) => ({
            clip,
            lane,
            url: laneClips.find((candidate) => candidate.clip === clip)!.url,
        }))), [candidates, playheadSeconds]);

    return clips.map(({ clip, lane, url }) => (
        <ClipAudio
            clip={clip}
            key={clip.id}
            lane={lane}
            playheadSeconds={playheadSeconds}
            playing={playing}
            url={url}
        />
    ));
}

function ClipAudio({
    clip,
    lane,
    playheadSeconds,
    playing,
    url,
}: {
    clip: AudioClip;
    lane: AudioLane;
    playheadSeconds: number;
    playing: boolean;
    url: string;
}) {
    const audioRef = useRef<HTMLAudioElement>(null);

    useEffect(() => {
        const element = audioRef.current;
        if (element === null) return;
        void syncAudioPreviewElement(element, audioClipPreviewAt(clip, lane, playheadSeconds), playing);
    }, [clip, lane, playheadSeconds, playing, url]);

    useEffect(() => {
        const element = audioRef.current;
        return () => element?.pause();
    }, []);

    return <audio hidden preload="auto" ref={audioRef} src={url} />;
}

function resolveAudioUrl(
    asset: AudioAsset,
    libraryById: ReadonlyMap<string, MediaItem>,
    catalogById: ReadonlyMap<string, BundledAudioTrack>,
): string | undefined {
    if (asset.locator.kind === "bundled") return catalogById.get(asset.locator.key)?.url;
    const item = libraryById.get(asset.id);
    return item?.kind === "audio" ? item.url : undefined;
}
