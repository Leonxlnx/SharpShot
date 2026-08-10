import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MAX_NATIVE_CURSOR_BYTES,
  MAX_GENERATED_AUTO_ZOOMS,
  mapClickZoomsToProjectTimeline,
  parseNativeCursorJsonl,
  readNativeCursorSidecar,
} from "../src/main/cursor-autozoom.js"
import { parseAutoZoomGenerateRequest } from "../src/shared/api.js"
import { createClipForVideoAsset, createDefaultProject, type VideoAsset } from "../src/shared/project.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("native cursor metadata adapter", () => {
  it("strictly converts native click samples and maps them through trims and speed", () => {
    const sidecar = parseNativeCursorJsonl(nativeJsonl([
      sample(30_000_000, 300, 200, 1, 1, 0, 0),
      sample(30_100_000, 300, 200, 0, 0, 1, 1),
      sample(60_000_000, 800, 600, 1, 1, 0, 0),
      sample(60_100_000, 800, 600, 0, 0, 1, 1),
    ]))
    const asset: VideoAsset = {
      id: "video-a",
      kind: "video",
      name: "Recording.mp4",
      locator: { kind: "managed", relativePath: "library/video-a" },
      durationUs: 10_000_000,
      width: 1_000,
      height: 800,
      frameRate: { numerator: 60, denominator: 1 },
    }
    const project = createDefaultProject({ id: "project-a", now: "2026-08-10T00:00:00.000Z" })
    project.assets[asset.id] = asset
    project.clips = [
      createClipForVideoAsset(asset, {
        id: "fast-trim",
        sourceInUs: 1_000_000,
        sourceOutUs: 5_000_000,
        speed: 2,
      }),
      createClipForVideoAsset(asset, {
        id: "slow-trim",
        sourceInUs: 5_000_000,
        sourceOutUs: 9_000_000,
        speed: 0.5,
      }),
    ]

    expect(sidecar.events).toHaveLength(4)
    expect(mapClickZoomsToProjectTimeline(sidecar, project, asset.id)).toMatchObject([
      {
        id: "auto-click-1-1",
        startUs: 870_000,
        endUs: 1_620_000,
        focus: { x: 0.3, y: 0.25 },
        source: "auto",
      },
      {
        id: "auto-click-2-2",
        startUs: 3_480_000,
        endUs: 6_480_000,
        focus: { x: 0.8, y: 0.75 },
        source: "auto",
      },
    ])
  })

  it("supports a fast click in one sample but rejects malformed ordering and counts", () => {
    const fastClick = parseNativeCursorJsonl(nativeJsonl([
      sample(10_000_000, 500, 400, 0, 1, 1, 1),
    ]))
    expect(fastClick.events.map((event) => event.kind === "button" ? event.state : "other"))
      .toEqual(["down", "up"])

    expect(() => parseNativeCursorJsonl(nativeJsonl([
      sample(20_000_000, 500, 400, 0, 1, 1, 1),
      sample(10_000_000, 500, 400, 0, 0, 0, 0),
    ]))).toThrow(/out of order/)
    expect(() => parseNativeCursorJsonl(nativeJsonl([
      sample(10_000_000, 500, 400, 0, 1, 1, 1),
    ], 2))).toThrow(/sample count/)
    expect(() => parseNativeCursorJsonl(nativeJsonl([
      sample(10_000_000, 500, 400, 0, 1, 0, 0),
    ]))).toThrow(/impossible button transition/)

    const farOutside = sample(10_000_000, 500, 400, 0, 0, 0, 0)
    farOutside.screen = { x: 2_147_483_647, y: -2_147_483_648 }
    farOutside.normalized = { x: 2_147.483_647, y: -2_147.483_648 }
    farOutside.inside = false
    expect(parseNativeCursorJsonl(nativeJsonl([farOutside])).events).toEqual([])
  })

  it("bounds click-to-clip expansion", () => {
    const sidecar = parseNativeCursorJsonl(nativeJsonl([
      sample(10_000_000, 500, 400, 0, 1, 1, 1),
    ]))
    const asset: VideoAsset = {
      id: "repeated-video",
      kind: "video",
      name: "Repeated.mp4",
      locator: { kind: "managed", relativePath: "library/repeated-video" },
      durationUs: 10_000_000,
      width: 1_000,
      height: 800,
      frameRate: { numerator: 60, denominator: 1 },
    }
    const project = createDefaultProject({ id: "repeated-project", now: "2026-08-10T00:00:00.000Z" })
    project.assets[asset.id] = asset
    project.clips = Array.from({ length: MAX_GENERATED_AUTO_ZOOMS + 1 }, (_, index) =>
      createClipForVideoAsset(asset, {
        id: `repeat-${index}`,
        sourceInUs: 0,
        sourceOutUs: 3_000_000,
      }))

    expect(() => mapClickZoomsToProjectTimeline(sidecar, project, asset.id))
      .toThrow(/too many automatic zooms/)
  })

  it("rejects an oversized sidecar before reading it into memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharpshot-autozoom-"))
    temporaryRoots.push(root)
    const path = join(root, "oversized.cursor.jsonl")
    const file = await open(path, "w")
    await file.truncate(MAX_NATIVE_CURSOR_BYTES + 1)
    await file.close()

    await expect(readNativeCursorSidecar(path)).rejects.toMatchObject({ code: "CURSOR_METADATA_TOO_LARGE" })
    await expect(readNativeCursorSidecar(join(root, "missing.cursor.jsonl")))
      .rejects.toMatchObject({ code: "CURSOR_METADATA_UNAVAILABLE" })
  })
})

describe("auto zoom IPC request", () => {
  it("accepts identifiers only and never accepts a renderer path", () => {
    expect(parseAutoZoomGenerateRequest({ projectId: "project-a", assetId: "video-a" }))
      .toEqual({ projectId: "project-a", assetId: "video-a" })
    expect(() => parseAutoZoomGenerateRequest({
      projectId: "project-a",
      assetId: "video-a",
      path: "C:\\private\\recording.cursor.jsonl",
    })).toThrow(/unsupported field: path/)
  })
})

function nativeJsonl(samples: readonly Record<string, unknown>[], declaredSamples = samples.length): string {
  const header = {
    kind: "header",
    format: "sharpshot-cursor",
    version: 1,
    timebase: 10_000_000,
    coordinateSpace: "physical-pixels",
    sampling: "video-frame-state-change",
    buttonBits: { left: 1, right: 2, middle: 4, x1: 8, x2: 16 },
    region: { left: 0, top: 0, width: 1_000, height: 800 },
  }
  const shape = {
    kind: "shape",
    id: 1,
    name: "arrow",
    identity: "system:arrow",
    hotspot: { x: 0, y: 0 },
    size: { width: 32, height: 32 },
  }
  return [
    header,
    shape,
    ...samples,
    { kind: "end", t: 100_000_000, samples: declaredSamples },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n"
}

function sample(
  t: number,
  x: number,
  y: number,
  buttons: number,
  down: number,
  up: number,
  click: number,
): Record<string, unknown> {
  return {
    kind: "sample",
    t,
    screen: { x, y },
    normalized: { x: x / 1_000, y: y / 800 },
    inside: true,
    visible: true,
    shape: 1,
    buttons,
    down,
    up,
    click,
  }
}
