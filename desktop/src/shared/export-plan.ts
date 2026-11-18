import {
  type AssetId,
  type BackgroundStyle,
  type EditorProject,
  type NormalizedRect,
  type OutputFormat,
  type TimeUs,
  type TimelineClip,
  type VideoAsset,
  validateProject,
} from "./project.js";
import { clipDurationUs, projectDurationUs } from "./editor-reducer.js";
import {
  evaluateZoomAt,
  type EvaluatedZoom,
  type ZoomSegment,
} from "./cursor-zoom.js";
import { AudioPlanError, buildAudioFilterPlan } from "./audio-timeline.js";
import { ProjectAudioError, materializeProjectAudio } from "./project-audio.js";
import type { ShapeOverlay, VisualOverlay } from "./overlays.js";

export interface ExportPlanRequest {
  project: EditorProject;
  /** Resolved by the trusted main process. Values are never interpolated into a filter graph. */
  assetPaths: Readonly<Record<AssetId, string>>;
  outputPath: string;
  format?: OutputFormat;
  /** MP4 only. GIF never includes audio. */
  includeAudio?: boolean;
  /** Main-process output override. The canonical project remains the source of all editor effects. */
  frameRate?: number;
  /** Exact absolute FFmpeg audio stream indexes selected by the trusted main process. */
  audioStreamIndexes?: Readonly<Record<string, number>>;
  gif?: {
    frameRate?: number;
    maxWidth?: number;
  };
}

export type ExportGraphMode = "final" | "gif-palette" | "gif-render";

export interface ExportPlanBuildOptions {
  mode?: ExportGraphMode;
  /** A main-process-owned temporary file used only by the second GIF pass. */
  palettePath?: string;
  /** Encoder-native final surface. Defaults to the portable software format. */
  mp4PixelFormat?: "yuv420p" | "nv12";
}

export interface ExportInput {
  kind: "clip" | "background" | "audio";
  assetId: AssetId;
  path: string;
  beforeInput: string[];
}

export interface ExportPlan {
  format: OutputFormat;
  inputs: ExportInput[];
  inputArgs: string[];
  filterGraph: string;
  outputArgs: string[];
  outputPath: string;
  durationUs: TimeUs;
  frameRate: number;
  outputWidth: number;
  outputHeight: number;
  videoLabel: string;
  audioLabel?: string;
}

export interface ScreenLayout {
  sourceCropPx: { x: number; y: number; width: number; height: number };
  screenRectPx: { x: number; y: number; width: number; height: number };
  cornerRadiusPx: number;
}

export interface ClipZoomIntersection {
  readonly segment: ZoomSegment;
  /** Visible bounds inside this clip's output timeline. */
  readonly activeStartUs: TimeUs;
  readonly activeEndUs: TimeUs;
  /** Original segment bounds shifted into clip-local output time. May cross a clip edge. */
  readonly segmentStartUs: number;
  readonly segmentEndUs: number;
}

export type ScreenFitMode = "fit" | "fill";

const EDITOR_OFFSET_RATIO = 0.0016;

export interface ScreenShadowBlurMetrics {
  /** Browser box-shadow blur radius, in canvas pixels. */
  cssBlurRadiusPx: number;
  /** FFmpeg gblur standard deviation, in canvas pixels. */
  ffmpegSigma: number;
}

/**
 * `ScreenStyle.shadow.blurPx` canonically means the CSS box-shadow blur radius
 * in canvas pixels. Chromium consumes that radius directly; FFmpeg's `gblur`
 * consumes Gaussian sigma, which is approximately half the CSS blur radius.
 */
export function resolveScreenShadowBlur(blurPx: number): ScreenShadowBlurMetrics {
  return {
    cssBlurRadiusPx: blurPx,
    ffmpegSigma: blurPx / 2,
  };
}

/** Exact crop persisted for preview/export fit-mode parity. */
export function computeFitModeCrop(
  mode: ScreenFitMode,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  padding: number,
): NormalizedRect {
  if (mode === "fit") return { x: 0, y: 0, width: 1, height: 1 };
  const paddingPx = Math.round(Math.min(canvas.width, canvas.height) * padding);
  const innerWidth = Math.max(2, canvas.width - paddingPx * 2);
  const innerHeight = Math.max(2, canvas.height - paddingPx * 2);
  const sourceAspect = source.width / source.height;
  const targetAspect = innerWidth / innerHeight;
  if (sourceAspect > targetAspect) {
    const width = targetAspect / sourceAspect;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  const height = sourceAspect / targetAspect;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

/**
 * Converts the editor's -100..100 offset controls into canonical normalized
 * screen-center coordinates without making direction depend on scale.
 */
export function screenPositionFromEditorOffset(
  offset: { x: number; y: number },
  project: Pick<EditorProject, "canvas">,
  asset: Pick<VideoAsset, "width" | "height">,
): { x: number; y: number } {
  const geometry = computeBaseScreenGeometry(project, asset);
  return {
    x: clamp(
      0.5 + offset.x * EDITOR_OFFSET_RATIO * geometry.baseWidth / geometry.innerWidth,
      0,
      1,
    ),
    y: clamp(
      0.5 + offset.y * EDITOR_OFFSET_RATIO * geometry.baseHeight / geometry.innerHeight,
      0,
      1,
    ),
  };
}

/** Inverse of screenPositionFromEditorOffset for loading saved projects. */
export function editorOffsetFromScreenPosition(
  project: Pick<EditorProject, "canvas">,
  asset: Pick<VideoAsset, "width" | "height">,
): { x: number; y: number } {
  const geometry = computeBaseScreenGeometry(project, asset);
  return {
    x: (project.canvas.screen.position.x - 0.5) * geometry.innerWidth /
      (EDITOR_OFFSET_RATIO * geometry.baseWidth),
    y: (project.canvas.screen.position.y - 0.5) * geometry.innerHeight /
      (EDITOR_OFFSET_RATIO * geometry.baseHeight),
  };
}

export class ExportPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPlanError";
  }
}

