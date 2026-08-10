import type {
  AppRoute as NativeRoute,
  MediaItem,
  MediaProbe,
  ShortcutBinding,
  Workflow as NativeWorkflow,
  WorkflowStore,
} from "../shared/api";
import {
  createClipForVideoAsset,
  createDefaultProject,
  DEFAULT_CANVAS_STYLE,
  validateProject,
  cloneProject,
  type ImageAsset,
  type CanvasStyle,
  type EditorProject as CanonicalEditorProject,
  type VideoAsset,
} from "../shared/project";
import {
  computeFitModeCrop,
  computeScreenLayout,
  editorOffsetFromScreenPosition,
  screenPositionFromEditorOffset,
} from "../shared/export-plan";
import type {
  AppRoute,
  CaptureItem,
  EditorProject as RendererEditorProject,
  Workflow,
} from "./types";
import { WALLPAPERS } from "./data";
import { backgroundPresetIdForStyle, backgroundStyleForPreset } from "./background-gallery";
import { canonicalizeOverlayDocument, createEmptyOverlayDocument } from "../shared/overlays";
import { reconcileAudioTimeline } from "./audio-editor";

const CAPTURE_ACCENTS = ["#9eb6ff", "#8fd8c5", "#e7b987", "#bca8ff"] as const;
const CLIP_ACCENTS = ["#7897e8", "#8b8fe8", "#9b82d8", "#75b3c7"] as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CreateCanonicalVideoProjectOptions {
  projectId?: string;
  clipId?: string;
  title?: string;
  now?: string;
}

/**
 * Creates the persisted, export-ready project model for a library video.
 * Media ids intentionally remain asset ids: StorageService uses that identity
 * to resolve the managed source without exposing a file path to the renderer.
 */
export function createCanonicalProjectFromVideo(
  media: MediaItem,
  probe: MediaProbe,
  options: CreateCanonicalVideoProjectOptions = {},
): CanonicalEditorProject {
  if (media.kind !== "video") {
    throw new TypeError("A Studio project can only be created from a video media item.");
  }
  assertSafeIdentifier(media.id, "media.id");
  if (probe.mediaId !== media.id) {
    throw new TypeError("The media probe does not belong to the selected media item.");
  }
  if (probe.video === undefined) {
    throw new TypeError("The selected media does not contain a video stream.");
  }

  const durationUs = positiveSafeInteger(
    probe.video.durationUs ?? probe.durationUs,
    "video duration",
  );
  const encodedWidth = positiveSafeInteger(probe.video.width, "video width");
  const encodedHeight = positiveSafeInteger(probe.video.height, "video height");
  const quarterTurn = isQuarterTurn(probe.video.rotationDegrees);
  const width = quarterTurn ? encodedHeight : encodedWidth;
  const height = quarterTurn ? encodedWidth : encodedHeight;
  const assetId = media.id;
  const projectId = options.projectId ?? deriveIdentifier("project", media.id);
  const clipId = options.clipId ?? deriveIdentifier("clip", media.id);
  assertSafeIdentifier(projectId, "projectId");
  assertSafeIdentifier(clipId, "clipId");

  const signatureModifiedMs = Date.parse(media.modifiedAt);
  const hasSignature = Number.isSafeInteger(media.byteLength)
    && media.byteLength >= 0
    && Number.isFinite(signatureModifiedMs)
    && signatureModifiedMs >= 0;
  const videoAsset: VideoAsset = {
    id: assetId,
    kind: "video",
    name: media.name.trim() || "Recording",
    locator: { kind: "managed", relativePath: `library/${assetId}` },
    ...(hasSignature ? {
      signature: { byteLength: media.byteLength, modifiedMs: signatureModifiedMs },
    } : {}),
    durationUs,
    width,
    height,
    frameRate: frameRateToRational(probe.video.frameRate),
    ...(probe.video.codec.trim() === "" ? {} : { videoCodec: probe.video.codec }),
    ...(validAudioProbe(probe.audio) ? {
      audio: {
        ...(probe.audio.codec.trim() === "" ? {} : { codec: probe.audio.codec }),
        sampleRate: Math.round(probe.audio.sampleRate),
        channels: Math.round(probe.audio.channels),
      },
    } : {}),
  };

  const project = createDefaultProject({
    id: projectId,
    title: options.title?.trim() || removeExtension(media.name) || "Untitled recording",
    ...(options.now === undefined ? {} : { now: options.now }),
    canvas: canvasForSource(width, height),
  });
  project.assets[assetId] = videoAsset;
  project.clips = [createClipForVideoAsset(videoAsset, { id: clipId })];
  validateProject(project);
  return project;
}

