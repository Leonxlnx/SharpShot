import { type ZoomSegment, validateZoomSegments } from "./cursor-zoom.js";
import {
  OverlayValidationError,
  type OverlayDocument,
  validateOverlayDocument,
} from "./overlays.js";
import {
  AudioTimelineValidationError,
  type AudioTimeline,
} from "./audio-timeline.js";
import { validateSavedProjectAudio } from "./project-audio.js";

export const PROJECT_MAGIC = "sharpshot-project" as const;
export const PROJECT_SCHEMA_VERSION = 1 as const;
export const MAX_PROJECT_CLIPS = 200;

export type TimeUs = number;
export type ProjectId = string;
export type AssetId = string;
export type ClipId = string;

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, 8] as const;
export type OutputFormat = "mp4" | "gif";
export type OutputFps = 15 | 30 | 60;

export type AssetLocator =
  | { kind: "managed"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "bundled"; key: string };

export interface MediaSignature {
  byteLength: number;
  modifiedMs: number;
}

export interface VideoAsset {
  id: AssetId;
  kind: "video";
  name: string;
  locator: AssetLocator;
  signature?: MediaSignature;
  durationUs: TimeUs;
  width: number;
  height: number;
  frameRate: {
    numerator: number;
    denominator: number;
  };
  videoCodec?: string;
  audio?: {
    codec?: string;
    sampleRate: number;
    channels: number;
  };
}

export interface ImageAsset {
  id: AssetId;
  kind: "image";
  name: string;
  locator: AssetLocator;
  signature?: MediaSignature;
  width: number;
  height: number;
}

export type MediaAsset = VideoAsset | ImageAsset;

export type SpeedAudioMode = "preserve-pitch" | "change-pitch" | "mute";

export interface TimelineClip {
  id: ClipId;
  assetId: AssetId;
  name: string;
  sourceInUs: TimeUs;
  sourceOutUs: TimeUs;
  speed: number;
  audio: {
    mode: SpeedAudioMode;
    gainDb: number;
  };
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GradientStop {
  offset: number;
  color: string;
}

export type BackgroundStyle =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; angleDeg: number; stops: GradientStop[] }
  | {
      kind: "image";
      assetId: AssetId;
      fit: "cover" | "contain";
      blurPx: number;
      opacity: number;
    };

export type FrameStyle =
  | { kind: "none" }
  | { kind: "macos" }
  | { kind: "windows" }
  | { kind: "browser"; title: string; url: string }
  | { kind: "macbook" };

export interface ScreenStyle {
  crop: NormalizedRect;
  /** Fraction of the canvas's shorter edge. */
  padding: number;
  scale: number;
  /** Normalized placement inside the padded area. */
  position: { x: number; y: number };
  /** Fraction of the composed screen's shorter edge. */
  cornerRadius: number;
  border: {
    widthPx: number;
    color: string;
    opacity: number;
  };
  shadow: {
    offsetX: number;
    offsetY: number;
    blurPx: number;
    opacity: number;
  };
  frame: FrameStyle;
}

export interface CanvasStyle {
  preset: "auto" | "wide" | "vertical" | "square" | "classic" | "tall" | "custom";
  width: number;
  height: number;
  background: BackgroundStyle;
  screen: ScreenStyle;
}

export interface ExportSettings {
  format: OutputFormat;
  fps: OutputFps;
  quality: "small" | "balanced" | "high" | "lossless-ish";
}

export interface ProjectZoomTrack {
  segments: ZoomSegment[];
}

export interface EditorProject {
  magic: typeof PROJECT_MAGIC;
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: ProjectId;
  title: string;
  createdAt: string;
  updatedAt: string;
  assets: Record<AssetId, MediaAsset>;
  /** Playback order. Source media is never mutated by timeline operations. */
  clips: TimelineClip[];
  canvas: CanvasStyle;
  export: ExportSettings;
  /** Optional so existing schema-v1 projects continue to load unchanged. */
  zoom?: ProjectZoomTrack;
  /** Optional so existing schema-v1 projects continue to load unchanged. */
  overlays?: OverlayDocument;
  /** Optional multitrack audio; legacy schema-v1 projects keep clip audio only. */
  audio?: AudioTimeline;
}

