import { open, type FileHandle } from "node:fs/promises"
import { TextDecoder } from "node:util"
import {
  createCursorSidecar,
  generateAutoZoomSegments,
  validateZoomSegments,
  type CursorButton,
  type CursorButtonEvent,
  type CursorSidecar,
  type ZoomSegment,
} from "../shared/cursor-zoom.js"
import { buildClipSpans, projectDurationUs } from "../shared/editor-reducer.js"
import type { EditorProject } from "../shared/project.js"
import { StorageError } from "./storage.js"

export const MAX_NATIVE_CURSOR_BYTES = 32 * 1024 * 1024
const MAX_NATIVE_CURSOR_LINES = 500_000
const MAX_NATIVE_CURSOR_EVENTS = 250_000
const MAX_NATIVE_CURSOR_LINE_BYTES = 16 * 1024
export const MAX_GENERATED_AUTO_ZOOMS = 5_000
const MAX_AUTO_ZOOM_MAPPING_WORK = 100_000
const NATIVE_TIMEBASE = 10_000_000
const MIN_NATIVE_NORMALIZED = -2_147.483_648
const MAX_NATIVE_NORMALIZED = 2_147.483_647
const BUTTONS: ReadonlyArray<readonly [CursorButton, number]> = [
  ["left", 1],
  ["right", 2],
  ["middle", 4],
  ["x1", 8],
  ["x2", 16],
]

export async function readNativeCursorSidecar(path: string): Promise<CursorSidecar> {
  let file: FileHandle
  try {
    file = await open(path, "r")
  } catch {
    throw new StorageError("CURSOR_METADATA_UNAVAILABLE", "Cursor metadata is no longer available.")
  }
  try {
    const details = await file.stat()
    if (!details.isFile()) throw invalid("Cursor metadata is not a file.")
    if (details.size > MAX_NATIVE_CURSOR_BYTES) {
      throw new StorageError("CURSOR_METADATA_TOO_LARGE", "Cursor metadata is too large to process safely.")
    }
    const bytes = Buffer.allocUnsafe(details.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const afterRead = await file.stat()
    if (offset !== details.size || afterRead.size !== details.size) {
      throw invalid("Cursor metadata changed while it was being read.")
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw invalid("Cursor metadata is not valid UTF-8.")
    }
    return parseNativeCursorJsonl(text)
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw invalid("Cursor metadata could not be read.")
  } finally {
    await file.close().catch(() => undefined)
  }
}

export function parseNativeCursorJsonl(text: string): CursorSidecar {
  if (Buffer.byteLength(text, "utf8") > MAX_NATIVE_CURSOR_BYTES) {
    throw new StorageError("CURSOR_METADATA_TOO_LARGE", "Cursor metadata is too large to process safely.")
  }
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.length < 2 || lines.length > MAX_NATIVE_CURSOR_LINES) {
    throw invalid("Cursor metadata has an invalid line count.")
  }

  const header = parseLine(lines[0]!, 1)
  expectRecord(header, "header")
  expectOnlyKeys(
    header,
    ["kind", "format", "version", "timebase", "coordinateSpace", "sampling", "buttonBits", "region"],
    "header",
  )
  expect(header.kind === "header", "The first cursor metadata line must be a header.")
  expect(header.format === "sharpshot-cursor", "Cursor metadata has an unsupported format.")
  expect(header.version === 1, "Cursor metadata has an unsupported version.")
  expect(header.timebase === NATIVE_TIMEBASE, "Cursor metadata has an unsupported timebase.")
  expect(header.coordinateSpace === "physical-pixels", "Cursor metadata has an unsupported coordinate space.")
  expect(header.sampling === "video-frame-state-change", "Cursor metadata has an unsupported sampling mode.")
  validateButtonBits(header.buttonBits)
  const region = validateRegion(header.region)

  const shapes = new Set<number>()
  const events: CursorButtonEvent[] = []
  let sampleCount = 0
  let previousTicks = -1
  let previousButtons = 0
  let sawSample = false
  let endTicks: number | undefined

  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const value = parseLine(lines[index]!, lineNumber)
    expectRecord(value, `line ${lineNumber}`)
    if (value.kind === "shape") {
      expect(!sawSample && endTicks === undefined, `Cursor shape at line ${lineNumber} is out of order.`)
      validateShape(value, shapes, lineNumber)
      continue
    }
    if (value.kind === "sample") {
      expect(endTicks === undefined, `Cursor sample at line ${lineNumber} follows the end marker.`)
      sawSample = true
      const sample = validateSample(value, shapes, previousTicks, previousButtons, region, lineNumber)
      previousTicks = sample.ticks
      previousButtons = sample.buttons
      sampleCount += 1
      if (sample.inside && sample.visible) {
        appendButtonEvents(events, sample.timeUs, sample.x, sample.y, sample.down, "down")
        appendButtonEvents(events, sample.timeUs, sample.x, sample.y, sample.up, "up")
      }
      expect(events.length <= MAX_NATIVE_CURSOR_EVENTS, "Cursor metadata contains too many button events.")
      continue
    }
    if (value.kind === "end") {
      expect(index === lines.length - 1, "The cursor metadata end marker must be last.")
      expectOnlyKeys(value, ["kind", "t", "samples"], `line ${lineNumber}`)
      const ticks = expectSafeInteger(value.t, `line ${lineNumber}.t`, 0)
      const declaredSamples = expectSafeInteger(value.samples, `line ${lineNumber}.samples`, 0)
      expect(ticks >= previousTicks, "Cursor metadata ends before its final sample.")
      expect(declaredSamples === sampleCount, "Cursor metadata sample count does not match its end marker.")
      endTicks = ticks
      continue
    }
    throw invalid(`Cursor metadata line ${lineNumber} has an unsupported kind.`)
  }

  expect(endTicks !== undefined, "Cursor metadata is missing its end marker.")
  return createCursorSidecar({
    durationUs: ticksToUs(endTicks),
    capture: {
      width: region.width,
      height: region.height,
      originX: region.left,
      originY: region.top,
      scaleFactor: 1,
    },
    events,
  })
}

