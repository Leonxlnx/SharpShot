import { randomUUID } from "node:crypto"
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises"
import path from "node:path"

const MARKER_KIND = "sharpshot.quick-video-audio-mux"
const MARKER_VERSION = 1
const MAX_MARKER_BYTES = 4 * 1024
const MAX_BASENAME_LENGTH = 255
const MARKER_NAME = /^\.sharpshot-quick-mux-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/
const DECIMAL_INTEGER = /^(?:0|[1-9]\d{0,31})$/

type FileIdentityV1 = {
  byteLength: string
  device: string
  inode: string
  modifiedNs: string
}

type RecoveryFileV1 = {
  basename: string
  identity: FileIdentityV1
}

export type QuickVideoMuxRecoveryMarkerV1 = {
  kind: typeof MARKER_KIND
  version: typeof MARKER_VERSION
  destinationMode: "automatic" | "explicit"
  final: RecoveryFileV1
  source: RecoveryFileV1
  stems: RecoveryFileV1[]
}

export type QuickVideoMuxRecoveryBundle = {
  markerPath: string
  finalPath: string
  /** Only paths whose current identity still belongs to this transaction. */
  ownedCleanupPaths: string[]
}

export type QuickVideoMuxRecoveryCleanupResult = {
  cleanupComplete: boolean
  markerRemoved: boolean
  removedPaths: string[]
}

export class QuickVideoMuxRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "QuickVideoMuxRecoveryError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safeBasename(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BASENAME_LENGTH &&
    value !== "." &&
    value !== ".." &&
    value.trimEnd() === value &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) &&
    path.win32.basename(value) === value &&
    path.posix.basename(value) === value
}

function parseIdentity(value: unknown): FileIdentityV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["byteLength", "device", "inode", "modifiedNs"])) {
    return undefined
  }
  const byteLength = value.byteLength
  const device = value.device
  const inode = value.inode
  const modifiedNs = value.modifiedNs
  if (
    typeof byteLength !== "string" || !DECIMAL_INTEGER.test(byteLength) ||
    typeof device !== "string" || !DECIMAL_INTEGER.test(device) ||
    typeof inode !== "string" || !DECIMAL_INTEGER.test(inode) ||
    typeof modifiedNs !== "string" || !DECIMAL_INTEGER.test(modifiedNs)
  ) return undefined
  return { byteLength, device, inode, modifiedNs }
}

function parseRecoveryFile(value: unknown): RecoveryFileV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["basename", "identity"]) || !safeBasename(value.basename)) {
    return undefined
  }
  const identity = parseIdentity(value.identity)
  return identity === undefined ? undefined : { basename: value.basename, identity }
}

function fileKey(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value
}