export const DEFAULT_CANVAS_STYLE: Readonly<CanvasStyle> = {
  preset: "wide",
  width: 1920,
  height: 1080,
  background: { kind: "solid", color: "#111318" },
  screen: {
    crop: { x: 0, y: 0, width: 1, height: 1 },
    padding: 0.075,
    scale: 1,
    position: { x: 0.5, y: 0.5 },
    cornerRadius: 0.025,
    border: { widthPx: 0, color: "#FFFFFF", opacity: 0 },
    shadow: { offsetX: 0, offsetY: 18, blurPx: 42, opacity: 0.28 },
    frame: { kind: "none" },
  },
};

export const DEFAULT_EXPORT_SETTINGS: Readonly<ExportSettings> = {
  format: "mp4",
  fps: 60,
  quality: "high",
};

export interface CreateProjectOptions {
  id?: ProjectId;
  title?: string;
  now?: string;
  canvas?: CanvasStyle;
  export?: ExportSettings;
}

export function createDefaultProject(options: CreateProjectOptions = {}): EditorProject {
  const now = options.now ?? new Date().toISOString();
  return {
    magic: PROJECT_MAGIC,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: options.id ?? createLocalId("project"),
    title: options.title?.trim() || "Untitled recording",
    createdAt: now,
    updatedAt: now,
    assets: {},
    clips: [],
    canvas: cloneValue(options.canvas ?? DEFAULT_CANVAS_STYLE),
    export: cloneValue(options.export ?? DEFAULT_EXPORT_SETTINGS),
  };
}

export interface CreateClipOptions {
  id?: ClipId;
  name?: string;
  sourceInUs?: TimeUs;
  sourceOutUs?: TimeUs;
  speed?: number;
  audioMode?: SpeedAudioMode;
  gainDb?: number;
}

export function createClipForVideoAsset(
  asset: VideoAsset,
  options: CreateClipOptions = {},
): TimelineClip {
  const clip: TimelineClip = {
    id: options.id ?? createLocalId("clip"),
    assetId: asset.id,
    name: options.name?.trim() || asset.name,
    sourceInUs: options.sourceInUs ?? 0,
    sourceOutUs: options.sourceOutUs ?? asset.durationUs,
    speed: options.speed ?? 1,
    audio: {
      mode: options.audioMode ?? "preserve-pitch",
      gainDb: options.gainDb ?? 0,
    },
  };

  validateClip(clip, asset, "clip");
  return clip;
}

export function cloneProject(project: EditorProject): EditorProject {
  return cloneValue(project);
}

export function serializeProject(project: EditorProject): string {
  validateProject(project);
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function parseProject(json: string): EditorProject {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new ProjectValidationError("project", `invalid JSON: ${errorMessage(error)}`);
  }
  validateProject(value);
  return value;
}

export class ProjectValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProjectValidationError";
    this.path = path;
  }
}

