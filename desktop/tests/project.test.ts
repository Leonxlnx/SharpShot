import { describe, expect, it } from "vitest";
import { createEmptyOverlayDocument } from "../src/shared/overlays.js";
import { createEmptyProjectAudio } from "../src/shared/project-audio.js";
import {
  PROJECT_MAGIC,
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  cloneProject,
  createClipForVideoAsset,
  createDefaultProject,
  parseProject,
  serializeProject,
  validateProject,
  type EditorProject,
  type ImageAsset,
  type VideoAsset,
} from "../src/shared/project.js";

function videoAsset(overrides: Partial<VideoAsset> = {}): VideoAsset {
  return {
    id: "video-1",
    kind: "video",
    name: "Recording.mp4",
    locator: { kind: "managed", relativePath: "media/Recording.mp4" },
    durationUs: 10_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 60, denominator: 1 },
    audio: { sampleRate: 48_000, channels: 2 },
    ...overrides,
  };
}

function populatedProject(): EditorProject {
  const asset = videoAsset();
  const project = createDefaultProject({
    id: "project-1",
    title: "Demo",
    now: "2026-08-09T12:00:00.000Z",
  });
  project.assets[asset.id] = asset;
  project.clips.push(createClipForVideoAsset(asset, { id: "clip-1" }));
  return project;
}