/** A deliberately small first export surface for privacy-safe visual masking. */
export const MAX_EXPORTED_SAFE_REDACTIONS = 64;

/**
 * Returns the only visual-overlay subset this exporter currently renders.
 * Rejecting everything else prevents persisted future-facing overlay data from
 * being silently omitted from an export.
 */
export function validateSafeRedactionsForExport(
  overlays: readonly VisualOverlay[],
): ShapeOverlay[] {
  if (overlays.length > MAX_EXPORTED_SAFE_REDACTIONS) {
    throw new ExportPlanError(
      `An export can contain at most ${MAX_EXPORTED_SAFE_REDACTIONS} safe redaction rectangles`,
    );
  }

  const redactions = overlays.map((overlay) => {
    const opaqueFill = overlay.kind === "shape"
      && overlay.opacity === 1
      && (overlay.fillColor.length === 7 || overlay.fillColor.slice(7).toUpperCase() === "FF");
    if (
      overlay.kind !== "shape" ||
      overlay.shape !== "rectangle" ||
      !opaqueFill ||
      overlay.strokeWidthPx !== 0 ||
      overlay.cornerRadius !== 0 ||
      overlay.rotationDeg !== 0
    ) {
      throw new ExportPlanError(
        `Visual overlay ${JSON.stringify(overlay.id)} cannot be exported; ` +
        "this version only exports fully opaque, axis-aligned rectangle redactions with no border or rounding",
      );
    }
    return overlay;
  });

  return redactions.sort((left, right) =>
    left.startUs - right.startUs ||
    left.endUs - right.endUs ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function computeScreenLayout(project: EditorProject, asset: VideoAsset): ScreenLayout {
  const { screen } = project.canvas;
  const geometry = computeBaseScreenGeometry(project, asset);
  const {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    paddingPx,
    innerWidth,
    innerHeight,
    baseWidth,
    baseHeight,
  } = geometry;
  const screenWidth = evenAtLeastTwo(Math.round(baseWidth * screen.scale));
  const screenHeight = evenAtLeastTwo(Math.round(baseHeight * screen.scale));
  const x = Math.round(paddingPx + innerWidth * screen.position.x - screenWidth / 2);
  const y = Math.round(paddingPx + innerHeight * screen.position.y - screenHeight / 2);
  const cornerRadiusPx = Math.round(
    Math.min(screenWidth, screenHeight) * screen.cornerRadius,
  );

  return {
    sourceCropPx: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    screenRectPx: { x, y, width: screenWidth, height: screenHeight },
    cornerRadiusPx,
  };
}

export function intersectZoomSegmentsWithClip(
  segments: readonly ZoomSegment[],
  clipTimelineStartUs: TimeUs,
  clipDurationUs: TimeUs,
): ClipZoomIntersection[] {
  const clipTimelineEndUs = clipTimelineStartUs + clipDurationUs;
  return segments
    .filter(
      (segment) =>
        segment.startUs < clipTimelineEndUs && segment.endUs > clipTimelineStartUs,
    )
    .map((segment) => ({
      segment,
      activeStartUs: Math.max(segment.startUs, clipTimelineStartUs) - clipTimelineStartUs,
      activeEndUs: Math.min(segment.endUs, clipTimelineEndUs) - clipTimelineStartUs,
      segmentStartUs: segment.startUs - clipTimelineStartUs,
      segmentEndUs: segment.endUs - clipTimelineStartUs,
    }));
}

/** Crop-aware counterpart used to keep renderer and export focus/clamping identical. */
export function evaluateZoomForCropAt(
  segments: readonly ZoomSegment[],
  timeUs: TimeUs,
  crop: NormalizedRect,
): EvaluatedZoom {
  const zoom = evaluateZoomAt(segments, timeUs);
  if (zoom.segmentId === undefined) return zoom;
  const segment = segments.find(({ id }) => id === zoom.segmentId)!;
  const cropCenterX = crop.x + crop.width / 2;
  const cropCenterY = crop.y + crop.height / 2;
  const relativeCenterX = (
    cropCenterX + (segment.focus.x - cropCenterX) * zoom.influence - crop.x
  ) / crop.width;
  const relativeCenterY = (
    cropCenterY + (segment.focus.y - cropCenterY) * zoom.influence - crop.y
  ) / crop.height;
  const halfViewport = 0.5 / zoom.scale;
  return {
    ...zoom,
    x: clamp(relativeCenterX, halfViewport, 1 - halfViewport),
    y: clamp(relativeCenterY, halfViewport, 1 - halfViewport),
  };
}

interface BaseScreenGeometry {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  paddingPx: number;
  innerWidth: number;
  innerHeight: number;
  baseWidth: number;
  baseHeight: number;
}

function computeBaseScreenGeometry(
  project: Pick<EditorProject, "canvas">,
  asset: Pick<VideoAsset, "width" | "height">,
): BaseScreenGeometry {
  const { width: canvasWidth, height: canvasHeight, screen } = project.canvas;
  const cropX = clamp(Math.floor(asset.width * screen.crop.x), 0, asset.width - 1);
  const cropY = clamp(Math.floor(asset.height * screen.crop.y), 0, asset.height - 1);
  const cropWidth = clamp(
    Math.round(asset.width * screen.crop.width),
    1,
    asset.width - cropX,
  );
  const cropHeight = clamp(
    Math.round(asset.height * screen.crop.height),
    1,
    asset.height - cropY,
  );
  const paddingPx = Math.round(Math.min(canvasWidth, canvasHeight) * screen.padding);
  const innerWidth = Math.max(2, canvasWidth - paddingPx * 2);
  const innerHeight = Math.max(2, canvasHeight - paddingPx * 2);
  const fit = Math.min(innerWidth / cropWidth, innerHeight / cropHeight);
  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    paddingPx,
    innerWidth,
    innerHeight,
    baseWidth: cropWidth * fit,
    baseHeight: cropHeight * fit,
  };
}

export function buildExportPlan(
  request: ExportPlanRequest,
  options: ExportPlanBuildOptions = {},
): ExportPlan {
  validateProject(request.project);
  const { project } = request;
  if (project.clips.length === 0) {
    throw new ExportPlanError("Cannot export an empty project");
  }
  if (!request.outputPath.trim()) {
    throw new ExportPlanError("An output path is required");
  }

  const format = request.format ?? project.export.format;
  const mode = options.mode ?? "final";
  if (format === "mp4" && mode !== "final") {
    throw new ExportPlanError("GIF graph modes require GIF output");
  }
  if (mode === "gif-render" && !options.palettePath?.trim()) {
    throw new ExportPlanError("The GIF render pass requires a palette path");
  }
  const frameRate = request.frameRate ?? project.export.fps;
  assertFrameRate(frameRate);
  const gifFrameRate = request.gif?.frameRate ?? Math.min(frameRate, 50);
  const gifMaxWidth = request.gif?.maxWidth ?? project.canvas.width;
  if (format === "gif") {
    assertGifFrameRate(gifFrameRate);
    assertGifMaxWidth(gifMaxWidth);
  }
  const durationUs = projectDurationUs(project);
  const inputs: ExportInput[] = [];
  const includeAudio = format === "mp4" && (request.includeAudio ?? true);
  const safeRedactions = validateSafeRedactionsForExport(project.overlays?.overlays ?? []);

  for (const clip of project.clips) {
    const asset = requireVideoAsset(project, clip.assetId);
    const path = requireResolvedPath(request.assetPaths, asset.id);
    inputs.push({
      kind: "clip",
      assetId: asset.id,
      path,
      beforeInput: [
        "-accurate_seek",
        "-ss",
        seconds(clip.sourceInUs),
        "-t",
        seconds(clip.sourceOutUs - clip.sourceInUs),
      ],
    });
  }

  let backgroundInputIndex: number | undefined;
  if (project.canvas.background.kind === "image") {
    const background = project.canvas.background;
    const path = requireResolvedPath(request.assetPaths, background.assetId);
    backgroundInputIndex = inputs.length;
    inputs.push({
      kind: "background",
      assetId: background.assetId,
      path,
      beforeInput: [],
    });
  }

  let materializedAudio: ReturnType<typeof materializeProjectAudio> = undefined;
  if (includeAudio && project.audio !== undefined) {
    try {
      materializedAudio = materializeProjectAudio(project);
    } catch (error) {
      if (error instanceof ProjectAudioError || error instanceof AudioPlanError) {
        throw new ExportPlanError(error.message);
      }
      throw error;
    }
  }
  let paletteInputIndex: number | undefined;
  if (mode === "gif-render") {
    paletteInputIndex = inputs.length;
  }
  let graph = buildFilterGraph(project, {
    format,
    mode,
    frameRate,
    gifFrameRate,
    gifMaxWidth,
    includeAudio: includeAudio && materializedAudio === undefined,
    mp4PixelFormat: options.mp4PixelFormat ?? "yuv420p",
    backgroundInputIndex,
    paletteInputIndex,
  }, safeRedactions);
  if (materializedAudio !== undefined) {
    try {
      const audioPlan = buildAudioFilterPlan({
        timeline: materializedAudio.timeline,
        assetPaths: request.assetPaths,
        baseInputIndex: inputs.length,
        assetStreamIndexes: request.audioStreamIndexes,
        preboundClipInputIndexes: materializedAudio.preboundClipInputIndexes,
      });
      inputs.push(...audioPlan.inputs.map((input): ExportInput => ({
        kind: "audio",
        assetId: input.assetId,
        path: input.path,
        beforeInput: input.beforeInputArgs,
      })));
      graph = {
        ...graph,
        filterGraph: `${graph.filterGraph};\n${audioPlan.filterGraph}`,
        audioLabel: "audio_out",
      };
    } catch (error) {
      if (error instanceof ProjectAudioError || error instanceof AudioPlanError) {
        throw new ExportPlanError(error.message);
      }
      throw error;
    }
  }
  const inputArgs = inputs.flatMap((input) => [...input.beforeInput, "-i", input.path]);
  if (mode === "gif-render") inputArgs.push("-i", options.palettePath!);
  const outputArgs = buildOutputArgs(project, format, graph.audioLabel);
  const outputWidth = format === "gif"
    ? evenAtMost(project.canvas.width, gifMaxWidth)
    : project.canvas.width;
  const outputHeight = format === "gif" && outputWidth !== project.canvas.width
    ? evenAtLeastTwo(Math.round(project.canvas.height * outputWidth / project.canvas.width))
    : project.canvas.height;

  return {
    format,
    inputs,
    inputArgs,
    filterGraph: graph.filterGraph,
    outputArgs,
    outputPath: request.outputPath,
    durationUs,
    frameRate,
    outputWidth,
    outputHeight,
    videoLabel: graph.videoLabel,
    audioLabel: graph.audioLabel,
  };
}

/**
 * Produces a diagnostic argv for child_process.spawn(ffmpegPath, argv, { shell: false }).
 * A graph file avoids Windows command-line length limits. Modern pinned FFmpeg
 * uses the generic `-/filter_complex file` syntax. Production export owns its
 * Media Foundation hardware/software retry policy in the main process.
 */
export function buildFfmpegArgs(
  plan: ExportPlan,
  options: { filterGraphPath?: string } = {},
): string[] {
  const graphArgs = options.filterGraphPath
    ? ["-/filter_complex", options.filterGraphPath]
    : ["-filter_complex", plan.filterGraph];
  return [
    "-hide_banner",
    "-y",
    ...plan.inputArgs,
    ...graphArgs,
    ...plan.outputArgs,
    plan.outputPath,
  ];
}

interface FilterGraphOptions {
  format: OutputFormat;
  mode: ExportGraphMode;
  frameRate: number;
  gifFrameRate: number;
  gifMaxWidth: number;
  includeAudio: boolean;
  mp4PixelFormat: "yuv420p" | "nv12";
  backgroundInputIndex?: number;
  paletteInputIndex?: number;
}

interface FilterGraphResult {
  filterGraph: string;
  videoLabel: string;
  audioLabel?: string;
}

function buildFilterGraph(
  project: EditorProject,
  options: FilterGraphOptions,
  safeRedactions: readonly ShapeOverlay[],
): FilterGraphResult {
  const graph: string[] = [];
  const clipCount = project.clips.length;
  const fps = options.frameRate;
  const { width, height } = project.canvas;
  let clipTimelineStartUs = 0;
  const backgroundInputLabels = buildBackgroundInputLabels(
    graph,
    project.canvas.background,
    options.backgroundInputIndex,
    clipCount,
  );

  project.clips.forEach((clip, index) => {
    const asset = requireVideoAsset(project, clip.assetId);
    const layout = computeScreenLayout(project, asset);
    const clipOutputDurationUs = clipDurationUs(clip);
    const outputDuration = seconds(clipOutputDurationUs);
    const sourceDuration = seconds(clip.sourceOutUs - clip.sourceInUs);
    const rawVideoLabel = `clipraw${index}`;
    const decoratedVideoLabel = `clipdecorated${index}`;

    graph.push(
      buildBackgroundSeed(
        project.canvas.background,
        width,
        height,
        fps,
        outputDuration,
        backgroundInputLabels[index],
        index,
      ),
    );

    const baseVideoFilters = [
      `trim=duration=${sourceDuration}`,
      `setpts=(PTS-STARTPTS)/${decimal(clip.speed)}`,
      cropFilter(layout),
    ];
    const zoomPan = buildZoomPanFilter(
      project.zoom?.segments ?? [],
      clipTimelineStartUs,
      clipOutputDurationUs,
      project.canvas.screen.crop,
      layout.sourceCropPx.width,
      layout.sourceCropPx.height,
      fps,
    );
    const videoFilters = zoomPan === undefined
      ? [
          ...baseVideoFilters,
          `scale=${layout.screenRectPx.width}:${layout.screenRectPx.height}:flags=lanczos`,
          `fps=${fps}`,
          "setsar=1",
          "format=rgba",
        ]
      : [
          ...baseVideoFilters,
          `fps=${fps}`,
          "setsar=1",
          zoomPan,
          `scale=${layout.screenRectPx.width}:${layout.screenRectPx.height}:flags=lanczos`,
          "setsar=1",
          "format=rgba",
        ];
    if (project.canvas.screen.border.widthPx > 0 && project.canvas.screen.border.opacity > 0) {
      const border = project.canvas.screen.border;
      videoFilters.push(
        `drawbox=x=0:y=0:w=iw:h=ih:color=${ffmpegColor(border.color)}@${decimal(border.opacity)}:t=${decimal(border.widthPx)}`,
      );
    }
    graph.push(`[${index}:v]${videoFilters.join(",")}[${rawVideoLabel}]`);

    const foregroundLabel = addCornerAndShadow(
      graph,
      project,
      layout,
      index,
      rawVideoLabel,
      outputDuration,
      fps,
    );

    const firstCompositeLabel = `clipbase${index}`;
    const shadow = project.canvas.screen.shadow;
    const hasShadow = shadow.opacity > 0;
    if (hasShadow) {
      graph.push(
        `[bg${index}][shadow${index}]overlay=x=0:y=0:shortest=1[${firstCompositeLabel}]`,
      );
    } else {
      graph.push(`[bg${index}]null[${firstCompositeLabel}]`);
    }

    const redactionFilters = buildSafeRedactionFilters(
      safeRedactions,
      clipTimelineStartUs,
      clipOutputDurationUs,
      width,
      height,
    );
    graph.push(
      `[${firstCompositeLabel}][${foregroundLabel}]${[
        `overlay=x=${layout.screenRectPx.x}:y=${layout.screenRectPx.y}:shortest=1`,
        `trim=duration=${outputDuration}`,
        "setpts=PTS-STARTPTS",
        "format=rgba",
        ...redactionFilters,
      ].join(",")}[${decoratedVideoLabel}]`,
    );

    if (options.includeAudio) {
      graph.push(buildAudioSegment(clip, asset, index, sourceDuration, outputDuration));
    }
    clipTimelineStartUs += clipOutputDurationUs;
  });

  if (options.format === "mp4") {
    if (!options.includeAudio) {
      const concatInputs = project.clips.map((_, index) => `[clipdecorated${index}]`).join("");
      graph.push(
        `${concatInputs}concat=n=${clipCount}:v=1:a=0[vcat]`,
        `[vcat]format=${options.mp4PixelFormat}[vout]`,
      );
      return { filterGraph: graph.join(";\n"), videoLabel: "vout" };
    }
    const concatInputs = project.clips.map((_, index) => `[clipdecorated${index}][a${index}]`).join("");
    graph.push(
      `${concatInputs}concat=n=${clipCount}:v=1:a=1[vcat][aout]`,
      `[vcat]format=${options.mp4PixelFormat}[vout]`,
    );
    return { filterGraph: graph.join(";\n"), videoLabel: "vout", audioLabel: "aout" };
  }

  const concatInputs = project.clips.map((_, index) => `[clipdecorated${index}]`).join("");
  graph.push(`${concatInputs}concat=n=${clipCount}:v=1:a=0[vcat]`);
  const gifScale = width > options.gifMaxWidth
    ? `,scale=${evenAtMost(width, options.gifMaxWidth)}:-2:flags=lanczos`
    : "";
  if (options.mode === "gif-palette") {
    graph.push(
      `[vcat]fps=${options.gifFrameRate}${gifScale},palettegen=stats_mode=full:reserve_transparent=0[vout]`,
    );
  } else if (options.mode === "gif-render") {
    if (options.paletteInputIndex === undefined) {
      throw new ExportPlanError("The GIF palette input is missing");
    }
    graph.push(
      `[vcat]fps=${options.gifFrameRate}${gifScale}[gifsrc]`,
      `[gifsrc][${options.paletteInputIndex}:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle[vout]`,
    );
  } else {
    graph.push(
      `[vcat]fps=${options.gifFrameRate}${gifScale},split=2[vpalette][vframes]`,
      "[vpalette]palettegen=stats_mode=diff[palette]",
      "[vframes][palette]paletteuse=dither=sierra2_4a[vout]",
    );
  }

  return { filterGraph: graph.join(";\n"), videoLabel: "vout" };
}

function buildBackgroundSeed(
  background: BackgroundStyle,
  width: number,
  height: number,
  fps: number,
  duration: string,
  backgroundInputLabel: string | undefined,
  index: number,
): string {
  const outputLabel = `bg${index}`;
  if (background.kind === "solid") {
    return `color=c=${ffmpegColor(background.color)}:s=${width}x${height}:r=${fps}:d=${duration},format=rgba[${outputLabel}]`;
  }

  if (background.kind === "gradient") {
    return buildGradientSeed(background, width, height, fps, duration, outputLabel);
  }

  if (backgroundInputLabel === undefined) {
    throw new ExportPlanError("Image background input is missing");
  }
  const scale =
    background.fit === "cover"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
  const blur = background.blurPx > 0 ? `,gblur=sigma=${decimal(background.blurPx)}:steps=2` : "";
  const image = `[${backgroundInputLabel}]${scale}${blur},fps=${fps},setsar=1,format=rgba`;
  const heldImage = `${image}${holdStaticFrame(duration, fps)}`;
  if (background.opacity >= 1) return `${heldImage}[${outputLabel}]`;
  return [
    `color=c=black:s=${width}x${height}:r=${fps}:d=${duration},format=rgba[bgunder${index}]`,
    `${heldImage},colorchannelmixer=aa=${decimal(background.opacity)}[bgimage${index}]`,
    `[bgunder${index}][bgimage${index}]overlay=x=0:y=0:shortest=1:format=auto[${outputLabel}]`,
  ].join(";\n");
}

function buildBackgroundInputLabels(
  graph: string[],
  background: BackgroundStyle,
  inputIndex: number | undefined,
  clipCount: number,
): string[] {
  if (background.kind !== "image") return [];
  if (inputIndex === undefined) throw new ExportPlanError("Image background input is missing");
  if (clipCount === 1) return [`${inputIndex}:v`];
  const labels = Array.from({ length: clipCount }, (_, index) => `wallpaper${index}`);
  graph.push(`[${inputIndex}:v]split=${clipCount}${labels.map((label) => `[${label}]`).join("")}`);
  return labels;
}

function buildGradientSeed(
  background: Extract<BackgroundStyle, { kind: "gradient" }>,
  width: number,
  height: number,
  fps: number,
  duration: string,
  outputLabel: string,
): string {
  const stops = background.stops.slice(0, 8);
  const angle = background.angleDeg * Math.PI / 180;
  const cosine = preciseDecimal(Math.cos(angle));
  const sine = preciseDecimal(Math.sin(angle));
  // Mirrors SVG's rotate(angle .5 .5) on the default left-to-right gradient.
  const position = `clip(0.5+(${cosine})*(X/${Math.max(1, width - 1)}-0.5)+(${sine})*(Y/${Math.max(1, height - 1)}-0.5),0,1)`;
  const colors = stops.map((stop) => parseColorChannels(stop.color));
  const red = gradientChannelExpression(stops, colors, 0, position);
  const green = gradientChannelExpression(stops, colors, 1, position);
  const blue = gradientChannelExpression(stops, colors, 2, position);
  const alpha = gradientChannelExpression(stops, colors, 3, position);
  return [
    `color=c=black:s=${width}x${height}:r=${fps}:d=${oneFrameDuration(fps)},format=gbrap`,
    `geq=r='${red}':g='${green}':b='${blue}':a='${alpha}'`,
    `format=rgba${holdStaticFrame(duration, fps)}[${outputLabel}]`,
  ].join(",");
}

function gradientChannelExpression(
  stops: ReadonlyArray<{ offset: number }>,
  colors: ReadonlyArray<readonly [number, number, number, number]>,
  channel: 0 | 1 | 2 | 3,
  position: string,
): string {
  let expression = String(colors.at(-1)?.[channel] ?? 255);
  for (let index = stops.length - 2; index >= 0; index -= 1) {
    const left = stops[index]!;
    const right = stops[index + 1]!;
    const leftValue = colors[index]![channel];
    const rightValue = colors[index + 1]![channel];
    const distance = right.offset - left.offset;
    if (distance <= 1e-12) {
      expression = `if(lt(${position},${preciseDecimal(right.offset)}),${leftValue},${expression})`;
      continue;
    }
    const ratio = `clip((${position}-${preciseDecimal(left.offset)})/${preciseDecimal(distance)},0,1)`;
    const interpolated = leftValue === rightValue
      ? String(leftValue)
      : `${leftValue}+(${rightValue - leftValue})*${ratio}`;
    expression = `if(lte(${position},${preciseDecimal(right.offset)}),${interpolated},${expression})`;
  }
  return expression;
}

function parseColorChannels(color: string): readonly [number, number, number, number] {
  const hex = color.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  ];
}