export function validateProject(value: unknown): asserts value is EditorProject {
  expectRecord(value, "project");
  expect(value.magic === PROJECT_MAGIC, "project.magic", `must equal ${PROJECT_MAGIC}`);
  expect(
    value.schemaVersion === PROJECT_SCHEMA_VERSION,
    "project.schemaVersion",
    `unsupported version ${String(value.schemaVersion)}`,
  );
  expectIdentifier(value.id, "project.id");
  expectNonEmptyString(value.title, "project.title");
  expectIsoDate(value.createdAt, "project.createdAt");
  expectIsoDate(value.updatedAt, "project.updatedAt");

  expectRecord(value.assets, "project.assets");
  const assets = value.assets as Record<string, unknown>;
  for (const [key, assetValue] of Object.entries(assets)) {
    validateAsset(assetValue, `project.assets.${key}`);
    expect(assetValue.id === key, `project.assets.${key}.id`, "must match its record key");
  }

  expect(Array.isArray(value.clips), "project.clips", "must be an array");
  expect(
    value.clips.length <= MAX_PROJECT_CLIPS,
    "project.clips",
    `must contain at most ${MAX_PROJECT_CLIPS} clips`,
  );
  const clipIds = new Set<string>();
  for (let index = 0; index < value.clips.length; index += 1) {
    const clipValue: unknown = value.clips[index];
    expectRecord(clipValue, `project.clips.${index}`);
    expectNonEmptyString(clipValue.assetId, `project.clips.${index}.assetId`);
    const asset = assets[clipValue.assetId];
    expect(asset !== undefined, `project.clips.${index}.assetId`, "references a missing asset");
    expectRecord(asset, `project.assets.${clipValue.assetId}`);
    expect(asset.kind === "video", `project.clips.${index}.assetId`, "must reference a video asset");
    validateClip(
      clipValue,
      asset as unknown as VideoAsset,
      `project.clips.${index}`,
    );
    expect(!clipIds.has(clipValue.id), `project.clips.${index}.id`, "must be unique");
    clipIds.add(clipValue.id);
  }

  if (value.zoom !== undefined) {
    expectRecord(value.zoom, "project.zoom");
    expect(Array.isArray(value.zoom.segments), "project.zoom.segments", "must be an array");
    validateZoomSegments(
      value.zoom.segments as ZoomSegment[],
      timelineDurationUs(value.clips as TimelineClip[]),
    );
  }

  if (value.overlays !== undefined) {
    try {
      validateOverlayDocument(value.overlays);
    } catch (error) {
      if (error instanceof OverlayValidationError) {
        throw new ProjectValidationError(
          `project.${error.path}`,
          error.message.slice(error.path.length + 2),
        );
      }
      throw error;
    }
  }

  if (value.audio !== undefined) {
    try {
      validateSavedProjectAudio(value.audio);
    } catch (error) {
      if (error instanceof AudioTimelineValidationError) {
        const nestedPath = error.path.replace(/^audioTimeline/u, "project.audio");
        throw new ProjectValidationError(
          nestedPath,
          error.message.slice(error.path.length + 2),
        );
      }
      throw error;
    }
    expect(
      value.audio.durationUs === timelineDurationUs(value.clips as TimelineClip[]),
      "project.audio.durationUs",
      "must match the video timeline duration",
    );
  }

  validateCanvas(value.canvas, "project.canvas", assets);
  validateExportSettings(value.export, "project.export");
}

export function frameDurationUs(asset: VideoAsset): TimeUs {
  const { numerator, denominator } = asset.frameRate;
  if (numerator <= 0 || denominator <= 0) return 33_333;
  return Math.max(1, Math.round((1_000_000 * denominator) / numerator));
}

function validateAsset(value: unknown, path: string): asserts value is MediaAsset {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectNonEmptyString(value.name, `${path}.name`);
  validateLocator(value.locator, `${path}.locator`);
  if (value.signature !== undefined) {
    expectRecord(value.signature, `${path}.signature`);
    expectSafeInteger(value.signature.byteLength, `${path}.signature.byteLength`, 0);
    expectFiniteNumber(value.signature.modifiedMs, `${path}.signature.modifiedMs`, 0);
  }
  expectPositiveInteger(value.width, `${path}.width`);
  expectPositiveInteger(value.height, `${path}.height`);

  if (value.kind === "video") {
    expectSafeInteger(value.durationUs, `${path}.durationUs`, 1);
    expectRecord(value.frameRate, `${path}.frameRate`);
    expectPositiveInteger(value.frameRate.numerator, `${path}.frameRate.numerator`);
    expectPositiveInteger(value.frameRate.denominator, `${path}.frameRate.denominator`);
    if (value.audio !== undefined) {
      expectRecord(value.audio, `${path}.audio`);
      expectPositiveInteger(value.audio.sampleRate, `${path}.audio.sampleRate`);
      expectPositiveInteger(value.audio.channels, `${path}.audio.channels`);
    }
    return;
  }

  expect(value.kind === "image", `${path}.kind`, "must be video or image");
}

function validateClip(value: unknown, asset: VideoAsset, path: string): asserts value is TimelineClip {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectIdentifier(value.assetId, `${path}.assetId`);
  expectNonEmptyString(value.name, `${path}.name`);
  expectSafeInteger(value.sourceInUs, `${path}.sourceInUs`, 0);
  expectSafeInteger(value.sourceOutUs, `${path}.sourceOutUs`, 1);
  expect(value.sourceInUs < value.sourceOutUs, path, "source range must have positive duration");
  expect(value.sourceOutUs <= asset.durationUs, `${path}.sourceOutUs`, "exceeds source duration");
  expectFiniteNumber(value.speed, `${path}.speed`, 0.25, 8);
  expectRecord(value.audio, `${path}.audio`);
  expect(
    value.audio.mode === "preserve-pitch" ||
      value.audio.mode === "change-pitch" ||
      value.audio.mode === "mute",
    `${path}.audio.mode`,
    "is invalid",
  );
  expectFiniteNumber(value.audio.gainDb, `${path}.audio.gainDb`, -60, 12);
}

