import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  completeQuickVideoMuxRecovery,
  discoverQuickVideoMuxRecoveryBundles,
  prepareQuickVideoMuxRecoveryMarker,
} from "../src/main/quick-video-mux-recovery.js"
import { StorageService } from "../src/main/storage.js"

const temporaryRoots: string[] = []

async function fixture(): Promise<{
  root: string
  screenshots: string
  recordings: string
  resources: string
}> {
  const base = await mkdtemp(path.join(tmpdir(), "sharpshot-quick-mux-recovery-"))
  temporaryRoots.push(base)
  const screenshots = path.join(base, "screenshots")
  const recordings = path.join(base, "recordings")
  const resources = path.join(base, "resources")
  await Promise.all([
    mkdir(screenshots, { recursive: true }),
    mkdir(recordings, { recursive: true }),
    mkdir(resources, { recursive: true }),
  ])
  return { root: path.join(base, "user-data"), screenshots, recordings, resources }
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

async function createPreparedBundle(recordings: string, stemCount = 2): Promise<{
  sourcePath: string
  stemPaths: string[]
  partialPath: string
  finalPath: string
  markerPath: string
}> {
  const sourcePath = path.join(recordings, "Recording 7.mp4")
  const stemPaths = [
    path.join(recordings, "Recording 7.system.wav"),
    path.join(recordings, "Recording 7.microphone.wav"),
  ].slice(0, stemCount)
  const partialPath = path.join(recordings, ".verified.audio-mux.partial.mp4")
  const finalPath = path.join(recordings, "Recording 7 (with audio).mp4")
  await Promise.all([
    writeFile(sourcePath, "native-video"),
    ...stemPaths.map((stemPath, index) => writeFile(stemPath, `audio-${index}`)),
    writeFile(partialPath, "verified-final"),
  ])
  const markerPath = await prepareQuickVideoMuxRecoveryMarker({
    finalPath,
    verifiedOutputPath: partialPath,
    sourceVideoPath: sourcePath,
    stemPaths,
  })
  return { sourcePath, stemPaths, partialPath, finalPath, markerPath }
}

async function exists(filePath: string): Promise<boolean> {
  return await access(filePath).then(() => true, () => false)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Quick Video mux restart recovery", () => {
  it("recovers a marker when the final was registered before the process exited", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings)
    await link(bundle.partialPath, bundle.finalPath)
    await rm(bundle.partialPath)

    const firstRun = createStorage(paths)
    await firstRun.initialize()
    await firstRun.registerMediaFile(bundle.finalPath, "recording")
    expect(await exists(bundle.markerPath)).toBe(true)

    const restarted = createStorage(paths)
    await restarted.initialize()
    await restarted.indexExistingCaptures()
    expect(restarted.listMedia().map((item) => item.name)).toEqual(["Recording 7 (with audio).mp4"])
    expect(await exists(bundle.markerPath)).toBe(false)
  })

  it("does not clean inputs or marker when durable final registration fails", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings)
    await link(bundle.partialPath, bundle.finalPath)
    await rm(bundle.partialPath)

    const storage = createStorage(paths)
    await storage.initialize()
    const libraryPath = path.join(paths.root, "library.json")
    await rm(libraryPath)
    await mkdir(libraryPath)

    await expect(storage.indexExistingCaptures()).rejects.toBeDefined()
    expect(await exists(bundle.markerPath)).toBe(true)
    expect(await exists(bundle.sourcePath)).toBe(true)
    expect(await Promise.all(bundle.stemPaths.map(exists))).toEqual([true, true])
  })

  it("indexes only the committed muxed MP4 after a crash before IPC registration", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings)
    await link(bundle.partialPath, bundle.finalPath)
    await rm(bundle.partialPath)

    const storage = createStorage(paths)
    await storage.initialize()
    await storage.indexExistingCaptures()

    expect(storage.listMedia().map((item) => item.name)).toEqual(["Recording 7 (with audio).mp4"])
    expect(await exists(bundle.finalPath)).toBe(true)
    expect(await exists(bundle.sourcePath)).toBe(false)
    expect(await Promise.all(bundle.stemPaths.map(exists))).toEqual([false, false])
    expect(await exists(bundle.markerPath)).toBe(false)
  })

  it("abandons a flushed marker when the final hard-link was never committed", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings, 1)
    await rm(bundle.partialPath)

    const storage = createStorage(paths)
    await storage.initialize()
    await storage.indexExistingCaptures()

    expect(storage.listMedia().map((item) => item.name).sort()).toEqual([
      "Recording 7.mp4",
      "Recording 7.system.wav",
    ])
    expect(await exists(bundle.sourcePath)).toBe(true)
    expect(await exists(bundle.stemPaths[0]!)).toBe(true)
    expect(await exists(bundle.markerPath)).toBe(false)
  })

  it("retains the marker after a partial cleanup failure and retries only remaining owned files", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings)
    await link(bundle.partialPath, bundle.finalPath)
    await rm(bundle.partialPath)
    const failedStem = bundle.stemPaths[0]!

    const first = await completeQuickVideoMuxRecovery(bundle.markerPath, {
      unlinkFile: async (filePath) => {
        if (filePath === failedStem) throw Object.assign(new Error("locked"), { code: "EPERM" })
        await rm(filePath)
      },
    })
    expect(first.cleanupComplete).toBe(false)
    expect(first.markerRemoved).toBe(false)
    expect(await exists(bundle.sourcePath)).toBe(false)
    expect(await exists(failedStem)).toBe(true)
    expect(await exists(bundle.markerPath)).toBe(true)

    const restarted = createStorage(paths)
    await restarted.initialize()
    await restarted.indexExistingCaptures()
    expect(restarted.listMedia().map((item) => item.name)).toEqual(["Recording 7 (with audio).mp4"])
    expect(await Promise.all(bundle.stemPaths.map(exists))).toEqual([false, false])
    expect(await exists(bundle.markerPath)).toBe(false)
  })

  it("never hides or deletes a cleanup path whose file identity was replaced", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings, 1)
    await link(bundle.partialPath, bundle.finalPath)
    await rm(bundle.partialPath)
    const replacedStem = bundle.stemPaths[0]!
    await rm(replacedStem)
    await writeFile(replacedStem, "user replacement that is not the captured stem")

    const storage = createStorage(paths)
    await storage.initialize()
    await storage.indexExistingCaptures()

    expect(storage.listMedia().map((item) => item.name)).toEqual(expect.arrayContaining([
      "Recording 7 (with audio).mp4",
      "Recording 7.system.wav",
    ]))
    expect(await readFile(replacedStem, "utf8")).toBe("user replacement that is not the captured stem")
    expect(await exists(bundle.sourcePath)).toBe(false)
    expect(await exists(bundle.markerPath)).toBe(false)
  })

  it("supports a strict identity-protected explicit sibling destination", async () => {
    const paths = await fixture()
    const bundle = await createPreparedBundle(paths.recordings, 1)
    await rm(bundle.markerPath)
    const explicitFinalPath = path.join(paths.recordings, "Ready to paste.mp4")
    const explicitMarkerPath = await prepareQuickVideoMuxRecoveryMarker({
      finalPath: explicitFinalPath,
      verifiedOutputPath: bundle.partialPath,
      sourceVideoPath: bundle.sourcePath,
      stemPaths: bundle.stemPaths,
      destinationMode: "explicit",
    })
    await link(bundle.partialPath, explicitFinalPath)
    await rm(bundle.partialPath)

    const discovered = await discoverQuickVideoMuxRecoveryBundles(paths.recordings)
    expect(discovered).toEqual([
      expect.objectContaining({ markerPath: explicitMarkerPath, finalPath: explicitFinalPath }),
    ])
    const cleanup = await completeQuickVideoMuxRecovery(explicitMarkerPath)
    expect(cleanup.cleanupComplete).toBe(true)
    expect(await exists(explicitFinalPath)).toBe(true)
  })

  it("does not hide or delete media named by a malformed traversal marker", async () => {
    const paths = await fixture()
    const victimPath = path.join(paths.recordings, "keep.wav")
    const finalPath = path.join(paths.recordings, "Recording 7 (with audio).mp4")
    const markerPath = path.join(paths.recordings, ".sharpshot-quick-mux-12345678-1234-4123-8123-123456789abc.json")
    await Promise.all([
      writeFile(victimPath, "keep"),
      writeFile(finalPath, "unrelated-final"),
      writeFile(markerPath, JSON.stringify({
        kind: "sharpshot.quick-video-audio-mux",
        version: 1,
        destinationMode: "automatic",
        final: { basename: path.basename(finalPath), identity: {} },
        source: { basename: "..\\outside.mp4", identity: {} },
        stems: [{ basename: "keep.wav", identity: {} }],
      })),
    ])

    expect(await discoverQuickVideoMuxRecoveryBundles(paths.recordings)).toEqual([])
    expect(await readFile(victimPath, "utf8")).toBe("keep")
    expect(await exists(markerPath)).toBe(true)

    const storage = createStorage(paths)
    await storage.initialize()
    await storage.indexExistingCaptures()
    expect(storage.listMedia().map((item) => item.name)).toEqual(expect.arrayContaining([
      "keep.wav",
      "Recording 7 (with audio).mp4",
    ]))
    expect(await readFile(victimPath, "utf8")).toBe("keep")
  })
})