/**
 * Lossily projects the canonical document into the renderer's presentational
 * model. The canonical project remains the source of truth for save/export.
 */
export function canonicalProjectToRenderer(project: CanonicalEditorProject): RendererEditorProject {
  validateProject(project);
  const videoAssets = Object.values(project.assets).filter(
    (asset): asset is VideoAsset => asset.kind === "video",
  );
  const sourceDuration = videoAssets.reduce(
    (maximum, asset) => Math.max(maximum, asset.durationUs / 1_000_000),
    0,
  );
  const shortestCanvasEdge = Math.min(project.canvas.width, project.canvas.height);
  const sourceAsset = project.clips
    .map((clip) => project.assets[clip.assetId])
    .find((asset): asset is VideoAsset => asset?.kind === "video") ?? videoAssets[0];
  const editorOffset = sourceAsset === undefined
    ? { x: 0, y: 0 }
    : editorOffsetFromScreenPosition(project, sourceAsset);
  const sourceLayout = sourceAsset === undefined ? undefined : computeScreenLayout(project, sourceAsset);

  return {
    name: project.title,
    sourceDuration,
    sourceAspect: sourceAsset === undefined ? 16 / 9 : sourceAsset.width / sourceAsset.height,
    ...(sourceAsset === undefined ? {} : { sourceWidth: sourceAsset.width, sourceHeight: sourceAsset.height }),
    canvasWidth: project.canvas.width,
    canvasHeight: project.canvas.height,
    borderWidthPx: project.canvas.screen.border.widthPx,
    borderColor: project.canvas.screen.border.color,
    borderOpacity: project.canvas.screen.border.opacity,
    shadowOffsetX: project.canvas.screen.shadow.offsetX,
    shadowOffsetY: project.canvas.screen.shadow.offsetY,
    shadowBlurPx: project.canvas.screen.shadow.blurPx,
    clips: project.clips.map((clip, index) => ({
      id: clip.id,
      sourceClipId: clip.id,
      name: clip.name,
      sourceStart: clip.sourceInUs / 1_000_000,
      sourceEnd: clip.sourceOutUs / 1_000_000,
      speed: clip.speed,
      color: CLIP_ACCENTS[index % CLIP_ACCENTS.length] ?? CLIP_ACCENTS[0],
      sourceAudio: { ...clip.audio },
    })),
    zoomSegments: (project.zoom?.segments ?? []).map((segment) => ({
      ...segment,
      focus: { ...segment.focus },
    })),
    overlays: canonicalizeOverlayDocument(project.overlays ?? createEmptyOverlayDocument()),
    ...(project.audio === undefined ? {} : { audio: structuredClone(project.audio) }),
    backgroundId: rendererBackground(project),
    aspectRatio: nearestRendererAspect(project.canvas.width / project.canvas.height),
    padding: clamp(Math.round(project.canvas.screen.padding * shortestCanvasEdge), 0, 96),
    cornerRadius: clamp(sourceLayout?.cornerRadiusPx ?? Math.round(project.canvas.screen.cornerRadius * shortestCanvasEdge), 0, 36),
    shadow: clamp(Math.round(project.canvas.screen.shadow.opacity * 100), 0, 100),
    fitMode: isFullCrop(project.canvas.screen.crop) ? "fit" : "fill",
    crop: { ...project.canvas.screen.crop },
    scale: clamp(Math.round(project.canvas.screen.scale * 100), 50, 200),
    offsetX: clamp(Math.round(editorOffset.x), -100, 100),
    offsetY: clamp(Math.round(editorOffset.y), -100, 100),
    cursorScale: 1,
    hideCursorIdle: true,
    clickEmphasis: true,
    systemVolume: rendererVolume(project),
    microphoneVolume: 0,
  };
}

