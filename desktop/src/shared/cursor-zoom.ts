/**
 * Cursor metadata and zoom evaluation are deliberately renderer-agnostic.
 * Native capture can write the sidecar, while preview and export consume the
 * same deterministic functions without doing work in the recording loop.
 */

export const CURSOR_SIDECAR_MAGIC = "sharpshot-cursor-track" as const;
export const CURSOR_SIDECAR_VERSION = 1 as const;

export type TimeUs = number;
export type CursorButton = "left" | "right" | "middle" | "x1" | "x2";

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface CursorCaptureSpace {
  /** Physical capture dimensions before editor composition. */
  readonly width: number;
  readonly height: number;
  /** Physical desktop origin; can be negative on multi-monitor layouts. */
  readonly originX: number;
  readonly originY: number;
  readonly scaleFactor: number;
}

interface PositionedCursorEvent extends NormalizedPoint {
  readonly timeUs: TimeUs;
}

export interface CursorMoveEvent extends PositionedCursorEvent {
  readonly kind: "move";
}

export interface CursorButtonEvent extends PositionedCursorEvent {
  readonly kind: "button";
  readonly button: CursorButton;
  readonly state: "down" | "up";
}

export interface CursorWheelEvent extends PositionedCursorEvent {
  readonly kind: "wheel";
  /** Wheel deltas use Windows wheel units, normally multiples of 120. */
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface CursorVisibilityEvent {
  readonly kind: "visibility";
  readonly timeUs: TimeUs;
  readonly visible: boolean;
}

export type CursorEvent =
  | CursorMoveEvent
  | CursorButtonEvent
  | CursorWheelEvent
  | CursorVisibilityEvent;

export interface CursorSidecar {
  readonly magic: typeof CURSOR_SIDECAR_MAGIC;
  readonly version: typeof CURSOR_SIDECAR_VERSION;
  readonly timebase: "microseconds";
  readonly coordinateSpace: "capture-normalized";
  readonly durationUs: TimeUs;
  readonly capture: CursorCaptureSpace;
  /** Events are stable-sorted by time. Equal timestamps preserve capture order. */
  readonly events: readonly CursorEvent[];
}

export interface CreateCursorSidecarOptions {
  readonly durationUs: TimeUs;
  readonly capture: CursorCaptureSpace;
  readonly events?: readonly CursorEvent[];
}

export class CursorZoomValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CursorZoomValidationError";
    this.path = path;
  }
}

export function createCursorSidecar(options: CreateCursorSidecarOptions): CursorSidecar {
  const sidecar: CursorSidecar = {
    magic: CURSOR_SIDECAR_MAGIC,
    version: CURSOR_SIDECAR_VERSION,
    timebase: "microseconds",
    coordinateSpace: "capture-normalized",
    durationUs: options.durationUs,
    capture: { ...options.capture },
    events: (options.events ?? []).map((event) => ({ ...event })),
  };
  validateCursorSidecar(sidecar);
  return sidecar;
}