describe("project schema", () => {
  it("creates a stable, empty, versioned default project", () => {
    const project = createDefaultProject({
      id: "project-fixed",
      now: "2026-08-09T12:00:00.000Z",
    });

    expect(project.magic).toBe(PROJECT_MAGIC);
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.id).toBe("project-fixed");
    expect(project.clips).toEqual([]);
    expect(project.canvas.width % 2).toBe(0);
    expect(project.canvas.height % 2).toBe(0);
    expect(() => validateProject(project)).not.toThrow();
  });

  it("round-trips microsecond timing without embedding media", () => {
    const project = populatedProject();
    project.clips[0]!.sourceInUs = 1_234_567;
    project.clips[0]!.sourceOutUs = 9_876_543;

    const serialized = serializeProject(project);
    const parsed = parseProject(serialized);

    expect(parsed).toEqual(project);
    expect(parsed.clips[0]!.sourceInUs).toBe(1_234_567);
    expect(serialized).not.toContain("base64");
  });

  it("round-trips optional manual zoom while legacy schema-v1 projects stay valid", () => {
    const legacy = populatedProject();
    expect(parseProject(serializeProject(legacy)).zoom).toBeUndefined();

    legacy.zoom = {
      segments: [{
        id: "zoom-1",
        startUs: 500_000,
        endUs: 2_500_000,
        focus: { x: 0.82, y: 0.18 },
        scale: 2.25,
        easeInUs: 300_000,
        easeOutUs: 400_000,
        source: "manual",
      }],
    };

    const parsed = parseProject(serializeProject(legacy));
    expect(parsed.zoom).toEqual(legacy.zoom);
    parsed.zoom!.segments[0] = {
      ...parsed.zoom!.segments[0]!,
      focus: { ...parsed.zoom!.segments[0]!.focus, x: 0.1 },
    };
    expect(legacy.zoom.segments[0]!.focus.x).toBe(0.82);
  });

  it("round-trips optional captions while legacy schema-v1 projects stay unchanged", () => {
    const legacy = populatedProject();
    const legacyJson = serializeProject(legacy);
    expect(parseProject(legacyJson).overlays).toBeUndefined();
    expect(legacyJson).not.toContain('"overlays"');

    const overlays = createEmptyOverlayDocument();
    overlays.captions.push({
      id: "caption-1",
      startUs: 1_230_000,
      endUs: 3_450_000,
      text: "Manual caption",
      style: { preset: "clean" },
    });
    legacy.overlays = overlays;

    const parsed = parseProject(serializeProject(legacy));
    expect(parsed.overlays).toEqual(overlays);
    parsed.overlays!.captions[0]!.text = "Changed clone";
    expect(legacy.overlays.captions[0]!.text).toBe("Manual caption");
  });

  it("round-trips optional multitrack audio while legacy schema-v1 projects stay unchanged", () => {
    const legacy = populatedProject();
    const legacyJson = serializeProject(legacy);
    expect(parseProject(legacyJson).audio).toBeUndefined();
    expect(legacyJson).not.toContain('\n  "audio":');

    legacy.audio = createEmptyProjectAudio(10_000_000);
    const parsed = parseProject(serializeProject(legacy));
    expect(parsed.audio).toEqual(legacy.audio);
    parsed.audio!.lanes[0]!.name = "Changed clone";
    expect(legacy.audio.lanes[0]!.name).toBe("Source audio");
  });

  it("requires saved audio duration to match video and keeps the reserved source lane derived", () => {
    const project = populatedProject();
    project.audio = createEmptyProjectAudio(10_000_000);
    project.audio.durationUs = 9_000_000;
    expect(() => validateProject(project)).toThrow(/must match the video timeline duration/);

    project.audio.durationUs = 10_000_000;
    project.audio.lanes[0]!.kind = "music";
    expect(() => validateProject(project)).toThrow(/reserved source-audio lane must be a system lane/);
  });

  it("caps video clips before derived source audio can exceed export limits", () => {
    const project = populatedProject();
    project.audio = createEmptyProjectAudio(10_000_000);
    project.clips = Array.from({ length: 257 }, (_, index) => ({
      ...project.clips[0]!,
      id: `clip-${index}`,
    }));
    project.audio.durationUs = 2_570_000_000;

    expect(() => validateProject(project)).toThrow(/at most 200 clips/);
  });

  it("reports invalid embedded caption documents as project validation errors", () => {
    const project = populatedProject();
    project.overlays = {
      ...createEmptyOverlayDocument(),
      captions: [{
        id: "caption-1",
        startUs: 0,
        endUs: 1_000_000,
        text: "Caption",
        style: { preset: "clean", unknown: true },
      }],
    } as unknown as EditorProject["overlays"];

    expect(() => validateProject(project)).toThrow(ProjectValidationError);
    expect(() => validateProject(project)).toThrow(/project\.overlays\.captions\.0\.style/);
  });

  it("keeps captions valid when a trim or speed change shortens the project", () => {
    const project = populatedProject();
    project.clips[0]!.sourceOutUs = 1_000_000;
    project.clips[0]!.speed = 8;
    project.overlays = createEmptyOverlayDocument();
    project.overlays.captions.push({
      id: "caption-after-new-end",
      startUs: 2_000_000,
      endUs: 3_000_000,
      text: "Preserved for a later timeline edit",
      style: { preset: "clean" },
    });

    expect(() => validateProject(project)).not.toThrow();
  });

  it("clones without sharing nested mutable state", () => {
    const project = populatedProject();
    const cloned = cloneProject(project);

    cloned.clips[0]!.audio.gainDb = -12;
    cloned.canvas.screen.crop.x = 0.2;

    expect(project.clips[0]!.audio.gainDb).toBe(0);
    expect(project.canvas.screen.crop.x).toBe(0);
  });

  it("rejects a clip whose asset is missing", () => {
    const project = populatedProject();
    project.clips[0]!.assetId = "missing";

    expect(() => validateProject(project)).toThrow(/references a missing asset/);
  });

  it("rejects traversal in managed project media", () => {
    const project = populatedProject();
    const asset = project.assets["video-1"] as VideoAsset;
    asset.locator = { kind: "managed", relativePath: "../outside.mp4" };

    expect(() => validateProject(project)).toThrow(/must not escape the project/);
  });

  it("requires image backgrounds to reference image assets", () => {
    const project = populatedProject();
    project.canvas.background = {
      kind: "image",
      assetId: "video-1",
      fit: "cover",
      blurPx: 0,
      opacity: 1,
    };

    expect(() => validateProject(project)).toThrow(/must reference an image asset/);

    const image: ImageAsset = {
      id: "wallpaper-1",
      kind: "image",
      name: "Aurora",
      locator: { kind: "bundled", key: "aurora" },
      width: 3840,
      height: 2160,
    };
    project.assets[image.id] = image;
    project.canvas.background.assetId = image.id;
    expect(() => validateProject(project)).not.toThrow();
  });

  it("reports invalid JSON and unsupported schema versions explicitly", () => {
    expect(() => parseProject("{"))
      .toThrow(ProjectValidationError);

    const project = populatedProject() as unknown as { schemaVersion: number };
    project.schemaVersion = 99;
    expect(() => validateProject(project)).toThrow(/unsupported version 99/);
  });

  it("rejects overlapping and out-of-timeline zoom segments", () => {
    const project = populatedProject();
    project.clips[0]!.sourceOutUs = 4_000_000;
    project.zoom = {
      segments: [
        {
          id: "zoom-1",
          startUs: 0,
          endUs: 2_000_000,
          focus: { x: 0.25, y: 0.5 },
          scale: 2,
          easeInUs: 200_000,
          easeOutUs: 200_000,
          source: "manual",
        },
        {
          id: "zoom-2",
          startUs: 1_900_000,
          endUs: 3_000_000,
          focus: { x: 0.75, y: 0.5 },
          scale: 2,
          easeInUs: 200_000,
          easeOutUs: 200_000,
          source: "manual",
        },
      ],
    };
    expect(() => validateProject(project)).toThrow(/overlaps the previous segment/);

    project.zoom.segments[1] = {
      ...project.zoom.segments[1]!,
      startUs: 2_000_000,
      endUs: 4_000_001,
    };
    expect(() => validateProject(project)).toThrow(/exceeds durationUs/);
  });
});
