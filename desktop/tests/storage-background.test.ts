import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StorageService } from "../src/main/storage.js"
import type { ImageAsset } from "../src/shared/project.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("bundled background storage", () => {
  it("serves manifest-owned masters through the trusted protocol and resolves the same file for export", async () => {
    const base = await mkdtemp(join(tmpdir(), "sharpshot-storage-background-"))
    temporaryRoots.push(base)
    const paths = {
      root: join(base, "user-data"),
      screenshots: join(base, "screenshots"),
      recordings: join(base, "recordings"),
      resources: join(base, "resources"),
    }
    const backgroundRoot = join(paths.resources, "backgrounds")
    await Promise.all([
      mkdir(paths.screenshots, { recursive: true }),
      mkdir(paths.recordings, { recursive: true }),
      mkdir(backgroundRoot, { recursive: true }),
    ])
    const backgroundPath = join(backgroundRoot, "cobalt-bloom.webp")
    await writeFile(backgroundPath, "background-master")
    await writeFile(join(backgroundRoot, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      items: [{ id: "cobalt-bloom", file: "cobalt-bloom.webp" }],
    }))

    const storage = new StorageService({
      rootDirectory: paths.root,
      captureDirectory: paths.screenshots,
      recordingDirectory: paths.recordings,
      resourcesDirectory: paths.resources,
      mediaAccessOrigin: "sharpshot-app://app",
    })
    await storage.initialize()

    const response = await storage.handleMediaRequest(new Request("sharpshot-media://background/cobalt-bloom"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(await response.text()).toBe("background-master")
    await expect(storage.handleMediaRequest(new Request("sharpshot-media://asset/cobalt-bloom")))
      .resolves.toMatchObject({ status: 404 })
    await expect(storage.handleMediaRequest(new Request("sharpshot-media://background/cobalt-bloom.webp")))
      .resolves.toMatchObject({ status: 404 })

    const asset: ImageAsset = {
      id: "cobalt-bloom",
      kind: "image",
      name: "Cobalt Bloom",
      locator: { kind: "bundled", key: "cobalt-bloom" },
      width: 3_840,
      height: 2_160,
    }
    await expect(storage.resolveProjectAssetPath(asset)).resolves.toBe(await realpath(backgroundPath))
  })
})