export function serializeCursorSidecar(sidecar: CursorSidecar): string {
  validateCursorSidecar(sidecar);
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export function parseCursorSidecar(json: string): CursorSidecar {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new CursorZoomValidationError(
      "cursorSidecar",
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateCursorSidecar(value);
  return value;
}

export function validateCursorSidecar(value: unknown): asserts value is CursorSidecar {
  expectRecord(value, "cursorSidecar");
  expect(
    value.magic === CURSOR_SIDECAR_MAGIC,
    "cursorSidecar.magic",
    `must equal ${CURSOR_SIDECAR_MAGIC}`,
  );
  expect(
    value.version === CURSOR_SIDECAR_VERSION,
    "cursorSidecar.version",
    `unsupported version ${String(value.version)}`,
  );
  expect(value.timebase === "microseconds", "cursorSidecar.timebase", "must be microseconds");
  expect(
    value.coordinateSpace === "capture-normalized",
    "cursorSidecar.coordinateSpace",
    "must be capture-normalized",
  );
  expectSafeTime(value.durationUs, "cursorSidecar.durationUs");
  expectRecord(value.capture, "cursorSidecar.capture");
  expectPositiveInteger(value.capture.width, "cursorSidecar.capture.width");
  expectPositiveInteger(value.capture.height, "cursorSidecar.capture.height");
  expectFinite(value.capture.originX, "cursorSidecar.capture.originX");
  expectFinite(value.capture.originY, "cursorSidecar.capture.originY");
  expectFiniteInRange(value.capture.scaleFactor, "cursorSidecar.capture.scaleFactor", 0.25, 8);
  expect(Array.isArray(value.events), "cursorSidecar.events", "must be an array");

  let previousTime = -1;
  value.events.forEach((event: unknown, index: number) => {
    const path = `cursorSidecar.events.${index}`;
    expectRecord(event, path);
    expectSafeTime(event.timeUs, `${path}.timeUs`);
    expect(event.timeUs >= previousTime, `${path}.timeUs`, "must be monotonic");
    expect(event.timeUs <= value.durationUs, `${path}.timeUs`, "exceeds durationUs");
    previousTime = event.timeUs;

    if (event.kind === "visibility") {
      expect(typeof event.visible === "boolean", `${path}.visible`, "must be a boolean");
      return;
    }

    expectNormalizedPoint(event, path);
    if (event.kind === "move") return;
    if (event.kind === "button") {
      expect(isCursorButton(event.button), `${path}.button`, "is invalid");
      expect(event.state === "down" || event.state === "up", `${path}.state`, "is invalid");
      return;
    }
    expect(event.kind === "wheel", `${path}.kind`, "is invalid");
    expectFinite(event.deltaX, `${path}.deltaX`);
    expectFinite(event.deltaY, `${path}.deltaY`);
  });
}

export interface CursorSmoothingOptions {
  /** Zero keeps captured coordinates, one applies the full zero-phase filter. */
  readonly strength: number;
  /** Filter response time. Higher values remove more hand jitter. */
  readonly responseUs: TimeUs;
  /** Never smooth or interpolate across an idle gap longer than this. */
  readonly maxGapUs: TimeUs;
  /** Blend from linear to time-aware Hermite motion during preview. */
  readonly curve: number;
  /** Ignore tiny duplicate move packets when calculating idle state. */
  readonly movementThreshold: number;
}

export const DEFAULT_CURSOR_SMOOTHING: Readonly<CursorSmoothingOptions> = {
  strength: 0.72,
  responseUs: 42_000,
  maxGapUs: 240_000,
  curve: 0.62,
  movementThreshold: 0.00035,
};

export interface CursorKeyframe extends NormalizedPoint {
  readonly timeUs: TimeUs;
  readonly capturedX: number;
  readonly capturedY: number;
  readonly clickAnchor: boolean;
}

export interface PreparedCursorTrack {
  readonly durationUs: TimeUs;
  readonly keyframes: readonly CursorKeyframe[];
  readonly movementTimesUs: readonly TimeUs[];
  readonly visibilityEvents: readonly CursorVisibilityEvent[];
  readonly pressEvents: readonly CursorButtonEvent[];
  readonly buttonEvents: Readonly<Record<CursorButton, readonly CursorButtonEvent[]>>;
  readonly smoothing: Readonly<CursorSmoothingOptions>;
}

export function prepareCursorTrack(
  sidecar: CursorSidecar,
  options: Partial<CursorSmoothingOptions> = {},
): PreparedCursorTrack {
  validateCursorSidecar(sidecar);
  const smoothing = resolveSmoothingOptions(options);
  const rawKeyframes: MutableKeyframe[] = [];
  const movementTimesUs: TimeUs[] = [];
  const visibilityEvents: CursorVisibilityEvent[] = [];
  const pressEvents: CursorButtonEvent[] = [];
  const buttonEvents: Record<CursorButton, CursorButtonEvent[]> = {
    left: [],
    right: [],
    middle: [],
    x1: [],
    x2: [],
  };
  let lastMovementPoint: NormalizedPoint | undefined;

  sidecar.events.forEach((event) => {
    if (event.kind === "visibility") {
      visibilityEvents.push(event);
      return;
    }

    const clickAnchor = event.kind === "button";
    const previous = rawKeyframes[rawKeyframes.length - 1];
    if (previous?.timeUs === event.timeUs) {
      previous.capturedX = event.x;
      previous.capturedY = event.y;
      previous.x = event.x;
      previous.y = event.y;
      previous.clickAnchor ||= clickAnchor;
    } else {
      rawKeyframes.push({
        timeUs: event.timeUs,
        x: event.x,
        y: event.y,
        capturedX: event.x,
        capturedY: event.y,
        clickAnchor,
      });
    }

    if (event.kind === "move") {
      if (
        !lastMovementPoint ||
        distance(lastMovementPoint, event) >= smoothing.movementThreshold
      ) {
        movementTimesUs.push(event.timeUs);
        lastMovementPoint = event;
      }
    } else if (event.kind === "button") {
      buttonEvents[event.button].push(event);
      if (event.state === "down") pressEvents.push(event);
    }
  });

  const keyframes = smoothKeyframes(rawKeyframes, smoothing);
  return {
    durationUs: sidecar.durationUs,
    keyframes,
    movementTimesUs,
    visibilityEvents,
    pressEvents,
    buttonEvents,
    smoothing,
  };
}

interface MutableKeyframe {
  timeUs: TimeUs;
  x: number;
  y: number;
  capturedX: number;
  capturedY: number;
  clickAnchor: boolean;
}

function smoothKeyframes(
  raw: readonly MutableKeyframe[],
  options: CursorSmoothingOptions,
): CursorKeyframe[] {
  if (raw.length < 3 || options.strength === 0) return raw.map(freezeKeyframe);
  const output = raw.map((point) => ({ ...point }));
  let chunkStart = 0;

  for (let index = 1; index <= raw.length; index += 1) {
    const atEnd = index === raw.length;
    const gap = atEnd ? Number.POSITIVE_INFINITY : raw[index]!.timeUs - raw[index - 1]!.timeUs;
    if (!atEnd && gap <= options.maxGapUs) continue;
    smoothChunk(raw, output, chunkStart, index, options);
    chunkStart = index;
  }
  return output.map(freezeKeyframe);
}

function smoothChunk(
  raw: readonly MutableKeyframe[],
  output: MutableKeyframe[],
  start: number,
  end: number,
  options: CursorSmoothingOptions,
): void {
  const length = end - start;
  if (length < 3) return;
  const forwardX = new Array<number>(length);
  const forwardY = new Array<number>(length);
  const backwardX = new Array<number>(length);
  const backwardY = new Array<number>(length);
  forwardX[0] = raw[start]!.x;
  forwardY[0] = raw[start]!.y;
  for (let local = 1; local < length; local += 1) {
    const index = start + local;
    const alpha = responseAlpha(raw[index]!.timeUs - raw[index - 1]!.timeUs, options.responseUs);
    forwardX[local] = mix(forwardX[local - 1]!, raw[index]!.x, alpha);
    forwardY[local] = mix(forwardY[local - 1]!, raw[index]!.y, alpha);
  }
  backwardX[length - 1] = raw[end - 1]!.x;
  backwardY[length - 1] = raw[end - 1]!.y;
  for (let local = length - 2; local >= 0; local -= 1) {
    const index = start + local;
    const alpha = responseAlpha(raw[index + 1]!.timeUs - raw[index]!.timeUs, options.responseUs);
    backwardX[local] = mix(backwardX[local + 1]!, raw[index]!.x, alpha);
    backwardY[local] = mix(backwardY[local + 1]!, raw[index]!.y, alpha);
  }

  // Keep chunk endpoints and click coordinates exact. That prevents visible drift
  // at cuts and makes a click ring land on the actual target.
  for (let local = 1; local < length - 1; local += 1) {
    const index = start + local;
    const point = raw[index]!;
    if (point.clickAnchor) continue;
    const filteredX = (forwardX[local]! + backwardX[local]!) * 0.5;
    const filteredY = (forwardY[local]! + backwardY[local]!) * 0.5;
    output[index]!.x = clamp01(mix(point.x, filteredX, options.strength));
    output[index]!.y = clamp01(mix(point.y, filteredY, options.strength));
  }
}

function freezeKeyframe(point: MutableKeyframe): CursorKeyframe {
  return {
    timeUs: point.timeUs,
    x: point.x,
    y: point.y,
    capturedX: point.capturedX,
    capturedY: point.capturedY,
    clickAnchor: point.clickAnchor,
  };
}

export interface CursorSample extends NormalizedPoint {
  readonly visible: boolean;
}

export function sampleCursorAt(
  track: PreparedCursorTrack,
  timeUs: TimeUs,
): CursorSample | undefined {
  if (track.keyframes.length === 0) return undefined;
  const time = clamp(timeUs, 0, track.durationUs);
  const rightIndex = upperBoundByTime(track.keyframes, time);
  const leftIndex = Math.max(0, rightIndex - 1);
  const left = track.keyframes[leftIndex]!;
  const visible = visibilityAt(track.visibilityEvents, time);
  if (rightIndex >= track.keyframes.length || left.timeUs === time) {
    return { x: left.x, y: left.y, visible };
  }
  const right = track.keyframes[rightIndex]!;
  const gapUs = right.timeUs - left.timeUs;
  if (gapUs <= 0 || gapUs > track.smoothing.maxGapUs) {
    return { x: left.x, y: left.y, visible };
  }

  const progress = (time - left.timeUs) / gapUs;
  const linearX = mix(left.x, right.x, progress);
  const linearY = mix(left.y, right.y, progress);
  const curvedX = hermiteCoordinate(track.keyframes, leftIndex, progress, "x");
  const curvedY = hermiteCoordinate(track.keyframes, leftIndex, progress, "y");
  return {
    x: clampBetween(mix(linearX, curvedX, track.smoothing.curve), left.x, right.x),
    y: clampBetween(mix(linearY, curvedY, track.smoothing.curve), left.y, right.y),
    visible,
  };
}

function hermiteCoordinate(
  points: readonly CursorKeyframe[],
  leftIndex: number,
  progress: number,
  key: "x" | "y",
): number {
  const left = points[leftIndex]!;
  const right = points[leftIndex + 1]!;
  const previous = points[Math.max(0, leftIndex - 1)]!;
  const next = points[Math.min(points.length - 1, leftIndex + 2)]!;
  const segmentUs = Math.max(1, right.timeUs - left.timeUs);
  const leftSpanUs = Math.max(1, right.timeUs - previous.timeUs);
  const rightSpanUs = Math.max(1, next.timeUs - left.timeUs);
  const leftTangent = ((right[key] - previous[key]) / leftSpanUs) * segmentUs;
  const rightTangent = ((next[key] - left[key]) / rightSpanUs) * segmentUs;
  const t2 = progress * progress;
  const t3 = t2 * progress;
  return (
    (2 * t3 - 3 * t2 + 1) * left[key] +
    (t3 - 2 * t2 + progress) * leftTangent +
    (-2 * t3 + 3 * t2) * right[key] +
    (t3 - t2) * rightTangent
  );
}

export interface CursorRenderOptions {
  readonly hideWhenIdle: boolean;
  readonly idleDelayUs: TimeUs;
  readonly idleFadeUs: TimeUs;
  readonly clickEmphasis: boolean;
  readonly clickAttackUs: TimeUs;
  readonly clickDurationUs: TimeUs;
}

export const DEFAULT_CURSOR_RENDER: Readonly<CursorRenderOptions> = {
  hideWhenIdle: true,
  idleDelayUs: 900_000,
  idleFadeUs: 220_000,
  clickEmphasis: true,
  clickAttackUs: 45_000,
  clickDurationUs: 360_000,
};

export interface ClickPulse {
  readonly button: CursorButton;
  readonly ageUs: TimeUs;
  readonly intensity: number;
}

export interface CursorRenderState extends CursorSample {
  readonly opacity: number;
  readonly moving: boolean;
  readonly pressedButtons: readonly CursorButton[];
  readonly click: ClickPulse | undefined;
}

export function cursorRenderStateAt(
  track: PreparedCursorTrack,
  timeUs: TimeUs,
  options: Partial<CursorRenderOptions> = {},
): CursorRenderState | undefined {
  const sample = sampleCursorAt(track, timeUs);
  if (!sample) return undefined;
  const render = resolveRenderOptions(options);
  const time = clamp(timeUs, 0, track.durationUs);
  const pressedButtons = pressedButtonsAt(track, time);
  const click = render.clickEmphasis ? clickPulseAt(track.pressEvents, time, render) : undefined;
  const movementIndex = upperBoundNumber(track.movementTimesUs, time) - 1;
  const lastMovementUs = movementIndex >= 0 ? track.movementTimesUs[movementIndex]! : 0;
  const idleAgeUs = Math.max(0, time - lastMovementUs);
  const moving = idleAgeUs <= Math.max(50_000, track.smoothing.maxGapUs);
  let opacity = sample.visible ? 1 : 0;
  if (
    opacity > 0 &&
    render.hideWhenIdle &&
    pressedButtons.length === 0 &&
    click === undefined &&
    idleAgeUs > render.idleDelayUs
  ) {
    const fadeProgress = (idleAgeUs - render.idleDelayUs) / Math.max(1, render.idleFadeUs);
    opacity = 1 - smootherStep(clamp01(fadeProgress));
  }
  return { ...sample, opacity, moving, pressedButtons, click };
}

function clickPulseAt(
  presses: readonly CursorButtonEvent[],
  timeUs: TimeUs,
  options: CursorRenderOptions,
): ClickPulse | undefined {
  const index = upperBoundByTime(presses, timeUs) - 1;
  if (index < 0) return undefined;
  const press = presses[index]!;
  const ageUs = timeUs - press.timeUs;
  if (ageUs < 0 || ageUs >= options.clickDurationUs) return undefined;
  const attackUs = Math.min(options.clickAttackUs, options.clickDurationUs);
  const intensity =
    ageUs <= attackUs
      ? smootherStep(ageUs / Math.max(1, attackUs))
      : 1 - smootherStep((ageUs - attackUs) / Math.max(1, options.clickDurationUs - attackUs));
  return { button: press.button, ageUs, intensity: clamp01(intensity) };
}

function pressedButtonsAt(track: PreparedCursorTrack, timeUs: TimeUs): CursorButton[] {
  const pressed: CursorButton[] = [];
  for (const button of CURSOR_BUTTONS) {
    const events = track.buttonEvents[button];
    const index = upperBoundByTime(events, timeUs) - 1;
    if (index >= 0 && events[index]!.state === "down") pressed.push(button);
  }
  return pressed;
}

export interface ZoomSegment {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly endUs: TimeUs;
  readonly focus: NormalizedPoint;
  readonly scale: number;
  readonly easeInUs: TimeUs;
  readonly easeOutUs: TimeUs;
  readonly source: "auto" | "manual";
}

export interface AutoZoomOptions {
  readonly scale: number;
  readonly leadUs: TimeUs;
  readonly holdUs: TimeUs;
  readonly tailUs: TimeUs;
  readonly easeInUs: TimeUs;
  readonly easeOutUs: TimeUs;
  readonly mergeGapUs: TimeUs;
  readonly mergeDistance: number;
  readonly triggerButtons: readonly CursorButton[];
}

export const DEFAULT_AUTO_ZOOM: Readonly<AutoZoomOptions> = {
  scale: 2,
  leadUs: 260_000,
  holdUs: 900_000,
  tailUs: 340_000,
  easeInUs: 220_000,
  easeOutUs: 260_000,
  mergeGapUs: 420_000,
  mergeDistance: 0.22,
  triggerButtons: ["left"],
};

export function generateAutoZoomSegments(
  sidecar: CursorSidecar,
  options: Partial<AutoZoomOptions> = {},
): ZoomSegment[] {
  validateCursorSidecar(sidecar);
  const resolved = resolveAutoZoomOptions(options);
  const triggers = sidecar.events.filter(
    (event): event is CursorButtonEvent =>
      event.kind === "button" &&
      event.state === "down" &&
      resolved.triggerButtons.includes(event.button),
  );
  const segments: AutoZoomWorkingSegment[] = [];

  triggers.forEach((trigger) => {
    let startUs = Math.max(0, trigger.timeUs - resolved.leadUs);
    let endUs = Math.min(sidecar.durationUs, trigger.timeUs + resolved.holdUs + resolved.tailUs);
    if (endUs <= startUs) return;
    const previous = segments[segments.length - 1];
    if (
      previous &&
      startUs <= previous.endUs + resolved.mergeGapUs &&
      distance(previous.focus, trigger) <= resolved.mergeDistance
    ) {
      const count = previous.triggerCount + 1;
      previous.focus = {
        x: (previous.focus.x * previous.triggerCount + trigger.x) / count,
        y: (previous.focus.y * previous.triggerCount + trigger.y) / count,
      };
      previous.endUs = Math.max(previous.endUs, endUs);
      previous.triggerCount = count;
      previous.easeOutUs = Math.min(resolved.easeOutUs, previous.endUs - previous.startUs);
      return;
    }

    if (previous && startUs < previous.endUs) {
      const boundary = clamp(trigger.timeUs, previous.startUs + 1, previous.endUs);
      previous.endUs = boundary;
      previous.easeInUs = Math.min(previous.easeInUs, previous.endUs - previous.startUs);
      previous.easeOutUs = Math.min(previous.easeOutUs, previous.endUs - previous.startUs - previous.easeInUs);
      startUs = boundary;
    }
    if (endUs <= startUs) return;
    const durationUs = endUs - startUs;
    const easeInUs = Math.min(resolved.easeInUs, Math.floor(durationUs / 2));
    const easeOutUs = Math.min(resolved.easeOutUs, durationUs - easeInUs);
    segments.push({
      id: `auto-zoom-${segments.length + 1}-${trigger.timeUs}`,
      startUs,
      endUs,
      focus: { x: trigger.x, y: trigger.y },
      scale: resolved.scale,
      easeInUs,
      easeOutUs,
      source: "auto",
      triggerCount: 1,
    });
  });

  const result = segments.map(({ triggerCount: _triggerCount, ...segment }) => segment);
  validateZoomSegments(result, sidecar.durationUs);
  return result;
}

export type ZoomOperation =
  | { readonly type: "zoom.add"; readonly segment: ZoomSegment }
  | {
      readonly type: "zoom.update";
      readonly id: string;
      readonly changes: Partial<Omit<ZoomSegment, "id" | "source">>;
    }
  | { readonly type: "zoom.delete"; readonly id: string }
  | { readonly type: "zoom.replace"; readonly segments: readonly ZoomSegment[] };

export function reduceZoomSegments(
  segments: readonly ZoomSegment[],
  operation: ZoomOperation,
  durationUs: TimeUs,
): ZoomSegment[] {
  validateZoomSegments(segments, durationUs);
  let next: ZoomSegment[];
  switch (operation.type) {
    case "zoom.add":
      if (segments.some((segment) => segment.id === operation.segment.id)) {
        throw new CursorZoomValidationError("zoom.add.segment.id", "must be unique");
      }
      next = [...segments, cloneZoomSegment(operation.segment)];
      break;
    case "zoom.update": {
      const index = segments.findIndex((segment) => segment.id === operation.id);
      if (index < 0) throw new CursorZoomValidationError("zoom.update.id", "was not found");
      next = segments.map((segment, segmentIndex) =>
        segmentIndex === index
          ? {
              ...segment,
              ...operation.changes,
              focus: operation.changes.focus
                ? { ...operation.changes.focus }
                : segment.focus,
            }
          : cloneZoomSegment(segment),
      );
      break;
    }
    case "zoom.delete": {
      if (!segments.some((segment) => segment.id === operation.id)) {
        throw new CursorZoomValidationError("zoom.delete.id", "was not found");
      }
      next = segments
        .filter((segment) => segment.id !== operation.id)
        .map(cloneZoomSegment);
      break;
    }
    case "zoom.replace":
      next = operation.segments.map(cloneZoomSegment);
      break;
    default:
      return assertNever(operation);
  }
  next.sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
  validateZoomSegments(next, durationUs);
  return next;
}

export function validateZoomSegments(
  segments: readonly ZoomSegment[],
  durationUs: TimeUs,
): void {
  expectSafeTime(durationUs, "zoom.durationUs");
  const ids = new Set<string>();
  let previousEndUs = 0;
  segments.forEach((segment, index) => {
    const path = `zoom.segments.${index}`;
    expectRecord(segment, path);
    expectSafeIdentifier(segment.id, `${path}.id`);
    expect(!ids.has(segment.id), `${path}.id`, "must be unique");
    ids.add(segment.id);
    expectSafeTime(segment.startUs, `${path}.startUs`);
    expectSafeTime(segment.endUs, `${path}.endUs`);
    expect(segment.endUs > segment.startUs, path, "must have positive duration");
    expect(segment.endUs <= durationUs, `${path}.endUs`, "exceeds durationUs");
    expect(segment.startUs >= previousEndUs, `${path}.startUs`, "overlaps the previous segment");
    previousEndUs = segment.endUs;
    expectNormalizedPoint(segment.focus, `${path}.focus`);
    expectFiniteInRange(segment.scale, `${path}.scale`, 1, 4.5);
    expectSafeTime(segment.easeInUs, `${path}.easeInUs`);
    expectSafeTime(segment.easeOutUs, `${path}.easeOutUs`);
    expect(
      segment.easeInUs + segment.easeOutUs <= segment.endUs - segment.startUs,
      path,
      "easing exceeds segment duration",
    );
    expect(
      segment.source === "auto" || segment.source === "manual",
      `${path}.source`,
      "is invalid",
    );
  });
}

export interface EvaluatedZoom extends NormalizedPoint {
  readonly scale: number;
  readonly influence: number;
  readonly segmentId: string | undefined;
}

export function evaluateZoomAt(
  segments: readonly ZoomSegment[],
  timeUs: TimeUs,
): EvaluatedZoom {
  const segment = findZoomSegmentAt(segments, timeUs);
  if (!segment) return { x: 0.5, y: 0.5, scale: 1, influence: 0, segmentId: undefined };
  const enter =
    segment.easeInUs === 0
      ? 1
      : smootherStep(clamp01((timeUs - segment.startUs) / segment.easeInUs));
  const exit =
    segment.easeOutUs === 0
      ? 1
      : smootherStep(clamp01((segment.endUs - timeUs) / segment.easeOutUs));
  const influence = Math.min(enter, exit);
  return {
    x: mix(0.5, segment.focus.x, influence),
    y: mix(0.5, segment.focus.y, influence),
    scale: mix(1, segment.scale, influence),
    influence,
    segmentId: segment.id,
  };
}

export interface PreviewTransform {
  readonly scale: number;
  /** Translation after scaling in normalized canvas units. */
  readonly translateX: number;
  readonly translateY: number;
  /** Edge-safe source point placed at the preview center. */
  readonly centerX: number;
  readonly centerY: number;
}

export function previewTransformForZoom(zoom: EvaluatedZoom): PreviewTransform {
  const scale = Math.max(1, zoom.scale);
  const halfViewport = 0.5 / scale;
  const centerX = clamp(zoom.x, halfViewport, 1 - halfViewport);
  const centerY = clamp(zoom.y, halfViewport, 1 - halfViewport);
  return {
    scale,
    translateX: 0.5 - centerX * scale,
    translateY: 0.5 - centerY * scale,
    centerX,
    centerY,
  };
}

export function applyPreviewTransform(
  point: NormalizedPoint,
  transform: PreviewTransform,
): NormalizedPoint {
  return {
    x: point.x * transform.scale + transform.translateX,
    y: point.y * transform.scale + transform.translateY,
  };
}

export interface PreviewCursorState extends CursorRenderState {
  readonly canvasX: number;
  readonly canvasY: number;
  readonly insideCanvas: boolean;
}

export interface CursorZoomPreviewFrame {
  readonly zoom: EvaluatedZoom;
  readonly transform: PreviewTransform;
  readonly cursor: PreviewCursorState | undefined;
}

export function evaluateCursorZoomPreview(
  track: PreparedCursorTrack,
  segments: readonly ZoomSegment[],
  timeUs: TimeUs,
  cursorOptions: Partial<CursorRenderOptions> = {},
): CursorZoomPreviewFrame {
  const zoom = evaluateZoomAt(segments, timeUs);
  const transform = previewTransformForZoom(zoom);
  const cursor = cursorRenderStateAt(track, timeUs, cursorOptions);
  if (!cursor) return { zoom, transform, cursor: undefined };
  const canvasPoint = applyPreviewTransform(cursor, transform);
  return {
    zoom,
    transform,
    cursor: {
      ...cursor,
      canvasX: canvasPoint.x,
      canvasY: canvasPoint.y,
      insideCanvas:
        canvasPoint.x >= 0 &&
        canvasPoint.x <= 1 &&
        canvasPoint.y >= 0 &&
        canvasPoint.y <= 1,
    },
  };
}

function findZoomSegmentAt(
  segments: readonly ZoomSegment[],
  timeUs: TimeUs,
): ZoomSegment | undefined {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle]!.startUs <= timeUs) low = middle + 1;
    else high = middle;
  }
  const candidate = segments[low - 1];
  return candidate && timeUs < candidate.endUs ? candidate : undefined;
}

