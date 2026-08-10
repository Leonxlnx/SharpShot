import {
  appendFile,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import { join } from "node:path"
import {
  safeErrorRecord,
  type RuntimeDiagnostic,
} from "./runtime-diagnostics.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const CURRENT_FILE_NAME = "runtime.jsonl"
const PREVIOUS_FILE_NAME = "runtime.previous.jsonl"

export class RuntimeDiagnosticLog {
  readonly directory: string
  readonly currentPath: string
  readonly previousPath: string
  private readonly maximumFileBytes: number
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string, maximumFileBytes = DEFAULT_MAX_FILE_BYTES) {
    if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1_024) {
      throw new Error("The runtime diagnostic log limit must be at least 1024 bytes.")
    }
    this.directory = join(userDataDirectory, "diagnostics")
    this.currentPath = join(this.directory, CURRENT_FILE_NAME)
    this.previousPath = join(this.directory, PREVIOUS_FILE_NAME)
    this.maximumFileBytes = maximumFileBytes
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.removeObsoleteRotations()
    const handle = await open(this.currentPath, "a")
    await handle.close()
  }

  record(diagnostic: RuntimeDiagnostic): void {
    const line = `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...diagnostic,
    })}\n`
    const pending = this.writeQueue.then(() => this.append(line))
    this.writeQueue = pending.catch((error: unknown) => {
      console.error("SharpShot could not write its local runtime diagnostic.", safeErrorRecord(error))
    })
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private async append(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const lineBytes = Buffer.byteLength(line, "utf8")
    const currentBytes = await fileSize(this.currentPath)
    if (currentBytes > 0 && currentBytes + lineBytes > this.maximumFileBytes) {
      await unlinkIfPresent(this.previousPath)
      try {
        await rename(this.currentPath, this.previousPath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
    }
    await appendFile(this.currentPath, line, "utf8")
  }

  private async removeObsoleteRotations(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^runtime\..+\.jsonl$/i.test(name) && name !== PREVIOUS_FILE_NAME)
      .map((name) => unlinkIfPresent(join(this.directory, name))))
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissingFileError(error)) return 0
    throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}