export function mapClickZoomsToProjectTimeline(
  sidecar: CursorSidecar,
  project: EditorProject,
  assetId: string,
): ZoomSegment[] {
  const asset = project.assets[assetId]
  if (asset?.kind !== "video") {
    throw new StorageError("PROJECT_ASSET_MISMATCH", "Auto zoom requires a video asset in this project.")
  }
  const sourceSegments = generateAutoZoomSegments(sidecar)
  const result: ZoomSegment[] = []
  const spans = buildClipSpans(project.clips)
  let mappingWork = 0

  for (const span of spans) {
    if (span.clip.assetId !== assetId) continue
    for (
      let sourceIndex = firstSegmentEndingAfter(sourceSegments, span.clip.sourceInUs);
      sourceIndex < sourceSegments.length;
      sourceIndex += 1
    ) {
      const source = sourceSegments[sourceIndex]!
      if (source.startUs >= span.clip.sourceOutUs) break
      mappingWork += 1
      if (mappingWork > MAX_AUTO_ZOOM_MAPPING_WORK) {
        throw new StorageError("AUTO_ZOOM_LIMIT", "This project has too many click/clip intersections for auto zoom.")
      }
      const sourceStartUs = Math.max(source.startUs, span.clip.sourceInUs)
      const sourceEndUs = Math.min(source.endUs, span.clip.sourceOutUs)
      if (sourceEndUs <= sourceStartUs) continue
      const startUs = span.timelineInUs + Math.round((sourceStartUs - span.clip.sourceInUs) / span.clip.speed)
      const endUs = span.timelineInUs + Math.round((sourceEndUs - span.clip.sourceInUs) / span.clip.speed)
      if (endUs <= startUs) continue
      const durationUs = endUs - startUs
      const requestedEaseInUs = sourceStartUs === source.startUs
        ? Math.round(source.easeInUs / span.clip.speed)
        : 0
      const requestedEaseOutUs = sourceEndUs === source.endUs
        ? Math.round(source.easeOutUs / span.clip.speed)
        : 0
      const easeInUs = Math.min(requestedEaseInUs, Math.floor(durationUs / 2))
      const easeOutUs = Math.min(requestedEaseOutUs, durationUs - easeInUs)
      result.push({
        id: `auto-click-${span.index + 1}-${result.length + 1}`,
        startUs,
        endUs,
        focus: { ...source.focus },
        scale: source.scale,
        easeInUs,
        easeOutUs,
        source: "auto",
      })
      if (result.length > MAX_GENERATED_AUTO_ZOOMS) {
        throw new StorageError("AUTO_ZOOM_LIMIT", "This project would create too many automatic zooms.")
      }
    }
  }

  validateZoomSegments(result, projectDurationUs(project))
  return result
}

