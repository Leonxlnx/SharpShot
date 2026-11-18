import type { NormalizedRect, TimeUs } from "./project.js";

export const OVERLAY_DOCUMENT_MAGIC = "sharpshot-overlays" as const;
export const OVERLAY_DOCUMENT_SCHEMA_VERSION = 1 as const;

export type TimedItemId = string;

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface CaptionStyle {
  fontFamily: string;
  /** Font size as a fraction of the output canvas height. */
  fontSizeRatio: number;
  fontWeight: 400 | 500 | 600 | 700 | 800 | 900;
  lineHeight: number;
  letterSpacingEm: number;
  color: string;
  backgroundColor: string;
  backgroundPaddingEm: number;
  backgroundRadiusPx: number;
  outlineColor: string;
  outlineWidthPx: number;
  shadowColor: string;
  shadowBlurPx: number;
  shadowOffset: { xPx: number; yPx: number };
  position: NormalizedPoint;
  maxWidth: number;
  align: "left" | "center" | "right";
  uppercase: boolean;
}

export interface CaptionStyleOverrides {
  fontFamily?: string;
  fontSizeRatio?: number;
  fontWeight?: CaptionStyle["fontWeight"];
  lineHeight?: number;
  letterSpacingEm?: number;
  color?: string;
  backgroundColor?: string;
  backgroundPaddingEm?: number;
  backgroundRadiusPx?: number;
  outlineColor?: string;
  outlineWidthPx?: number;
  shadowColor?: string;
  shadowBlurPx?: number;
  shadowOffset?: Partial<CaptionStyle["shadowOffset"]>;
  position?: Partial<NormalizedPoint>;
  maxWidth?: number;
  align?: CaptionStyle["align"];
  uppercase?: boolean;
}

/**
 * A deliberately small set of production-ready presets. They are complete style
 * values, so a renderer never has to guess at a missing default.
 */
export const CAPTION_STYLE_PRESETS = {
  clean: {
    fontFamily: "Segoe UI, Arial, sans-serif",
    fontSizeRatio: 0.052,
    fontWeight: 700,
    lineHeight: 1.12,
    letterSpacingEm: -0.025,
    color: "#FFFFFFFF",
    backgroundColor: "#00000000",
    backgroundPaddingEm: 0,
    backgroundRadiusPx: 0,
    outlineColor: "#000000B8",
    outlineWidthPx: 2,
    shadowColor: "#00000099",
    shadowBlurPx: 12,
    shadowOffset: { xPx: 0, yPx: 3 },
    position: { x: 0.5, y: 0.86 },
    maxWidth: 0.82,
    align: "center",
    uppercase: false,
  },
  boxed: {
    fontFamily: "Segoe UI, Arial, sans-serif",
    fontSizeRatio: 0.048,
    fontWeight: 700,
    lineHeight: 1.14,
    letterSpacingEm: -0.018,
    color: "#FFFFFFFF",
    backgroundColor: "#101114E8",
    backgroundPaddingEm: 0.32,
    backgroundRadiusPx: 14,
    outlineColor: "#00000000",
    outlineWidthPx: 0,
    shadowColor: "#00000070",
    shadowBlurPx: 18,
    shadowOffset: { xPx: 0, yPx: 6 },
    position: { x: 0.5, y: 0.86 },
    maxWidth: 0.8,
    align: "center",
    uppercase: false,
  },
  bold: {
    fontFamily: "Segoe UI, Arial, sans-serif",
    fontSizeRatio: 0.062,
    fontWeight: 900,
    lineHeight: 1.02,
    letterSpacingEm: -0.04,
    color: "#FFF36AFF",
    backgroundColor: "#00000000",
    backgroundPaddingEm: 0,
    backgroundRadiusPx: 0,
    outlineColor: "#111111FF",
    outlineWidthPx: 4,
    shadowColor: "#00000090",
    shadowBlurPx: 8,
    shadowOffset: { xPx: 0, yPx: 4 },
    position: { x: 0.5, y: 0.82 },
    maxWidth: 0.86,
    align: "center",
    uppercase: true,
  },
  "lower-third": {
    fontFamily: "Segoe UI, Arial, sans-serif",
    fontSizeRatio: 0.042,
    fontWeight: 600,
    lineHeight: 1.18,
    letterSpacingEm: -0.012,
    color: "#FFFFFFFF",
    backgroundColor: "#0D0E12E6",
    backgroundPaddingEm: 0.38,
    backgroundRadiusPx: 10,
    outlineColor: "#00000000",
    outlineWidthPx: 0,
    shadowColor: "#00000066",
    shadowBlurPx: 16,
    shadowOffset: { xPx: 0, yPx: 5 },
    position: { x: 0.08, y: 0.86 },
    maxWidth: 0.62,
    align: "left",
    uppercase: false,
  },
} as const satisfies Record<string, CaptionStyle>;

export type CaptionStylePresetId = keyof typeof CAPTION_STYLE_PRESETS;

export interface CaptionStyleReference {
  preset: CaptionStylePresetId;
  overrides?: CaptionStyleOverrides;
}

export interface TimedCaptionCue {
  id: TimedItemId;
  startUs: TimeUs;
  endUs: TimeUs;
  text: string;
  speaker?: string;
  style: CaptionStyleReference;
}