/**
 * Applies the current visual editor controls back onto the validated project
 * document used by autosave and export. This is deliberately the only lossy
 * seam between the presentation model and the canonical domain model.
 */
export function rendererProjectToCanonical(
  renderer: RendererEditorProject,
  base: CanonicalEditorProject,
  library: readonly MediaItem[] = [],
): CanonicalEditorProject {
  const project = cloneProject(base);
  const fallbackClip = base.clips[0];
  const fallbackAsset = fallbackClip === undefined ? undefined : base.assets[fallbackClip.assetId];
  if (fallbackAsset?.kind !== "video") {
    throw new TypeError("The Studio project no longer has a video source.");
  }
  const baseRenderer = canonicalProjectToRenderer(base);

  project.title = renderer.name.trim() || base.title;
  project.clips = renderer.clips.map((clip) => {
    const original = base.clips.find((candidate) => candidate.id === clip.sourceClipId)
      ?? base.clips.find((candidate) => candidate.id === clip.id)
      ?? fallbackClip;
    const asset = original === undefined ? undefined : base.assets[original.assetId];
    if (original === undefined || asset?.kind !== "video") {
      throw new TypeError(`Clip ${clip.id} has no managed video source.`);
    }
    const originalRenderer = baseRenderer.clips.find((candidate) => candidate.id === original.id);
    const sourceInUs = originalRenderer !== undefined && clip.sourceStart === originalRenderer.sourceStart
      ? original.sourceInUs
      : clamp(Math.round(clip.sourceStart * 1_000_000), 0, asset.durationUs - 1);
    const sourceOutUs = originalRenderer !== undefined && clip.sourceEnd === originalRenderer.sourceEnd
      ? original.sourceOutUs
      : clamp(Math.round(clip.sourceEnd * 1_000_000), sourceInUs + 1, asset.durationUs);
    const audioChanged = renderer.systemVolume !== baseRenderer.systemVolume;
    const gainDb = audioChanged && renderer.systemVolume > 0
      ? clamp(20 * Math.log10(renderer.systemVolume / 100), -96, 24)
      : original.audio.gainDb;
    return {
      ...original,
      id: boundedIdentifier(clip.id, "clip"),
      name: originalRenderer !== undefined && clip.name === originalRenderer.name ? original.name : clip.name.trim() || original.name,
      sourceInUs,
      sourceOutUs,
      speed: originalRenderer !== undefined && clip.speed === originalRenderer.speed ? original.speed : clamp(clip.speed, 0.25, 8),
      audio: audioChanged ? {
        mode: renderer.systemVolume <= 0 ? "mute" as const : original.audio.mode === "mute" ? "preserve-pitch" as const : original.audio.mode,
        gainDb,
      } : { ...original.audio },
    };
  });
  project.zoom = renderer.zoomSegments.length === 0
    ? undefined
    : {
        segments: renderer.zoomSegments.map((segment) => ({
          ...segment,
          focus: { ...segment.focus },
        })),
      };
  const overlays = canonicalizeOverlayDocument(renderer.overlays);
  if (base.overlays !== undefined || overlays.captions.length > 0 || overlays.overlays.length > 0) {
    project.overlays = overlays;
  } else {
    delete project.overlays;
  }
  if (renderer.audio === undefined) {
    delete project.audio;
  } else {
    const durationUs = project.clips.reduce(
      (total, clip) => total + Math.max(1, Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed)),
      0,
    );
    project.audio = reconcileAudioTimeline(renderer.audio, durationUs);
  }

  const baseRendererAspect = nearestRendererAspect(base.canvas.width / base.canvas.height);
  const preservesBaseAspect = renderer.aspectRatio === baseRendererAspect;
  const dimensions = preservesBaseAspect
    ? { width: base.canvas.width, height: base.canvas.height }
    : rendererCanvasDimensions(renderer.aspectRatio);
  const shortestEdge = Math.min(dimensions.width, dimensions.height);
  const paddingChanged = renderer.padding !== baseRenderer.padding;
  const padding = paddingChanged ? renderer.padding / shortestEdge : base.canvas.screen.padding;
  const baseFitMode = isFullCrop(base.canvas.screen.crop) ? "fit" : "fill";
  const fitGeometryChanged = renderer.fitMode !== baseFitMode
    || renderer.aspectRatio !== baseRenderer.aspectRatio
    || paddingChanged;
  const explicitCrop = renderer.crop;
  const crop = explicitCrop === undefined
    ? computeFitModeCrop(renderer.fitMode, fallbackAsset, dimensions, padding)
    : sameNormalizedRect(explicitCrop, base.canvas.screen.crop)
      ? { ...base.canvas.screen.crop }
      : { ...explicitCrop };
  const screenGeometryChanged = fitGeometryChanged
    || !sameNormalizedRect(crop, base.canvas.screen.crop);
  project.canvas = {
    ...project.canvas,
    ...dimensions,
    preset: preservesBaseAspect ? base.canvas.preset : rendererAspectPreset(renderer.aspectRatio),
    screen: {
      ...project.canvas.screen,
      crop,
      padding,
      scale: renderer.scale === baseRenderer.scale ? base.canvas.screen.scale : renderer.scale / 100,
      position: { ...base.canvas.screen.position },
      cornerRadius: base.canvas.screen.cornerRadius,
      shadow: {
        ...project.canvas.screen.shadow,
        opacity: renderer.shadow === baseRenderer.shadow ? base.canvas.screen.shadow.opacity : renderer.shadow / 100,
      },
    },
  };
  const positionChanged = renderer.offsetX !== baseRenderer.offsetX
    || renderer.offsetY !== baseRenderer.offsetY
    || screenGeometryChanged;
  if (positionChanged) {
    project.canvas.screen.position = screenPositionFromEditorOffset(
      { x: renderer.offsetX, y: renderer.offsetY },
      project,
      fallbackAsset,
    );
  }
  if (renderer.cornerRadius !== baseRenderer.cornerRadius
    || screenGeometryChanged
    || renderer.scale !== baseRenderer.scale) {
    const layout = computeScreenLayout(project, fallbackAsset);
    project.canvas.screen.cornerRadius = renderer.cornerRadius /
      Math.min(layout.screenRectPx.width, layout.screenRectPx.height);
  }

  if (renderer.backgroundId !== baseRenderer.backgroundId) {
    applyRendererBackground(project, renderer.backgroundId, library);
  }
  validateProject(project);
  return project;
}

