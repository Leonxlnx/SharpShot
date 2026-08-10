import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  HotkeyHostClient,
  type HotkeyHostProcess,
  type HotkeyHostSpawnOptions,
} from "../src/main/hotkey-host-client.js"

const READY = {
  v: 1,
  type: "ready",
  capabilities: {
    registerHotKey: true,
    lowLevelHookFallback: true,
    hookFallbackAccelerators: ["Win+Shift+A", "Win+Shift+D"],
    transactionalReplace: true,
    parentProcessWait: true,
    stdinEofShutdown: true,
    maxBindings: 64,
    maxLineBytes: 65_536,
  },
} as const

class FakeHostProcess extends EventEmitter implements HotkeyHostProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  readonly input: string[] = []

  constructor() {
    super()
    this.stdin.setEncoding("utf8")
    this.stdin.on("data", (chunk: string) => this.input.push(chunk))
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 1
    queueMicrotask(() => this.emit("exit", 1, null))
    return true
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  request(index = this.input.length - 1): Record<string, unknown> {
    const serialized = this.input[index]
    if (serialized === undefined) throw new Error("No native-host request was written.")
    return JSON.parse(serialized.trim()) as Record<string, unknown>
  }
}

function fixture(): { client: HotkeyHostClient; process: FakeHostProcess } {
  const process = new FakeHostProcess()
  const spawnHost = vi.fn((
    _executablePath: string,
    _args: string[],
    _options: HotkeyHostSpawnOptions,
  ) => process)
  return {
    process,
    client: new HotkeyHostClient({
      executablePath: "C:\\SharpShot.Native.exe",
      parentProcessId: 42,
      spawnHost,
      readyTimeoutMs: 250,
      requestTimeoutMs: 250,
      shutdownTimeoutMs: 50,
    }),
  }
}

async function start(client: HotkeyHostClient, process: FakeHostProcess): Promise<void> {
  const starting = client.start()
  process.send(READY)
  await expect(starting).resolves.toBe(true)
}

describe("native hotkey host transport", () => {
  it.each([false, true])("sends the explicit hook-fallback decision (%s)", async (allowHookFallback) => {
    const { client, process } = fixture()
    await start(client, process)

    const pending = client.replaceBindings([
      { bindingId: "quick-video", accelerator: "Win+Shift+A" },
    ], allowHookFallback)
    const request = process.request()
    expect(request.allowHookFallback).toBe(allowHookFallback)
    expect(request.cmd).toBe("bindings.replace")

    process.send({
      v: 1,
      type: "response",
      id: request.id,
      ok: true,
      result: {
        applied: true,
        rollbackComplete: true,
        hookActive: allowHookFallback,
        bindings: [{
          bindingId: "quick-video",
          registered: true,
          backend: allowHookFallback ? "hook" : "register-hot-key",
        }],
      },
    })

    await expect(pending).resolves.toMatchObject({ applied: true, hookActive: allowHookFallback })
    process.kill()
  })

  it("rejects a malformed correlated error response instead of orphaning its promise", async () => {
    const { client, process } = fixture()
    await start(client, process)

    const pending = client.replaceBindings([
      { bindingId: "quick-video", accelerator: "Win+Shift+A" },
    ], true)
    const request = process.request()
    process.send({
      v: 1,
      type: "response",
      id: request.id,
      ok: false,
      error: { code: "BROKEN_WITHOUT_MESSAGE" },
    })

    await expect(pending).rejects.toMatchObject({ code: "MISSING_FIELD" })
    expect(client.available).toBe(false)
  })

  it.each(["stdout", "stderr"] as const)("turns a %s pipe error into a bounded transport failure", async (pipe) => {
    const { client, process } = fixture()
    const unavailable = vi.fn()
    client.on("unavailable", unavailable)
    await start(client, process)

    const pending = client.replaceBindings([
      { bindingId: "quick-video", accelerator: "Win+Shift+A" },
    ], true)
    process[pipe].emit("error", new Error(`${pipe} failed`))

    await expect(pending).rejects.toThrow(`${pipe} failed`)
    expect(client.available).toBe(false)
    expect(unavailable).toHaveBeenCalledTimes(1)
  })

  it("reports a fresh failure after an orderly reset and same-client restart", async () => {
    const processes = [new FakeHostProcess(), new FakeHostProcess()]
    let spawnIndex = 0
    const client = new HotkeyHostClient({
      executablePath: "C:\\SharpShot.Native.exe",
      parentProcessId: 42,
      spawnHost: () => {
        const process = processes[spawnIndex]
        spawnIndex += 1
        if (process === undefined) throw new Error("Unexpected third host start.")
        return process
      },
      readyTimeoutMs: 250,
      requestTimeoutMs: 250,
      shutdownTimeoutMs: 50,
    })
    const unavailable = vi.fn()
    client.on("unavailable", unavailable)

    await start(client, processes[0]!)
    processes[0]!.stdout.emit("error", new Error("first failure"))
    expect(unavailable).toHaveBeenCalledTimes(1)
    await client.shutdown()

    await start(client, processes[1]!)
    processes[1]!.stderr.emit("error", new Error("second failure"))
    expect(unavailable).toHaveBeenCalledTimes(2)
    expect(unavailable.mock.calls[1]?.[0]).toMatchObject({ message: "second failure" })
  })
})
