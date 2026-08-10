import { describe, expect, it } from "vitest";
import { createAudioClip, createAudioLane, createAudioTimeline } from "../../shared/audio-timeline";
import { SOURCE_AUDIO_LANE_ID } from "../../shared/project-audio";
import { INITIAL_PROJECT } from "../data";
import { exportHasAnyAudio, exportSummary, prepareExportRequest, projectHasMusic } from "./ExportSheet";
import { addSafeRedaction } from "../safe-redaction";

describe("ExportSheet audio availability", () => {
    it("enables the MP4 audio mix for imported music without embedded source audio", () => {
        const project = structuredClone(INITIAL_PROJECT);
        const durationUs = Math.max(1, Math.round(project.sourceDuration * 1_000_000));
        project.audio = createAudioTimeline({
            durationUs,
            assets: {
                music: {
                    id: "music",
                    kind: "music",
                    name: "Music",
                    locator: { kind: "library" },
                    durationUs,
                    sampleRate: 48_000,
                    channels: 2,
                },
            },
            lanes: [
                createAudioLane({ id: SOURCE_AUDIO_LANE_ID, kind: "system" }),
                createAudioLane({
                    id: "music",
                    kind: "music",
                    clips: [createAudioClip({ id: "music-clip", assetId: "music", sourceOutUs: durationUs })],
                }),
            ],
        });

        expect(projectHasMusic(project)).toBe(true);
        expect(exportHasAnyAudio(project, false)).toBe(true);
    });

    it("does not count an empty saved music lane, but keeps embedded source audio available", () => {
        const project = structuredClone(INITIAL_PROJECT);
        project.audio = createAudioTimeline({
            durationUs: Math.max(1, Math.round(project.sourceDuration * 1_000_000)),
            lanes: [
                createAudioLane({ id: SOURCE_AUDIO_LANE_ID, kind: "system" }),
                createAudioLane({ id: "music", kind: "music" }),
            ],
        });

        expect(projectHasMusic(project)).toBe(false);
        expect(exportHasAnyAudio(project, false)).toBe(false);
        expect(exportHasAnyAudio(project, true)).toBe(true);
    });
});

describe("ExportSheet project preparation", () => {
    it("persists the latest project before starting the native request", async () => {
        const order: string[] = [];
        const result = await prepareExportRequest(
            async () => { order.push("prepare"); return true; },
            async () => { order.push("request"); return "started"; },
        );

        expect(order).toEqual(["prepare", "request"]);
        expect(result).toEqual({ prepared: true, result: "started" });
    });

    it("does not start the native request when the latest save fails", async () => {
        let requested = false;
        const result = await prepareExportRequest(
            async () => false,
            async () => { requested = true; },
        );

        expect(result).toEqual({ prepared: false });
        expect(requested).toBe(false);
    });
});

describe("ExportSheet feature truth", () => {
    it("counts opaque redactions without claiming unsupported annotations", () => {
        const project = structuredClone(INITIAL_PROJECT);
        project.overlays = addSafeRedaction({
            document: project.overlays,
            playheadUs: 0,
            projectDurationUs: Math.max(1, Math.round(project.sourceDuration * 1_000_000)),
        }).document;

        const summary = exportSummary(project, "mp4", true);
        expect(summary).toContain("1 opaque redaction.");
        expect(summary).toContain("Audio mix included.");
        expect(summary).not.toContain("visual annotation");
        expect(summary).not.toContain("blur");
        expect(summary).not.toContain("spotlight");
    });

    it("describes silent GIF and disabled MP4 audio honestly", () => {
        expect(exportSummary(INITIAL_PROJECT, "gif", true)).toContain("GIF exports are silent.");
        expect(exportSummary(INITIAL_PROJECT, "mp4", false)).toContain("Audio excluded.");
    });
});