interface VisualOverlayBase {
  id: TimedItemId;
  startUs: TimeUs;
  endUs: TimeUs;
  opacity: number;
}

export interface ArrowOverlay extends VisualOverlayBase {
  kind: "arrow";
  from: NormalizedPoint;
  to: NormalizedPoint;
  color: string;
  strokeWidthPx: number;
  headLengthPx: number;
  lineStyle: "solid" | "dashed";
  animation: "none" | "draw";
}

export interface ShapeOverlay extends VisualOverlayBase {
  kind: "shape";
  shape: "rectangle" | "ellipse";
  area: NormalizedRect;
  fillColor: string;
  strokeColor: string;
  strokeWidthPx: number;
  cornerRadius: number;
  rotationDeg: number;
}

export interface SpotlightOverlay extends VisualOverlayBase {
  kind: "spotlight";
  shape: "rectangle" | "ellipse";
  area: NormalizedRect;
  dimColor: string;
  dimOpacity: number;
  featherPx: number;
}

export interface BlurMaskOverlay extends VisualOverlayBase {
  kind: "blur-mask";
  shape: "rectangle" | "ellipse";
  area: NormalizedRect;
  blurPx: number;
  featherPx: number;
}

export type VisualOverlay =
  | ArrowOverlay
  | ShapeOverlay
  | SpotlightOverlay
  | BlurMaskOverlay;

export interface OverlayDocument {
  magic: typeof OVERLAY_DOCUMENT_MAGIC;
  schemaVersion: typeof OVERLAY_DOCUMENT_SCHEMA_VERSION;
  captions: TimedCaptionCue[];
  overlays: VisualOverlay[];
}

export interface SubtitleImportOptions {
  /** Safe identifier prefix. Default: `srt` or `vtt`. */
  idPrefix?: string;
  /** Offset applied after parsing. It may be negative if no cue crosses time zero. */
  offsetUs?: TimeUs;
  style?: CaptionStyleReference;
}

export class OverlayValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "OverlayValidationError";
    this.path = path;
  }
}

export class SubtitleParseError extends Error {
  readonly format: "srt" | "vtt";
  readonly line: number;

  constructor(format: "srt" | "vtt", line: number, message: string) {
    super(`${format.toUpperCase()} line ${line}: ${message}`);
    this.name = "SubtitleParseError";
    this.format = format;
    this.line = line;
  }
}

export function createEmptyOverlayDocument(): OverlayDocument {
  return {
    magic: OVERLAY_DOCUMENT_MAGIC,
    schemaVersion: OVERLAY_DOCUMENT_SCHEMA_VERSION,
    captions: [],
    overlays: [],
  };
}

export function resolveCaptionStyle(reference: CaptionStyleReference): CaptionStyle {
  validateStyleReference(reference, "caption.style");
  const preset = CAPTION_STYLE_PRESETS[reference.preset];
  const overrides = reference.overrides;
  if (!overrides) return cloneValue(preset);

  const resolved: CaptionStyle = {
    ...cloneValue(preset),
    ...overrides,
    shadowOffset: { ...preset.shadowOffset, ...overrides.shadowOffset },
    position: { ...preset.position, ...overrides.position },
  };
  validateCaptionStyle(resolved, "caption.style.resolved");
  return resolved;
}

export function validateOverlayDocument(value: unknown): asserts value is OverlayDocument {
  expectRecord(value, "overlays");
  expectOnlyKeys(value, ["magic", "schemaVersion", "captions", "overlays"], "overlays");
  expect(
    value.magic === OVERLAY_DOCUMENT_MAGIC,
    "overlays.magic",
    `must equal ${OVERLAY_DOCUMENT_MAGIC}`,
  );
  expect(
    value.schemaVersion === OVERLAY_DOCUMENT_SCHEMA_VERSION,
    "overlays.schemaVersion",
    `unsupported version ${String(value.schemaVersion)}`,
  );
  expect(Array.isArray(value.captions), "overlays.captions", "must be an array");
  expect(Array.isArray(value.overlays), "overlays.overlays", "must be an array");

  const ids = new Set<string>();
  value.captions.forEach((cue: unknown, index: number) => {
    const path = `overlays.captions.${index}`;
    validateCaptionCue(cue, path);
    expect(!ids.has(cue.id), `${path}.id`, "must be unique across captions and overlays");
    ids.add(cue.id);
  });
  value.overlays.forEach((overlay: unknown, index: number) => {
    const path = `overlays.overlays.${index}`;
    validateVisualOverlay(overlay, path);
    expect(!ids.has(overlay.id), `${path}.id`, "must be unique across captions and overlays");
    ids.add(overlay.id);
  });
}

export function validateCaptionCue(value: unknown, path = "caption"): asserts value is TimedCaptionCue {
  expectRecord(value, path);
  expectOnlyKeys(value, ["id", "startUs", "endUs", "text", "speaker", "style"], path);
  validateTimedBase(value, path);
  expectText(value.text, `${path}.text`);
  if (value.speaker !== undefined) {
    expectNonEmptyString(value.speaker, `${path}.speaker`);
    expect(value.speaker.length <= 160, `${path}.speaker`, "must be at most 160 characters");
    expect(!/[\r\n\0]/u.test(value.speaker), `${path}.speaker`, "must stay on one line");
  }
  validateStyleReference(value.style, `${path}.style`);
}