function resolveSmoothingOptions(
  options: Partial<CursorSmoothingOptions>,
): CursorSmoothingOptions {
  const resolved = { ...DEFAULT_CURSOR_SMOOTHING, ...options };
  expectFiniteInRange(resolved.strength, "cursorSmoothing.strength", 0, 1);
  expectPositiveInteger(resolved.responseUs, "cursorSmoothing.responseUs");
  expectPositiveInteger(resolved.maxGapUs, "cursorSmoothing.maxGapUs");
  expectFiniteInRange(resolved.curve, "cursorSmoothing.curve", 0, 1);
  expectFiniteInRange(
    resolved.movementThreshold,
    "cursorSmoothing.movementThreshold",
    0,
    1,
  );
  return resolved;
}

function resolveRenderOptions(options: Partial<CursorRenderOptions>): CursorRenderOptions {
  const resolved = { ...DEFAULT_CURSOR_RENDER, ...options };
  expectSafeTime(resolved.idleDelayUs, "cursorRender.idleDelayUs");
  expectSafeTime(resolved.idleFadeUs, "cursorRender.idleFadeUs");
  expectSafeTime(resolved.clickAttackUs, "cursorRender.clickAttackUs");
  expectPositiveInteger(resolved.clickDurationUs, "cursorRender.clickDurationUs");
  expect(
    resolved.clickAttackUs <= resolved.clickDurationUs,
    "cursorRender.clickAttackUs",
    "exceeds clickDurationUs",
  );
  return resolved;
}

