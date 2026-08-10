import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildAudioFilterPlan,
  buildAudioInputArgs,
  createAudioClip,
  createAudioLane,
  createAudioTimeline,
} from "../src/shared/audio-timeline.js"

const run = promisify(execFile)
const ffmpeg = fileURLToPath(new URL("../resources/ffmpeg/win32-x64/ffmpeg.exe", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe("pinned FFmpeg audio planning", () => {
  it.runIf(process.platform === "win32" && existsSync(ffmpeg))(
    "preserves a lone clip's nonzero timeline offset with the silence bed",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "sharpshot-audio-smoke-"))
      temporaryDirectories.push(directory)
      const source = join(directory, "source.wav")
      const output = join(directory, "output.wav")
      await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=0.25",
        "-c:a", "pcm_s16le", source,
      ])

      const timeline = createAudioTimeline({
        durationUs: 2_000_000,
        assets: {
          music: {
            id: "music",
            kind: "music",
            name: "Smoke tone",
            locator: { kind: "library" },
            durationUs: 250_000,
            sampleRate: 44_100,
            channels: 1,
          },
        },
        lanes: [createAudioLane({
          id: "music",
          kind: "music",
          clips: [createAudioClip({
            id: "clip",
            assetId: "music",
            timelineStartUs: 1_000_000,
            sourceOutUs: 250_000,
          })],
        })],
      })
      const plan = buildAudioFilterPlan({ timeline, assetPaths: { music: source } })
      await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y",
        ...buildAudioInputArgs(plan),
        "-filter_complex", plan.filterGraph,
        "-map", plan.outputLabel,
        "-c:a", "pcm_s16le", output,
      ])

      const detected = await run(ffmpeg, [
        "-hide_banner", "-i", output,
        "-af", "silencedetect=noise=-50dB:d=0.4",
        "-f", "null", "-",
      ])
      const firstSilenceEnd = /silence_end:\s*([0-9.]+)/u.exec(detected.stderr)?.[1]
      expect(firstSilenceEnd).toBeDefined()
      expect(Number(firstSilenceEnd)).toBeGreaterThan(0.99)
      expect(Number(firstSilenceEnd)).toBeLessThan(1.01)
    },
    20_000,
  )
})
