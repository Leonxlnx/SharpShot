import { describe, expect, it } from "vitest";
import {
  ExportPlanError,
  MAX_EXPORTED_SAFE_REDACTIONS,
  atempoFilters,
  buildExportPlan,
  buildFfmpegArgs,
  computeFitModeCrop,
  computeScreenLayout,
  editorOffsetFromScreenPosition,
  evaluateZoomForCropAt,
  intersectZoomSegmentsWithClip,
  resolveScreenShadowBlur,
  screenPositionFromEditorOffset,
} from "../src/shared/export-plan.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  DEFAULT_CANVAS_STYLE,
  type EditorProject,
  type ImageAsset,
  type VideoAsset,
} from "../src/shared/project.js";
import { createEmptyOverlayDocument, type ShapeOverlay, type VisualOverlay } from "../src/shared/overlays.js";
import { createAudioClip, createAudioLane } from "../src/shared/audio-timeline.js";
import { createEmptyProjectAudio, SOURCE_AUDIO_LANE_ID } from "../src/shared/project-audio.js";

function videoAsset(id: string, audio = true): VideoAsset {
  return {
    id,
    kind: "video",
    name: `${id}.mp4`,
    locator: { kind: "external", absolutePath: `C:\\Media\\${id}.mp4` },
    durationUs: 12_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 60, denominator: 1 },
    audio: audio ? { sampleRate: 48_000, channels: 2 } : undefined,
  };
}

function exportProject(): EditorProject {
  const first = videoAsset("video-a", true);
  const second = videoAsset("video-b", false);
  const project = createDefaultProject({ id: "project", now: "2026-08-09T12:00:00.000Z" });
  project.canvas = {
    ...project.canvas,
    width: 1280,
    height: 720,
    screen: {
      ...project.canvas.screen,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      padding: 0.08,
      cornerRadius: 0.06,
      shadow: { offsetX: 0, offsetY: 12, blurPx: 24, opacity: 0.3 },
    },
  };
  project.export = { format: "mp4", fps: 60, quality: "high" };
  project.assets = { [first.id]: first, [second.id]: second };
  project.clips = [
    createClipForVideoAsset(first, {
      id: "clip-a",
      sourceInUs: 2_000_000,
      sourceOutUs: 8_000_000,
      speed: 2,
    }),
    createClipForVideoAsset(second, {
      id: "clip-b",
      sourceInUs: 1_000_000,
      sourceOutUs: 3_000_000,
      speed: 0.25,
    }),
  ];
  return project;
}

function safeRedaction(overrides: Partial<ShapeOverlay> = {}): ShapeOverlay {
  return {
    kind: "shape",
    id: "safe-redaction",
    startUs: 2_500_000,
    endUs: 4_500_000,
    opacity: 1,
    shape: "rectangle",
    area: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    fillColor: "#090A0BFF",
    strokeColor: "#00000000",
    strokeWidthPx: 0,
    cornerRadius: 0,
    rotationDeg: 0,
    ...overrides,
  };
}

