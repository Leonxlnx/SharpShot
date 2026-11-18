import { describe, expect, it } from "vitest";
import type { MediaItem, MediaProbe } from "../shared/api";
import { validateProject } from "../shared/project";
import { canonicalProjectToRenderer, createCanonicalProjectFromVideo, rendererProjectToCanonical } from "./model-adapter";
import { clipDuration, editorReducer, INITIAL_EDITOR_STATE } from "./state";

const media: MediaItem = {
    id: "long-recording",
    name: "Long recording.mp4",
    kind: "video",
    origin: "recording",
    mimeType: "video/mp4",
    byteLength: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    modifiedAt: "2026-08-10T00:00:00.000Z",
    url: "sharpshot-media://asset/long-recording",
};

const probe: MediaProbe = {
    mediaId: media.id,
    durationUs: 120_000_000,
    video: {
        codec: "h264",
        width: 1_920,
        height: 1_080,
        frameRate: 60,
        durationUs: 120_000_000,
        rotationDegrees: 0,
    },
};

describe("split clip ids", () => {
    it("keeps 60 repeated splits bounded, unique, and save-valid", () => {
        const canonical = createCanonicalProjectFromVideo(media, probe);
        let state = {
            ...structuredClone(INITIAL_EDITOR_STATE),
            project: canonicalProjectToRenderer(canonical),
        };

        for (let split = 0; split < 60; split += 1) {
            let cursor = 0;
            let longestIndex = 0;
            let longestDuration = 0;
            state.project.clips.forEach((clip, index) => {
                const duration = clipDuration(clip);
                if (duration > longestDuration) {
                    longestDuration = duration;
                    longestIndex = index;
                }
            });
            for (let index = 0; index < longestIndex; index += 1) cursor += clipDuration(state.project.clips[index]!);
            state = editorReducer({ ...state, playhead: cursor + longestDuration / 2 }, { type: "SPLIT" });
        }

        const ids = state.project.clips.map((clip) => clip.id);
        expect(ids).toHaveLength(61);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))).toBe(true);
        expect(state.project.clips.every((clip) => clip.sourceClipId === canonical.clips[0]!.id)).toBe(true);

        const saved = rendererProjectToCanonical(state.project, canonical);
        expect(() => validateProject(saved)).not.toThrow();
        expect(saved.clips.every((clip) => clip.assetId === media.id)).toBe(true);
    });
});