export function workflowStoreToRenderer(
  store: WorkflowStore,
  options: { quickVideoAudioMux?: boolean } = {},
): Workflow[] {
  return store.workflows.map((workflow) => nativeWorkflowToRenderer(workflow, store.shortcutBindings, options));
}

export function nativeWorkflowToRenderer(
  workflow: NativeWorkflow,
  bindings: readonly ShortcutBinding[],
  options: { quickVideoAudioMux?: boolean } = {},
): Workflow {
  const shortcuts = bindings
    .filter((binding) =>
      binding.action.type === "workflow.run" && binding.action.workflowId === workflow.id,
    )
    .map((binding) => binding.accelerator.split("+").filter(Boolean));

  const after: Workflow["after"] = ["Save to Library"];
  const hasSeparateAudioStems = workflow.kind === "video" && Boolean(workflow.video?.systemAudio || workflow.video?.microphoneDeviceId);
  const canMuxQuickAudio = options.quickVideoAudioMux === true && workflow.finish.afterCapture !== "open-editor";
  if (workflow.finish.clipboard !== "none" && (!hasSeparateAudioStems || canMuxQuickAudio)) after.push("Copy");
  if (workflow.kind === "video" && workflow.finish.afterCapture === "open-editor") after.push("Open Editor");

  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.kind === "screenshot"
      ? "Capture a clean, pixel-exact image"
      : workflow.finish.afterCapture === "open-editor"
        ? "Record directly into a Studio project"
        : "Record, copy, and keep moving",
    kind: workflow.kind,
    // The current native helper supports area capture only. Older aspirational
    // window/display values are normalized so the UI matches what will run.
    target: "Region",
    shortcuts,
    enabled: workflow.enabled,
    ...(workflow.video === undefined ? {} : {
      fps: workflow.video.fps,
      quality: workflow.video.quality === "maximum"
        ? "Maximum" as const
        : workflow.video.quality === "balanced"
          ? "Balanced" as const
          : "High" as const,
    }),
    cursor: workflow.capture.cursor !== "hidden",
    systemAudio: workflow.video?.systemAudio ?? false,
    microphone: workflow.video?.microphoneDeviceId !== undefined,
    countdown: normalizeCountdown(workflow.capture.countdownMs),
    after,
  };
}

