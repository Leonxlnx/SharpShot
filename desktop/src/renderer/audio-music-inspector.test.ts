import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioClip, createAudioLane, createAudioTimeline } from "../shared/audio-timeline";
import {
    AudioMusicInspector,
    audioFadePresetFor,
    audioFadePresetUs,
    audioTaskIsCurrent,
} from "./components/AudioMusicInspector";
import { INITIAL_EDITOR_STATE, projectDurationUs } from "./state";
import type { EditorState } from "./types";

afterEach(() => vi.unstubAllGlobals());

function renderAudioInspector(state: EditorState): string {
    vi.stubGlobal("window", {});
    const props: ComponentProps<typeof AudioMusicInspector> = {
        state,
        dispatch: vi.fn(() => true),
        sourceHasAudio: true,
        audioCatalog: [],
        libraryAudio: [],
        mutationsLocked: false,
        onLibraryAudioImported: vi.fn(),
        onNotify: vi.fn(),
    };
    return renderToStaticMarkup(createElement(AudioMusicInspector, props));
}

describe("audio inspector async task guard", () => {
    it("rejects probe completion during a continuous edit or open export sheet", () => {
        const project = structuredClone(INITIAL_EDITOR_STATE.project);
        const current = {
            project,
            continuousEditStart: null,
            exportOpen: false,
        };

        expect(audioTaskIsCurrent(3, 3, project, current, false)).toBe(true);
        expect(audioTaskIsCurrent(3, 3, project, { ...current, continuousEditStart: project }, false)).toBe(false);
        expect(audioTaskIsCurrent(3, 3, project, { ...current, exportOpen: true }, false)).toBe(false);
        expect(audioTaskIsCurrent(3, 3, project, current, true)).toBe(false);
    });

    it("rejects stale generations and cross-project probe completion", () => {
        const project = structuredClone(INITIAL_EDITOR_STATE.project);
        const current = { project, continuousEditStart: null, exportOpen: false };

        expect(audioTaskIsCurrent(2, 3, project, current, false)).toBe(false);
        expect(audioTaskIsCurrent(3, 3, structuredClone(project), current, false)).toBe(false);
        expect(audioTaskIsCurrent(3, 3, null, current, false)).toBe(false);
    });
});

describe("audio inspector controls", () => {
    it("keeps the selected clip first and replaces duplicate trim and fade sliders with presets", () => {
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const durationUs = projectDurationUs(initial.project);
        const asset = {
            id: "music-a",
            kind: "music" as const,
            name: "Focus track",
            locator: { kind: "bundled" as const, key: "focus-track" },
            durationUs: 4_000_000,
            sampleRate: 48_000,
            channels: 2,
        };
        const clip = createAudioClip({
            id: "music-clip-a",
            assetId: asset.id,
            sourceOutUs: asset.durationUs,
            fadeInUs: 250_000,
            fadeOutUs: 1_000_000,
        });
        const state: EditorState = {
            ...initial,
            activeTool: "audio",
            selectedAudioClipId: clip.id,
            project: {
                ...initial.project,
                audio: createAudioTimeline({
                    durationUs,
                    assets: { [asset.id]: asset },
                    lanes: [createAudioLane({ id: "music", kind: "music", clips: [clip] })],
                }),
            },
        };
        const html = renderAudioInspector(state);

        expect(html.indexOf('class="audio-music-editor"')).toBeLessThan(html.indexOf("Included tracks"));
        expect(html).toContain('aria-label="Set fade in to quick" aria-pressed="true"');
        expect(html).toContain('aria-label="Set fade out to smooth" aria-pressed="true"');
        expect(html).toContain('<details class="audio-fade-exact"><summary>Exact timing');
        expect(html).not.toContain('<details class="audio-fade-exact" open="">');
        expect(html).toContain('aria-label="Exact fade in"');
        expect(html).toContain('aria-label="Clip gain"');
        expect(html).not.toContain("Trim in");
        expect(html).not.toContain("Trim out");
        expect(html).not.toContain('aria-label="Fade in" type="range"');
        expect(html).toContain("1 clip");
        expect(html).toContain("0 tracks");
    });

    it("keeps quick and smooth fades distinct while clamping them to short clips", () => {
        expect(audioFadePresetUs("None", 400_000)).toBe(0);
        expect(audioFadePresetUs("Quick", 400_000)).toBe(100_000);
        expect(audioFadePresetUs("Smooth", 400_000)).toBe(200_000);
        expect(audioFadePresetUs("Quick", 8_000_000)).toBe(250_000);
        expect(audioFadePresetUs("Smooth", 8_000_000)).toBe(1_000_000);
        expect(audioFadePresetUs("Smooth", Number.NaN)).toBe(0);
        expect(audioFadePresetFor(100_000, 400_000)).toBe("Quick");
        expect(audioFadePresetFor(123_000, 400_000)).toBeUndefined();
    });
});