describe("export filter planning", () => {
  it("builds accurate per-clip seeks, speed filters, silence, and concat", () => {
    const project = exportProject();
    const plan = buildExportPlan({
      project,
      assetPaths: {
        "video-a": "C:\\Captures\\first recording.mp4",
        "video-b": "C:\\Captures\\second recording.mp4",
      },
      outputPath: "C:\\Exports\\finished.mp4",
    });

    expect(plan.inputs).toHaveLength(2);
    expect(plan.inputs[0]!.beforeInput).toEqual([
      "-accurate_seek",
      "-ss",
      "2",
      "-t",
      "6",
    ]);
    expect(plan.filterGraph).toContain("setpts=(PTS-STARTPTS)/2");
    const firstLayout = computeScreenLayout(project, project.assets["video-a"] as VideoAsset);
    expect(plan.filterGraph).toContain("crop=1536:864:192:108");
    expect(plan.filterGraph).toContain(
      `scale=${firstLayout.screenRectPx.width}:${firstLayout.screenRectPx.height}:flags=lanczos`,
    );
    expect(plan.filterGraph).toContain(
      `overlay=x=${firstLayout.screenRectPx.x}:y=${firstLayout.screenRectPx.y}:shortest=1`,
    );
    expect(plan.filterGraph).toContain("atempo=2");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=8");
    expect(plan.filterGraph).toContain("concat=n=2:v=1:a=1[vcat][aout]");
    expect(plan.outputArgs).toContain("h264_mf");
    expect(plan.outputArgs).toContain("nv12");
    expect(plan.outputArgs).not.toContain("libx264");
    expect(plan.durationUs).toBe(11_000_000);
  });

  it("keeps the legacy graph byte-identical when zoom is absent or empty", () => {
    const project = exportProject();
    const request = {
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    };
    const legacyGraph = buildExportPlan(request).filterGraph;
    project.zoom = { segments: [] };
    const emptyZoomGraph = buildExportPlan(request).filterGraph;

    expect(emptyZoomGraph).toBe(legacyGraph);
    expect(emptyZoomGraph).not.toContain("zoompan=");
  });

  it("keeps the graph byte-identical for an absent or empty visual-overlay track", () => {
    const project = exportProject();
    const request = {
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    };
    const absentGraph = buildExportPlan(request).filterGraph;
    project.overlays = createEmptyOverlayDocument();

    expect(buildExportPlan(request).filterGraph).toBe(absentGraph);
  });

  it("draws a safe redaction over the composed canvas with clip-local end-exclusive timing", () => {
    const project = exportProject();
    project.overlays = createEmptyOverlayDocument();
    project.overlays.overlays = [safeRedaction()];
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });

    const first = "drawbox=x=320:y=180:w=640:h=360:color=0x090A0B:t=fill:" +
      "enable='gte(t,2.5)*lt(t,3)'";
    const second = "drawbox=x=320:y=180:w=640:h=360:color=0x090A0B:t=fill:" +
      "enable='gte(t,0)*lt(t,1.5)'";
    expect(plan.filterGraph).toContain(first);
    expect(plan.filterGraph).toContain(second);
    expect(plan.filterGraph.indexOf(first)).toBeLessThan(plan.filterGraph.indexOf("[clipdecorated0]"));
    expect(plan.filterGraph.indexOf(second)).toBeLessThan(plan.filterGraph.indexOf("[clipdecorated1]"));
    expect(plan.filterGraph.lastIndexOf(second)).toBeLessThan(plan.filterGraph.indexOf("concat=n=2:v=1"));
  });

  it("clamps tiny edge redactions to at least one output pixel", () => {
    const project = exportProject();
    project.overlays = createEmptyOverlayDocument();
    project.overlays.overlays = [safeRedaction({
      id: "edge-redaction",
      startUs: 0,
      endUs: 100_000,
      area: { x: 0.999_999, y: 0.999_999, width: 0.000_001, height: 0.000_001 },
    })];
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });

    expect(plan.filterGraph).toContain("drawbox=x=1279:y=719:w=1:h=1:");
  });

  it.each([
    ["blur", { kind: "blur-mask", id: "blur", startUs: 0, endUs: 1_000_000, opacity: 1, shape: "rectangle", area: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, blurPx: 20, featherPx: 0 }],
    ["ellipse", safeRedaction({ id: "ellipse", shape: "ellipse" })],
    ["translucent fill", safeRedaction({ id: "translucent", fillColor: "#000000FE" })],
    ["overlay opacity", safeRedaction({ id: "opacity", opacity: 0.99 })],
    ["border", safeRedaction({ id: "border", strokeWidthPx: 1 })],
    ["rounding", safeRedaction({ id: "rounding", cornerRadius: 0.1 })],
    ["rotation", safeRedaction({ id: "rotation", rotationDeg: 1 })],
  ] as const)("rejects an unsupported %s visual instead of silently omitting it", (_label, overlay) => {
    const project = exportProject();
    project.overlays = createEmptyOverlayDocument();
    project.overlays.overlays = [overlay as VisualOverlay];

    expect(() => buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    })).toThrow(/only exports fully opaque, axis-aligned rectangle redactions/);
  });

  it("rejects more than the bounded number of safe redactions", () => {
    const project = exportProject();
    project.overlays = createEmptyOverlayDocument();
    project.overlays.overlays = Array.from(
      { length: MAX_EXPORTED_SAFE_REDACTIONS + 1 },
      (_, index) => safeRedaction({ id: `redaction-${index}` }),
    );

    expect(() => buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    })).toThrow(`at most ${MAX_EXPORTED_SAFE_REDACTIONS} safe redaction rectangles`);
  });

  it("intersects project zoom with clip output time and inserts zoom before screen scale", () => {
    const project = exportProject();
    project.canvas.screen.border = { widthPx: 2, color: "#FFFFFF", opacity: 0.5 };
    project.zoom = {
      segments: [{
        id: "zoom-cross-cut",
        startUs: 2_500_000,
        endUs: 4_500_000,
        focus: { x: 0.95, y: 0.05 },
        scale: 2,
        easeInUs: 500_000,
        easeOutUs: 500_000,
        source: "manual",
      }],
    };
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });
    const firstChain = plan.filterGraph.match(/\[0:v\](.*?)\[clipraw0\]/s)?.[1] ?? "";
    const secondChain = plan.filterGraph.match(/\[1:v\](.*?)\[clipraw1\]/s)?.[1] ?? "";

    expect(firstChain).toContain("zoompan=");
    expect(firstChain).toContain(":d=1:s=1536x864:fps=60");
    expect(firstChain).toContain("gte(ot,2.5)*lt(ot,3)");
    expect(firstChain).toContain("(ot-(2.5))/0.5");
    expect(firstChain).toContain("((4.5)-ot)/0.5");
    expect(secondChain).toContain("gte(ot,0)*lt(ot,1.5)");
    expect(secondChain).toContain("(ot-(-0.5))/0.5");
    expect(secondChain).toContain("((1.5)-ot)/0.5");
    expect(secondChain).toContain("0.5+0.5625*");
    expect(secondChain).toContain("0.5-0.5625*");
    expect(secondChain).toContain("pow(clip(");

    expect(firstChain.indexOf("crop=")).toBeLessThan(firstChain.indexOf("fps=60"));
    expect(firstChain.indexOf("fps=60")).toBeLessThan(firstChain.indexOf("zoompan="));
    expect(firstChain.indexOf("zoompan=")).toBeLessThan(firstChain.indexOf("scale="));
    expect(firstChain.indexOf("scale=")).toBeLessThan(firstChain.indexOf("drawbox="));
  });

  it("matches smootherstep focus and edge clamping for crop-aware preview", () => {
    const segments = [{
      id: "zoom-edge",
      startUs: 0,
      endUs: 4_000_000,
      focus: { x: 1, y: 0 },
      scale: 2,
      easeInUs: 1_000_000,
      easeOutUs: 1_000_000,
      source: "manual" as const,
    }];
    const crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.8 };

    expect(evaluateZoomForCropAt(segments, 0, crop)).toMatchObject({
      scale: 1,
      influence: 0,
      x: 0.5,
      y: 0.5,
    });
    expect(evaluateZoomForCropAt(segments, 500_000, crop)).toMatchObject({
      scale: 1.5,
      influence: 0.5,
    });
    expect(evaluateZoomForCropAt(segments, 500_000, crop).x).toBeCloseTo(2 / 3, 10);
    expect(evaluateZoomForCropAt(segments, 500_000, crop).y).toBeCloseTo(1 / 3, 10);
    expect(evaluateZoomForCropAt(segments, 2_000_000, crop)).toMatchObject({
      scale: 2,
      influence: 1,
      x: 0.75,
      y: 0.25,
    });
    expect(evaluateZoomForCropAt(segments, 3_500_000, crop).influence).toBe(0.5);
    expect(evaluateZoomForCropAt(segments, 4_000_000, crop)).toMatchObject({
      scale: 1,
      influence: 0,
      x: 0.5,
      y: 0.5,
    });
  });

  it("preserves original easing across clip-local intersections", () => {
    const segment = {
      id: "zoom-1",
      startUs: 2_500_000,
      endUs: 4_500_000,
      focus: { x: 0.5, y: 0.5 },
      scale: 2,
      easeInUs: 500_000,
      easeOutUs: 500_000,
      source: "manual" as const,
    };

    expect(intersectZoomSegmentsWithClip([segment], 0, 3_000_000)).toEqual([{
      segment,
      activeStartUs: 2_500_000,
      activeEndUs: 3_000_000,
      segmentStartUs: 2_500_000,
      segmentEndUs: 4_500_000,
    }]);
    expect(intersectZoomSegmentsWithClip([segment], 3_000_000, 8_000_000)).toEqual([{
      segment,
      activeStartUs: 0,
      activeEndUs: 1_500_000,
      segmentStartUs: -500_000,
      segmentEndUs: 1_500_000,
    }]);
  });

  it("keeps hostile-looking paths out of the graph and in one argv item", () => {
    const project = exportProject();
    const oddPath = "C:\\Odd folder\\a;[x]' name.mp4";
    const outputPath = "C:\\Odd output\\done;[x].mp4";
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": oddPath, "video-b": "C:\\safe.mp4" },
      outputPath,
    });
    const args = buildFfmpegArgs(plan);

    expect(plan.filterGraph).not.toContain(oddPath);
    expect(args.filter((item) => item === oddPath)).toHaveLength(1);
    expect(args.at(-1)).toBe(outputPath);
  });

  it("supports the modern graph-file argv form", () => {
    const project = exportProject();
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });
    const args = buildFfmpegArgs(plan, { filterGraphPath: "C:\\Temp\\graph.txt" });
    const graphOption = args.indexOf("-/filter_complex");

    expect(graphOption).toBeGreaterThan(0);
    expect(args[graphOption + 1]).toBe("C:\\Temp\\graph.txt");
    expect(args).not.toContain(plan.filterGraph);
  });

  it("creates bounded atempo chains for all extreme speeds", () => {
    expect(atempoFilters(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(atempoFilters(1)).toEqual([]);
    expect(atempoFilters(4)).toEqual(["atempo=2", "atempo=2"]);
    expect(atempoFilters(8)).toEqual(["atempo=2", "atempo=2", "atempo=2"]);
  });

  it("plans gradient, rounded-corner, border, and shadow composition", () => {
    const project = exportProject();
    project.canvas.background = {
      kind: "gradient",
      angleDeg: 135,
      stops: [
        { offset: 0, color: "#5B4BFF" },
        { offset: 1, color: "#FF6B9D" },
      ],
    };
    project.canvas.screen.border = { widthPx: 2, color: "#FFFFFF", opacity: 0.5 };
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });

    expect(plan.filterGraph).toContain("format=gbrap,geq=r=");
    expect(plan.filterGraph).toContain("clip(0.5+");
    expect(plan.filterGraph).toContain("drawbox=");
    expect(plan.filterGraph).toContain("geq=lum=");
    expect(plan.filterGraph).toContain("gblur=sigma=12");
    expect(plan.filterGraph).toContain("loop=loop=-1:size=1:start=0");
    expect(plan.filterGraph).toContain("alphamerge");
    expect(plan.filterGraph).toContain("nullsrc=s=1280x720");
    expect(plan.filterGraph).toContain("[bg0][shadow0]overlay=x=0:y=0");
  });

  it("treats shadow blurPx as a CSS radius and converts only FFmpeg to sigma", () => {
    const defaultBlur = resolveScreenShadowBlur(DEFAULT_CANVAS_STYLE.screen.shadow.blurPx);
    expect(defaultBlur).toEqual({ cssBlurRadiusPx: 42, ffmpegSigma: 21 });

    const project = exportProject();
    project.canvas.screen.shadow = { ...DEFAULT_CANVAS_STYLE.screen.shadow };
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });
    expect(plan.filterGraph).toContain("gblur=sigma=21:steps=2");

    project.canvas.screen.shadow = { offsetX: -9, offsetY: 17, blurPx: 0, opacity: 0.4 };
    const hardShadowPlan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });
    expect(hardShadowPlan.filterGraph).toContain("[maskshadow0]lut=y='val*0.4'");
    expect(hardShadowPlan.filterGraph).not.toContain("gblur=");
  });

  it("renders preserve-pitch, change-pitch, mute, and audio-free MP4 plans distinctly", () => {
    const project = exportProject();
    project.clips[0]!.audio.mode = "change-pitch";
    const pitched = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });

    expect(pitched.filterGraph).toContain("asetrate=96000,aresample=48000");
    expect(pitched.audioLabel).toBe("aout");

    const silent = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
      includeAudio: false,
    });
    expect(silent.filterGraph).not.toContain("[0:a]");
    expect(silent.filterGraph).not.toContain("anullsrc");
    expect(silent.audioLabel).toBeUndefined();
    expect(silent.outputArgs).toContain("-an");
  });

  it("mixes derived source audio with imported music and ducking without reopening video inputs", () => {
    const project = exportProject();
    project.audio = createEmptyProjectAudio(11_000_000);
    project.audio.assets.music = {
      id: "music",
      kind: "music",
      name: "Music",
      locator: { kind: "library" },
      durationUs: 20_000_000,
      sampleRate: 44_100,
      channels: 2,
    };
    project.audio.lanes.push(createAudioLane({
      id: "music-lane",
      kind: "music",
      clips: [createAudioClip({ id: "music-clip", assetId: "music", sourceOutUs: 5_000_000 })],
    }));
    project.audio.ducking.push({
      id: "duck",
      triggerLaneId: SOURCE_AUDIO_LANE_ID,
      targetLaneId: "music-lane",
      thresholdDb: -24,
      ratio: 4,
      attackUs: 20_000,
      releaseUs: 250_000,
      makeupDb: 0,
    });

    const plan = buildExportPlan({
      project,
      assetPaths: {
        "video-a": "C:\\Captures\\first.mp4",
        "video-b": "C:\\Captures\\second.mp4",
        music: "C:\\Music\\track.mp3",
      },
      audioStreamIndexes: { "video-a": 3, music: 7 },
      outputPath: "C:\\Exports\\mixed.mp4",
    });

    expect(plan.inputs.filter((input) => input.kind === "audio")).toHaveLength(1);
    expect(plan.filterGraph).toContain("[0:3]atrim=start=0:duration=6");
    expect(plan.filterGraph).toContain("[2:7]atrim=start=0:end=5");
    expect(plan.filterGraph).toContain("sidechaincompress=");
    expect(plan.filterGraph).toContain("concat=n=2:v=1:a=0[vcat]");
    expect(plan.filterGraph).not.toContain("[a0]");
    expect(plan.audioLabel).toBe("audio_out");
    expect(plan.outputArgs).toContain("[audio_out]");
  });

  it("exports imported music when the video sources contain no audio", () => {
    const project = exportProject();
    const first = project.assets["video-a"] as VideoAsset;
    delete first.audio;
    project.audio = createEmptyProjectAudio(11_000_000);
    project.audio.assets.music = {
      id: "music",
      kind: "music",
      name: "Music only",
      locator: { kind: "library" },
      durationUs: 20_000_000,
      sampleRate: 48_000,
      channels: 2,
    };
    project.audio.lanes.push(createAudioLane({
      id: "music-lane",
      kind: "music",
      clips: [createAudioClip({
        id: "music-clip",
        assetId: "music",
        timelineStartUs: 1_000_000,
        sourceOutUs: 5_000_000,
      })],
    }));

    const plan = buildExportPlan({
      project,
      assetPaths: {
        "video-a": "C:\\Captures\\first.mp4",
        "video-b": "C:\\Captures\\second.mp4",
        music: "C:\\Music\\track.mp3",
      },
      audioStreamIndexes: { music: 4 },
      outputPath: "C:\\Exports\\music-only.mp4",
    });

    expect(plan.inputs.filter((input) => input.kind === "audio")).toHaveLength(1);
    expect(plan.filterGraph).not.toContain("[0:a]");
    expect(plan.filterGraph).toContain("[2:4]atrim=start=0:end=5");
    expect(plan.filterGraph).toContain("adelay=1000:all=1");
    expect(plan.audioLabel).toBe("audio_out");
    expect(plan.outputArgs).toContain("[audio_out]");
  });

  it("adds image backgrounds as safe inputs", () => {
    const project = exportProject();
    const wallpaper: ImageAsset = {
      id: "wallpaper",
      kind: "image",
      name: "Aurora",
      locator: { kind: "bundled", key: "wallpapers/aurora" },
      width: 3840,
      height: 2160,
    };
    project.assets[wallpaper.id] = wallpaper;
    project.canvas.background = {
      kind: "image",
      assetId: wallpaper.id,
      fit: "cover",
      blurPx: 18,
      opacity: 0.9,
    };
    const wallpaperPath = "C:\\Program Files\\SharpShot\\aurora.png";
    const plan = buildExportPlan({
      project,
      assetPaths: {
        "video-a": "A.mp4",
        "video-b": "B.mp4",
        wallpaper: wallpaperPath,
      },
      outputPath: "out.mp4",
    });

    expect(plan.inputs.filter((input) => input.kind === "background")).toHaveLength(1);
    expect(plan.inputs.at(-1)).toMatchObject({ kind: "background", path: wallpaperPath });
    expect(plan.inputs.at(-1)?.beforeInput).toEqual([]);
    expect(plan.filterGraph).toContain("[2:v]split=2[wallpaper0][wallpaper1]");
    expect(plan.filterGraph).toContain("[wallpaper0]scale=");
    expect(plan.filterGraph).toContain("[wallpaper1]scale=");
    expect(plan.filterGraph).toContain("force_original_aspect_ratio=increase");
    expect(plan.filterGraph).toContain("gblur=sigma=18");
    expect(plan.filterGraph).toContain("colorchannelmixer=aa=0.9");
    expect(plan.filterGraph).toContain("[bgunder0][bgimage0]overlay=x=0:y=0");
    expect(plan.filterGraph).not.toContain(wallpaperPath);
  });

  it("reuses one wallpaper input across the 200-clip export limit", () => {
    const project = exportProject();
    const source = project.assets["video-a"] as VideoAsset;
    project.assets = { [source.id]: source };
    project.clips = Array.from({ length: 200 }, (_, index) =>
      createClipForVideoAsset(source, {
        id: `clip-${index}`,
        sourceInUs: 0,
        sourceOutUs: 100_000,
      }),
    );
    const wallpaper: ImageAsset = {
      id: "wallpaper-many-cuts",
      kind: "image",
      name: "Wallpaper",
      locator: { kind: "external", absolutePath: "C:\\Media\\wallpaper.png" },
      width: 3840,
      height: 2160,
    };
    project.assets[wallpaper.id] = wallpaper;
    project.canvas.background = {
      kind: "image",
      assetId: wallpaper.id,
      fit: "cover",
      blurPx: 0,
      opacity: 1,
    };
    const wallpaperPath = "C:\\Media\\wallpaper.png";
    const plan = buildExportPlan({
      project,
      assetPaths: { [source.id]: "C:\\Media\\source.mp4", [wallpaper.id]: wallpaperPath },
      outputPath: "C:\\Exports\\many-cuts.mp4",
      includeAudio: false,
    });

    expect(plan.inputs).toHaveLength(201);
    expect(plan.inputs.filter((input) => input.kind === "background")).toHaveLength(1);
    expect(plan.inputArgs.filter((argument) => argument === wallpaperPath)).toHaveLength(1);
    expect(plan.filterGraph).toContain("[200:v]split=200[wallpaper0][wallpaper1]");
    expect(plan.filterGraph).toContain("[wallpaper199]scale=");
    expect(plan.filterGraph).toContain("concat=n=200:v=1:a=0[vcat]");
  });

  it("builds a palette GIF graph without audio", () => {
    const project = exportProject();
    const plan = buildExportPlan({
      project,
      format: "gif",
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.gif",
    });

    expect(plan.filterGraph).toContain("concat=n=2:v=1:a=0[vcat]");
    expect(plan.filterGraph).toContain("palettegen=stats_mode=diff");
    expect(plan.filterGraph).toContain("paletteuse=dither=sierra2_4a");
    expect(plan.filterGraph).not.toContain("[0:a]");
    expect(plan.filterGraph).not.toContain("anullsrc");
    expect(plan.outputArgs).toEqual(["-map", "[vout]", "-an", "-loop", "0"]);
  });

  it("builds safe two-pass GIF graphs without interpolating the palette path", () => {
    const project = exportProject();
    const common = {
      project,
      format: "gif" as const,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.gif",
      gif: { frameRate: 30, maxWidth: 640 },
    };
    const palette = buildExportPlan(common, { mode: "gif-palette" });
    const oddPalettePath = "C:\\Temp folder\\palette;[x]' file.png";
    const rendered = buildExportPlan(common, {
      mode: "gif-render",
      palettePath: oddPalettePath,
    });

    expect(palette.filterGraph).toContain("palettegen=stats_mode=full");
    expect(palette.filterGraph).not.toContain("paletteuse=");
    expect(rendered.filterGraph).toContain("paletteuse=dither=sierra2_4a");
    expect(rendered.filterGraph).not.toContain(oddPalettePath);
    expect(rendered.inputArgs.filter((item) => item === oddPalettePath)).toHaveLength(1);
    expect(rendered.outputWidth).toBe(640);
    expect(rendered.outputHeight).toBe(360);
  });

  it("computes deterministic even screen geometry", () => {
    const project = exportProject();
    const media = project.assets["video-a"] as VideoAsset;
    const layout = computeScreenLayout(project, media);

    expect(layout.sourceCropPx).toEqual({ x: 192, y: 108, width: 1536, height: 864 });
    expect(layout.screenRectPx.width % 2).toBe(0);
    expect(layout.screenRectPx.height % 2).toBe(0);
    expect(layout.screenRectPx.width).toBeGreaterThan(0);
    expect(layout.cornerRadiusPx).toBeGreaterThan(0);
  });

  it("maps 16:9 Fit and Fill exactly into a square canvas", () => {
    const project = exportProject();
    const media = project.assets["video-a"] as VideoAsset;
    project.canvas.width = 1080;
    project.canvas.height = 1080;
    project.canvas.screen.padding = 0;
    project.canvas.screen.scale = 1;
    project.canvas.screen.position = { x: 0.5, y: 0.5 };

    project.canvas.screen.crop = computeFitModeCrop("fit", media, project.canvas, 0);
    const fit = computeScreenLayout(project, media);
    expect(project.canvas.screen.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(fit.screenRectPx).toEqual({ x: 0, y: 236, width: 1080, height: 608 });

    project.canvas.screen.crop = computeFitModeCrop("fill", media, project.canvas, 0);
    const fill = computeScreenLayout(project, media);
    expect(project.canvas.screen.crop).toEqual({
      x: 0.21875,
      y: 0,
      width: 0.5625,
      height: 1,
    });
    expect(fill.screenRectPx).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
  });

  it("keeps positive position moving right at 150% scale and round-trips editor offsets", () => {
    const project = exportProject();
    const media = project.assets["video-a"] as VideoAsset;
    project.canvas.screen.scale = 1.5;
    project.canvas.screen.position = { x: 0.4, y: 0.5 };
    const left = computeScreenLayout(project, media);
    project.canvas.screen.position = { x: 0.5, y: 0.5 };
    const center = computeScreenLayout(project, media);
    project.canvas.screen.cornerRadius = 0.125;
    const roundedCenter = computeScreenLayout(project, media);
    expect(roundedCenter.cornerRadiusPx).toBe(
      Math.round(Math.min(center.screenRectPx.width, center.screenRectPx.height) * 0.125),
    );
    project.canvas.screen.position = { x: 0.6, y: 0.5 };
    const right = computeScreenLayout(project, media);

    expect(left.screenRectPx.x).toBeLessThan(center.screenRectPx.x);
    expect(right.screenRectPx.x).toBeGreaterThan(center.screenRectPx.x);

    const position = screenPositionFromEditorOffset({ x: 75, y: -40 }, project, media);
    project.canvas.screen.position = position;
    const restored = editorOffsetFromScreenPosition(project, media);
    expect(restored.x).toBeCloseTo(75, 8);
    expect(restored.y).toBeCloseTo(-40, 8);
  });

  it("honors non-uniform gradient stop offsets in the generated expression", () => {
    const project = exportProject();
    project.canvas.background = {
      kind: "gradient",
      angleDeg: 0,
      stops: [
        { offset: 0, color: "#000000" },
        { offset: 0.2, color: "#FF0000" },
        { offset: 1, color: "#FFFFFF" },
      ],
    };
    const plan = buildExportPlan({
      project,
      assetPaths: { "video-a": "A.mp4", "video-b": "B.mp4" },
      outputPath: "out.mp4",
    });

    expect(plan.filterGraph).toContain("/0.2,0,1)");
    expect(plan.filterGraph).toContain("/0.8,0,1)");
  });

  it("rejects empty projects and unresolved assets", () => {
    const empty = createDefaultProject({ id: "empty", now: "2026-08-09T12:00:00.000Z" });
    expect(() =>
      buildExportPlan({ project: empty, assetPaths: {}, outputPath: "out.mp4" }),
    ).toThrow(ExportPlanError);

    const project = exportProject();
    expect(() =>
      buildExportPlan({ project, assetPaths: {}, outputPath: "out.mp4" }),
    ).toThrow(/No resolved path/);
  });
});