export function mediaItemsToCaptures(items: readonly MediaItem[]): CaptureItem[] {
  return items
    .filter((item) => item.kind === "image" || item.kind === "video")
    .map((item, index) => mediaItemToCapture(item, index));
}

export function mediaItemToCapture(item: MediaItem, index = 0): CaptureItem {
  const kind: CaptureItem["kind"] = item.kind === "video" ? "video" : "screenshot";
  return {
    id: item.id,
    name: removeExtension(item.name),
    kind,
    createdLabel: formatCreatedAt(item.createdAt),
    dimensions: "Original resolution",
    size: formatBytes(item.byteLength),
    workflow: item.origin === "recording" ? "Video workflow" : item.origin === "capture" ? "Screenshot workflow" : "Imported",
    thumbnail: item.url,
    accent: CAPTURE_ACCENTS[index % CAPTURE_ACCENTS.length] ?? CAPTURE_ACCENTS[0],
  };
}

export function nativeRouteToRenderer(route: NativeRoute): { route: AppRoute; mediaId?: string } {
  if (route.startsWith("editor/")) return { route: "editor", mediaId: route.slice("editor/".length) };
  return { route: route as Exclude<AppRoute, "editor"> };
}

export function formatBytes(value: number): string {
  const bytes = Math.max(0, value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let amount = bytes / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unitIndex]}`;
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normalizeCountdown(value: number): Workflow["countdown"] {
  if (value >= 1_000) return 3;
  return 0;
}

function removeExtension(value: string): string {
  return value.replace(/\.[A-Za-z0-9]{1,8}$/, "") || value;
}

function canvasForSource(width: number, height: number): CanvasStyle {
  const sourceRatio = width / height;
  const candidates: ReadonlyArray<Pick<CanvasStyle, "preset" | "width" | "height">> = [
    { preset: "wide", width: 1_920, height: 1_080 },
    { preset: "custom", width: 1_920, height: 1_200 },
    { preset: "classic", width: 1_440, height: 1_080 },
    { preset: "square", width: 1_080, height: 1_080 },
    { preset: "tall", width: 1_080, height: 1_350 },
    { preset: "vertical", width: 1_080, height: 1_920 },
  ];
  const closest = candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(Math.log(sourceRatio / (best.width / best.height)));
    const candidateDistance = Math.abs(Math.log(sourceRatio / (candidate.width / candidate.height)));
    return candidateDistance < bestDistance ? candidate : best;
  });

  return {
    ...DEFAULT_CANVAS_STYLE,
    ...closest,
    background: { ...DEFAULT_CANVAS_STYLE.background },
    screen: {
      ...DEFAULT_CANVAS_STYLE.screen,
      crop: { ...DEFAULT_CANVAS_STYLE.screen.crop },
      position: { ...DEFAULT_CANVAS_STYLE.screen.position },
      border: { ...DEFAULT_CANVAS_STYLE.screen.border },
      shadow: { ...DEFAULT_CANVAS_STYLE.screen.shadow },
      frame: { ...DEFAULT_CANVAS_STYLE.screen.frame },
    },
  };
}

function frameRateToRational(value: number | undefined): VideoAsset["frameRate"] {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return { numerator: 60, denominator: 1 };
  }

  const broadcastRates = [
    { value: 24_000 / 1_001, numerator: 24_000 },
    { value: 30_000 / 1_001, numerator: 30_000 },
    { value: 60_000 / 1_001, numerator: 60_000 },
    { value: 120_000 / 1_001, numerator: 120_000 },
  ] as const;
  const broadcast = broadcastRates.find((candidate) => Math.abs(candidate.value - value) < 0.02);
  if (broadcast !== undefined) return { numerator: broadcast.numerator, denominator: 1_001 };

  const denominator = 1_000;
  const numerator = Math.max(1, Math.round(value * denominator));
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function rendererBackground(project: CanonicalEditorProject): string {
  const background = project.canvas.background;
  const presetId = backgroundPresetIdForStyle(background);
  if (presetId !== undefined) return presetId;
  if (background.kind === "solid") {
    return svgBackground(`<rect width="100%" height="100%" fill="${background.color}"/>`);
  }
  if (background.kind === "gradient") {
    const stops = background.stops
      .map((stop) => `<stop offset="${stop.offset * 100}%" stop-color="${stop.color}"/>`)
      .join("");
    return svgBackground(
      `<defs><linearGradient id="g" gradientTransform="rotate(${background.angleDeg} .5 .5)">${stops}</linearGradient></defs>`
      + '<rect width="100%" height="100%" fill="url(#g)"/>',
    );
  }

  const asset = project.assets[background.assetId];
  if (asset?.kind !== "image") return "cobalt";
  if (asset.locator.kind === "managed") {
    return `sharpshot-media://asset/${encodeURIComponent(asset.id)}`;
  }
  if (asset.locator.kind === "external" && SAFE_IDENTIFIER.test(asset.id)) {
    // Persisted projects intentionally replace registered managed locators with
    // external ones. Keep the absolute path outside the renderer trust boundary:
    // the media protocol resolves the validated library id in the main process.
    return `sharpshot-media://asset/${encodeURIComponent(asset.id)}`;
  }
  if (asset.locator.kind === "bundled") {
    const key = asset.locator.key.toLocaleLowerCase("en-US");
    return BUNDLED_RENDERER_BACKGROUNDS.find(([needle]) => key.includes(needle))?.[1] ?? "cobalt";
  }
  return "cobalt";
}

