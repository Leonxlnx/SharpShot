import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StorageService } from "../src/main/storage.js"
import { createDefaultWorkflowStore } from "../src/shared/workflows.js"

const temporaryRoots: string[] = []

async function fixture(): Promise<{
  root: string
  screenshots: string
  recordings: string
  resources: string
}> {
  const root = await mkdtemp(join(tmpdir(), "sharpshot-storage-recovery-"))
  temporaryRoots.push(root)
  const screenshots = join(root, "pictures", "Screenshots")
  const recordings = join(root, "videos", "Recordings")
  const resources = join(root, "resources")
  await Promise.all([
    mkdir(screenshots, { recursive: true }),
    mkdir(recordings, { recursive: true }),
    mkdir(resources, { recursive: true }),
  ])
  return { root: join(root, "user-data"), screenshots, recordings, resources }
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

describe("startup recovery", () => {
  it("normalizes persisted editable cursor workflows before silent startup hotkeys register", async () => {
    const paths = await fixture()
    await mkdir(paths.root, { recursive: true })
    const store = createDefaultWorkflowStore()
    const editableVideoId = store.workflows.find((workflow) => workflow.kind === "video")?.id
    expect(editableVideoId).toBeDefined()
    const persisted = {
      ...store,
      workflows: store.workflows.map((workflow) => workflow.id === editableVideoId
        ? { ...workflow, capture: { ...workflow.capture, cursor: "editable-metadata" as const } }
        : workflow),
    }
    await writeFile(join(paths.root, "workflows.json"), `${JSON.stringify(persisted)}\n`, "utf8")

    const storage = createStorage(paths)
    await storage.initialize()

    const loaded = storage.getWorkflowStore()
    expect(loaded.workflows.find((workflow) => workflow.id === editableVideoId)?.capture.cursor).toBe("visible")
    expect(loaded.workflows.find((workflow) => workflow.kind === "screenshot")?.capture.cursor).toBe("hidden")
    const durable = JSON.parse(await readFile(join(paths.root, "workflows.json"), "utf8")) as typeof persisted
    expect(durable.workflows.find((workflow) => workflow.id === editableVideoId)?.capture.cursor).toBe("visible")
  })

  it("reindexes completed screenshots, recordings, audio stems, and cursor sidecars but skips partials", async () => {
    const paths = await fixture()
    await Promise.all([
      writeFile(join(paths.screenshots, "Screenshot 1.png"), "png"),
      writeFile(join(paths.recordings, "Recording 1.mp4"), "mp4"),
      writeFile(join(paths.recordings, "Recording 1.cursor.jsonl"), "{}\n"),
      writeFile(join(paths.recordings, "Recording 1.system.wav"), "wav"),
      writeFile(join(paths.recordings, "Recording 2.partial.mp4"), "partial"),
      writeFile(join(paths.recordings, ".orphan.audio-mux.partial.mp4"), "partial"),
    ])
    const storage = createStorage(paths)
    await storage.initialize()

    await storage.indexExistingCaptures()
    const library = storage.listMedia()

    expect(library).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Screenshot 1.png", kind: "image", origin: "capture" }),
      expect.objectContaining({ name: "Recording 1.mp4", kind: "video", origin: "recording", cursorMetadataAvailable: true }),
      expect.objectContaining({ name: "Recording 1.system.wav", kind: "audio", origin: "recording" }),
    ]))
    expect(library.some((item) => item.name.includes("partial"))).toBe(false)
  })

  it("persists one batched discovery and writes nothing for an unchanged second scan", async () => {
    const paths = await fixture()
    await Promise.all([
      writeFile(join(paths.screenshots, "Screenshot.png"), "png"),
      writeFile(join(paths.recordings, "Recording 1.mp4"), "mp4-one"),
      writeFile(join(paths.recordings, "Recording 1.cursor.jsonl"), "{}\n"),
      writeFile(join(paths.recordings, "Recording 2.mp4"), "mp4-two"),
      writeFile(join(paths.recordings, "Recording 2.cursor.jsonl"), "{}\n"),
    ])
    const storage = createStorage(paths)
    await storage.initialize()
    const writeLibrary = vi.spyOn(
      storage as unknown as { writeLibrary(items?: unknown[]): Promise<void> },
      "writeLibrary",
    )

    await storage.indexExistingCaptures()
    expect(writeLibrary).toHaveBeenCalledOnce()
    const first = storage.listMedia()
    expect(first.filter((item) => item.kind === "video")).toHaveLength(2)
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Recording 1.mp4", cursorMetadataAvailable: true }),
      expect.objectContaining({ name: "Recording 2.mp4", cursorMetadataAvailable: true }),
    ]))

    writeLibrary.mockClear()
    await storage.indexExistingCaptures()
    expect(writeLibrary).not.toHaveBeenCalled()
    expect(storage.listMedia()).toEqual(first)
  })
})

describe("settings side effects", () => {
  it("keeps launch-at-login unchanged and durable when Windows rejects the update", async () => {
    const paths = await fixture()
    const storage = createStorage(paths)
    await storage.initialize()
    const failure = new Error("Windows rejected the setting")
    const applySystemSetting = vi.fn(() => { throw failure })

    await expect(storage.updateSettingsWithLoginItem(
      { launchAtLogin: true },
      applySystemSetting,
    )).rejects.toBe(failure)

    expect(storage.getSettings().launchAtLogin).toBe(false)
    const durable = JSON.parse(await readFile(join(paths.root, "settings.json"), "utf8")) as {
      settings: { launchAtLogin: boolean }
    }
    expect(durable.settings.launchAtLogin).toBe(false)
  })

  it("does not touch the Windows startup registration for unrelated settings", async () => {
    const paths = await fixture()
    const storage = createStorage(paths)
    await storage.initialize()
    const applySystemSetting = vi.fn()

    const settings = await storage.updateSettingsWithLoginItem(
      { theme: "dark" },
      applySystemSetting,
    )

    expect(settings.theme).toBe("dark")
    expect(applySystemSetting).not.toHaveBeenCalled()
  })
})