function buildSafeRedactionFilters(
  redactions: readonly ShapeOverlay[],
  clipStartUs: TimeUs,
  clipDurationUs: TimeUs,
  canvasWidth: number,
  canvasHeight: number,
): string[] {
  const clipEndUs = clipStartUs + clipDurationUs;
  return redactions.flatMap((redaction) => {
    const startUs = Math.max(redaction.startUs, clipStartUs);
    const endUs = Math.min(redaction.endUs, clipEndUs);
    if (endUs <= startUs) return [];

    const left = clamp(Math.floor(redaction.area.x * canvasWidth), 0, canvasWidth - 1);
    const top = clamp(Math.floor(redaction.area.y * canvasHeight), 0, canvasHeight - 1);
    const right = clamp(
      Math.ceil((redaction.area.x + redaction.area.width) * canvasWidth),
      left + 1,
      canvasWidth,
    );
    const bottom = clamp(
      Math.ceil((redaction.area.y + redaction.area.height) * canvasHeight),
      top + 1,
      canvasHeight,
    );
    const localStart = seconds(startUs - clipStartUs);
    const localEnd = seconds(endUs - clipStartUs);
    const color = `0x${redaction.fillColor.slice(1, 7).toUpperCase()}`;
    return [
      `drawbox=x=${left}:y=${top}:w=${right - left}:h=${bottom - top}:` +
      `color=${color}:t=fill:enable='gte(t,${localStart})*lt(t,${localEnd})'`,
    ];
  });
}