function validateCanvas(
  value: unknown,
  path: string,
  assets: Readonly<Record<string, unknown>>,
): asserts value is CanvasStyle {
  expectRecord(value, path);
  expect(
    value.preset === "auto" ||
      value.preset === "wide" ||
      value.preset === "vertical" ||
      value.preset === "square" ||
      value.preset === "classic" ||
      value.preset === "tall" ||
      value.preset === "custom",
    `${path}.preset`,
    "is invalid",
  );
  expectPositiveInteger(value.width, `${path}.width`);
  expectPositiveInteger(value.height, `${path}.height`);
  expect(value.width % 2 === 0, `${path}.width`, "must be even for video export");
  expect(value.height % 2 === 0, `${path}.height`, "must be even for video export");
  validateBackground(value.background, `${path}.background`, assets);
  expectRecord(value.screen, `${path}.screen`);
  validateRect(value.screen.crop, `${path}.screen.crop`);
  expectFiniteNumber(value.screen.padding, `${path}.screen.padding`, 0, 0.45);
  expectFiniteNumber(value.screen.scale, `${path}.screen.scale`, 0.1, 3);
  expectRecord(value.screen.position, `${path}.screen.position`);
  expectFiniteNumber(value.screen.position.x, `${path}.screen.position.x`, 0, 1);
  expectFiniteNumber(value.screen.position.y, `${path}.screen.position.y`, 0, 1);
  expectFiniteNumber(value.screen.cornerRadius, `${path}.screen.cornerRadius`, 0, 0.5);
  expectRecord(value.screen.border, `${path}.screen.border`);
  expectFiniteNumber(value.screen.border.widthPx, `${path}.screen.border.widthPx`, 0, 128);
  expectColor(value.screen.border.color, `${path}.screen.border.color`);
  expectFiniteNumber(value.screen.border.opacity, `${path}.screen.border.opacity`, 0, 1);
  expectRecord(value.screen.shadow, `${path}.screen.shadow`);
  expectFiniteNumber(value.screen.shadow.offsetX, `${path}.screen.shadow.offsetX`, -4096, 4096);
  expectFiniteNumber(value.screen.shadow.offsetY, `${path}.screen.shadow.offsetY`, -4096, 4096);
  expectFiniteNumber(value.screen.shadow.blurPx, `${path}.screen.shadow.blurPx`, 0, 512);
  expectFiniteNumber(value.screen.shadow.opacity, `${path}.screen.shadow.opacity`, 0, 1);
  validateFrame(value.screen.frame, `${path}.screen.frame`);
}

function validateBackground(
  value: unknown,
  path: string,
  assets: Readonly<Record<string, unknown>>,
): asserts value is BackgroundStyle {
  expectRecord(value, path);
  if (value.kind === "solid") {
    expectColor(value.color, `${path}.color`);
    return;
  }
  if (value.kind === "gradient") {
    expectFiniteNumber(value.angleDeg, `${path}.angleDeg`, -3600, 3600);
    expect(Array.isArray(value.stops) && value.stops.length >= 2, `${path}.stops`, "needs at least two stops");
    let previous = -1;
    value.stops.forEach((stopValue: unknown, index: number) => {
      expectRecord(stopValue, `${path}.stops.${index}`);
      expectFiniteNumber(stopValue.offset, `${path}.stops.${index}.offset`, 0, 1);
      expect(stopValue.offset >= previous, `${path}.stops.${index}.offset`, "must be sorted");
      expectColor(stopValue.color, `${path}.stops.${index}.color`);
      previous = stopValue.offset;
    });
    return;
  }
  expect(value.kind === "image", `${path}.kind`, "is invalid");
  expectIdentifier(value.assetId, `${path}.assetId`);
  const asset = assets[value.assetId];
  expect(asset !== undefined, `${path}.assetId`, "references a missing asset");
  expectRecord(asset, `${path}.assetId`);
  expect(asset.kind === "image", `${path}.assetId`, "must reference an image asset");
  expect(value.fit === "cover" || value.fit === "contain", `${path}.fit`, "is invalid");
  expectFiniteNumber(value.blurPx, `${path}.blurPx`, 0, 512);
  expectFiniteNumber(value.opacity, `${path}.opacity`, 0, 1);
}

