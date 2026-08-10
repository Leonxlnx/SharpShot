import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateCaptionAss } from "../shared/caption-ass.js";
import {
  buildExportPlan,
  computeScreenLayout,
  ExportPlanError,
  validateSafeRedactionsForExport,
  type ExportGraphMode,
  type ExportPlan,
} from "../shared/export-plan.js";
import {
  type AssetId,
  type EditorProject,
  MAX_PROJECT_CLIPS,
  type OutputFormat,
  validateProject,
} from "../shared/project.js";
import { clipDurationUs, projectDurationUs } from "../shared/editor-reducer.js";
import { activeProjectAudioAssetIds } from "../shared/project-audio.js";
import {
  probeMedia,
  resolveBundledMediaBinary,
  type MediaBinaryResolutionOptions,
  type MediaProbeResult,
} from "./media-probe.js";

const MICROSECONDS_PER_SECOND = 1_000_000;
const MIN_SPEED_MILLI = 250;
const MAX_SPEED_MILLI = 8_000;
const MAX_CLIPS = MAX_PROJECT_CLIPS;
const MAX_CANVAS_EDGE = 7_680;
const MAX_INTERMEDIATE_EDGE = 16_384;
const MAX_INTERMEDIATE_PIXELS = 80_000_000;
const DEFAULT_GIF_FRAME_RATE = 20;
const WINDOWS_COMMAND_LINE_LIMIT_UTF16 = 32_767;

export type ExportFormat = "mp4" | "gif";
export type ExportFit = "contain" | "cover";
export type HardwareAcceleration = "auto" | "on" | "off";

export interface ExportClip {
  sourcePath: string;
  sourceInUs: number;
  sourceOutUs: number;
  rateMilli: number;
  gainDb?: number;
  muted?: boolean;
  fit?: ExportFit;
}

export type ExportBackground =
  | { kind: "solid"; color: string }
  | { kind: "image"; path: string };

export interface ExportCanvas {
  width: number;
  height: number;
  fps: { numerator: number; denominator: number };
  paddingPx: number;
  fit: ExportFit;
  background: ExportBackground;
}

export interface ExportRequest {
  id?: string;
  format: ExportFormat;
  outputPath: string;
  overwrite?: boolean;
  clips: ExportClip[];
  canvas: ExportCanvas;
  includeAudio?: boolean;
  audioBitRateKbps?: number;
  quality?: number;
  hardwareAcceleration?: HardwareAcceleration;
  gif?: {
    frameRate?: number;
    maxWidth?: number;
  };
}

/**
 * Trusted main-process project export. The renderer supplies only a project ID;
 * main loads and validates the canonical project, resolves its asset IDs, and
 * constructs this request. Filter graphs and FFmpeg argv are never accepted.
 */
export interface ProjectExportRequest {
  id?: string;
  project: EditorProject;
  assetPaths: Readonly<Record<AssetId, string>>;
  outputPath: string;
  overwrite?: boolean;
  format?: OutputFormat;
  /** Main-only export overrides; applied to an immutable project clone. */
  width?: number;
  height?: number;
  frameRate?: EditorProject["export"]["fps"];
  quality?: EditorProject["export"]["quality"];
  includeAudio?: boolean;
  audioBitRateKbps?: number;
  hardwareAcceleration?: HardwareAcceleration;
  gif?: {
    frameRate?: number;
    maxWidth?: number;
  };
}

export type ExportPhase = "preparing" | "palette" | "rendering" | "validating";

export interface ExportProgress {
  phase: ExportPhase;
  fraction: number;
  outTimeUs: number;
  frame?: number;
  fps?: number;
  speed?: string;
}

function reportProgress(
  observer: ((progress: ExportProgress) => void) | undefined,
  progress: ExportProgress,
): void {
  try {
    observer?.(progress);
  } catch {
    // Progress is observational and must never change export or commit state.
  }
}

export interface ExportMediaOptions extends MediaBinaryResolutionOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  id: string;
  outputPath: string;
  durationUs: number;
  metadata: MediaProbeResult;
  warnings: string[];
}

export interface ExportHandle {
  id: string;
  promise: Promise<ExportResult>;
  cancel: () => void;
}

interface ResolvedClip extends ExportClip {
  sourcePath: string;
  hasAudio: boolean;
  videoStreamIndex: number;
  audioStreamIndex?: number;
  sourceDurationUs: number;
  outputDurationUs: number;
}

interface ResolvedRequest extends Omit<ExportRequest, "clips" | "outputPath"> {
  id: string;
  outputPath: string;
  clips: ResolvedClip[];
  totalDurationUs: number;
}

interface ResolvedProjectRequest extends Omit<ProjectExportRequest, "id" | "outputPath" | "assetPaths" | "project"> {
  id: string;
  project: EditorProject;
  assetPaths: Readonly<Record<AssetId, string>>;
  outputPath: string;
  format: OutputFormat;
  totalDurationUs: number;
  warnings: string[];
  streamSelections: Readonly<Record<AssetId, ProbedStreamSelection>>;
  audioStreamIndexes: Readonly<Record<AssetId, number>>;
}

export interface ProbedStreamSelection {
  videoIndex: number;
  audioIndex?: number;
}

interface CompiledGraph {
  inputArgs: string[];
  graph: string;
  videoLabel: string;
  audioLabel?: string;
}

type GraphMode = "mp4" | "gif-palette" | "gif-render";

export class ExportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportValidationError";
  }
}

export class ExportCancelledError extends Error {
  constructor() {
    super("Export was cancelled.");
    this.name = "ExportCancelledError";
  }
}

export class ExportProcessError extends Error {
  readonly exitCode?: number;
  readonly stderr: string;

  constructor(message: string, stderr = "", exitCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportProcessError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export class ExportBusyError extends Error {
  constructor(activeJobId: string) {
    super(`Export ${activeJobId} is already running.`);
    this.name = "ExportBusyError";
  }
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ExportValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function assertFiniteInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ExportValidationError(`${name} must be from ${minimum} to ${maximum}.`);
  }
}

function outputDurationUs(clip: ExportClip): number {
  const duration = Math.round((clip.sourceOutUs - clip.sourceInUs) * 1_000 / clip.rateMilli);
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new ExportValidationError("A clip produced an invalid output duration.");
  }
  return duration;
}

function validateColor(value: string): string {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value);
  if (!match) throw new ExportValidationError("Background color must be #RRGGBB or #RRGGBBAA.");
  const rgb = match[1];
  if (!rgb) throw new ExportValidationError("Background color is invalid.");
  if (!match[2]) return `0x${rgb}`;
  const alpha = Number.parseInt(match[2], 16) / 255;
  return `0x${rgb}@${alpha.toFixed(6)}`;
}