function addCornerAndShadow(
  graph: string[],
  project: EditorProject,
  layout: ScreenLayout,
  index: number,
  rawVideoLabel: string,
  duration: string,
  fps: number,
): string {
  const radius = layout.cornerRadiusPx;
  const shadow = project.canvas.screen.shadow;
  const hasShadow = shadow.opacity > 0;
  if (radius <= 0 && !hasShadow) return rawVideoLabel;

  const { width, height } = layout.screenRectPx;
  const maskSeed = `maskvideo${index}`;
  if (radius > 0) {
    graph.push(
      `nullsrc=s=${width}x${height}:r=${fps}:d=${oneFrameDuration(fps)},format=gray,geq=lum='${roundedMaskExpression(radius)}'${holdStaticFrame(duration, fps)}[${maskSeed}]`,
    );
  }

  let foregroundLabel = rawVideoLabel;
  if (radius > 0) {
    foregroundLabel = `rounded${index}`;
    graph.push(`[${rawVideoLabel}][${maskSeed}]alphamerge[${foregroundLabel}]`);
  }

  if (hasShadow) {
    const canvas = project.canvas;
    const shadowX = layout.screenRectPx.x + Math.round(shadow.offsetX);
    const shadowY = layout.screenRectPx.y + Math.round(shadow.offsetY);
    const shadowMask = `maskshadow${index}`;
    const shadowAlpha = `shadowalpha${index}`;
    const { ffmpegSigma } = resolveScreenShadowBlur(shadow.blurPx);
    const blur = ffmpegSigma > 0 ? `gblur=sigma=${decimal(ffmpegSigma)}:steps=2,` : "";
    graph.push(
      `nullsrc=s=${canvas.width}x${canvas.height}:r=${fps}:d=${oneFrameDuration(fps)},format=gray,geq=lum='${roundedRectMaskExpression(shadowX, shadowY, width, height, radius)}'[${shadowMask}]`,
      `[${shadowMask}]${blur}lut=y='val*${decimal(shadow.opacity)}'${holdStaticFrame(duration, fps)}[${shadowAlpha}]`,
      `color=c=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration},format=rgba[shadowcolor${index}]`,
      `[shadowcolor${index}][${shadowAlpha}]alphamerge[shadow${index}]`,
    );
  }

  return foregroundLabel;
}

