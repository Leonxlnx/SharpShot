import { describe, expect, it } from "vitest";
import { parseProject as parseProjectRequest } from "../src/shared/api.js";
import { createEmptyOverlayDocument } from "../src/shared/overlays.js";
import { createEmptyProjectAudio } from "../src/shared/project-audio.js";
import { createClipForVideoAsset, createDefaultProject, type VideoAsset } from "../src/shared/project.js";

describe("project IPC validation", () => {
  it("accepts the persisted zoom track", () => {
    const project = createDefaultProject({ id: "project-zoom-ipc", now: "2026-08-10T00:00:00.000Z" });
    project.zoom = { segments: [] };
    expect(parseProjectRequest(project).zoom).toEqual({ segments: [] });
  });

  it("accepts captions but keeps the top-level project whitelist strict", () => {
    const project = createDefaultProject({ id: "project-captions-ipc", now: "2026-08-10T00:00:00.000Z" });
    project.overlays = createEmptyOverlayDocument();
    project.overlays.captions.push({
      id: "caption-1",
      startUs: 0,
      endUs: 1_000_000,
      text: "Imported caption",
      style: { preset: "boxed" },
    });

    const parsed = parseProjectRequest(project);
    expect(parsed.overlays).toEqual(project.overlays);
    expect(parsed.overlays).not.toBe(project.overlays);
    expect(() => parseProjectRequest({ ...project, surprise: true })).toThrow(/unsupported field: surprise/);
  });

  it("accepts optional project audio alongside captions", () => {
    const project = createDefaultProject({ id: "project-audio-ipc", now: "2026-08-10T00:00:00.000Z" });
    const video: VideoAsset = {
      id: "video-audio-ipc",
      kind: "video",
      name: "Recording.mp4",
      locator: { kind: "managed", relativePath: "library/video-audio-ipc" },
      durationUs: 2_000_000,
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    };
    project.assets[video.id] = video;
    project.clips = [createClipForVideoAsset(video, { id: "clip-audio-ipc" })];
    project.audio = createEmptyProjectAudio(2_000_000);
    project.overlays = createEmptyOverlayDocument();

    const parsed = parseProjectRequest(project);
    expect(parsed.audio).toEqual(project.audio);
    expect(parsed.audio).not.toBe(project.audio);
    expect(parsed.overlays).toEqual(project.overlays);
  });
});
