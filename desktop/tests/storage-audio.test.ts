import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StorageService } from "../src/main/storage.js"
import { createAudioClip, createAudioLane } from "../src/shared/audio-timeline.js"
import { createEmptyProjectAudio } from "../src/shared/project-audio.js"
import {
  createClipForVideoAsset,
  createDefaultProject,
  type VideoAsset,
} from "../src/shared/project.js"

const temporaryRoots: string[] = []

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "sharpshot-storage-audio-"))
  temporaryRoots.push(base)
  const paths = {
    root: join(base, "user-data"),
    screenshots: join(base, "screenshots"),
    recordings: join(base, "recordings"),
    resources: join(base, "resources"),
  }
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })))
  return paths
}

function createStorage(paths: Awaited<ReturnType<typeof fixture>>): StorageService {
  return new StorageService({
    rootDirectory: paths.root,
    captureDirectory: paths.screenshots,
    recordingDirectory: paths.recordings,
    resourcesDirectory: paths.resources,
    mediaAccessOrigin: "sharpshot-app://app",
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("project audio storage", () => {
  it("stamps and revalidates imported audio and prevents deletion while referenced", async () => {
    const paths = await fixture()
    const videoPath = join(paths.recordings, "source.mp4")
    const audioPath = join(paths.recordings, "music.mp3")
    await Promise.all([writeFile(videoPath, "video"), writeFile(audioPath, "music")])
    const storage = createStorage(paths)
    await storage.initialize()
    const videoItem = await storage.registerMediaFile(videoPath, "recording")
    const audioItem = await storage.registerMediaFile(audioPath, "import")

    const video: VideoAsset = {
      id: videoItem.id,
      kind: "video",
      name: videoItem.name,
      locator: { kind: "external", absolutePath: videoPath },
      durationUs: 1_000_000,
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    }
    const project = createDefaultProject({ id: "audio-project", now: "2026-08-10T00:00:00.000Z" })
    project.assets[video.id] = video
    project.clips = [createClipForVideoAsset(video, { id: "video-clip" })]
    project.audio = createEmptyProjectAudio(1_000_000)
    project.audio.assets[audioItem.id] = {
      id: audioItem.id,
      kind: "music",
      name: audioItem.name,
      locator: { kind: "library" },
      durationUs: 1_000_000,
      sampleRate: 44_100,
      channels: 2,
    }
    project.audio.lanes.push(createAudioLane({
      id: "music",
      kind: "music",
      clips: [createAudioClip({ id: "music-clip", assetId: audioItem.id, sourceOutUs: 1_000_000 })],
    }))

    const saved = await storage.saveProject(project)
    const savedAudio = saved.project.audio!.assets[audioItem.id]!
    expect(saved.project.assets[video.id]!.locator).toEqual({
      kind: "managed",
      relativePath: `library/${video.id}`,
    })
    expect(JSON.stringify(saved.project)).not.toContain(videoPath)
    await expect(storage.resolveProjectAssetPath(saved.project.assets[video.id]!))
      .resolves.toBe(await realpath(videoPath))
    expect(savedAudio.locator).toEqual({ kind: "library" })
    expect(savedAudio.signature).toMatchObject({ byteLength: 5 })
    await expect(storage.resolveProjectAudioAssetPath(savedAudio)).resolves.toBe(await realpath(audioPath))
    await expect(storage.removeMedia(audioItem.id)).rejects.toMatchObject({ code: "MEDIA_IN_USE" })

    const restartedStorage = createStorage(paths)
    await restartedStorage.initialize()
    const reopened = await restartedStorage.loadProject(project.id)
    expect(reopened.assets[video.id]!.locator).toEqual({
      kind: "managed",
      relativePath: `library/${video.id}`,
    })
    expect(JSON.stringify(reopened)).not.toContain(videoPath)

    await writeFile(audioPath, "music changed")
    await expect(storage.resolveProjectAudioAssetPath(savedAudio)).rejects.toMatchObject({
      code: "PROJECT_ASSET_CHANGED",
    })
    const changedAudioItem = await storage.registerMediaFile(audioPath, "import")
    const unrelatedEdit = structuredClone(saved.project)
    unrelatedEdit.title = "Unrelated title edit"
    await expect(storage.saveProject(unrelatedEdit)).rejects.toMatchObject({
      code: "PROJECT_ASSET_CHANGED",
    })

    const replaced = structuredClone(saved.project)
    replaced.audio!.lanes.find((lane) => lane.kind === "music")!.clips = []
    replaced.audio!.assets[audioItem.id] = {
      id: audioItem.id,
      kind: "music",
      name: changedAudioItem.name,
      locator: { kind: "library" },
      signature: {
        byteLength: changedAudioItem.byteLength,
        modifiedMs: Date.parse(changedAudioItem.modifiedAt),
      },
      durationUs: 500_000,
      sampleRate: 48_000,
      channels: 2,
    }
    replaced.audio!.lanes.find((lane) => lane.kind === "music")!.clips = [createAudioClip({
      id: "music-clip-replaced",
      assetId: audioItem.id,
      sourceOutUs: 500_000,
    })]
    await expect(storage.saveProject(replaced)).resolves.toMatchObject({
      project: { audio: { assets: { [audioItem.id]: { durationUs: 500_000 } } } },
    })
  })

  it("loads only manifest-owned CC0 tracks and range-serves their immutable URL", async () => {
    const paths = await fixture()
    const audioRoot = join(paths.resources, "audio")
    await mkdir(join(audioRoot, "music"), { recursive: true })
    await writeFile(join(audioRoot, "music", "track.mp3"), "abcde")
    await writeFile(join(audioRoot, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      assets: [{
        id: "track",
        title: "Track",
        creator: "Creator",
        kind: "music",
        file: "music/track.mp3",
        license: "CC0-1.0",
        bytes: 5,
        durationSeconds: 2,
        media: { sampleRateHz: 44_100, channels: 2 },
      }],
    }))
    const storage = createStorage(paths)
    await storage.initialize()

    expect(storage.listBundledAudio()).toEqual([expect.objectContaining({
      id: "track",
      durationUs: 2_000_000,
      url: "sharpshot-media://audio/track",
    })])
    await expect(storage.resolveProjectAudioAssetPath({
      id: "track",
      kind: "music",
      name: "Track",
      locator: { kind: "bundled", key: "track" },
      durationUs: 2_000_000,
      sampleRate: 44_100,
      channels: 2,
    })).resolves.toBe(await realpath(join(audioRoot, "music", "track.mp3")))

    const response = await storage.handleMediaRequest(new Request("sharpshot-media://audio/track", {
      headers: { Range: "bytes=1-3" },
    }))
    expect(response.status).toBe(206)
    expect(await response.text()).toBe("bcd")
  })
})