function resolveAutoZoomOptions(options: Partial<AutoZoomOptions>): AutoZoomOptions {
  const resolved = { ...DEFAULT_AUTO_ZOOM, ...options };
  expectFiniteInRange(resolved.scale, "autoZoom.scale", 1, 4.5);
  expectSafeTime(resolved.leadUs, "autoZoom.leadUs");
  expectSafeTime(resolved.holdUs, "autoZoom.holdUs");
  expectSafeTime(resolved.tailUs, "autoZoom.tailUs");
  expectSafeTime(resolved.easeInUs, "autoZoom.easeInUs");
  expectSafeTime(resolved.easeOutUs, "autoZoom.easeOutUs");
  expectSafeTime(resolved.mergeGapUs, "autoZoom.mergeGapUs");
  expectFiniteInRange(resolved.mergeDistance, "autoZoom.mergeDistance", 0, Math.SQRT2);
  expect(
    resolved.triggerButtons.length > 0 && resolved.triggerButtons.every(isCursorButton),
    "autoZoom.triggerButtons",
    "must contain valid cursor buttons",
  );
  return resolved;
}

function visibilityAt(events: readonly CursorVisibilityEvent[], timeUs: TimeUs): boolean {
  const index = upperBoundByTime(events, timeUs) - 1;
  return index < 0 ? true : events[index]!.visible;
}