function firstSegmentEndingAfter(segments: readonly ZoomSegment[], sourceUs: number): number {
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (segments[middle]!.endUs <= sourceUs) low = middle + 1
    else high = middle
  }
  return low
}

type NativeRegion = { left: number; top: number; width: number; height: number }

function parseLine(line: string, lineNumber: number): unknown {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_NATIVE_CURSOR_LINE_BYTES) {
    throw invalid(`Cursor metadata line ${lineNumber} has an invalid length.`)
  }
  try {
    return JSON.parse(normalized)
  } catch {
    throw invalid(`Cursor metadata line ${lineNumber} is not valid JSON.`)
  }
}

function validateButtonBits(value: unknown): void {
  expectRecord(value, "header.buttonBits")
  expectOnlyKeys(value, ["left", "right", "middle", "x1", "x2"], "header.buttonBits")
  for (const [button, bit] of BUTTONS) {
    expect(value[button] === bit, `Cursor metadata has an invalid ${button} button bit.`)
  }
}

function validateRegion(value: unknown): NativeRegion {
  expectRecord(value, "header.region")
  expectOnlyKeys(value, ["left", "top", "width", "height"], "header.region")
  return {
    left: expectIntegerInRange(value.left, "header.region.left", -2_147_483_648, 2_147_483_647),
    top: expectIntegerInRange(value.top, "header.region.top", -2_147_483_648, 2_147_483_647),
    width: expectIntegerInRange(value.width, "header.region.width", 1, 131_072),
    height: expectIntegerInRange(value.height, "header.region.height", 1, 131_072),
  }
}

function validateShape(value: Record<string, unknown>, shapes: Set<number>, lineNumber: number): void {
  expectOnlyKeys(value, ["kind", "id", "name", "identity", "hotspot", "size"], `line ${lineNumber}`)
  const id = expectIntegerInRange(value.id, `line ${lineNumber}.id`, 1, 65_535)
  expect(!shapes.has(id), `Cursor shape ${id} is defined more than once.`)
  expectShortString(value.name, `line ${lineNumber}.name`, 64)
  expectShortString(value.identity, `line ${lineNumber}.identity`, 128)
  expectPoint(value.hotspot, `line ${lineNumber}.hotspot`, -131_072, 131_072)
  expectPoint(value.size, `line ${lineNumber}.size`, 0, 131_072, "width", "height")
  shapes.add(id)
}

function validateSample(
  value: Record<string, unknown>,
  shapes: ReadonlySet<number>,
  previousTicks: number,
  previousButtons: number,
  region: NativeRegion,
  lineNumber: number,
): {
  ticks: number
  timeUs: number
  x: number
  y: number
  inside: boolean
  visible: boolean
  buttons: number
  down: number
  up: number
} {
  const name = `line ${lineNumber}`
  expectOnlyKeys(
    value,
    ["kind", "t", "screen", "normalized", "inside", "visible", "shape", "buttons", "down", "up", "click"],
    name,
  )
  const ticks = expectSafeInteger(value.t, `${name}.t`, 0)
  expect(ticks >= previousTicks, `Cursor metadata timestamp at line ${lineNumber} is out of order.`)
  const screen = expectPoint(value.screen, `${name}.screen`, -2_147_483_648, 2_147_483_647)
  const normalized = expectFinitePoint(
    value.normalized,
    `${name}.normalized`,
    MIN_NATIVE_NORMALIZED,
    MAX_NATIVE_NORMALIZED,
  )
  const inside = expectBoolean(value.inside, `${name}.inside`)
  const visible = expectBoolean(value.visible, `${name}.visible`)
  expect(!inside || visible, `Cursor metadata line ${lineNumber} cannot be inside while hidden.`)
  if (inside) {
    expect(normalized.x >= 0 && normalized.x < 1 && normalized.y >= 0 && normalized.y < 1,
      `Cursor metadata line ${lineNumber} has an out-of-bounds inside position.`)
  }
  const expectedX = clamp((screen.x - region.left) / region.width, MIN_NATIVE_NORMALIZED, MAX_NATIVE_NORMALIZED)
  const expectedY = clamp((screen.y - region.top) / region.height, MIN_NATIVE_NORMALIZED, MAX_NATIVE_NORMALIZED)
  expect(Math.abs(expectedX - normalized.x) <= 0.000_002 && Math.abs(expectedY - normalized.y) <= 0.000_002,
    `Cursor metadata line ${lineNumber} has inconsistent coordinates.`)
  const shape = expectIntegerInRange(value.shape, `${name}.shape`, 0, 65_535)
  expect(shape === 0 || shapes.has(shape), `Cursor metadata line ${lineNumber} references an unknown shape.`)
  const buttons = expectIntegerInRange(value.buttons, `${name}.buttons`, 0, 31)
  const down = expectIntegerInRange(value.down, `${name}.down`, 0, 31)
  const up = expectIntegerInRange(value.up, `${name}.up`, 0, 31)
  const click = expectIntegerInRange(value.click, `${name}.click`, 0, 31)
  validateButtonTransition(previousButtons, buttons, down, up, click, lineNumber)
  return { ticks, timeUs: ticksToUs(ticks), x: normalized.x, y: normalized.y, inside, visible, buttons, down, up }
}