export function validateVisualOverlay(value: unknown, path = "overlay"): asserts value is VisualOverlay {
  expectRecord(value, path);
  validateTimedBase(value, path);
  expectFiniteNumber(value.opacity, `${path}.opacity`, 0, 1);

  if (value.kind === "arrow") {
    expectOnlyKeys(
      value,
      [
        "kind",
        "id",
        "startUs",
        "endUs",
        "opacity",
        "from",
        "to",
        "color",
        "strokeWidthPx",
        "headLengthPx",
        "lineStyle",
        "animation",
      ],
      path,
    );
    validatePoint(value.from, `${path}.from`);
    validatePoint(value.to, `${path}.to`);
    const dx = value.to.x - value.from.x;
    const dy = value.to.y - value.from.y;
    expect(Math.hypot(dx, dy) > 1e-6, path, "arrow endpoints must differ");
    expectColor(value.color, `${path}.color`);
    expectFiniteNumber(value.strokeWidthPx, `${path}.strokeWidthPx`, 1, 128);
    expectFiniteNumber(value.headLengthPx, `${path}.headLengthPx`, 2, 256);
    expect(
      value.lineStyle === "solid" || value.lineStyle === "dashed",
      `${path}.lineStyle`,
      "must be solid or dashed",
    );
    expect(
      value.animation === "none" || value.animation === "draw",
      `${path}.animation`,
      "must be none or draw",
    );
    return;
  }

  if (value.kind === "shape") {
    expectOnlyKeys(
      value,
      [
        "kind",
        "id",
        "startUs",
        "endUs",
        "opacity",
        "shape",
        "area",
        "fillColor",
        "strokeColor",
        "strokeWidthPx",
        "cornerRadius",
        "rotationDeg",
      ],
      path,
    );
    validateOverlayShape(value.shape, `${path}.shape`);
    validateRect(value.area, `${path}.area`);
    expectColor(value.fillColor, `${path}.fillColor`);
    expectColor(value.strokeColor, `${path}.strokeColor`);
    expectFiniteNumber(value.strokeWidthPx, `${path}.strokeWidthPx`, 0, 128);
    expectFiniteNumber(value.cornerRadius, `${path}.cornerRadius`, 0, 0.5);
    expectFiniteNumber(value.rotationDeg, `${path}.rotationDeg`, -3600, 3600);
    return;
  }

  if (value.kind === "spotlight") {
    expectOnlyKeys(
      value,
      [
        "kind",
        "id",
        "startUs",
        "endUs",
        "opacity",
        "shape",
        "area",
        "dimColor",
        "dimOpacity",
        "featherPx",
      ],
      path,
    );
    validateOverlayShape(value.shape, `${path}.shape`);
    validateRect(value.area, `${path}.area`);
    expectColor(value.dimColor, `${path}.dimColor`);
    expectFiniteNumber(value.dimOpacity, `${path}.dimOpacity`, 0, 1);
    expectFiniteNumber(value.featherPx, `${path}.featherPx`, 0, 512);
    return;
  }

  if (value.kind === "blur-mask") {
    expectOnlyKeys(
      value,
      [
        "kind",
        "id",
        "startUs",
        "endUs",
        "opacity",
        "shape",
        "area",
        "blurPx",
        "featherPx",
      ],
      path,
    );
    validateOverlayShape(value.shape, `${path}.shape`);
    validateRect(value.area, `${path}.area`);
    expectFiniteNumber(value.blurPx, `${path}.blurPx`, 1, 256);
    expectFiniteNumber(value.featherPx, `${path}.featherPx`, 0, 512);
    return;
  }

  throw new OverlayValidationError(`${path}.kind`, "must be arrow, shape, spotlight, or blur-mask");
}

/** Sorts timed items and rebuilds every object in a stable key order. */
export function canonicalizeOverlayDocument(document: OverlayDocument): OverlayDocument {
  validateOverlayDocument(document);
  return {
    magic: OVERLAY_DOCUMENT_MAGIC,
    schemaVersion: OVERLAY_DOCUMENT_SCHEMA_VERSION,
    captions: [...document.captions].sort(compareTimedItems).map(canonicalCaption),
    overlays: [...document.overlays].sort(compareTimedItems).map(canonicalVisualOverlay),
  };
}

export function serializeOverlayDocument(document: OverlayDocument): string {
  return `${JSON.stringify(canonicalizeOverlayDocument(document), null, 2)}\n`;
}

export function parseOverlayDocument(json: string): OverlayDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new OverlayValidationError("overlays", `invalid JSON: ${errorMessage(error)}`);
  }
  validateOverlayDocument(value);
  return canonicalizeOverlayDocument(value);
}

export function importSrt(source: string, options: SubtitleImportOptions = {}): TimedCaptionCue[] {
  const prepared = prepareSubtitleImport("srt", options);
  const lines = normalizeLines(source);
  const blocks = lineBlocks(lines);
  const cues: TimedCaptionCue[] = [];

  for (const block of blocks) {
    const timingIndex = block.lines.findIndex(({ text }) => text.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1) {
      throw new SubtitleParseError("srt", block.lines[0]!.number, "cue is missing a timing line");
    }
    const timing = block.lines[timingIndex]!;
    const match = /^\s*(\S+)\s*-->\s*(\S+)\s*$/u.exec(timing.text);
    if (!match) throw new SubtitleParseError("srt", timing.number, "invalid timing line");

    const startUs = parseSrtTimestamp(match[1]!, timing.number) + prepared.offsetUs;
    const endUs = parseSrtTimestamp(match[2]!, timing.number) + prepared.offsetUs;
    const text = block.lines
      .slice(timingIndex + 1)
      .map((line) => line.text)
      .join("\n")
      .trim();
    const cue = createImportedCue(
      prepared,
      cues.length,
      startUs,
      endUs,
      text,
      timing.number,
    );
    validateCaptionCue(cue, `srt.cues.${cues.length}`);
    cues.push(cue);
  }

  return cues.sort(compareTimedItems);
}