function buildAudioSegment(
  clip: TimelineClip,
  asset: VideoAsset,
  index: number,
  sourceDuration: string,
  outputDuration: string,
): string {
  if (!asset.audio || clip.audio.mode === "mute") {
    return `anullsrc=r=48000:cl=stereo:d=${outputDuration},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`;
  }

  const filters = [
    `atrim=duration=${sourceDuration}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
  ];
  if (clip.audio.mode === "change-pitch") {
    filters.push(`asetrate=${Math.round(48_000 * clip.speed)}`, "aresample=48000");
  } else {
    filters.push(...atempoFilters(clip.speed));
  }
  if (clip.audio.gainDb !== 0) filters.push(`volume=${decimal(clip.audio.gainDb)}dB`);
  filters.push(
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    `apad=whole_dur=${outputDuration}`,
    `atrim=duration=${outputDuration}`,
    "asetpts=PTS-STARTPTS",
  );
  return `[${index}:a]${filters.join(",")}[a${index}]`;
}

export function atempoFilters(speed: number): string[] {
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 8) {
    throw new ExportPlanError("Audio speed must be between 0.25 and 8");
  }
  if (Math.abs(speed - 1) < 1e-9) return [];

  const filters: string[] = [];
  let remainder = speed;
  while (remainder < 0.5 - 1e-9) {
    filters.push("atempo=0.5");
    remainder /= 0.5;
  }
  while (remainder > 2 + 1e-9) {
    filters.push("atempo=2");
    remainder /= 2;
  }
  if (Math.abs(remainder - 1) > 1e-9) {
    filters.push(`atempo=${decimal(remainder)}`);
  }
  return filters;
}

function buildOutputArgs(
  project: EditorProject,
  format: OutputFormat,
  audioLabel: string | undefined,
): string[] {
  if (format === "gif") {
    return ["-map", "[vout]", "-an", "-loop", "0"];
  }

  const quality = {
    small: "45",
    balanced: "65",
    high: "85",
    "lossless-ish": "100",
  }[project.export.quality];
  return [
    "-map",
    "[vout]",
    ...(audioLabel === undefined ? ["-an"] : ["-map", `[${audioLabel}]`]),
    "-c:v",
    "h264_mf",
    "-rate_control",
    "quality",
    "-quality",
    quality,
    "-scenario",
    "archive",
    "-pix_fmt",
    "nv12",
    ...(audioLabel === undefined ? [] : ["-c:a", "aac", "-b:a", "192k"]),
    "-movflags",
    "+faststart",
  ];
}

function cropFilter(layout: ScreenLayout): string {
  const crop = layout.sourceCropPx;
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
}

function buildZoomPanFilter(
  segments: readonly ZoomSegment[],
  clipTimelineStartUs: TimeUs,
  clipDurationUs: TimeUs,
  crop: NormalizedRect,
  width: number,
  height: number,
  fps: number,
): string | undefined {
  const intersections = intersectZoomSegmentsWithClip(
    segments,
    clipTimelineStartUs,
    clipDurationUs,
  );
  if (intersections.length === 0) return undefined;

  const zoom = nestedZoomExpression(intersections, (slice, influence) =>
    `1+${preciseDecimal(slice.segment.scale - 1)}*(${influence})`, "1");
  const x = nestedZoomExpression(intersections, (slice, influence) =>
    zoomPanAxisExpression(slice.segment.focus.x, crop.x, crop.width, influence, "iw"), "0");
  const y = nestedZoomExpression(intersections, (slice, influence) =>
    zoomPanAxisExpression(slice.segment.focus.y, crop.y, crop.height, influence, "ih"), "0");
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}

function nestedZoomExpression(
  intersections: readonly ClipZoomIntersection[],
  value: (slice: ClipZoomIntersection, influence: string) => string,
  fallback: string,
): string {
  return [...intersections].reverse().reduce((next, slice) => {
    const condition = `gte(ot,${seconds(slice.activeStartUs)})*lt(ot,${seconds(slice.activeEndUs)})`;
    return `if(${condition},${value(slice, zoomInfluenceExpression(slice))},${next})`;
  }, fallback);
}

function zoomInfluenceExpression(slice: ClipZoomIntersection): string {
  const enter = slice.segment.easeInUs === 0
    ? "1"
    : smootherStepExpression(
        `(ot-(${seconds(slice.segmentStartUs)}))/${seconds(slice.segment.easeInUs)}`,
      );
  const exit = slice.segment.easeOutUs === 0
    ? "1"
    : smootherStepExpression(
        `((${seconds(slice.segmentEndUs)})-ot)/${seconds(slice.segment.easeOutUs)}`,
      );
  return `min(${enter},${exit})`;
}

function smootherStepExpression(value: string): string {
  const unit = `clip(${value},0,1)`;
  return `pow(${unit},3)*(${unit}*(${unit}*6-15)+10)`;
}

function zoomPanAxisExpression(
  focus: number,
  cropOrigin: number,
  cropSize: number,
  influence: string,
  inputSize: "iw" | "ih",
): string {
  const cropCenter = cropOrigin + cropSize / 2;
  const relativeDelta = (focus - cropCenter) / cropSize;
  const offset = `${preciseDecimal(Math.abs(relativeDelta))}*(${influence})`;
  const center = relativeDelta < 0 ? `0.5-${offset}` : `0.5+${offset}`;
  return `(clip(${center},1/(2*zoom),1-1/(2*zoom))-1/(2*zoom))*${inputSize}`;
}

function roundedMaskExpression(radius: number): string {
  const r = Math.max(1, Math.round(radius));
  return `if(gt(between(X,${r},W-1-${r})+between(Y,${r},H-1-${r})+lte(hypot(X-if(lt(X,${r}),${r},W-1-${r}),Y-if(lt(Y,${r}),${r},H-1-${r})),${r}),0),255,0)`;
}

function roundedRectMaskExpression(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const left = x;
  const top = y;
  const right = x + width - 1;
  const bottom = y + height - 1;
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(width, height) / 2)));
  if (r === 0) {
    return `if(gte(between(X,${left},${right})*between(Y,${top},${bottom}),1),255,0)`;
  }
  const innerLeft = left + r;
  const innerRight = right - r;
  const innerTop = top + r;
  const innerBottom = bottom - r;
  return `if(gt(between(X,${innerLeft},${innerRight})+between(Y,${innerTop},${innerBottom})+lte(hypot(X-if(lt(X,${innerLeft}),${innerLeft},${innerRight}),Y-if(lt(Y,${innerTop}),${innerTop},${innerBottom})),${r}),0),255,0)`;
}

function requireVideoAsset(project: EditorProject, assetId: AssetId): VideoAsset {
  const asset = project.assets[assetId];
  if (!asset || asset.kind !== "video") {
    throw new ExportPlanError(`Clip references missing video asset ${assetId}`);
  }
  return asset;
}

function requireResolvedPath(paths: Readonly<Record<AssetId, string>>, assetId: AssetId): string {
  const path = paths[assetId];
  if (!path || !path.trim()) throw new ExportPlanError(`No resolved path for asset ${assetId}`);
  return path;
}

function seconds(microseconds: TimeUs): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function oneFrameDuration(frameRate: number): string {
  return (1 / frameRate).toFixed(9).replace(/\.?0+$/, "") || "0.001";
}

function holdStaticFrame(duration: string, frameRate: number): string {
  return `,loop=loop=-1:size=1:start=0,trim=duration=${duration},setpts=N/(${frameRate}*TB)`;
}

function decimal(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function preciseDecimal(value: number): string {
  return value.toFixed(12).replace(/\.?0+$/, "") || "0";
}

function ffmpegColor(color: string): string {
  return `0x${color.slice(1).toUpperCase()}`;
}

function evenAtLeastTwo(value: number): number {
  const safe = Math.max(2, value);
  return safe % 2 === 0 ? safe : safe - 1;
}

function evenAtMost(width: number, maximum: number): number {
  return evenAtLeastTwo(Math.min(width, maximum));
}

function assertFrameRate(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 120) {
    throw new ExportPlanError("Frame rate must be an integer from 1 to 120");
  }
}

function assertGifFrameRate(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new ExportPlanError("GIF frame rate must be an integer from 1 to 50");
  }
}

function assertGifMaxWidth(value: number): void {
  if (!Number.isInteger(value) || value < 64 || value > 7_680) {
    throw new ExportPlanError("GIF maximum width must be an integer from 64 to 7680");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
