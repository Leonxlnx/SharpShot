import { describe, expect, it } from "vitest";
import { BACKGROUND_PRESETS } from "./background-gallery";
import type { MediaItem, MediaProbe, Workflow as NativeWorkflow } from "../shared/api";
import { validateProject, type VideoAsset } from "../shared/project";
import { computeScreenLayout } from "../shared/export-plan";
import {
  canonicalProjectToRenderer,
  createCanonicalProjectFromVideo,
  rendererProjectToCanonical,
  nativeWorkflowToRenderer,
} from "./model-adapter";
import { computeRendererPreviewGeometry } from "./preview-geometry";
import { createEmptyOverlayDocument } from "../shared/overlays";
import { insertMusicClip } from "./audio-editor";

const media: MediaItem = {
  id: "recording-01", name: "Launch walkthrough.mp4", kind: "video", origin: "recording",
  mimeType: "video/mp4", byteLength: 42_000_123, createdAt: "2026-08-09T10:00:00.000Z",
  modifiedAt: "2026-08-09T10:01:00.000Z", url: "sharpshot-media://asset/recording-01",
  cursorMetadataAvailable: true,
};
const probe: MediaProbe = {
  mediaId: media.id, durationUs: 12_345_678,
  video: { codec: "h264", width: 3_840, height: 2_160, frameRate: 60_000 / 1_001, durationUs: 12_345_678, rotationDegrees: 0 },
  audio: { codec: "aac", sampleRate: 48_000, channels: 2 },
};