function validateRequest(request: ExportRequest): void {
  if (request.format !== "mp4" && request.format !== "gif") {
    throw new ExportValidationError("Only MP4 and GIF exports are supported.");
  }
  if (!Array.isArray(request.clips) || request.clips.length === 0 || request.clips.length > MAX_CLIPS) {
    throw new ExportValidationError(`An export needs 1 to ${MAX_CLIPS} clips.`);
  }
  assertIntegerInRange("Canvas width", request.canvas.width, 64, MAX_CANVAS_EDGE);
  assertIntegerInRange("Canvas height", request.canvas.height, 64, MAX_CANVAS_EDGE);
  if (request.canvas.width % 2 !== 0 || request.canvas.height % 2 !== 0) {
    throw new ExportValidationError("Canvas dimensions must be even.");
  }
  assertIntegerInRange("Frame-rate numerator", request.canvas.fps.numerator, 1, 240_000);
  assertIntegerInRange("Frame-rate denominator", request.canvas.fps.denominator, 1, 10_000);
  const frameRate = request.canvas.fps.numerator / request.canvas.fps.denominator;
  assertFiniteInRange("Frame rate", frameRate, 1, 120);
  assertIntegerInRange(
    "Canvas padding",
    request.canvas.paddingPx,
    0,
    Math.floor(Math.min(request.canvas.width, request.canvas.height) / 2) - 2,
  );
  if (request.canvas.fit !== "contain" && request.canvas.fit !== "cover") {
    throw new ExportValidationError("Canvas fit must be contain or cover.");
  }
  if (request.canvas.background.kind === "solid") validateColor(request.canvas.background.color);
  if (request.canvas.background.kind === "image" && !request.canvas.background.path.trim()) {
    throw new ExportValidationError("Background image path is empty.");
  }
  assertIntegerInRange("Audio bitrate", request.audioBitRateKbps ?? 192, 64, 512);
  if (
    request.hardwareAcceleration !== undefined &&
    request.hardwareAcceleration !== "auto" &&
    request.hardwareAcceleration !== "on" &&
    request.hardwareAcceleration !== "off"
  ) {
    throw new ExportValidationError("Hardware acceleration must be auto, on, or off.");
  }
  assertIntegerInRange("Export quality", request.quality ?? 80, 1, 100);

  const expectedExtension = request.format === "mp4" ? ".mp4" : ".gif";
  if (path.extname(request.outputPath).toLowerCase() !== expectedExtension) {
    throw new ExportValidationError(`The output filename must end in ${expectedExtension}.`);
  }

  for (const [index, clip] of request.clips.entries()) {
    if (!clip.sourcePath.trim()) throw new ExportValidationError(`Clip ${index + 1} has no source path.`);
    assertIntegerInRange(`Clip ${index + 1} source in`, clip.sourceInUs, 0, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange(`Clip ${index + 1} source out`, clip.sourceOutUs, 1, Number.MAX_SAFE_INTEGER);
    if (clip.sourceOutUs <= clip.sourceInUs) {
      throw new ExportValidationError(`Clip ${index + 1} ends before it starts.`);
    }
    assertIntegerInRange(`Clip ${index + 1} speed`, clip.rateMilli, MIN_SPEED_MILLI, MAX_SPEED_MILLI);
    assertFiniteInRange(`Clip ${index + 1} gain`, clip.gainDb ?? 0, -96, 24);
    if (clip.fit !== undefined && clip.fit !== "contain" && clip.fit !== "cover") {
      throw new ExportValidationError(`Clip ${index + 1} fit is invalid.`);
    }
    outputDurationUs(clip);
  }

  if (request.gif) {
    assertIntegerInRange("GIF frame rate", request.gif.frameRate ?? DEFAULT_GIF_FRAME_RATE, 1, 50);
    assertIntegerInRange("GIF maximum width", request.gif.maxWidth ?? 1_280, 64, MAX_CANVAS_EDGE);
  }
}

function samePath(first: string, second: string): boolean {
  const normalizedFirst = path.resolve(first);
  const normalizedSecond = path.resolve(second);
  return process.platform === "win32"
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveRequest(
  request: ExportRequest,
  options: ExportMediaOptions,
): Promise<ResolvedRequest> {
  validateRequest(request);
  if (options.signal?.aborted) throw new ExportCancelledError();

  const outputPath = path.resolve(request.outputPath);
  const canonicalOutputPath = await canonicalOutputCandidate(outputPath);
  const probeCache = new Map<string, Promise<MediaProbeResult>>();
  const clips: ResolvedClip[] = [];

  for (const clip of request.clips) {
    const sourcePath = path.resolve(clip.sourcePath);
    if (samePath(sourcePath, outputPath) || samePath(await realpath(sourcePath), canonicalOutputPath)) {
      throw new ExportValidationError("The export cannot overwrite one of its source files.");
    }
    let pendingProbe = probeCache.get(sourcePath);
    if (!pendingProbe) {
      pendingProbe = probeMedia(sourcePath, {
        binaryPath: options.ffprobePath,
        resourcesPath: options.resourcesPath,
        developmentRoot: options.developmentRoot,
        allowPathFallback: options.allowPathFallback,
        platform: options.platform,
        arch: options.arch,
        env: options.env,
        exists: options.exists,
        signal: options.signal,
      });
      probeCache.set(sourcePath, pendingProbe);
    }
    const metadata = await pendingProbe;
    if (!metadata.video) throw new ExportValidationError(`${path.basename(sourcePath)} has no video stream.`);
    if (metadata.durationUs !== undefined && clip.sourceOutUs > metadata.durationUs + 100_000) {
      throw new ExportValidationError(`${path.basename(sourcePath)} is shorter than the selected clip range.`);
    }
    const sourceDurationUs = clip.sourceOutUs - clip.sourceInUs;
    clips.push({
      ...clip,
      sourcePath,
      hasAudio: metadata.audio !== undefined,
      videoStreamIndex: metadata.video.index,
      audioStreamIndex: metadata.audio?.index,
      sourceDurationUs,
      outputDurationUs: outputDurationUs(clip),
    });
  }

  if (request.canvas.background.kind === "image") {
    const backgroundPath = path.resolve(request.canvas.background.path);
    const backgroundStat = await stat(backgroundPath);
    if (!backgroundStat.isFile()) throw new ExportValidationError("Background image is not a file.");
  }

  const totalDurationUs = clips.reduce((total, clip) => total + clip.outputDurationUs, 0);
  if (!Number.isSafeInteger(totalDurationUs) || totalDurationUs <= 0) {
    throw new ExportValidationError("The project duration is invalid.");
  }

  return {
    ...request,
    id: request.id ?? randomUUID(),
    outputPath,
    clips,
    totalDurationUs,
  };
}

function validateProjectExportRequest(request: ProjectExportRequest): {
  project: EditorProject;
  format: OutputFormat;
  totalDurationUs: number;
} {
  try {
    validateProject(request.project);
  } catch (error) {
    throw new ExportValidationError(
      `The project is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const project = structuredClone(request.project);
  if (request.width !== undefined) project.canvas.width = request.width;
  if (request.height !== undefined) project.canvas.height = request.height;
  project.export = {
    format: request.format ?? project.export.format,
    fps: request.frameRate ?? project.export.fps,
    quality: request.quality ?? project.export.quality,
  };
  try {
    validateProject(project);
    validateSafeRedactionsForExport(project.overlays?.overlays ?? []);
  } catch (error) {
    throw new ExportValidationError(
      `The export overrides are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const format = project.export.format;
  if (format !== "mp4" && format !== "gif") {
    throw new ExportValidationError("Only MP4 and GIF exports are supported.");
  }
  if (project.clips.length === 0 || project.clips.length > MAX_CLIPS) {
    throw new ExportValidationError(`A project export needs 1 to ${MAX_CLIPS} clips.`);
  }
  assertIntegerInRange("Canvas width", project.canvas.width, 64, MAX_CANVAS_EDGE);
  assertIntegerInRange("Canvas height", project.canvas.height, 64, MAX_CANVAS_EDGE);
  assertIntegerInRange("Audio bitrate", request.audioBitRateKbps ?? 192, 64, 512);
  if (!request.outputPath.trim()) throw new ExportValidationError("The output path is empty.");
  const expectedExtension = format === "mp4" ? ".mp4" : ".gif";
  if (path.extname(request.outputPath).toLowerCase() !== expectedExtension) {
    throw new ExportValidationError(`The output filename must end in ${expectedExtension}.`);
  }
  if (request.outputPath.length > 32_767) {
    throw new ExportValidationError("The export path is too long.");
  }
  if (request.gif !== undefined) {
    assertIntegerInRange(
      "GIF frame rate",
      request.gif.frameRate ?? Math.min(project.export.fps, 50),
      1,
      50,
    );
    assertIntegerInRange(
      "GIF maximum width",
      request.gif.maxWidth ?? project.canvas.width,
      64,
      MAX_CANVAS_EDGE,
    );
  }

  const totalDurationUs = projectDurationUs(project);
  if (!Number.isSafeInteger(totalDurationUs) || totalDurationUs <= 0 || totalDurationUs > 6 * 60 * 60 * MICROSECONDS_PER_SECOND) {
    throw new ExportValidationError("The export duration must be between one frame and six hours.");
  }
  const outputFrameRate = format === "gif"
    ? request.gif?.frameRate ?? Math.min(project.export.fps, 50)
    : project.export.fps;
  const outputWidth = format === "gif"
    ? Math.min(project.canvas.width, request.gif?.maxWidth ?? project.canvas.width)
    : project.canvas.width;
  const outputHeight = Math.round(project.canvas.height * outputWidth / project.canvas.width);
  const pixelFrames = totalDurationUs / MICROSECONDS_PER_SECOND * outputFrameRate * outputWidth * outputHeight;
  if (!Number.isFinite(pixelFrames) || pixelFrames > 8_000_000_000_000) {
    throw new ExportValidationError("This export is too large to render safely in one job.");
  }
  const canvasPixels = project.canvas.width * project.canvas.height;
  let filterPixelFrames = 0;
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId];
    if (asset?.kind !== "video") {
      throw new ExportValidationError(`Project asset ${clip.assetId} is not a video.`);
    }
    const layout = computeScreenLayout(project, asset);
    const intermediatePixels = layout.screenRectPx.width * layout.screenRectPx.height;
    if (
      layout.screenRectPx.width > MAX_INTERMEDIATE_EDGE ||
      layout.screenRectPx.height > MAX_INTERMEDIATE_EDGE ||
      intermediatePixels > MAX_INTERMEDIATE_PIXELS
    ) {
      throw new ExportValidationError(
        "Screen scale creates an oversized intermediate surface; reduce scale or export dimensions.",
      );
    }
    filterPixelFrames += clipDurationUs(clip) / MICROSECONDS_PER_SECOND *
      outputFrameRate * (canvasPixels + intermediatePixels);
  }
  if (!Number.isFinite(filterPixelFrames) || filterPixelFrames > 8_000_000_000_000) {
    throw new ExportValidationError(
      "This composition is too expensive to render safely in one job; reduce duration, scale, frame rate, or dimensions.",
    );
  }
  return { project, format, totalDurationUs };
}

async function resolveProjectRequest(
  request: ProjectExportRequest,
  options: ExportMediaOptions,
): Promise<ResolvedProjectRequest> {
  const { project, format, totalDurationUs } = validateProjectExportRequest(request);
  if (options.signal?.aborted) throw new ExportCancelledError();

  const outputPath = path.resolve(request.outputPath);
  const canonicalOutputPath = await canonicalOutputCandidate(outputPath);
  const assetPaths: Record<AssetId, string> = {};
  const streamSelections: Record<AssetId, ProbedStreamSelection> = {};
  const audioStreamIndexes: Record<AssetId, number> = {};
  const probeCache = new Map<string, Promise<MediaProbeResult>>();
  const referencedVideoIds = new Set(project.clips.map((clip) => clip.assetId));

  for (const assetId of referencedVideoIds) {
    const asset = project.assets[assetId];
    if (asset?.kind !== "video") {
      throw new ExportValidationError(`Project asset ${assetId} is not a video.`);
    }
    const unresolvedPath = request.assetPaths[assetId];
    if (!unresolvedPath?.trim()) {
      throw new ExportValidationError(`Project asset ${assetId} has no resolved path.`);
    }
    const sourcePath = path.resolve(unresolvedPath);
    if (samePath(sourcePath, outputPath) || samePath(await realpath(sourcePath), canonicalOutputPath)) {
      throw new ExportValidationError("The export cannot overwrite one of its source files.");
    }
    let pendingProbe = probeCache.get(sourcePath);
    if (pendingProbe === undefined) {
      pendingProbe = probeMedia(sourcePath, {
        binaryPath: options.ffprobePath,
        resourcesPath: options.resourcesPath,
        developmentRoot: options.developmentRoot,
        allowPathFallback: options.allowPathFallback,
        platform: options.platform,
        arch: options.arch,
        env: options.env,
        exists: options.exists,
        signal: options.signal,
      });
      probeCache.set(sourcePath, pendingProbe);
    }
    const metadata = await pendingProbe;
    if (!metadata.video) {
      throw new ExportValidationError(`${path.basename(sourcePath)} has no video stream.`);
    }
    const latestSourceOutUs = Math.max(
      ...project.clips
        .filter((clip) => clip.assetId === assetId)
        .map((clip) => clip.sourceOutUs),
    );
    if (metadata.durationUs !== undefined && latestSourceOutUs > metadata.durationUs + 100_000) {
      throw new ExportValidationError(`${path.basename(sourcePath)} is shorter than a selected clip range.`);
    }
    asset.audio = metadata.audio === undefined
      ? undefined
      : {
          codec: metadata.audio.codec,
          sampleRate: Math.max(1, metadata.audio.sampleRate ?? 48_000),
          channels: Math.max(1, metadata.audio.channels ?? 2),
        };
    assetPaths[assetId] = sourcePath;
    streamSelections[assetId] = {
      videoIndex: metadata.video.index,
      audioIndex: metadata.audio?.index,
    };
    if (metadata.audio !== undefined) audioStreamIndexes[assetId] = metadata.audio.index;
  }

  if (project.canvas.background.kind === "image") {
    const assetId = project.canvas.background.assetId;
    const asset = project.assets[assetId];
    if (asset?.kind !== "image") {
      throw new ExportValidationError(`Project background asset ${assetId} is not an image.`);
    }
    const unresolvedPath = request.assetPaths[assetId];
    if (!unresolvedPath?.trim()) {
      throw new ExportValidationError(`Project background asset ${assetId} has no resolved path.`);
    }
    const backgroundPath = path.resolve(unresolvedPath);
    if (
      samePath(backgroundPath, outputPath) ||
      samePath(await realpath(backgroundPath), canonicalOutputPath)
    ) {
      throw new ExportValidationError("The export cannot overwrite its background image.");
    }
    const backgroundStat = await stat(backgroundPath);
    if (!backgroundStat.isFile()) {
      throw new ExportValidationError("The background image is not a file.");
    }
    assetPaths[assetId] = backgroundPath;
  }

  if (format === "mp4" && (request.includeAudio ?? true) && project.audio !== undefined) {
    for (const assetId of activeProjectAudioAssetIds(project.audio)) {
      if (Object.hasOwn(assetPaths, assetId)) {
        throw new ExportValidationError(`Project audio asset ${assetId} collides with another media asset.`);
      }
      const asset = project.audio.assets[assetId];
      if (asset === undefined) {
        throw new ExportValidationError(`Project audio asset ${assetId} is missing.`);
      }
      const unresolvedPath = request.assetPaths[assetId];
      if (!unresolvedPath?.trim()) {
        throw new ExportValidationError(`Project audio asset ${assetId} has no resolved path.`);
      }
      const sourcePath = path.resolve(unresolvedPath);
      if (samePath(sourcePath, outputPath) || samePath(await realpath(sourcePath), canonicalOutputPath)) {
        throw new ExportValidationError("The export cannot overwrite one of its audio sources.");
      }
      let pendingProbe = probeCache.get(sourcePath);
      if (pendingProbe === undefined) {
        pendingProbe = probeMedia(sourcePath, {
          binaryPath: options.ffprobePath,
          resourcesPath: options.resourcesPath,
          developmentRoot: options.developmentRoot,
          allowPathFallback: options.allowPathFallback,
          platform: options.platform,
          arch: options.arch,
          env: options.env,
          exists: options.exists,
          signal: options.signal,
        });
        probeCache.set(sourcePath, pendingProbe);
      }
      const metadata = await pendingProbe;
      if (metadata.audio === undefined) {
        throw new ExportValidationError(`${path.basename(sourcePath)} has no audio stream.`);
      }
      const latestSourceOutUs = Math.max(
        ...project.audio.lanes.filter((lane) => !lane.muted).flatMap((lane) => lane.clips)
          .filter((clip) => clip.assetId === assetId && !clip.muted)
          .map((clip) => clip.sourceOutUs),
      );
      const audioDurationUs = probedAudioDurationUs(metadata);
      if (audioDurationUs !== undefined && latestSourceOutUs > audioDurationUs + 100_000) {
        throw new ExportValidationError(`${path.basename(sourcePath)} is shorter than a selected audio clip range.`);
      }
      assetPaths[assetId] = sourcePath;
      audioStreamIndexes[assetId] = metadata.audio.index;
    }
  }

  const warnings: string[] = [];
  if (project.canvas.screen.frame.kind !== "none") {
    warnings.push("Window and device frame chrome is not rendered yet; the screen composition was exported without it.");
  }
  if (
    format === "gif" &&
    request.gif?.frameRate === undefined &&
    project.export.fps > 50
  ) {
    warnings.push("GIF frame rate was limited to 50 fps for reliable palette rendering.");
  }
  if (project.canvas.background.kind === "gradient" && project.canvas.background.stops.length > 8) {
    warnings.push("The gradient was rendered with its first eight color stops.");
  }

  return {
    ...request,
    id: request.id ?? randomUUID(),
    project,
    assetPaths,
    outputPath,
    format,
    totalDurationUs,
    warnings,
    streamSelections,
    audioStreamIndexes,
  };
}

export function probedAudioDurationUs(
  metadata: Pick<MediaProbeResult, "audio" | "durationUs">,
): number | undefined {
  const streamDurationUs = metadata.audio?.durationUs;
  if (streamDurationUs !== undefined && streamDurationUs > 0) return streamDurationUs;
  return metadata.durationUs !== undefined && metadata.durationUs > 0 ? metadata.durationUs : undefined;
}

async function canonicalOutputCandidate(outputPath: string): Promise<string> {
  try {
    return await realpath(outputPath);
  } catch {
    try {
      return path.join(await realpath(path.dirname(outputPath)), path.basename(outputPath));
    } catch {
      return path.resolve(outputPath);
    }
  }
}

function seconds(microseconds: number): string {
  return (microseconds / MICROSECONDS_PER_SECOND).toFixed(6);
}

function atempoFilters(rateMilli: number): string[] {
  let tempo = rateMilli / 1_000;
  const factors: number[] = [];
  while (tempo > 2 + Number.EPSILON) {
    factors.push(2);
    tempo /= 2;
  }
  while (tempo < 0.5 - Number.EPSILON) {
    factors.push(0.5);
    tempo /= 0.5;
  }
  factors.push(tempo);
  return factors.map((factor) => `atempo=${factor.toFixed(8)}`);
}

function clipVideoFilters(
  clip: ResolvedClip,
  index: number,
  request: ResolvedRequest,
): string {
  const innerWidth = request.canvas.width - request.canvas.paddingPx * 2;
  const innerHeight = request.canvas.height - request.canvas.paddingPx * 2;
  const fit = clip.fit ?? request.canvas.fit;
  const geometry =
    fit === "cover"
      ? [
          `scale=w=${innerWidth}:h=${innerHeight}:force_original_aspect_ratio=increase:force_divisible_by=2`,
          `crop=w=${innerWidth}:h=${innerHeight}:x=(iw-ow)/2:y=(ih-oh)/2`,
          "format=pix_fmts=rgba",
        ]
      : [
          `scale=w=${innerWidth}:h=${innerHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          "format=pix_fmts=rgba",
          `pad=w=${innerWidth}:h=${innerHeight}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0`,
        ];
  const fps = `${request.canvas.fps.numerator}/${request.canvas.fps.denominator}`;
  const filters = [
    `trim=duration=${seconds(clip.sourceDurationUs)}`,
    "setpts=PTS-STARTPTS",
    `setpts=(PTS-STARTPTS)*1000/${clip.rateMilli}`,
    ...geometry,
    `fps=fps=${fps}:start_time=0`,
    "setsar=1",
    `trim=duration=${seconds(clip.outputDurationUs)}`,
    "setpts=PTS-STARTPTS",
  ];
  return `[${index}:${clip.videoStreamIndex}]${filters.join(",")}[v${index}]`;
}

function clipAudioFilters(clip: ResolvedClip, index: number): string {
  if (!clip.hasAudio || clip.muted) {
    const filters = [
      `anullsrc=r=48000:cl=stereo:d=${seconds(clip.outputDurationUs)}`,
      `atrim=duration=${seconds(clip.outputDurationUs)}`,
      "asetpts=PTS-STARTPTS",
    ];
    return `${filters.join(",")}[a${index}]`;
  }
  if (clip.audioStreamIndex === undefined) {
    throw new ExportValidationError(`Clip ${index + 1} has no probed audio stream selection.`);
  }

  const gain = 10 ** ((clip.gainDb ?? 0) / 20);
  const filters = [
    `atrim=duration=${seconds(clip.sourceDurationUs)}`,
    "asetpts=PTS-STARTPTS",
    ...atempoFilters(clip.rateMilli),
    `volume=${gain.toFixed(8)}`,
    "aresample=48000",
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    `apad=whole_dur=${seconds(clip.outputDurationUs)}`,
    `atrim=duration=${seconds(clip.outputDurationUs)}`,
    "asetpts=PTS-STARTPTS",
  ];
  return `[${index}:${clip.audioStreamIndex}]${filters.join(",")}[a${index}]`;
}

function composeVideoGraph(
  request: ResolvedRequest,
  mode: GraphMode,
  paletteInputIndex?: number,
): { lines: string[]; videoLabel: string } {
  const lines = request.clips.map((clip, index) => clipVideoFilters(clip, index, request));
  if (request.clips.length === 1) {
    lines.push("[v0]null[vcat]");
  } else {
    lines.push(`${request.clips.map((_, index) => `[v${index}]`).join("")}concat=n=${request.clips.length}:v=1:a=0[vcat]`);
  }

  const fps = `${request.canvas.fps.numerator}/${request.canvas.fps.denominator}`;
  if (request.canvas.background.kind === "solid") {
    lines.push(
      `color=c=${validateColor(request.canvas.background.color)}:s=${request.canvas.width}x${request.canvas.height}:r=${fps}:d=${seconds(request.totalDurationUs)},setpts=PTS-STARTPTS[bg]`,
    );
  } else {
    const backgroundIndex = request.clips.length;
    lines.push(
      `[${backgroundIndex}:v:0]fps=fps=${fps}:start_time=0,scale=w=${request.canvas.width}:h=${request.canvas.height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=w=${request.canvas.width}:h=${request.canvas.height}:x=(iw-ow)/2:y=(ih-oh)/2,trim=duration=${seconds(request.totalDurationUs)},setpts=PTS-STARTPTS[bg]`,
    );
  }

  lines.push(
    `[bg][vcat]overlay=x=${request.canvas.paddingPx}:y=${request.canvas.paddingPx}:shortest=1:eof_action=endall:format=auto[vbase]`,
  );

  if (mode === "mp4") {
    lines.push("[vbase]format=pix_fmts=nv12[vout]");
    return { lines, videoLabel: "vout" };
  }

  const gifFrameRate = request.gif?.frameRate ?? DEFAULT_GIF_FRAME_RATE;
  const maxWidth = request.gif?.maxWidth ?? 1_280;
  const gifScale = request.canvas.width > maxWidth ? `,scale=w=${maxWidth}:h=-2:flags=lanczos` : "";
  if (mode === "gif-palette") {
    lines.push(
      `[vbase]fps=fps=${gifFrameRate}${gifScale},palettegen=stats_mode=full:reserve_transparent=0[palette]`,
    );
    return { lines, videoLabel: "palette" };
  }

  if (paletteInputIndex === undefined) throw new ExportValidationError("GIF palette input is missing.");
  lines.push(`[vbase]fps=fps=${gifFrameRate}${gifScale}[gifsrc]`);
  lines.push(
    `[gifsrc][${paletteInputIndex}:v:0]paletteuse=dither=sierra2_4a:diff_mode=rectangle[vout]`,
  );
  return { lines, videoLabel: "vout" };
}

function compileExportGraph(
  request: ResolvedRequest,
  mode: GraphMode,
  palettePath?: string,
): CompiledGraph {
  const inputArgs: string[] = [];
  for (const clip of request.clips) {
    inputArgs.push(
      "-ss",
      seconds(clip.sourceInUs),
      "-t",
      seconds(clip.sourceDurationUs),
      "-i",
      clip.sourcePath,
    );
  }
  if (request.canvas.background.kind === "image") {
    inputArgs.push(
      "-loop",
      "1",
      "-framerate",
      String(request.canvas.fps.numerator / request.canvas.fps.denominator),
      "-i",
      path.resolve(request.canvas.background.path),
    );
  }

  let paletteInputIndex: number | undefined;
  if (mode === "gif-render") {
    if (!palettePath) throw new ExportValidationError("GIF render needs a generated palette.");
    paletteInputIndex = request.clips.length + (request.canvas.background.kind === "image" ? 1 : 0);
    inputArgs.push("-i", palettePath);
  }

  const composed = composeVideoGraph(request, mode, paletteInputIndex);
  const lines = [...composed.lines];
  let audioLabel: string | undefined;
  if (mode === "mp4" && (request.includeAudio ?? true)) {
    lines.push(...request.clips.map(clipAudioFilters));
    if (request.clips.length === 1) {
      lines.push("[a0]anull[aout]");
    } else {
      lines.push(`${request.clips.map((_, index) => `[a${index}]`).join("")}concat=n=${request.clips.length}:v=0:a=1[aout]`);
    }
    audioLabel = "aout";
  }

  return {
    inputArgs,
    graph: lines.join(";\n"),
    videoLabel: composed.videoLabel,
    audioLabel,
  };
}

function parseClockToMicroseconds(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const secondsValue = Number(match[3]);
  const result = Math.round((hours * 3_600 + minutes * 60 + secondsValue) * MICROSECONDS_PER_SECOND);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

interface RunFfmpegOptions {
  /** Present only for captioned exports so libass can open a safe owned basename. */
  cwd?: string;
  signal?: AbortSignal;
  totalDurationUs: number;
  phase: ExportPhase;
  phaseStart: number;
  phaseEnd: number;
  onProgress?: (progress: ExportProgress) => void;
  /** Test-only platform override; production uses the host platform. */
  platform?: NodeJS.Platform;
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""';
  if (!/[\t "]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + character;
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Includes separators and the terminating NUL passed to CreateProcessW. */
export function windowsCommandLineUtf16Length(binary: string, args: readonly string[]): number {
  return quoteWindowsArgument(binary).length
    + args.reduce((length, argument) => length + 1 + quoteWindowsArgument(argument).length, 0)
    + 1;
}

export function assertWindowsFfmpegCommandLineBudget(
  binary: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  const required = windowsCommandLineUtf16Length(binary, args);
  if (required > WINDOWS_COMMAND_LINE_LIMIT_UTF16) {
    throw new ExportValidationError(
      `This project needs a ${required}-unit Windows FFmpeg command line; the limit is ${WINDOWS_COMMAND_LINE_LIMIT_UTF16} UTF-16 units including the terminator. Shorten the source media path or reduce the number of cuts.`,
    );
  }
}

export async function runFfmpeg(
  binary: string,
  args: readonly string[],
  options: RunFfmpegOptions,
): Promise<void> {
  if (options.signal?.aborted) throw new ExportCancelledError();
  assertWindowsFfmpegCommandLineBudget(binary, args, options.platform);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let settled = false;
    let cancelled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let progressBuffer = "";
    let stderr = "";
    const progressValues = new Map<string, string>();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (hardKillTimer) clearTimeout(hardKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };

    const emitProgress = (): void => {
      const outTimeUs =
        Number.parseInt(progressValues.get("out_time_us") ?? "", 10) ||
        parseClockToMicroseconds(progressValues.get("out_time") ?? "0:00:00") ||
        0;
      const localFraction = Math.min(1, Math.max(0, outTimeUs / options.totalDurationUs));
      const fraction = options.phaseStart + localFraction * (options.phaseEnd - options.phaseStart);
      const frame = Number.parseInt(progressValues.get("frame") ?? "", 10);
      const fps = Number.parseFloat(progressValues.get("fps") ?? "");
      reportProgress(options.onProgress, {
        phase: options.phase,
        fraction: progressValues.get("progress") === "end" ? options.phaseEnd : fraction,
        outTimeUs,
        frame: Number.isFinite(frame) ? frame : undefined,
        fps: Number.isFinite(fps) ? fps : undefined,
        speed: progressValues.get("speed"),
      });
      progressValues.clear();
    };

    const processProgressText = (text: string): void => {
      progressBuffer += text;
      if (progressBuffer.length > 64 * 1_024) {
        child.kill();
        finish(new ExportProcessError("FFmpeg progress output exceeded the safety limit."));
        return;
      }
      let newline = progressBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = progressBuffer.slice(0, newline).trimEnd();
        progressBuffer = progressBuffer.slice(newline + 1);
        const separator = line.indexOf("=");
        if (separator > 0) {
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1);
          progressValues.set(key, value);
          if (key === "progress") emitProgress();
        }
        newline = progressBuffer.indexOf("\n");
      }
    };

    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        // The child may have exited between the failure and cleanup request.
      }
    };

    const abort = (): void => {
      if (cancelled) return;
      cancelled = true;
      try {
        child.stdin.write("q\n");
      } catch {
        killChild();
      }
      hardKillTimer = setTimeout(killChild, 1_000);
    };

    const onPipeError = (pipe: "progress" | "diagnostic", error: Error): void => {
      if (settled) return;
      killChild();
      if (cancelled || options.signal?.aborted) {
        finish(new ExportCancelledError());
        return;
      }
      finish(new ExportProcessError(
        `FFmpeg ${pipe} stream failed: ${error.message}`,
        stderr,
        undefined,
        { cause: error },
      ));
    };

    child.stdin.on("error", () => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => processProgressText(chunk.toString("utf8")));
    child.stdout.on("error", (error) => onPipeError("progress", error));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1_024);
    });
    child.stderr.on("error", (error) => onPipeError("diagnostic", error));
    child.on("error", (error) => {
      finish(new ExportProcessError(`Could not start FFmpeg: ${error.message}`, stderr, undefined, { cause: error }));
    });
    child.on("close", (code) => {
      if (cancelled || options.signal?.aborted) {
        finish(new ExportCancelledError());
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        finish(
          new ExportProcessError(
            `FFmpeg failed${detail ? `: ${detail.slice(-4_096)}` : "."}`,
            detail,
            code ?? undefined,
          ),
        );
        return;
      }
      finish();
    });
  });
}

function tempPathFor(outputPath: string, token: string, suffix: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `.${parsed.name}.${token}.${suffix}${parsed.ext}`);
}

export async function commitRenderedFile(
  partialPath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) {
    await rename(partialPath, outputPath);
    return;
  }
  try {
    await link(partialPath, outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ExportValidationError(
        "The export destination appeared while rendering; nothing was overwritten.",
      );
    }
    throw error;
  }
  await rm(partialPath, { force: true }).catch(() => undefined);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function commonFfmpegArgs(compiled: CompiledGraph, graphPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    ...compiled.inputArgs,
    "-/filter_complex",
    graphPath,
    "-map",
    `[${compiled.videoLabel}]`,
  ];
}

function buildResolvedProjectPlan(
  request: ResolvedProjectRequest,
  mode: ExportGraphMode,
  palettePath?: string,
  captionFileName?: string,
): ExportPlan {
  try {
    const plan = buildExportPlan(
      {
        project: request.project,
        assetPaths: request.assetPaths,
        outputPath: request.outputPath,
        format: request.format,
        includeAudio: request.includeAudio,
        audioStreamIndexes: request.audioStreamIndexes,
        frameRate: request.format === "gif"
          ? request.gif?.frameRate ?? Math.min(request.project.export.fps, 50)
          : request.project.export.fps,
        gif: request.gif,
      },
      { mode, palettePath, mp4PixelFormat: "nv12" },
    );
    return applyCaptionAssToPlan(
      applyProbedStreamSelections(plan, request.streamSelections),
      captionFileName,
    );
  } catch (error) {
    if (error instanceof ExportPlanError) {
      throw new ExportValidationError(error.message);
    }
    throw error;
  }
}

const SAFE_ASS_FILE_NAME = /^\.[0-9a-f-]+\.captions\.ass$/iu;

/** Inserts libass after composition and before MP4 conversion or GIF palette work. */
export function applyCaptionAssToPlan(plan: ExportPlan, captionFileName?: string): ExportPlan {
  if (captionFileName === undefined) return plan;
  if (!SAFE_ASS_FILE_NAME.test(captionFileName)) {
    throw new ExportValidationError("The generated caption filename is unsafe.");
  }
  const marker = ";\n[vcat]";
  const markerIndex = plan.filterGraph.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new ExportValidationError("The export graph has no final composition for captions.");
  }
  const captionFilter = `${marker}ass=filename=${captionFileName}[vcaptioned];\n[vcaptioned]`;
  return {
    ...plan,
    filterGraph:
      plan.filterGraph.slice(0, markerIndex) +
      captionFilter +
      plan.filterGraph.slice(markerIndex + marker.length),
  };
}

/**
 * Binds every clip input to the exact playable streams selected by ffprobe.
 * Generic `:v`/`:a` selectors are unsafe for MP4s whose first video stream is
 * attached cover art rather than the timeline video.
 */
export function applyProbedStreamSelections(
  plan: ExportPlan,
  selections: Readonly<Record<AssetId, ProbedStreamSelection>>,
): ExportPlan {
  let filterGraph = plan.filterGraph;
  for (const [inputIndex, input] of plan.inputs.entries()) {
    if (input.kind !== "clip") continue;
    const selection = selections[input.assetId];
    if (selection === undefined) {
      throw new ExportValidationError(`Project asset ${input.assetId} has no probed stream selection.`);
    }
    if (!Number.isSafeInteger(selection.videoIndex) || selection.videoIndex < 0) {
      throw new ExportValidationError(`Project asset ${input.assetId} has an invalid video stream selection.`);
    }
    if (
      selection.audioIndex !== undefined &&
      (!Number.isSafeInteger(selection.audioIndex) || selection.audioIndex < 0)
    ) {
      throw new ExportValidationError(`Project asset ${input.assetId} has an invalid audio stream selection.`);
    }
    filterGraph = filterGraph.replaceAll(
      `[${inputIndex}:v]`,
      `[${inputIndex}:${selection.videoIndex}]`,
    );
    if (selection.audioIndex !== undefined) {
      filterGraph = filterGraph.replaceAll(
        `[${inputIndex}:a]`,
        `[${inputIndex}:${selection.audioIndex}]`,
      );
    }
  }
  return filterGraph === plan.filterGraph ? plan : { ...plan, filterGraph };
}

function commonProjectFfmpegArgs(plan: ExportPlan, graphPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    ...plan.inputArgs,
    "-/filter_complex",
    graphPath,
    "-map",
    `[${plan.videoLabel}]`,
  ];
}

async function verifyRenderedFile(
  request: ResolvedRequest,
  partialPath: string,
  options: ExportMediaOptions,
): Promise<MediaProbeResult> {
  const fileStat = await stat(partialPath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new ExportProcessError("FFmpeg did not create a usable output file.");
  }
  const metadata = await probeMedia(partialPath, {
    binaryPath: options.ffprobePath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
    signal: options.signal,
  });
  if (!metadata.video) throw new ExportProcessError("The rendered file has no video stream.");
  const expectedWidth =
    request.format === "gif" && request.canvas.width > (request.gif?.maxWidth ?? 1_280)
      ? request.gif?.maxWidth ?? 1_280
      : request.canvas.width;
  if (metadata.video.width !== expectedWidth) {
    throw new ExportProcessError("The rendered file has an unexpected width.");
  }
  if (metadata.durationUs !== undefined) {
    const frameUs = Math.ceil(
      MICROSECONDS_PER_SECOND * request.canvas.fps.denominator / request.canvas.fps.numerator,
    );
    if (Math.abs(metadata.durationUs - request.totalDurationUs) > Math.max(frameUs * 2, 100_000)) {
      throw new ExportProcessError("The rendered file duration does not match the project.");
    }
  }
  return metadata;
}

async function verifyProjectRenderedFile(
  request: ResolvedProjectRequest,
  plan: ExportPlan,
  partialPath: string,
  options: ExportMediaOptions,
): Promise<MediaProbeResult> {
  const fileStat = await stat(partialPath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new ExportProcessError("FFmpeg did not create a usable output file.");
  }
  const metadata = await probeMedia(partialPath, {
    binaryPath: options.ffprobePath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
    signal: options.signal,
  });
  if (!metadata.video) throw new ExportProcessError("The rendered file has no video stream.");
  if (metadata.video.width !== plan.outputWidth || metadata.video.height !== plan.outputHeight) {
    throw new ExportProcessError("The rendered file has unexpected dimensions.");
  }
  if (metadata.durationUs !== undefined) {
    const effectiveFps = request.format === "gif"
      ? request.gif?.frameRate ?? Math.min(request.project.export.fps, 50)
      : request.project.export.fps;
    const frameUs = Math.ceil(MICROSECONDS_PER_SECOND / effectiveFps);
    if (Math.abs(metadata.durationUs - request.totalDurationUs) > Math.max(frameUs * 2, 100_000)) {
      throw new ExportProcessError("The rendered file duration does not match the project.");
    }
  }
  return metadata;
}

async function exportMp4(
  request: ResolvedRequest,
  ffmpeg: string,
  graphPath: string,
  partialPath: string,
  options: ExportMediaOptions,
  warnings: string[],
): Promise<void> {
  const compiled = compileExportGraph(request, "mp4");
  await writeFile(graphPath, compiled.graph, { encoding: "utf8", flag: "wx" });
  const baseArgs = [
    ...commonFfmpegArgs(compiled, graphPath),
    ...(compiled.audioLabel ? ["-map", `[${compiled.audioLabel}]`] : ["-an"]),
    "-t",
    `${request.totalDurationUs}us`,
    "-c:v",
    "h264_mf",
    "-rate_control",
    "quality",
    "-quality",
    String(request.quality ?? 80),
    "-scenario",
    "archive",
    "-pix_fmt",
    "nv12",
    ...(compiled.audioLabel
      ? [
          "-c:a",
          "aac",
          "-b:a",
          `${request.audioBitRateKbps ?? 192}k`,
          "-ar",
          "48000",
          "-ac",
          "2",
        ]
      : []),
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-y",
    partialPath,
  ];

  const acceleration = request.hardwareAcceleration ?? "auto";
  const attempts = acceleration === "auto" ? [true, false] : [acceleration === "on"];
  let firstError: unknown;
  for (const [attemptIndex, hardware] of attempts.entries()) {
    if (attemptIndex > 0) {
      await rm(partialPath, { force: true });
      warnings.push("Hardware H.264 was unavailable; Media Foundation software encoding was used.");
    }
    try {
      await runFfmpeg(ffmpeg, [...baseArgs.slice(0, -2), "-hw_encoding", hardware ? "1" : "0", ...baseArgs.slice(-2)], {
        signal: options.signal,
        totalDurationUs: request.totalDurationUs,
        phase: "rendering",
        phaseStart: 0.05,
        phaseEnd: 0.9,
        onProgress: options.onProgress,
      });
      return;
    } catch (error) {
      if (error instanceof ExportCancelledError || acceleration !== "auto" || attemptIndex > 0) throw error;
      firstError = error;
    }
  }
  throw firstError;
}

async function exportGif(
  request: ResolvedRequest,
  ffmpeg: string,
  paletteGraphPath: string,
  renderGraphPath: string,
  palettePath: string,
  partialPath: string,
  options: ExportMediaOptions,
): Promise<void> {
  const palette = compileExportGraph(request, "gif-palette");
  await writeFile(paletteGraphPath, palette.graph, { encoding: "utf8", flag: "wx" });
  await runFfmpeg(
    ffmpeg,
    [
      ...commonFfmpegArgs(palette, paletteGraphPath),
      "-frames:v",
      "1",
      "-update",
      "1",
      "-y",
      palettePath,
    ],
    {
      signal: options.signal,
      totalDurationUs: request.totalDurationUs,
      phase: "palette",
      phaseStart: 0.05,
      phaseEnd: 0.45,
      onProgress: options.onProgress,
    },
  );

  const rendered = compileExportGraph(request, "gif-render", palettePath);
  await writeFile(renderGraphPath, rendered.graph, { encoding: "utf8", flag: "wx" });
  await runFfmpeg(
    ffmpeg,
    [
      ...commonFfmpegArgs(rendered, renderGraphPath),
      "-an",
      "-t",
      `${request.totalDurationUs}us`,
      "-c:v",
      "gif",
      "-loop",
      "0",
      "-y",
      partialPath,
    ],
    {
      signal: options.signal,
      totalDurationUs: request.totalDurationUs,
      phase: "rendering",
      phaseStart: 0.45,
      phaseEnd: 0.9,
      onProgress: options.onProgress,
    },
  );
}

function projectQualityNumber(project: EditorProject): number {
  if (project.export.quality === "small") return 45;
  if (project.export.quality === "balanced") return 65;
  if (project.export.quality === "lossless-ish") return 100;
  return 85;
}

async function exportProjectMp4(
  request: ResolvedProjectRequest,
  ffmpeg: string,
  graphPath: string,
  partialPath: string,
  options: ExportMediaOptions,
  warnings: string[],
  captions?: { fileName: string; workingDirectory: string },
): Promise<ExportPlan> {
  const plan = buildResolvedProjectPlan(request, "final", undefined, captions?.fileName);
  await writeFile(graphPath, plan.filterGraph, { encoding: "utf8", flag: "wx" });
  const baseArgs = [
    ...commonProjectFfmpegArgs(plan, graphPath),
    ...(plan.audioLabel ? ["-map", `[${plan.audioLabel}]`] : ["-an"]),
    "-t",
    `${request.totalDurationUs}us`,
    "-c:v",
    "h264_mf",
    "-rate_control",
    "quality",
    "-quality",
    String(projectQualityNumber(request.project)),
    "-scenario",
    "archive",
    "-pix_fmt",
    "nv12",
    ...(plan.audioLabel
      ? [
          "-c:a",
          "aac",
          "-b:a",
          `${request.audioBitRateKbps ?? 192}k`,
          "-ar",
          "48000",
          "-ac",
          "2",
        ]
      : []),
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-y",
    partialPath,
  ];

  const acceleration = request.hardwareAcceleration ?? "auto";
  const attempts = acceleration === "auto" ? [true, false] : [acceleration === "on"];
  let firstError: unknown;
  for (const [attemptIndex, hardware] of attempts.entries()) {
    if (attemptIndex > 0) {
      await rm(partialPath, { force: true });
      warnings.push("Hardware H.264 was unavailable; Media Foundation software encoding was used.");
    }
    try {
      await runFfmpeg(
        ffmpeg,
        [...baseArgs.slice(0, -2), "-hw_encoding", hardware ? "1" : "0", ...baseArgs.slice(-2)],
        {
          cwd: captions?.workingDirectory,
          signal: options.signal,
          totalDurationUs: request.totalDurationUs,
          phase: "rendering",
          phaseStart: 0.05,
          phaseEnd: 0.9,
          onProgress: options.onProgress,
        },
      );
      return plan;
    } catch (error) {
      if (error instanceof ExportCancelledError || acceleration !== "auto" || attemptIndex > 0) {
        throw error;
      }
      firstError = error;
    }
  }
  throw firstError;
}

async function exportProjectGif(
  request: ResolvedProjectRequest,
  ffmpeg: string,
  paletteGraphPath: string,
  renderGraphPath: string,
  palettePath: string,
  partialPath: string,
  options: ExportMediaOptions,
  captions?: { fileName: string; workingDirectory: string },
): Promise<ExportPlan> {
  const palette = buildResolvedProjectPlan(request, "gif-palette", undefined, captions?.fileName);
  await writeFile(paletteGraphPath, palette.filterGraph, { encoding: "utf8", flag: "wx" });
  await runFfmpeg(
    ffmpeg,
    [
      ...commonProjectFfmpegArgs(palette, paletteGraphPath),
      "-frames:v",
      "1",
      "-update",
      "1",
      "-y",
      palettePath,
    ],
    {
      cwd: captions?.workingDirectory,
      signal: options.signal,
      totalDurationUs: request.totalDurationUs,
      phase: "palette",
      phaseStart: 0.05,
      phaseEnd: 0.45,
      onProgress: options.onProgress,
    },
  );

  const rendered = buildResolvedProjectPlan(request, "gif-render", palettePath, captions?.fileName);
  await writeFile(renderGraphPath, rendered.filterGraph, { encoding: "utf8", flag: "wx" });
  await runFfmpeg(
    ffmpeg,
    [
      ...commonProjectFfmpegArgs(rendered, renderGraphPath),
      "-an",
      "-t",
      `${request.totalDurationUs}us`,
      "-c:v",
      "gif",
      "-loop",
      "0",
      "-y",
      partialPath,
    ],
    {
      cwd: captions?.workingDirectory,
      signal: options.signal,
      totalDurationUs: request.totalDurationUs,
      phase: "rendering",
      phaseStart: 0.45,
      phaseEnd: 0.9,
      onProgress: options.onProgress,
    },
  );
  return rendered;
}

export async function exportMedia(
  request: ExportRequest,
  options: ExportMediaOptions = {},
): Promise<ExportResult> {
  reportProgress(options.onProgress, { phase: "preparing", fraction: 0, outTimeUs: 0 });
  let resolved: ResolvedRequest;
  try {
    resolved = await resolveRequest(request, options);
  } catch (error) {
    if (options.signal?.aborted) throw new ExportCancelledError();
    throw error;
  }
  if (!resolved.overwrite && (await pathExists(resolved.outputPath))) {
    throw new ExportValidationError("The export destination already exists.");
  }

  const ffmpeg = resolveBundledMediaBinary("ffmpeg", {
    explicitPath: options.ffmpegPath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
  });
  const destinationDirectory = path.dirname(resolved.outputPath);
  await mkdir(destinationDirectory, { recursive: true });

  const token = randomUUID();
  const partialPath = tempPathFor(resolved.outputPath, token, "partial");
  const graphPath = path.join(destinationDirectory, `.${token}.ffgraph`);
  const paletteGraphPath = path.join(destinationDirectory, `.${token}.palette.ffgraph`);
  const renderGraphPath = path.join(destinationDirectory, `.${token}.render.ffgraph`);
  const palettePath = path.join(destinationDirectory, `.${token}.palette.png`);
  const temporaryPaths = [partialPath, graphPath, paletteGraphPath, renderGraphPath, palettePath];
  const warnings: string[] = [];

  try {
    if (resolved.format === "mp4") {
      await exportMp4(resolved, ffmpeg, graphPath, partialPath, options, warnings);
    } else {
      await exportGif(
        resolved,
        ffmpeg,
        paletteGraphPath,
        renderGraphPath,
        palettePath,
        partialPath,
        options,
      );
    }

    if (options.signal?.aborted) throw new ExportCancelledError();
    reportProgress(options.onProgress, {
      phase: "validating",
      fraction: 0.92,
      outTimeUs: resolved.totalDurationUs,
    });
    let metadata: MediaProbeResult;
    try {
      metadata = await verifyRenderedFile(resolved, partialPath, options);
    } catch (error) {
      if (options.signal?.aborted) throw new ExportCancelledError();
      throw error;
    }
    if (!resolved.overwrite && (await pathExists(resolved.outputPath))) {
      throw new ExportValidationError("The export destination appeared while rendering; nothing was overwritten.");
    }

    await commitRenderedFile(partialPath, resolved.outputPath, resolved.overwrite ?? false);
    reportProgress(options.onProgress, {
      phase: "validating",
      fraction: 1,
      outTimeUs: resolved.totalDurationUs,
    });
    return {
      id: resolved.id,
      outputPath: resolved.outputPath,
      durationUs: resolved.totalDurationUs,
      metadata: { ...metadata, path: resolved.outputPath },
      warnings,
    };
  } finally {
    await Promise.allSettled(temporaryPaths.map((temporaryPath) => rm(temporaryPath, { force: true })));
  }
}

export function exportProjectMedia(
  request: ProjectExportRequest,
  options: ExportMediaOptions = {},
): Promise<ExportResult> {
  return exportProjectMediaInternal(request, options);
}

async function exportProjectMediaInternal(
  request: ProjectExportRequest,
  options: ExportMediaOptions,
  claimCommit?: () => boolean,
): Promise<ExportResult> {
  reportProgress(options.onProgress, { phase: "preparing", fraction: 0, outTimeUs: 0 });
  let resolved: ResolvedProjectRequest;
  try {
    resolved = await resolveProjectRequest(request, options);
  } catch (error) {
    if (options.signal?.aborted) throw new ExportCancelledError();
    throw error;
  }
  if (!resolved.overwrite && (await pathExists(resolved.outputPath))) {
    throw new ExportValidationError("The export destination already exists.");
  }

  const ffmpeg = resolveBundledMediaBinary("ffmpeg", {
    explicitPath: options.ffmpegPath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
  });
  const destinationDirectory = path.dirname(resolved.outputPath);
  await mkdir(destinationDirectory, { recursive: true });

  const token = randomUUID();
  const partialPath = tempPathFor(resolved.outputPath, token, "partial");
  const graphPath = path.join(destinationDirectory, `.${token}.ffgraph`);
  const paletteGraphPath = path.join(destinationDirectory, `.${token}.palette.ffgraph`);
  const renderGraphPath = path.join(destinationDirectory, `.${token}.render.ffgraph`);
  const palettePath = path.join(destinationDirectory, `.${token}.palette.png`);
  const captionFileName = `.${token}.captions.ass`;
  const captionPath = path.join(destinationDirectory, captionFileName);
  const hasCaptions = (resolved.project.overlays?.captions.length ?? 0) > 0;
  const captions = hasCaptions
    ? { fileName: captionFileName, workingDirectory: destinationDirectory }
    : undefined;
  const temporaryPaths = [
    partialPath,
    graphPath,
    paletteGraphPath,
    renderGraphPath,
    palettePath,
  ];
  const warnings = [...resolved.warnings];

  try {
    if (hasCaptions) {
      await writeFile(captionPath, generateCaptionAss({
        captions: resolved.project.overlays!.captions,
        canvas: resolved.project.canvas,
      }), { encoding: "utf8", flag: "wx" });
      temporaryPaths.push(captionPath);
      if (options.signal?.aborted) throw new ExportCancelledError();
    }
    const finalPlan = resolved.format === "mp4"
      ? await exportProjectMp4(resolved, ffmpeg, graphPath, partialPath, options, warnings, captions)
      : await exportProjectGif(
          resolved,
          ffmpeg,
          paletteGraphPath,
          renderGraphPath,
          palettePath,
          partialPath,
          options,
          captions,
        );

    if (options.signal?.aborted) throw new ExportCancelledError();
    reportProgress(options.onProgress, {
      phase: "validating",
      fraction: 0.92,
      outTimeUs: resolved.totalDurationUs,
    });
    let metadata: MediaProbeResult;
    try {
      metadata = await verifyProjectRenderedFile(resolved, finalPlan, partialPath, options);
    } catch (error) {
      if (options.signal?.aborted) throw new ExportCancelledError();
      throw error;
    }
    if (options.signal?.aborted) throw new ExportCancelledError();
    if (!resolved.overwrite && (await pathExists(resolved.outputPath))) {
      throw new ExportValidationError("The export destination appeared while rendering; nothing was overwritten.");
    }
    if (options.signal?.aborted) throw new ExportCancelledError();
    if (claimCommit !== undefined && !claimCommit()) throw new ExportCancelledError();

    await commitRenderedFile(partialPath, resolved.outputPath, resolved.overwrite ?? false);
    reportProgress(options.onProgress, {
      phase: "validating",
      fraction: 1,
      outTimeUs: resolved.totalDurationUs,
    });
    return {
      id: resolved.id,
      outputPath: resolved.outputPath,
      durationUs: resolved.totalDurationUs,
      metadata: { ...metadata, path: resolved.outputPath },
      warnings: [...new Set(warnings)],
    };
  } finally {
    await Promise.allSettled(temporaryPaths.map((temporaryPath) => rm(temporaryPath, { force: true })));
  }
}

export class ExportService {
  private active?: { id: string; controller: AbortController; committing: boolean };
  private reservedJobId?: string;

  get activeJobId(): string | undefined {
    return this.active?.id;
  }

  /** Claims the single export slot before any save dialog or preflight awaits. */
  reserveStart(id: string = randomUUID()): string {
    const busyJobId = this.active?.id ?? this.reservedJobId;
    if (busyJobId !== undefined) throw new ExportBusyError(busyJobId);
    this.reservedJobId = id;
    return id;
  }

  releaseStart(id: string): void {
    if (this.reservedJobId === id) this.reservedJobId = undefined;
  }

  private claimStart(id: string): AbortController {
    if (this.active) throw new ExportBusyError(this.active.id);
    if (this.reservedJobId !== undefined && this.reservedJobId !== id) {
      throw new ExportBusyError(this.reservedJobId);
    }
    if (this.reservedJobId === id) this.reservedJobId = undefined;
    const controller = new AbortController();
    this.active = { id, controller, committing: false };
    return controller;
  }

  start(request: ExportRequest, options: Omit<ExportMediaOptions, "signal"> = {}): ExportHandle {
    const id = request.id ?? randomUUID();
    const controller = this.claimStart(id);
    const promise = exportMedia({ ...request, id }, { ...options, signal: controller.signal }).finally(() => {
      if (this.active?.id === id) this.active = undefined;
    });
    return {
      id,
      promise,
      cancel: () => controller.abort(),
    };
  }

  startProject(
    request: ProjectExportRequest,
    options: Omit<ExportMediaOptions, "signal"> = {},
  ): ExportHandle {
    const id = request.id ?? randomUUID();
    const controller = this.claimStart(id);
    const claimCommit = (): boolean => {
      const active = this.active;
      if (
        active === undefined ||
        active.id !== id ||
        active.committing ||
        active.controller.signal.aborted
      ) {
        return false;
      }
      active.committing = true;
      return true;
    };
    const promise = exportProjectMediaInternal(
      { ...request, id },
      { ...options, signal: controller.signal },
      claimCommit,
    ).finally(() => {
      if (this.active?.id === id) this.active = undefined;
    });
    return {
      id,
      promise,
      cancel: () => controller.abort(),
    };
  }

  cancel(jobId?: string): boolean {
    if (!this.active || (jobId !== undefined && this.active.id !== jobId)) return false;
    if (this.active.committing) return false;
    this.active.controller.abort();
    return true;
  }
}