function upperBoundByTime<T extends { readonly timeUs: number }>(
  items: readonly T[],
  timeUs: number,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.timeUs <= timeUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundNumber(items: readonly number[], value: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function responseAlpha(deltaUs: number, responseUs: number): number {
  return 1 - Math.exp(-Math.max(0, deltaUs) / Math.max(1, responseUs));
}

function distance(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function cloneZoomSegment(segment: ZoomSegment): ZoomSegment {
  return { ...segment, focus: { ...segment.focus } };
}

function isCursorButton(value: unknown): value is CursorButton {
  return typeof value === "string" && (CURSOR_BUTTONS as readonly string[]).includes(value);
}

const CURSOR_BUTTONS: readonly CursorButton[] = ["left", "right", "middle", "x1", "x2"];

function expectRecord(value: unknown, path: string): asserts value is Record<string, any> {
  expect(typeof value === "object" && value !== null && !Array.isArray(value), path, "must be an object");
}

interface AutoZoomWorkingSegment {
  id: string;
  startUs: TimeUs;
  endUs: TimeUs;
  focus: { x: number; y: number };
  scale: number;
  easeInUs: TimeUs;
  easeOutUs: TimeUs;
  source: "auto";
  triggerCount: number;
}

function expectNormalizedPoint<T>(value: T, path: string): asserts value is T & NormalizedPoint {
  expectRecord(value, path);
  expectFiniteInRange(value.x, `${path}.x`, 0, 1);
  expectFiniteInRange(value.y, `${path}.y`, 0, 1);
}

function expectPositiveInteger(value: unknown, path: string): asserts value is number {
  expect(
    Number.isSafeInteger(value) && (value as number) >= 1,
    path,
    "must be a positive safe integer",
  );
}

function expectSafeTime(value: unknown, path: string): asserts value is number {
  expect(
    Number.isSafeInteger(value) && (value as number) >= 0,
    path,
    "must be a non-negative integer number of microseconds",
  );
}

function expectSafeIdentifier(value: unknown, path: string): asserts value is string {
  expect(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    path,
    "must be a safe identifier",
  );
}

function expectFinite(value: unknown, path: string): asserts value is number {
  expect(typeof value === "number" && Number.isFinite(value), path, "must be finite");
}

function expectFiniteInRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  expectFinite(value, path);
  expect(value >= minimum && value <= maximum, path, `must be between ${minimum} and ${maximum}`);
}

function expect(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new CursorZoomValidationError(path, message);
}

function smootherStep(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mix(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clampBetween(value: number, first: number, second: number): number {
  return clamp(value, Math.min(first, second), Math.max(first, second));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertNever(value: never): never {
  throw new CursorZoomValidationError("zoom.operation", `unhandled operation ${JSON.stringify(value)}`);
}
