import { describe, expect, it } from "vitest";
import type { AudioClip, AudioLane } from "../shared/audio-timeline";
import {
    audioClipPreviewAt,
    audioLanePreviewClipsAt,
    syncAudioPreviewElement,
    type AudioClipPreviewState,
} from "./components/AudioPreview";

const lane: AudioLane = {
    id: "music",
    kind: "music",
    name: "Music",
    gainDb: 0,
    muted: false,
    clips: [],
};

const clip: AudioClip = {
    id: "music-clip",
    assetId: "music-asset",
    timelineStartUs: 1_000_000,
    sourceInUs: 2_000_000,
    sourceOutUs: 6_000_000,
    playbackRate: { numerator: 2, denominator: 1 },
    speedMode: "preserve-pitch",
    gainDb: 0,
    muted: false,
    fadeInUs: 0,
    fadeOutUs: 0,
};

describe("audio preview timing", () => {
    it("maps timeline time into source time at the clip playback rate", () => {
        expect(audioClipPreviewAt(clip, lane, 1.5)).toMatchObject({
            sourceSeconds: 3,
            playbackRate: 2,
            preservesPitch: true,
        });
    });

    it("uses start-inclusive and end-exclusive active bounds", () => {
        expect(audioClipPreviewAt(clip, lane, 0.999999)).toBeNull();
        expect(audioClipPreviewAt(clip, lane, 1)?.sourceSeconds).toBe(2);
        expect(audioClipPreviewAt(clip, lane, 2.999999)).not.toBeNull();
        expect(audioClipPreviewAt(clip, lane, 3)).toBeNull();
        expect(audioClipPreviewAt(clip, lane, Number.NaN)).toBeNull();
    });

    it("keeps only the active clip and nearest upcoming clip in the preload budget", () => {
        const first = {
            ...clip,
            id: "first",
            timelineStartUs: 0,
            sourceInUs: 0,
            sourceOutUs: 2_000_000,
            playbackRate: { numerator: 1, denominator: 1 },
        };
        const next = { ...first, id: "next", timelineStartUs: 2_000_000 };
        const later = { ...first, id: "later", timelineStartUs: 4_000_000 };

        expect(audioLanePreviewClipsAt([later, next, first], 0.5).map(({ id }) => id)).toEqual([
            "first",
            "next",
        ]);
        expect(audioLanePreviewClipsAt([later, next, first], -1).map(({ id }) => id)).toEqual(["first"]);
    });

    it("switches the bounded pool exactly at an end boundary", () => {
        const first = {
            ...clip,
            id: "first",
            timelineStartUs: 0,
            sourceInUs: 0,
            sourceOutUs: 2_000_000,
            playbackRate: { numerator: 1, denominator: 1 },
        };
        const next = { ...first, id: "next", timelineStartUs: 2_000_000 };
        const later = { ...first, id: "later", timelineStartUs: 4_000_000 };

        expect(audioLanePreviewClipsAt([first, next, later], 2).map(({ id }) => id)).toEqual([
            "next",
            "later",
        ]);
        expect(audioClipPreviewAt(next, lane, 2)?.sourceSeconds).toBe(0);
    });
});

describe("audio preview media synchronization", () => {
    const preview: AudioClipPreviewState = {
        sourceSeconds: 0.08,
        playbackRate: 2,
        preservesPitch: false,
        volume: 0.4,
    };

    it("applies media settings, seeks a paused element, and starts playback", async () => {
        const element = new FakeAudio();
        element.currentTime = 0.04;

        await syncAudioPreviewElement(element, preview, true);

        expect(element.currentTime).toBe(0.08);
        expect(element.playbackRate).toBe(2);
        expect(element.preservesPitch).toBe(false);
        expect(element.volume).toBe(0.4);
        expect(element.playCalls).toBe(1);
    });

    it("seeks only when playback drift is greater than 80 milliseconds", () => {
        const element = new FakeAudio();
        element.paused = false;
        element.currentTime = 0;

        syncAudioPreviewElement(element, preview, true);
        expect(element.currentTime).toBe(0);

        syncAudioPreviewElement(element, { ...preview, sourceSeconds: 0.080001 }, true);
        expect(element.currentTime).toBe(0.080001);
    });

    it("catches play rejection and pauses inactive or non-playing media", async () => {
        const element = new FakeAudio();
        element.rejectPlay = true;
        await expect(syncAudioPreviewElement(element, preview, true)).resolves.toBeUndefined();

        element.paused = false;
        syncAudioPreviewElement(element, null, true);
        expect(element.pauseCalls).toBe(1);

        element.paused = false;
        element.currentTime = 0;
        syncAudioPreviewElement(element, preview, false);
        expect(element.currentTime).toBe(0.08);
        expect(element.pauseCalls).toBe(2);
    });
});

describe("audio preview volume", () => {
    it("combines lane and clip gain and honors either mute", () => {
        expect(audioClipPreviewAt(
            { ...clip, gainDb: -6 },
            { ...lane, gainDb: -6 },
            2,
        )?.volume).toBeCloseTo(10 ** (-12 / 20), 8);
        expect(audioClipPreviewAt({ ...clip, muted: true }, lane, 2)?.volume).toBe(0);
        expect(audioClipPreviewAt(clip, { ...lane, muted: true }, 2)?.volume).toBe(0);
    });

    it("applies the linear fade envelopes used by export", () => {
        const faded = {
            ...clip,
            playbackRate: { numerator: 1, denominator: 1 },
            fadeInUs: 2_000_000,
            fadeOutUs: 2_000_000,
        };
        expect(audioClipPreviewAt(faded, lane, 1.5)?.volume).toBeCloseTo(0.25, 8);
        expect(audioClipPreviewAt(faded, lane, 3)?.volume).toBe(1);
        expect(audioClipPreviewAt(faded, lane, 4.5)?.volume).toBeCloseTo(0.25, 8);
    });

    it("clamps positive gain to the HTML media volume ceiling", () => {
        expect(audioClipPreviewAt({ ...clip, gainDb: 12 }, { ...lane, gainDb: 12 }, 2)?.volume).toBe(1);
    });
});

class FakeAudio {
    currentTime = 0;
    paused = true;
    playbackRate = 1;
    preservesPitch = true;
    volume = 1;
    playCalls = 0;
    pauseCalls = 0;
    rejectPlay = false;

    pause() {
        this.pauseCalls += 1;
        this.paused = true;
    }

    play() {
        this.playCalls += 1;
        if (this.rejectPlay) return Promise.reject(new Error("autoplay blocked"));
        this.paused = false;
        return Promise.resolve();
    }
}