export function exportSrt(cues: readonly TimedCaptionCue[]): string {
  validateCueCollection(cues, "srt.cues");
  const blocks = [...cues].sort(compareTimedItems).map((cue, index) => {
    const [startMs, endMs] = cueMilliseconds(cue);
    return [
      String(index + 1),
      `${formatSubtitleMilliseconds(startMs, ",")} --> ${formatSubtitleMilliseconds(endMs, ",")}`,
      cue.text,
    ].join("\n");
  });
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

export function importWebVtt(source: string, options: SubtitleImportOptions = {}): TimedCaptionCue[] {
  const prepared = prepareSubtitleImport("vtt", options);
  const lines = normalizeLines(source);
  if (lines.length === 0 || !/^WEBVTT(?:[ \t].*)?$/u.test(lines[0]!.text)) {
    throw new SubtitleParseError("vtt", 1, "missing WEBVTT header");
  }

  const blocks = lineBlocks(lines.slice(1));
  const cues: TimedCaptionCue[] = [];
  const usedIds = new Set<string>();
  for (const block of blocks) {
    const first = block.lines[0]!;
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/u.test(first.text)) continue;

    const timingIndex = block.lines.findIndex(({ text }) => text.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1) {
      throw new SubtitleParseError("vtt", first.number, "cue is missing a timing line");
    }
    const timing = block.lines[timingIndex]!;
    const match = /^\s*(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/u.exec(timing.text);
    if (!match) throw new SubtitleParseError("vtt", timing.number, "invalid timing line");

    const startUs = parseVttTimestamp(match[1]!, timing.number) + prepared.offsetUs;
    const endUs = parseVttTimestamp(match[2]!, timing.number) + prepared.offsetUs;
    const text = block.lines
      .slice(timingIndex + 1)
      .map((line) => line.text)
      .join("\n")
      .trim();
    const explicitId = timingIndex === 1 ? block.lines[0]!.text.trim() : "";
    const generatedId = createUniqueImportedId(prepared.idPrefix, cues.length, usedIds);
    const id = isIdentifier(explicitId) && !usedIds.has(explicitId) ? explicitId : generatedId;
    usedIds.add(id);
    const cue: TimedCaptionCue = {
      id,
      startUs,
      endUs,
      text,
      style: cloneValue(prepared.style),
    };
    if (startUs < 0) {
      throw new SubtitleParseError("vtt", timing.number, "offset places cue before time zero");
    }
    try {
      validateCaptionCue(cue, `vtt.cues.${cues.length}`);
    } catch (error) {
      throw subtitleValidationError("vtt", timing.number, error);
    }
    cues.push(cue);
  }

  return cues.sort(compareTimedItems);
}

export function exportWebVtt(cues: readonly TimedCaptionCue[]): string {
  validateCueCollection(cues, "vtt.cues");
  const blocks = [...cues].sort(compareTimedItems).map((cue) => {
    const [startMs, endMs] = cueMilliseconds(cue);
    return [
      cue.id,
      `${formatSubtitleMilliseconds(startMs, ".")} --> ${formatSubtitleMilliseconds(endMs, ".")}`,
      cue.text,
    ].join("\n");
  });
  return blocks.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export function splitTimedItemAt<T extends TimedCaptionCue | VisualOverlay>(
  item: T,
  atUs: TimeUs,
  rightId: TimedItemId,
): [T, T] {
  validateOneTimedItem(item);
  expectSafeTime(atUs, "split.atUs");
  expectIdentifier(rightId, "split.rightId");
  if (rightId === item.id) throw new OverlayValidationError("split.rightId", "must differ from source id");
  if (atUs <= item.startUs || atUs >= item.endUs) {
    throw new OverlayValidationError("split.atUs", "must be strictly inside the timed item");
  }
  const left = { ...item, endUs: atUs } as T;
  const right = { ...item, id: rightId, startUs: atUs } as T;
  validateOneTimedItem(left);
  validateOneTimedItem(right);
  return [left, right];
}

/** Splits every cue or visual that spans `atUs`; item ordering remains deterministic. */
export function splitOverlayDocumentAt(document: OverlayDocument, atUs: TimeUs): OverlayDocument {
  validateOverlayDocument(document);
  expectSafeTime(atUs, "split.atUs");
  const usedIds = collectIds(document);
  return finalizeTransform({
    ...document,
    captions: splitSpanningItems(document.captions, atUs, usedIds),
    overlays: splitSpanningItems(document.overlays, atUs, usedIds),
  });
}

/**
 * Deletes `[startUs, endUs)` and closes the gap. Items in the deleted span are
 * removed; partial overlaps are trimmed; later items shift left.
 */
export function rippleDeleteOverlayDocument(
  document: OverlayDocument,
  startUs: TimeUs,
  endUs: TimeUs,
): OverlayDocument {
  validateOverlayDocument(document);
  validateEditRange(startUs, endUs, "rippleDelete");
  return finalizeTransform({
    ...document,
    captions: document.captions
      .map((cue) => rippleDeleteItem(cue, startUs, endUs))
      .filter(isPresent),
    overlays: document.overlays
      .map((overlay) => rippleDeleteItem(overlay, startUs, endUs))
      .filter(isPresent),
  });
}

/**
 * Inserts a gap at `atUs`. Later items shift right. A spanning item is split so
 * it does not appear over the inserted content.
 */
export function rippleInsertOverlayDocument(
  document: OverlayDocument,
  atUs: TimeUs,
  durationUs: TimeUs,
): OverlayDocument {
  validateOverlayDocument(document);
  expectSafeTime(atUs, "rippleInsert.atUs");
  expectPositiveTime(durationUs, "rippleInsert.durationUs");
  const usedIds = collectIds(document);
  return finalizeTransform({
    ...document,
    captions: rippleInsertItems(document.captions, atUs, durationUs, usedIds),
    overlays: rippleInsertItems(document.overlays, atUs, durationUs, usedIds),
  });
}

function validateStyleReference(value: unknown, path: string): asserts value is CaptionStyleReference {
  expectRecord(value, path);
  expectOnlyKeys(value, ["preset", "overrides"], path);
  expect(
    typeof value.preset === "string" && value.preset in CAPTION_STYLE_PRESETS,
    `${path}.preset`,
    "is not a known caption preset",
  );
  if (value.overrides === undefined) return;
  validateCaptionStyleOverrides(value.overrides, `${path}.overrides`);
  const preset = CAPTION_STYLE_PRESETS[value.preset as CaptionStylePresetId];
  validateCaptionStyle(
    {
      ...preset,
      ...value.overrides,
      shadowOffset: { ...preset.shadowOffset, ...value.overrides.shadowOffset },
      position: { ...preset.position, ...value.overrides.position },
    },
    `${path}.resolved`,
  );
}

function validateCaptionStyleOverrides(
  value: unknown,
  path: string,
): asserts value is CaptionStyleOverrides {
  expectRecord(value, path);
  expectOnlyKeys(
    value,
    [
      "fontFamily",
      "fontSizeRatio",
      "fontWeight",
      "lineHeight",
      "letterSpacingEm",
      "color",
      "backgroundColor",
      "backgroundPaddingEm",
      "backgroundRadiusPx",
      "outlineColor",
      "outlineWidthPx",
      "shadowColor",
      "shadowBlurPx",
      "shadowOffset",
      "position",
      "maxWidth",
      "align",
      "uppercase",
    ],
    path,
  );
  if (value.shadowOffset !== undefined) {
    expectRecord(value.shadowOffset, `${path}.shadowOffset`);
    expectOnlyKeys(value.shadowOffset, ["xPx", "yPx"], `${path}.shadowOffset`);
  }
  if (value.position !== undefined) {
    expectRecord(value.position, `${path}.position`);
    expectOnlyKeys(value.position, ["x", "y"], `${path}.position`);
  }
}

function validateCaptionStyle(value: unknown, path: string): asserts value is CaptionStyle {
  expectRecord(value, path);
  expectNonEmptyString(value.fontFamily, `${path}.fontFamily`);
  expect(value.fontFamily.length <= 512, `${path}.fontFamily`, "must be at most 512 characters");
  expectFiniteNumber(value.fontSizeRatio, `${path}.fontSizeRatio`, 0.01, 0.3);
  expect(
    value.fontWeight === 400 ||
      value.fontWeight === 500 ||
      value.fontWeight === 600 ||
      value.fontWeight === 700 ||
      value.fontWeight === 800 ||
      value.fontWeight === 900,
    `${path}.fontWeight`,
    "must be a supported font weight",
  );
  expectFiniteNumber(value.lineHeight, `${path}.lineHeight`, 0.75, 2.5);
  expectFiniteNumber(value.letterSpacingEm, `${path}.letterSpacingEm`, -0.2, 1);
  expectColor(value.color, `${path}.color`);
  expectColor(value.backgroundColor, `${path}.backgroundColor`);
  expectFiniteNumber(value.backgroundPaddingEm, `${path}.backgroundPaddingEm`, 0, 3);
  expectFiniteNumber(value.backgroundRadiusPx, `${path}.backgroundRadiusPx`, 0, 256);
  expectColor(value.outlineColor, `${path}.outlineColor`);
  expectFiniteNumber(value.outlineWidthPx, `${path}.outlineWidthPx`, 0, 32);
  expectColor(value.shadowColor, `${path}.shadowColor`);
  expectFiniteNumber(value.shadowBlurPx, `${path}.shadowBlurPx`, 0, 256);
  expectRecord(value.shadowOffset, `${path}.shadowOffset`);
  expectFiniteNumber(value.shadowOffset.xPx, `${path}.shadowOffset.xPx`, -256, 256);
  expectFiniteNumber(value.shadowOffset.yPx, `${path}.shadowOffset.yPx`, -256, 256);
  validatePoint(value.position, `${path}.position`);
  expectFiniteNumber(value.maxWidth, `${path}.maxWidth`, 0.05, 1);
  expect(
    value.align === "left" || value.align === "center" || value.align === "right",
    `${path}.align`,
    "must be left, center, or right",
  );
  expect(typeof value.uppercase === "boolean", `${path}.uppercase`, "must be a boolean");
}

function validateTimedBase(value: Record<string, unknown>, path: string): void {
  expectIdentifier(value.id, `${path}.id`);
  expectSafeTime(value.startUs, `${path}.startUs`);
  expectPositiveTime(value.endUs, `${path}.endUs`);
  expect(value.startUs < value.endUs, path, "time range must have positive duration");
}

function validatePoint(value: unknown, path: string): asserts value is NormalizedPoint {
  expectRecord(value, path);
  expectOnlyKeys(value, ["x", "y"], path);
  expectFiniteNumber(value.x, `${path}.x`, 0, 1);
  expectFiniteNumber(value.y, `${path}.y`, 0, 1);
}

function validateRect(value: unknown, path: string): asserts value is NormalizedRect {
  expectRecord(value, path);
  expectOnlyKeys(value, ["x", "y", "width", "height"], path);
  expectFiniteNumber(value.x, `${path}.x`, 0, 1);
  expectFiniteNumber(value.y, `${path}.y`, 0, 1);
  expectFiniteNumber(value.width, `${path}.width`, Number.EPSILON, 1);
  expectFiniteNumber(value.height, `${path}.height`, Number.EPSILON, 1);
  expect(value.x + value.width <= 1 + 1e-9, path, "extends beyond the canvas width");
  expect(value.y + value.height <= 1 + 1e-9, path, "extends beyond the canvas height");
}

function validateOverlayShape(value: unknown, path: string): asserts value is "rectangle" | "ellipse" {
  expect(value === "rectangle" || value === "ellipse", path, "must be rectangle or ellipse");
}

interface PreparedSubtitleImport {
  format: "srt" | "vtt";
  idPrefix: string;
  offsetUs: TimeUs;
  style: CaptionStyleReference;
}

function prepareSubtitleImport(
  format: "srt" | "vtt",
  options: SubtitleImportOptions,
): PreparedSubtitleImport {
  const idPrefix = options.idPrefix ?? format;
  expectIdentifier(idPrefix, `${format}.options.idPrefix`);
  const offsetUs = options.offsetUs ?? 0;
  expect(
    Number.isSafeInteger(offsetUs),
    `${format}.options.offsetUs`,
    "must be a safe integer number of microseconds",
  );
  const style = options.style ?? { preset: "clean" };
  validateStyleReference(style, `${format}.options.style`);
  return { format, idPrefix, offsetUs, style: cloneValue(style) };
}

function createImportedCue(
  prepared: PreparedSubtitleImport,
  index: number,
  startUs: TimeUs,
  endUs: TimeUs,
  text: string,
  line: number,
): TimedCaptionCue {
  if (startUs < 0) {
    throw new SubtitleParseError(prepared.format, line, "offset places cue before time zero");
  }
  const cue: TimedCaptionCue = {
    id: createImportedId(prepared.idPrefix, index),
    startUs,
    endUs,
    text,
    style: cloneValue(prepared.style),
  };
  try {
    validateCaptionCue(cue, `${prepared.format}.cues.${index}`);
  } catch (error) {
    throw subtitleValidationError(prepared.format, line, error);
  }
  return cue;
}

function createImportedId(prefix: string, zeroBasedIndex: number): string {
  const suffix = String(zeroBasedIndex + 1).padStart(4, "0");
  const available = Math.max(1, 128 - suffix.length - 1);
  return `${prefix.slice(0, available)}-${suffix}`;
}

function createUniqueImportedId(
  prefix: string,
  zeroBasedIndex: number,
  usedIds: ReadonlySet<string>,
): string {
  const preferred = createImportedId(prefix, zeroBasedIndex);
  if (!usedIds.has(preferred)) return preferred;
  let attempt = 2;
  while (true) {
    const suffix = `-${attempt}`;
    const candidate = `${preferred.slice(0, 128 - suffix.length)}${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
    attempt += 1;
  }
}

function subtitleValidationError(
  format: "srt" | "vtt",
  line: number,
  error: unknown,
): SubtitleParseError {
  const message = error instanceof OverlayValidationError ? error.message : errorMessage(error);
  return new SubtitleParseError(format, line, message);
}

interface NumberedLine {
  text: string;
  number: number;
}

function normalizeLines(source: string): NumberedLine[] {
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (normalized.trim().length === 0) return [];
  return normalized.split("\n").map((text, index) => ({ text, number: index + 1 }));
}

function lineBlocks(lines: readonly NumberedLine[]): Array<{ lines: NumberedLine[] }> {
  const blocks: Array<{ lines: NumberedLine[] }> = [];
  let current: NumberedLine[] = [];
  for (const line of lines) {
    if (line.text.trim().length === 0) {
      if (current.length > 0) {
        blocks.push({ lines: current });
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push({ lines: current });
  return blocks;
}

function parseSrtTimestamp(value: string, line: number): TimeUs {
  const match = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/u.exec(value);
  if (!match) throw new SubtitleParseError("srt", line, `invalid timestamp ${value}`);
  return timestampPartsToUs(match[1]!, match[2]!, match[3]!, match[4]!);
}

function parseVttTimestamp(value: string, line: number): TimeUs {
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)\.(\d{1,3})$/u.exec(value);
  if (!match) throw new SubtitleParseError("vtt", line, `invalid timestamp ${value}`);
  const hours = match[1] ?? "0";
  return timestampPartsToUs(hours, match[2]!, match[3]!, match[4]!);
}

function timestampPartsToUs(
  hoursText: string,
  minutesText: string,
  secondsText: string,
  millisecondsText: string,
): TimeUs {
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText.padEnd(3, "0"));
  const result = (((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds) * 1_000;
  if (!Number.isSafeInteger(result)) {
    throw new OverlayValidationError("subtitle.timestamp", "exceeds the supported timeline range");
  }
  return result;
}

function cueMilliseconds(cue: TimedCaptionCue): [number, number] {
  const startMs = Math.round(cue.startUs / 1_000);
  const endMs = Math.max(startMs + 1, Math.round(cue.endUs / 1_000));
  return [startMs, endMs];
}

function formatSubtitleMilliseconds(totalMs: number, separator: "," | "."): string {
  const milliseconds = totalMs % 1_000;
  const totalSeconds = Math.floor(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function validateCueCollection(cues: readonly TimedCaptionCue[], path: string): void {
  const ids = new Set<string>();
  cues.forEach((cue, index) => {
    validateCaptionCue(cue, `${path}.${index}`);
    expect(!ids.has(cue.id), `${path}.${index}.id`, "must be unique");
    ids.add(cue.id);
  });
}

function validateEditRange(startUs: TimeUs, endUs: TimeUs, path: string): void {
  expectSafeTime(startUs, `${path}.startUs`);
  expectPositiveTime(endUs, `${path}.endUs`);
  expect(startUs < endUs, path, "range must have positive duration");
}

function validateOneTimedItem(item: TimedCaptionCue | VisualOverlay): void {
  if ("kind" in item) validateVisualOverlay(item);
  else validateCaptionCue(item);
}

function collectIds(document: OverlayDocument): Set<string> {
  return new Set([
    ...document.captions.map((cue) => cue.id),
    ...document.overlays.map((overlay) => overlay.id),
  ]);
}

function splitSpanningItems<T extends TimedCaptionCue | VisualOverlay>(
  items: readonly T[],
  atUs: TimeUs,
  usedIds: Set<string>,
): T[] {
  return items.flatMap((item) => {
    if (atUs <= item.startUs || atUs >= item.endUs) return [item];
    const rightId = nextSplitId(item.id, usedIds);
    usedIds.add(rightId);
    return splitTimedItemAt(item, atUs, rightId);
  });
}

function rippleDeleteItem<T extends TimedCaptionCue | VisualOverlay>(
  item: T,
  startUs: TimeUs,
  endUs: TimeUs,
): T | undefined {
  const durationUs = endUs - startUs;
  if (item.endUs <= startUs) return item;
  if (item.startUs >= endUs) {
    return { ...item, startUs: item.startUs - durationUs, endUs: item.endUs - durationUs };
  }
  if (item.startUs >= startUs && item.endUs <= endUs) return undefined;
  if (item.startUs < startUs && item.endUs <= endUs) {
    return { ...item, endUs: startUs };
  }
  if (item.startUs >= startUs && item.endUs > endUs) {
    return { ...item, startUs, endUs: item.endUs - durationUs };
  }
  return { ...item, endUs: item.endUs - durationUs };
}

function rippleInsertItems<T extends TimedCaptionCue | VisualOverlay>(
  items: readonly T[],
  atUs: TimeUs,
  durationUs: TimeUs,
  usedIds: Set<string>,
): T[] {
  return items.flatMap((item) => {
    if (item.endUs <= atUs) return [item];
    if (item.startUs >= atUs) {
      return [{ ...item, startUs: item.startUs + durationUs, endUs: item.endUs + durationUs } as T];
    }
    const rightId = nextSplitId(item.id, usedIds);
    usedIds.add(rightId);
    const [left, right] = splitTimedItemAt(item, atUs, rightId);
    return [left, { ...right, startUs: right.startUs + durationUs, endUs: right.endUs + durationUs } as T];
  });
}

function nextSplitId(sourceId: string, usedIds: ReadonlySet<string>): string {
  const marker = "-split";
  const base = `${sourceId.slice(0, 128 - marker.length)}${marker}`;
  if (!usedIds.has(base)) return base;
  let index = 2;
  while (true) {
    const suffix = `${marker}-${index}`;
    const candidate = `${sourceId.slice(0, 128 - suffix.length)}${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
    index += 1;
  }
}

function finalizeTransform(document: OverlayDocument): OverlayDocument {
  validateOverlayDocument(document);
  return canonicalizeOverlayDocument(document);
}

function canonicalCaption(cue: TimedCaptionCue): TimedCaptionCue {
  return {
    id: cue.id,
    startUs: cue.startUs,
    endUs: cue.endUs,
    text: cue.text,
    ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
    style: canonicalStyleReference(cue.style),
  };
}

function canonicalStyleReference(reference: CaptionStyleReference): CaptionStyleReference {
  return {
    preset: reference.preset,
    ...(reference.overrides === undefined
      ? {}
      : { overrides: canonicalStyleOverrides(reference.overrides) }),
  };
}

function canonicalStyleOverrides(overrides: CaptionStyleOverrides): CaptionStyleOverrides {
  const canonical: CaptionStyleOverrides = {};
  const scalarKeys = [
    "fontFamily",
    "fontSizeRatio",
    "fontWeight",
    "lineHeight",
    "letterSpacingEm",
    "color",
    "backgroundColor",
    "backgroundPaddingEm",
    "backgroundRadiusPx",
    "outlineColor",
    "outlineWidthPx",
    "shadowColor",
    "shadowBlurPx",
  ] as const;
  for (const key of scalarKeys) {
    const value = overrides[key];
    if (value !== undefined) Object.assign(canonical, { [key]: value });
  }
  if (overrides.shadowOffset !== undefined) {
    canonical.shadowOffset = {
      ...(overrides.shadowOffset.xPx === undefined ? {} : { xPx: overrides.shadowOffset.xPx }),
      ...(overrides.shadowOffset.yPx === undefined ? {} : { yPx: overrides.shadowOffset.yPx }),
    };
  }
  if (overrides.position !== undefined) {
    canonical.position = {
      ...(overrides.position.x === undefined ? {} : { x: overrides.position.x }),
      ...(overrides.position.y === undefined ? {} : { y: overrides.position.y }),
    };
  }
  if (overrides.maxWidth !== undefined) canonical.maxWidth = overrides.maxWidth;
  if (overrides.align !== undefined) canonical.align = overrides.align;
  if (overrides.uppercase !== undefined) canonical.uppercase = overrides.uppercase;
  return canonical;
}

function canonicalVisualOverlay(overlay: VisualOverlay): VisualOverlay {
  const base = {
    kind: overlay.kind,
    id: overlay.id,
    startUs: overlay.startUs,
    endUs: overlay.endUs,
    opacity: overlay.opacity,
  };
  switch (overlay.kind) {
    case "arrow":
      return {
        ...base,
        kind: "arrow",
        from: { x: overlay.from.x, y: overlay.from.y },
        to: { x: overlay.to.x, y: overlay.to.y },
        color: overlay.color,
        strokeWidthPx: overlay.strokeWidthPx,
        headLengthPx: overlay.headLengthPx,
        lineStyle: overlay.lineStyle,
        animation: overlay.animation,
      };
    case "shape":
      return {
        ...base,
        kind: "shape",
        shape: overlay.shape,
        area: canonicalRect(overlay.area),
        fillColor: overlay.fillColor,
        strokeColor: overlay.strokeColor,
        strokeWidthPx: overlay.strokeWidthPx,
        cornerRadius: overlay.cornerRadius,
        rotationDeg: overlay.rotationDeg,
      };
    case "spotlight":
      return {
        ...base,
        kind: "spotlight",
        shape: overlay.shape,
        area: canonicalRect(overlay.area),
        dimColor: overlay.dimColor,
        dimOpacity: overlay.dimOpacity,
        featherPx: overlay.featherPx,
      };
    case "blur-mask":
      return {
        ...base,
        kind: "blur-mask",
        shape: overlay.shape,
        area: canonicalRect(overlay.area),
        blurPx: overlay.blurPx,
        featherPx: overlay.featherPx,
      };
  }
}

function canonicalRect(rect: NormalizedRect): NormalizedRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function compareTimedItems(
  left: Pick<TimedCaptionCue, "startUs" | "endUs" | "id">,
  right: Pick<TimedCaptionCue, "startUs" | "endUs" | "id">,
): number {
  return (
    left.startUs - right.startUs ||
    left.endUs - right.endUs ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expectRecord(value: unknown, path: string): asserts value is Record<string, any> {
  expect(typeof value === "object" && value !== null && !Array.isArray(value), path, "must be an object");
}

function expectOnlyKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  expect(unknown === undefined, unknown === undefined ? path : `${path}.${unknown}`, "is not supported");
}

function expectNonEmptyString(value: unknown, path: string): asserts value is string {
  expect(typeof value === "string" && value.trim().length > 0, path, "must be a non-empty string");
}

function expectText(value: unknown, path: string): asserts value is string {
  expectNonEmptyString(value, path);
  expect(value.length <= 20_000, path, "must be at most 20,000 characters");
  expect(!value.includes("\0"), path, "must not contain NUL characters");
  expect(!/\n[ \t]*\n/u.test(value), path, "must not contain blank lines");
}

function expectIdentifier(value: unknown, path: string): asserts value is string {
  expect(typeof value === "string" && isIdentifier(value), path, "must be a safe identifier");
}

function expectSafeTime(value: unknown, path: string): asserts value is TimeUs {
  expect(
    Number.isSafeInteger(value) && (value as number) >= 0,
    path,
    "must be an integer number of microseconds >= 0",
  );
}

function expectPositiveTime(value: unknown, path: string): asserts value is TimeUs {
  expect(
    Number.isSafeInteger(value) && (value as number) >= 1,
    path,
    "must be an integer number of microseconds >= 1",
  );
}

function expectColor(value: unknown, path: string): asserts value is string {
  expect(
    typeof value === "string" && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(value),
    path,
    "must be #RRGGBB or #RRGGBBAA",
  );
}

function expectFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  expect(
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum,
    path,
    `must be between ${minimum} and ${maximum}`,
  );
}

function expect(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new OverlayValidationError(path, message);
}
