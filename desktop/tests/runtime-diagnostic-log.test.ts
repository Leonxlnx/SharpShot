import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RuntimeDiagnosticLog } from "../src/main/runtime-diagnostic-log.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("runtime diagnostic log", () => {
  it("serializes writes and retains only a bounded current and previous JSONL file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharpshot-runtime-log-"))
    temporaryRoots.push(root)
    const log = new RuntimeDiagnosticLog(root, 1_024)
    await log.initialize()

    for (let index = 0; index < 10; index += 1) {
      log.record({
        event: "renderer-load-failed",
        target: "packaged-app",
        errorName: "Error",
        errorMessage: "x".repeat(480),
        errorCode: index,
      })
    }
    await log.flush()

    const entries = (await readdir(log.directory)).sort()
    expect(entries).toEqual(["runtime.jsonl", "runtime.previous.jsonl"])
    expect((await stat(log.currentPath)).size).toBeLessThanOrEqual(1_024)
    expect((await stat(log.previousPath)).size).toBeLessThanOrEqual(1_024)
    const retained = [
      ...parseLines(await readFile(log.previousPath, "utf8")),
      ...parseLines(await readFile(log.currentPath, "utf8")),
    ]
    expect(retained.map((record) => record.errorCode)).toEqual([8, 9])
    expect(retained.every((record) => typeof record.recordedAt === "string")).toBe(true)
  })

  it("removes obsolete rotations explicitly during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharpshot-runtime-log-"))
    temporaryRoots.push(root)
    const diagnostics = join(root, "diagnostics")
    await mkdir(diagnostics, { recursive: true })
    await writeFile(join(diagnostics, "runtime.2.jsonl"), "stale\n", "utf8")
    await writeFile(join(diagnostics, "unrelated.txt"), "keep\n", "utf8")

    const log = new RuntimeDiagnosticLog(root)
    await log.initialize()

    expect((await readdir(diagnostics)).sort()).toEqual(["runtime.jsonl", "unrelated.txt"])
  })
})

function parseLines(value: string): Array<Record<string, unknown>> {
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}