const RENDERER_BUNDLED_BACKGROUNDS = new Map(
  WALLPAPERS.map((wallpaper) => [wallpaper.id, {
    key: bundledBackgroundKey(wallpaper.source),
    width: wallpaper.width,
    height: wallpaper.height,
  }] as const),
);
const BUNDLED_RENDERER_BACKGROUNDS = [...RENDERER_BUNDLED_BACKGROUNDS]
  .map(([rendererId, bundled]) => [bundled.key.toLocaleLowerCase("en-US"), rendererId] as const);

function bundledBackgroundKey(source: string): string {
  try {
    const url = new URL(source);
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (url.protocol !== "sharpshot-media:" || url.hostname !== "background" || !SAFE_IDENTIFIER.test(key)) {
      throw new TypeError("Invalid bundled background source.");
    }
    return key;
  } catch {
    throw new TypeError("The wallpaper catalog contains an invalid bundled background source.");
  }
}

function applyRendererBackground(
  project: CanonicalEditorProject,
  backgroundId: string,
  library: readonly MediaItem[],
): void {
  const presetStyle = backgroundStyleForPreset(backgroundId);
  if (presetStyle !== undefined) {
    project.canvas.background = presetStyle;
    return;
  }
  const bundled = RENDERER_BUNDLED_BACKGROUNDS.get(backgroundId);
  if (bundled !== undefined) {
    const asset: ImageAsset = {
      id: bundled.key,
      kind: "image",
      name: bundled.key,
      locator: { kind: "bundled", key: bundled.key },
      width: bundled.width,
      height: bundled.height,
    };
    project.assets[asset.id] = asset;
    project.canvas.background = { kind: "image", assetId: asset.id, fit: "cover", blurPx: 0, opacity: 1 };
    return;
  }

  const managedId = mediaIdFromUrl(backgroundId);
  const media = managedId === undefined ? undefined : library.find((item) => item.id === managedId && item.kind === "image");
  if (media !== undefined) {
    const asset: ImageAsset = {
      id: media.id,
      kind: "image",
      name: media.name,
      locator: { kind: "managed", relativePath: `library/${media.id}` },
      width: 1_920,
      height: 1_080,
    };
    project.assets[asset.id] = asset;
    project.canvas.background = { kind: "image", assetId: asset.id, fit: "cover", blurPx: 0, opacity: 1 };
  }
}

function mediaIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "sharpshot-media:" || url.hostname !== "asset") return undefined;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return SAFE_IDENTIFIER.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function rendererCanvasDimensions(aspect: RendererEditorProject["aspectRatio"]): { width: number; height: number } {
  if (aspect === "9:16") return { width: 1_080, height: 1_920 };
  if (aspect === "4:5") return { width: 1_080, height: 1_350 };
  if (aspect === "16:10") return { width: 1_920, height: 1_200 };
  if (aspect === "4:3") return { width: 1_440, height: 1_080 };
  if (aspect === "1:1") return { width: 1_080, height: 1_080 };
  return { width: 1_920, height: 1_080 };
}

function rendererAspectPreset(aspect: RendererEditorProject["aspectRatio"]): CanvasStyle["preset"] {
  if (aspect === "9:16") return "vertical";
  if (aspect === "4:5") return "tall";
  if (aspect === "4:3") return "classic";
  if (aspect === "1:1") return "square";
  return aspect === "16:9" ? "wide" : "custom";
}

function boundedIdentifier(value: string, prefix: string): string {
  if (SAFE_IDENTIFIER.test(value)) return value;
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const candidate = sanitized.slice(0, 128);
  if (SAFE_IDENTIFIER.test(candidate)) return candidate;
  return `${prefix}-${Math.abs(hashString(value)).toString(36)}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash;
}

function svgBackground(content: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" preserveAspectRatio="none">${content}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function rendererVolume(project: CanonicalEditorProject): number {
  const audibleClips = project.clips.filter((clip) => clip.audio.mode !== "mute");
  if (audibleClips.length === 0) return 0;
  const averageGainDb = audibleClips.reduce((sum, clip) => sum + clip.audio.gainDb, 0)
    / audibleClips.length;
  return clamp(Math.round(100 * (10 ** (averageGainDb / 20))), 0, 100);
}

function nearestRendererAspect(ratio: number): RendererEditorProject["aspectRatio"] {
  const aspects: ReadonlyArray<readonly [RendererEditorProject["aspectRatio"], number]> = [
    ["16:9", 16 / 9],
    ["16:10", 16 / 10],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["4:5", 4 / 5],
    ["9:16", 9 / 16],
  ];
  return aspects.reduce((best, candidate) =>
    Math.abs(Math.log(ratio / candidate[1])) < Math.abs(Math.log(ratio / best[1]))
      ? candidate
      : best,
  )[0];
}

function validAudioProbe(value: MediaProbe["audio"]): value is NonNullable<MediaProbe["audio"]> & {
  sampleRate: number;
  channels: number;
} {
  return value !== undefined
    && Number.isFinite(value.sampleRate)
    && (value.sampleRate ?? 0) > 0
    && Number.isFinite(value.channels)
    && (value.channels ?? 0) > 0;
}

function isFullCrop(crop: CanonicalEditorProject["canvas"]["screen"]["crop"]): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

function sameNormalizedRect(
  left: CanonicalEditorProject["canvas"]["screen"]["crop"],
  right: CanonicalEditorProject["canvas"]["screen"]["crop"],
): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function isQuarterTurn(value: number): boolean {
  const normalized = ((Math.round(value) % 360) + 360) % 360;
  return normalized === 90 || normalized === 270;
}

function positiveSafeInteger(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`The ${name} is missing or invalid.`);
  }
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) {
    throw new TypeError(`The ${name} is outside the supported range.`);
  }
  return rounded;
}

function deriveIdentifier(prefix: string, source: string): string {
  const available = 128 - prefix.length - 1;
  return `${prefix}-${source.slice(0, available)}`;
}

function assertSafeIdentifier(value: string, name: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw new TypeError(`${name} is not a valid SharpShot identifier.`);
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return Math.max(1, a);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