function validateButtonTransition(
  previous: number,
  current: number,
  down: number,
  up: number,
  click: number,
  lineNumber: number,
): void {
  for (const [, bit] of BUTTONS) {
    const wasDown = (previous & bit) !== 0
    const isDown = (current & bit) !== 0
    const pressed = (down & bit) !== 0
    const released = (up & bit) !== 0
    const clicked = (click & bit) !== 0
    const valid = !wasDown && isDown
      ? pressed && !released && !clicked
      : wasDown && !isDown
        ? !pressed && released && clicked
        : !wasDown && !isDown
          ? (!pressed && !released && !clicked) || (pressed && released && clicked)
          : !pressed && !released && !clicked
    expect(valid, `Cursor metadata line ${lineNumber} has an impossible button transition.`)
  }
}

function appendButtonEvents(
  events: CursorButtonEvent[],
  timeUs: number,
  x: number,
  y: number,
  mask: number,
  state: "down" | "up",
): void {
  for (const [button, bit] of BUTTONS) {
    if ((mask & bit) !== 0) events.push({ kind: "button", timeUs, x, y, button, state })
  }
}

function expectPoint(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  xKey = "x",
  yKey = "y",
): { x: number; y: number } {
  expectRecord(value, name)
  expectOnlyKeys(value, [xKey, yKey], name)
  return {
    x: expectIntegerInRange(value[xKey], `${name}.${xKey}`, minimum, maximum),
    y: expectIntegerInRange(value[yKey], `${name}.${yKey}`, minimum, maximum),
  }
}

function expectFinitePoint(value: unknown, name: string, minimum: number, maximum: number): { x: number; y: number } {
  expectRecord(value, name)
  expectOnlyKeys(value, ["x", "y"], name)
  return {
    x: expectFiniteInRange(value.x, `${name}.x`, minimum, maximum),
    y: expectFiniteInRange(value.y, `${name}.y`, minimum, maximum),
  }
}

function expectRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  expect(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object.`)
}

function expectOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    expect(allowed.includes(key), `${name} contains an unsupported field: ${key}.`)
  }
  for (const key of allowed) expect(Object.hasOwn(value, key), `${name} is missing ${key}.`)
}

function expectBoolean(value: unknown, name: string): boolean {
  expect(typeof value === "boolean", `${name} must be a boolean.`)
  return value
}

function expectShortString(value: unknown, name: string, maximum: number): string {
  expect(typeof value === "string" && value.length > 0 && value.length <= maximum, `${name} is invalid.`)
  return value
}

function expectSafeInteger(value: unknown, name: string, minimum: number): number {
  expect(Number.isSafeInteger(value) && (value as number) >= minimum, `${name} must be an integer >= ${minimum}.`)
  return value as number
}

function expectIntegerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  expect(Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum,
    `${name} must be an integer between ${minimum} and ${maximum}.`)
  return value as number
}

function expectFiniteInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  expect(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum,
    `${name} must be between ${minimum} and ${maximum}.`)
  return value
}

function ticksToUs(ticks: number): number {
  return Math.round(ticks / (NATIVE_TIMEBASE / 1_000_000))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw invalid(message)
}

function invalid(message: string): StorageError {
  return new StorageError("CURSOR_METADATA_INVALID", message)
}