function expectedFinalBasename(sourceBasename: string, finalBasename: string): boolean {
  const source = path.parse(sourceBasename)
  if (source.ext.toLowerCase() !== ".mp4" || path.extname(finalBasename).toLowerCase() !== ".mp4") return false
  const escapedStem = source.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escapedStem} \\(with audio\\)(?: \\((?:[2-9]|[1-9]\\d{1,2}|1000)\\))?\\.mp4$`, "i")
    .test(finalBasename)
}

function expectedStemBasename(sourceBasename: string, stemBasename: string): boolean {
  const source = path.parse(sourceBasename)
  const key = stemBasename.toLocaleLowerCase("en-US")
  return key === `${source.name}.system.wav`.toLocaleLowerCase("en-US") ||
    key === `${source.name}.microphone.wav`.toLocaleLowerCase("en-US")
}

export function parseQuickVideoMuxRecoveryMarker(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): QuickVideoMuxRecoveryMarkerV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "version", "destinationMode", "final", "source", "stems"])) {
    return undefined
  }
  if (
    value.kind !== MARKER_KIND ||
    value.version !== MARKER_VERSION ||
    (value.destinationMode !== "automatic" && value.destinationMode !== "explicit") ||
    !Array.isArray(value.stems)
  ) {
    return undefined
  }
  const final = parseRecoveryFile(value.final)
  const source = parseRecoveryFile(value.source)
  const stems = value.stems.map(parseRecoveryFile)
  if (final === undefined || source === undefined || stems.some((stem) => stem === undefined)) return undefined
  const typedStems = stems as RecoveryFileV1[]
  if (typedStems.length < 1 || typedStems.length > 2) return undefined
  if (path.extname(final.basename).toLowerCase() !== ".mp4") return undefined
  if (value.destinationMode === "automatic" && !expectedFinalBasename(source.basename, final.basename)) return undefined
  if (typedStems.some((stem) => !expectedStemBasename(source.basename, stem.basename))) return undefined
  const names = [final.basename, source.basename, ...typedStems.map((stem) => stem.basename)]
    .map((name) => fileKey(name, platform))
  if (new Set(names).size !== names.length) return undefined
  return {
    kind: MARKER_KIND,
    version: MARKER_VERSION,
    destinationMode: value.destinationMode,
    final,
    source,
    stems: typedStems,
  }
}

async function identityForRegularFile(filePath: string): Promise<FileIdentityV1> {
  const file = await lstat(filePath, { bigint: true })
  if (!file.isFile()) throw new QuickVideoMuxRecoveryError("Quick Video recovery only accepts regular files.")
  return {
    byteLength: file.size.toString(),
    device: file.dev.toString(),
    inode: file.ino.toString(),
    modifiedNs: file.mtimeNs.toString(),
  }
}

async function matchesIdentity(filePath: string, expected: FileIdentityV1): Promise<"match" | "missing" | "different"> {
  try {
    const actual = await identityForRegularFile(filePath)
    return actual.byteLength === expected.byteLength &&
      actual.device === expected.device &&
      actual.inode === expected.inode &&
      actual.modifiedNs === expected.modifiedNs
      ? "match"
      : "different"
  } catch (error) {
    if (isMissing(error)) return "missing"
    return "different"
  }
}

function sameDirectory(left: string, right: string, platform: NodeJS.Platform): boolean {
  return fileKey(path.resolve(left), platform) === fileKey(path.resolve(right), platform)
}

async function atomicWriteMarker(markerPath: string, value: QuickVideoMuxRecoveryMarkerV1): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(serialized, "utf8") > MAX_MARKER_BYTES) {
    throw new QuickVideoMuxRecoveryError("Quick Video recovery marker exceeds its safety limit.")
  }
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, "wx", 0o600)
  try {
    await handle.writeFile(serialized, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, markerPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  // Best-effort directory metadata flush. Windows may reject directory handles;
  // the marker file itself has already been flushed and atomically renamed.
  try {
    const directory = await open(path.dirname(markerPath), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // Unsupported on some Windows/filesystem combinations.
  }
}

/**
 * Prepare and flush the recovery intent before the verified partial is linked
 * to its public final name. All transaction members must be sibling files.
 */
export async function prepareQuickVideoMuxRecoveryMarker(input: {
  finalPath: string
  verifiedOutputPath: string
  sourceVideoPath: string
  stemPaths: readonly string[]
  destinationMode?: "automatic" | "explicit"
  platform?: NodeJS.Platform
}): Promise<string> {
  const platform = input.platform ?? process.platform
  const finalPath = path.resolve(input.finalPath)
  const directory = path.dirname(finalPath)
  const verifiedOutputPath = path.resolve(input.verifiedOutputPath)
  const sourceVideoPath = path.resolve(input.sourceVideoPath)
  const stemPaths = input.stemPaths.map((stemPath) => path.resolve(stemPath))
  if (
    stemPaths.length < 1 || stemPaths.length > 2 ||
    !sameDirectory(path.dirname(verifiedOutputPath), directory, platform) ||
    !sameDirectory(path.dirname(sourceVideoPath), directory, platform) ||
    stemPaths.some((stemPath) => !sameDirectory(path.dirname(stemPath), directory, platform))
  ) {
    throw new QuickVideoMuxRecoveryError("Quick Video recovery artifacts must be sibling files.")
  }

  const [finalIdentity, sourceIdentity, ...stemIdentities] = await Promise.all([
    identityForRegularFile(verifiedOutputPath),
    identityForRegularFile(sourceVideoPath),
    ...stemPaths.map(identityForRegularFile),
  ])
  const marker = parseQuickVideoMuxRecoveryMarker({
    kind: MARKER_KIND,
    version: MARKER_VERSION,
    destinationMode: input.destinationMode ?? "automatic",
    final: { basename: path.basename(finalPath), identity: finalIdentity },
    source: { basename: path.basename(sourceVideoPath), identity: sourceIdentity },
    stems: stemPaths.map((stemPath, index) => ({
      basename: path.basename(stemPath),
      identity: stemIdentities[index],
    })),
  }, platform)
  if (marker === undefined) {
    throw new QuickVideoMuxRecoveryError("Quick Video recovery filenames do not match the native bundle contract.")
  }

  const markerPath = path.join(directory, `.sharpshot-quick-mux-${randomUUID()}.json`)
  await atomicWriteMarker(markerPath, marker)
  return markerPath
}

async function readMarker(markerPath: string, platform: NodeJS.Platform): Promise<QuickVideoMuxRecoveryMarkerV1 | undefined> {
  try {
    const markerFile = await lstat(markerPath)
    if (!markerFile.isFile() || markerFile.size <= 0 || markerFile.size > MAX_MARKER_BYTES) return undefined
    const serialized = await readFile(markerPath, "utf8")
    if (Buffer.byteLength(serialized, "utf8") > MAX_MARKER_BYTES) return undefined
    return parseQuickVideoMuxRecoveryMarker(JSON.parse(serialized) as unknown, platform)
  } catch {
    return undefined
  }
}

async function inspectActiveBundle(
  markerPath: string,
  platform: NodeJS.Platform,
): Promise<{ bundle?: QuickVideoMuxRecoveryBundle; abandoned: boolean }> {
  const marker = await readMarker(markerPath, platform)
  if (marker === undefined) return { abandoned: false }
  const directory = path.dirname(markerPath)
  const finalPath = path.join(directory, marker.final.basename)
  const finalState = await matchesIdentity(finalPath, marker.final.identity)
  if (finalState !== "match") return { abandoned: true }

  const cleanupFiles = [marker.source, ...marker.stems]
  const states = await Promise.all(cleanupFiles.map(async (file) => ({
    path: path.join(directory, file.basename),
    state: await matchesIdentity(path.join(directory, file.basename), file.identity),
  })))
  return {
    abandoned: false,
    bundle: {
      markerPath,
      finalPath,
      ownedCleanupPaths: states.filter(({ state }) => state === "match").map(({ path: filePath }) => filePath),
    },
  }
}

/**
 * Find committed bundles. A prepared marker without its identity-matching final
 * hard-link is abandoned and removed; malformed markers are left untouched and
 * never influence media discovery.
 */
export async function discoverQuickVideoMuxRecoveryBundles(
  directoryValue: string,
  platform: NodeJS.Platform = process.platform,
): Promise<QuickVideoMuxRecoveryBundle[]> {
  const directory = path.resolve(directoryValue)
  const entries = await readdir(directory, { withFileTypes: true })
  const bundles: QuickVideoMuxRecoveryBundle[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !MARKER_NAME.test(entry.name)) continue
    const markerPath = path.join(directory, entry.name)
    const inspected = await inspectActiveBundle(markerPath, platform)
    if (inspected.bundle !== undefined) bundles.push(inspected.bundle)
    else if (inspected.abandoned) await unlink(markerPath).catch(() => undefined)
  }
  return bundles
}

/** Remove only identity-matching transaction inputs, then retire the marker. */
export async function completeQuickVideoMuxRecovery(
  markerPathValue: string,
  options: {
    platform?: NodeJS.Platform
    unlinkFile?: (filePath: string) => Promise<void>
  } = {},
): Promise<QuickVideoMuxRecoveryCleanupResult> {
  const platform = options.platform ?? process.platform
  const markerPath = path.resolve(markerPathValue)
  if (!MARKER_NAME.test(path.basename(markerPath))) {
    return { cleanupComplete: false, markerRemoved: false, removedPaths: [] }
  }
  const inspected = await inspectActiveBundle(markerPath, platform)
  if (inspected.bundle === undefined) {
    if (inspected.abandoned) {
      const markerRemoved = await unlink(markerPath).then(() => true, (error) => isMissing(error))
      return { cleanupComplete: false, markerRemoved, removedPaths: [] }
    }
    return { cleanupComplete: false, markerRemoved: false, removedPaths: [] }
  }

  const unlinkFile = options.unlinkFile ?? unlink
  const removedPaths: string[] = []
  let cleanupComplete = true
  for (const cleanupPath of inspected.bundle.ownedCleanupPaths) {
    try {
      await unlinkFile(cleanupPath)
      removedPaths.push(cleanupPath)
    } catch (error) {
      if (!isMissing(error)) cleanupComplete = false
    }
  }
  if (!cleanupComplete) return { cleanupComplete: false, markerRemoved: false, removedPaths }
  const markerRemoved = await unlink(markerPath).then(() => true, (error) => isMissing(error))
  return { cleanupComplete: true, markerRemoved, removedPaths }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