function validateRect(value: unknown, path: string): asserts value is NormalizedRect {
  expectRecord(value, path);
  expectFiniteNumber(value.x, `${path}.x`, 0, 1);
  expectFiniteNumber(value.y, `${path}.y`, 0, 1);
  expectFiniteNumber(value.width, `${path}.width`, Number.EPSILON, 1);
  expectFiniteNumber(value.height, `${path}.height`, Number.EPSILON, 1);
  expect(value.x + value.width <= 1 + 1e-9, path, "extends beyond the source width");
  expect(value.y + value.height <= 1 + 1e-9, path, "extends beyond the source height");
}

function validateFrame(value: unknown, path: string): asserts value is FrameStyle {
  expectRecord(value, path);
  if (value.kind === "browser") {
    expect(typeof value.title === "string", `${path}.title`, "must be a string");
    expect(typeof value.url === "string", `${path}.url`, "must be a string");
    return;
  }
  expect(
    value.kind === "none" ||
      value.kind === "macos" ||
      value.kind === "windows" ||
      value.kind === "macbook",
    `${path}.kind`,
    "is invalid",
  );
}

function validateExportSettings(value: unknown, path: string): asserts value is ExportSettings {
  expectRecord(value, path);
  expect(value.format === "mp4" || value.format === "gif", `${path}.format`, "is invalid");
  expect(value.fps === 15 || value.fps === 30 || value.fps === 60, `${path}.fps`, "is invalid");
  expect(
    value.quality === "small" ||
      value.quality === "balanced" ||
      value.quality === "high" ||
      value.quality === "lossless-ish",
    `${path}.quality`,
    "is invalid",
  );
}

function timelineDurationUs(clips: readonly TimelineClip[]): TimeUs {
  return clips.reduce(
    (duration, clip) =>
      duration + Math.max(1, Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed)),
    0,
  );
}

function validateLocator(value: unknown, path: string): asserts value is AssetLocator {
  expectRecord(value, path);
  if (value.kind === "managed") {
    expectNonEmptyString(value.relativePath, `${path}.relativePath`);
    expect(!isAbsoluteLike(value.relativePath), `${path}.relativePath`, "must remain relative");
    const segments = value.relativePath.replace(/\\/g, "/").split("/");
    expect(!segments.includes(".."), `${path}.relativePath`, "must not escape the project");
    return;
  }
  if (value.kind === "external") {
    expectNonEmptyString(value.absolutePath, `${path}.absolutePath`);
    expect(isAbsoluteLike(value.absolutePath), `${path}.absolutePath`, "must be absolute");
    return;
  }
  expect(value.kind === "bundled", `${path}.kind`, "is invalid");
  expectNonEmptyString(value.key, `${path}.key`);
  expect(!isAbsoluteLike(value.key), `${path}.key`, "must remain relative");
  expect(!value.key.includes(".."), `${path}.key`, "must not contain traversal");
}

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isAbsoluteLike(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.startsWith("\\");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expectRecord(value: unknown, path: string): asserts value is Record<string, any> {
  expect(typeof value === "object" && value !== null && !Array.isArray(value), path, "must be an object");
}

function expectNonEmptyString(value: unknown, path: string): asserts value is string {
  expect(typeof value === "string" && value.trim().length > 0, path, "must be a non-empty string");
}

function expectIdentifier(value: unknown, path: string): asserts value is string {
  expect(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    path,
    "must be a safe identifier",
  );
}

function expectIsoDate(value: unknown, path: string): asserts value is string {
  expectNonEmptyString(value, path);
  expect(Number.isFinite(Date.parse(value)), path, "must be an ISO date string");
}

function expectColor(value: unknown, path: string): asserts value is string {
  expect(
    typeof value === "string" && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value),
    path,
    "must be #RRGGBB or #RRGGBBAA",
  );
}

function expectPositiveInteger(value: unknown, path: string): asserts value is number {
  expectSafeInteger(value, path, 1);
}

function expectSafeInteger(value: unknown, path: string, minimum: number): asserts value is number {
  expect(Number.isSafeInteger(value) && (value as number) >= minimum, path, `must be an integer >= ${minimum}`);
}

function expectFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): asserts value is number {
  expect(
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum,
    path,
    `must be between ${minimum} and ${maximum}`,
  );
}

function expect(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new ProjectValidationError(path, message);
}