describe("renderer media adapter", () => {
  it("creates an export-ready managed project", () => {
    const project = createCanonicalProjectFromVideo(media, probe);
    expect(() => validateProject(project)).not.toThrow();
    expect(project.assets[media.id]).toMatchObject({ locator: { kind: "managed", relativePath: `library/${media.id}` }, durationUs: 12_345_678 });
    expect(project.clips).toHaveLength(1);
  });

  it("round-trips edits and a bundled background", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    renderer.clips = [
      { ...renderer.clips[0]!, id: "clip-left", sourceEnd: 4.5, speed: 1.5 },
      { ...renderer.clips[0]!, id: "clip-right", sourceStart: 5, name: "Finish" },
    ];
    renderer.backgroundId = "obsidian";
    renderer.aspectRatio = "1:1";
    const saved = rendererProjectToCanonical(renderer, original);
    expect(() => validateProject(saved)).not.toThrow();
    expect(saved.clips.map((clip) => clip.id)).toEqual(["clip-left", "clip-right"]);
    expect(saved.canvas.background).toMatchObject({ kind: "image", assetId: "obsidian-tide" });
  });

  it("round-trips zoom segments without sharing mutable focus objects", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    original.zoom = {
      segments: [{
        id: "manual-zoom-1",
        startUs: 1_000_000,
        endUs: 3_000_000,
        focus: { x: 0.72, y: 0.36 },
        scale: 2.25,
        easeInUs: 200_000,
        easeOutUs: 250_000,
        source: "manual",
      }],
    };

    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.zoomSegments).toEqual(original.zoom.segments);
    expect(renderer.zoomSegments).not.toBe(original.zoom.segments);
    expect(renderer.zoomSegments[0]?.focus).not.toBe(original.zoom.segments[0]?.focus);

    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.zoom?.segments).toEqual(original.zoom.segments);
    expect(saved.zoom?.segments).not.toBe(renderer.zoomSegments);
    expect(saved.zoom?.segments[0]?.focus).not.toBe(renderer.zoomSegments[0]?.focus);
    expect(() => validateProject(saved)).not.toThrow();
  });

  it("round-trips captions and disabled visual annotations losslessly", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const overlays = createEmptyOverlayDocument();
    overlays.captions = [{
      id: "caption-1",
      startUs: 1_000_000,
      endUs: 3_000_000,
      text: "Built into the project",
      speaker: "Host",
      style: { preset: "lower-third", overrides: { color: "#FFEEDDFF", position: { x: 0.12 } } },
    }];
    overlays.overlays = [{
      id: "blur-1",
      kind: "blur-mask",
      startUs: 500_000,
      endUs: 2_500_000,
      opacity: 0.75,
      shape: "rectangle",
      area: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      blurPx: 18,
      featherPx: 7,
    }];
    original.overlays = overlays;

    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.overlays).toEqual(overlays);
    expect(renderer.overlays).not.toBe(overlays);
    expect(renderer.overlays.captions[0]?.style).not.toBe(overlays.captions[0]?.style);
    expect(renderer.overlays.overlays[0]).not.toBe(overlays.overlays[0]);

    renderer.overlays.captions[0]!.text = "Edited locally";
    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.overlays).toEqual(renderer.overlays);
    expect(saved.overlays).not.toBe(renderer.overlays);
    expect(saved.overlays?.overlays).toEqual(overlays.overlays);
    expect(() => validateProject(saved)).not.toThrow();
  });

  it("keeps the optional legacy overlay field absent when the renderer document is empty", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    expect(original.overlays).toBeUndefined();
    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.overlays).toEqual(createEmptyOverlayDocument());
    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.overlays).toBeUndefined();
  });

  it("round-trips path-free music assets and reconciles them after a video trim", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const inserted = insertMusicClip({
      durationUs: probe.durationUs!,
      playheadUs: 1_000_000,
      asset: {
        id: "music-roundtrip",
        kind: "music",
        name: "Roundtrip music",
        locator: { kind: "library" },
        durationUs: 8_000_000,
        sampleRate: 48_000,
        channels: 2,
      },
    });
    original.audio = inserted.timeline;

    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.audio).toEqual(original.audio);
    expect(renderer.audio).not.toBe(original.audio);
    expect(renderer.audio?.assets["music-roundtrip"]).not.toBe(original.audio.assets["music-roundtrip"]);
    renderer.clips[0] = { ...renderer.clips[0]!, sourceEnd: 4 };

    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.audio?.durationUs).toBe(4_000_000);
    expect(saved.audio?.lanes.find((lane) => lane.kind === "music")?.clips[0]).toMatchObject({
      timelineStartUs: 1_000_000,
      sourceOutUs: 3_000_000,
    });
    expect(() => validateProject(saved)).not.toThrow();
  });

  it("keeps a split clip attached to its original asset and audio metadata", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const first = original.clips[0]!;
    original.assets["recording-02"] = {
      ...structuredClone(original.assets[media.id]!),
      id: "recording-02",
      locator: { kind: "managed", relativePath: "library/recording-02" },
    };
    original.clips = [
      first,
      { ...structuredClone(first), id: "second", assetId: "recording-02", audio: { mode: "mute", gainDb: -12 } },
    ];
    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.clips.map((clip) => clip.sourceAudio)).toEqual(original.clips.map((clip) => clip.audio));
    const second = renderer.clips[1]!;
    const midpoint = (second.sourceStart + second.sourceEnd) / 2;
    renderer.clips = [
      renderer.clips[0]!,
      { ...second, id: "second-left", sourceEnd: midpoint },
      { ...second, id: "second-right", sourceStart: midpoint },
    ];

    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.clips.map(({ assetId }) => assetId)).toEqual([media.id, "recording-02", "recording-02"]);
    expect(saved.clips.slice(1).map(({ audio }) => audio)).toEqual([
      { mode: "mute", gainDb: -12 },
      { mode: "mute", gainDb: -12 },
    ]);
    expect(() => validateProject(saved)).not.toThrow();
  });

  it("only accepts a registered library image as a managed background", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    const image: MediaItem = { ...media, id: "background-01", name: "Background.png", kind: "image", mimeType: "image/png", url: "sharpshot-media://asset/background-01" };
    renderer.backgroundId = image.url;
    const saved = rendererProjectToCanonical(renderer, original, [media, image]);
    expect(saved.canvas.background).toMatchObject({ kind: "image", assetId: image.id });
  });

  it.each(BACKGROUND_PRESETS)("round-trips the $name background preset", (preset) => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    renderer.backgroundId = preset.id;

    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.canvas.background).toEqual(preset.style);
    expect(canonicalProjectToRenderer(saved).backgroundId).toBe(preset.id);
  });

  it("reopens a registered external image background through the safe media protocol", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const image: MediaItem = { ...media, id: "background-01", name: "Background.png", kind: "image", mimeType: "image/png", url: "sharpshot-media://asset/background-01" };
    const renderer = canonicalProjectToRenderer(original);
    renderer.backgroundId = image.url;
    const imported = rendererProjectToCanonical(renderer, original, [media, image]);

    const registeredExternal = structuredClone(imported);
    registeredExternal.assets[image.id]!.locator = {
      kind: "external",
      absolutePath: "C:\\Users\\someone\\Pictures\\private-wallpaper.png",
    };

    const reopened = canonicalProjectToRenderer(registeredExternal);
    expect(reopened.backgroundId).toBe(image.url);
    expect(reopened.backgroundId).not.toContain("private-wallpaper");

    const savedAgain = rendererProjectToCanonical(reopened, registeredExternal, [media, image]);
    expect(savedAgain.canvas.background).toEqual(registeredExternal.canvas.background);
    expect(savedAgain.assets[image.id]).toEqual(registeredExternal.assets[image.id]);
  });

  it.each([
    { preset: "vertical" as const, width: 1_080, height: 1_920, aspect: "9:16" as const },
    { preset: "tall" as const, width: 1_080, height: 1_350, aspect: "4:5" as const },
  ])("preserves a $preset canvas through a no-op renderer round trip", ({ preset, width, height, aspect }) => {
    const original = createCanonicalProjectFromVideo(media, probe);
    original.canvas = { ...original.canvas, preset, width, height };
    const renderer = canonicalProjectToRenderer(original);
    expect(renderer.aspectRatio).toBe(aspect);
    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.canvas).toMatchObject({ preset, width, height });
    expect(() => validateProject(saved)).not.toThrow();
  });

  it("does not coerce a custom canvas merely because Studio autosaves", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    original.canvas = { ...original.canvas, preset: "custom", width: 1_700, height: 1_000 };
    const renderer = canonicalProjectToRenderer(original);
    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.canvas).toMatchObject({ preset: "custom", width: 1_700, height: 1_000 });
  });

  it("normalizes legacy workflow promises and exposes audio Copy only with the quick mux capability", () => {
    const legacy: NativeWorkflow = {
      version: 1,
      id: "legacy-video",
      name: "Legacy video",
      kind: "video",
      enabled: true,
      capture: { source: "display", cursor: "editable-metadata", countdownMs: 5_000 },
      video: { fps: 60, quality: "high", systemAudio: true },
      finish: { saveOriginal: true, clipboard: "file", afterCapture: "nothing" },
    };
    const unsupported = nativeWorkflowToRenderer(legacy, []);
    expect(unsupported).toMatchObject({ target: "Region", countdown: 3, cursor: true });
    expect(unsupported.after).not.toContain("Copy");
    expect(nativeWorkflowToRenderer(legacy, [], { quickVideoAudioMux: true }).after).toContain("Copy");
    expect(nativeWorkflowToRenderer({ ...legacy, finish: { ...legacy.finish, afterCapture: "open-editor" } }, [], { quickVideoAudioMux: true }).after).not.toContain("Copy");
  });

  it.each(["fit", "fill"] as const)("keeps a 16:9 source consistent when changing a project to 1:1 %s", (fitMode) => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    renderer.aspectRatio = "1:1";
    renderer.fitMode = fitMode;
    delete renderer.crop;
    const saved = rendererProjectToCanonical(renderer, original);
    const asset = saved.assets[media.id] as VideoAsset;
    const layout = computeScreenLayout(saved, asset);
    if (fitMode === "fit") {
      expect(saved.canvas.screen.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
      expect(layout.screenRectPx.width).toBeGreaterThan(layout.screenRectPx.height);
    } else {
      expect(saved.canvas.screen.crop.x).toBeCloseTo(0.21875, 5);
      expect(saved.canvas.screen.crop.width).toBeCloseTo(0.5625, 5);
      expect(layout.screenRectPx.width).toBe(layout.screenRectPx.height);
    }
  });

  it("keeps positive and negative position direction at 150% scale", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const centered = canonicalProjectToRenderer(original);
    centered.scale = 150;
    centered.offsetX = 0;
    const centeredProject = rendererProjectToCanonical(centered, original);
    const asset = centeredProject.assets[media.id] as VideoAsset;
    const centerX = computeScreenLayout(centeredProject, asset).screenRectPx.x;

    const left = { ...centered, offsetX: -60 };
    const right = { ...centered, offsetX: 60 };
    const leftProject = rendererProjectToCanonical(left, original);
    const rightProject = rendererProjectToCanonical(right, original);
    expect(computeScreenLayout(leftProject, leftProject.assets[media.id] as VideoAsset).screenRectPx.x).toBeLessThan(centerX);
    expect(computeScreenLayout(rightProject, rightProject.assets[media.id] as VideoAsset).screenRectPx.x).toBeGreaterThan(centerX);
    expect(canonicalProjectToRenderer(leftProject).offsetX).toBeCloseTo(-60, 0);
    expect(canonicalProjectToRenderer(rightProject).offsetX).toBeCloseTo(60, 0);
  });

  it("persists an explicit crop with preview and export geometry in parity", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    renderer.crop = { x: 0.11, y: 0.07, width: 0.72, height: 0.81 };
    renderer.scale = 127;
    renderer.offsetX = -18;
    renderer.offsetY = 21;

    const preview = computeRendererPreviewGeometry(renderer);
    const saved = rendererProjectToCanonical(renderer, original);
    const exported = computeScreenLayout(saved, saved.assets[media.id] as VideoAsset);

    expect(saved.canvas.screen.crop).toEqual(renderer.crop);
    expect(exported.sourceCropPx).toEqual(preview.layout.sourceCropPx);
    expect(exported.screenRectPx).toEqual(preview.layout.screenRectPx);
  });

  it("recomputes the selected fit mode after an explicit crop is cleared", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    original.canvas = { ...original.canvas, width: 1_080, height: 1_080, preset: "square" };
    original.canvas.screen.crop = { x: 0.1, y: 0.08, width: 0.7, height: 0.84 };
    const renderer = canonicalProjectToRenderer(original);
    delete renderer.crop;
    renderer.fitMode = "fill";

    const saved = rendererProjectToCanonical(renderer, original);
    expect(saved.canvas.screen.crop.x).toBeCloseTo(0.21875, 6);
    expect(saved.canvas.screen.crop.y).toBe(0);
    expect(saved.canvas.screen.crop.width).toBeCloseTo(0.5625, 6);
    expect(saved.canvas.screen.crop.height).toBe(1);
  });

  it("preserves richer canonical fields when a rename and trim do not edit them", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const asset = original.assets[media.id] as VideoAsset;
    original.clips = [
      { ...original.clips[0]!, id: "rich-a", sourceOutUs: 6_000_000, audio: { mode: "mute", gainDb: -12 } },
      { ...original.clips[0]!, id: "rich-b", sourceInUs: 6_000_000, audio: { mode: "change-pitch", gainDb: 7.25 } },
    ];
    original.canvas.screen = {
      ...original.canvas.screen,
      crop: { x: 0.13, y: 0.07, width: 0.74, height: 0.82 },
      padding: 0.22,
      scale: 2.8,
      position: { x: 0.31, y: 0.76 },
      cornerRadius: 0.18,
      border: { widthPx: 9, color: "#AABBCC", opacity: 0.63 },
      shadow: { offsetX: -17, offsetY: 33, blurPx: 87, opacity: 0.74 },
    };
    original.assets["rich-wallpaper"] = {
      id: "rich-wallpaper",
      kind: "image",
      name: "Rich wallpaper",
      locator: { kind: "bundled", key: "rich-wallpaper" },
      width: 3_840,
      height: 2_160,
    };
    original.canvas.background = { kind: "image", assetId: "rich-wallpaper", fit: "contain", blurPx: 27, opacity: 0.58 };
    const untouched = JSON.stringify({
      screen: original.canvas.screen,
      background: original.canvas.background,
      audio: original.clips.map((clip) => clip.audio),
      asset,
    });

    const renderer = canonicalProjectToRenderer(original);
    renderer.name = "Renamed safely";
    renderer.clips[0] = { ...renderer.clips[0]!, sourceEnd: renderer.clips[0]!.sourceEnd - 0.25 };
    const saved = rendererProjectToCanonical(renderer, original);
    expect(JSON.stringify({
      screen: saved.canvas.screen,
      background: saved.canvas.background,
      audio: saved.clips.map((clip) => clip.audio),
      asset: saved.assets[media.id],
    })).toBe(untouched);
    expect(saved.title).toBe("Renamed safely");
    expect(saved.clips[0]?.sourceOutUs).toBe(5_750_000);
  });

  it("keeps the displayed corner radius stable when scale changes", () => {
    const original = createCanonicalProjectFromVideo(media, probe);
    const renderer = canonicalProjectToRenderer(original);
    const radius = renderer.cornerRadius;
    renderer.scale = 150;
    const saved = rendererProjectToCanonical(renderer, original);
    expect(computeScreenLayout(saved, saved.assets[media.id] as VideoAsset).cornerRadiusPx).toBe(radius);
  });
});
