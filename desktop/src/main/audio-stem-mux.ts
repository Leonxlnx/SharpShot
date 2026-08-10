import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  copyVideoFileToClipboard,
  type CopyVideoOptions,
  type VideoClipboardResult,
} from "./clipboard.js";
import {
  probeMedia,
  resolveBundledMediaBinary,
  type MediaBinaryResolutionOptions,
  type MediaProbeResult,
} from "./media-probe.js";
import { prepareQuickVideoMuxRecoveryMarker } from "./quick-video-mux-recovery.js";

const MICROSECONDS_PER_SECOND = 1_000_000;
const DEFAULT_AUDIO_BIT_RATE_KBPS = 192;
const MAX_STDERR_BYTES = 64 * 1_024;
const MAX_AUTO_DESTINATIONS = 1_000;

export interface QuickVideoAudioMuxRequest {
  sourceVideoPath: string;
  /**
   * Omit this for a no-clobber sibling name such as
   * `Recording ... (with audio).mp4`. An explicit destination is never
   * overwritten either and must remain beside the native recording bundle.
   */
  outputPath?: string;
  systemAudioPath?: string;
  microphoneAudioPath?: string;
  audioBitRateKbps?: number;
  copyToClipboard?: boolean;
}

export interface QuickVideoAudioMuxProgress {
  fraction: number;
  outTimeUs: number;
}

export interface QuickVideoAudioMuxOptions extends MediaBinaryResolutionOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: QuickVideoAudioMuxProgress) => void;
  clipboardOptions?: CopyVideoOptions;
}

export interface RetainedAudioStemPaths {
  systemAudioPath?: string;
  microphoneAudioPath?: string;
}

export interface QuickVideoAudioMuxResult {
  sourceVideoPath: string;
  outputPath: string;
  /**
   * Durable transaction intent. Remove native inputs through
   * `completeQuickVideoMuxRecovery` only after the final file is registered.
   */
  recoveryMarkerPath: string;
  durationUs: number;
  metadata: MediaProbeResult;
  /** The service never deletes or modifies either editor stem. */
  retainedStemPaths: RetainedAudioStemPaths;
  clipboard?: VideoClipboardResult;
}

export interface AudioStemMuxPlan {
  args: string[];
  filterGraph: string;
}

export class AudioStemMuxValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioStemMuxValidationError";
  }
}

export class AudioStemMuxCancelledError extends Error {
  constructor() {
    super("Quick Video audio mux was cancelled.");
    this.name = "AudioStemMuxCancelledError";
  }
}

export class AudioStemMuxProcessError extends Error {
  readonly exitCode?: number;
  readonly stderr: string;

  constructor(message: string, stderr = "", exitCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioStemMuxProcessError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function guardAudioStemMuxPipes(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  onError: (pipe: "stdout" | "stderr", error: Error) => void,
): void {
  let handled = false;
  const handleError = (pipe: "stdout" | "stderr") => (value: unknown): void => {
    if (handled) return;
    handled = true;
    const error = value instanceof Error
      ? value
      : new Error(`FFmpeg ${pipe} emitted an invalid pipe error.`);
    onError(pipe, error);
  };
  child.stdout.on("error", handleError("stdout"));
  child.stderr.on("error", handleError("stderr"));
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function seconds(durationUs: number): string {
  return (durationUs / MICROSECONDS_PER_SECOND).toFixed(6);
}

function assertBitRate(value: number): void {
  if (!Number.isSafeInteger(value) || value < 64 || value > 512) {
    throw new AudioStemMuxValidationError("Audio bitrate must be an integer from 64 to 512 kbps.");
  }
}

function assertMp4Path(name: string, value: string): void {
  if (!value.trim() || path.extname(value).toLowerCase() !== ".mp4") {
    throw new AudioStemMuxValidationError(`${name} must be an MP4 path.`);
  }
}

function assertWavPath(name: string, value: string): void {
  if (!value.trim() || path.extname(value).toLowerCase() !== ".wav") {
    throw new AudioStemMuxValidationError(`${name} must be a WAV path.`);
  }
}

function normalizeStemPaths(
  request: QuickVideoAudioMuxRequest,
  platform: NodeJS.Platform,
): { paths: string[]; retained: RetainedAudioStemPaths } {
  const retained: RetainedAudioStemPaths = {};
  if (request.systemAudioPath !== undefined) {
    assertWavPath("System-audio stem", request.systemAudioPath);
    retained.systemAudioPath = path.resolve(request.systemAudioPath);
  }
  if (request.microphoneAudioPath !== undefined) {
    assertWavPath("Microphone stem", request.microphoneAudioPath);
    retained.microphoneAudioPath = path.resolve(request.microphoneAudioPath);
  }
  const paths = [retained.systemAudioPath, retained.microphoneAudioPath].filter(
    (value): value is string => value !== undefined,
  );
  if (paths.length === 0) {
    throw new AudioStemMuxValidationError("At least one completed WAV stem is required.");
  }
  if (paths.length === 2 && samePath(paths[0]!, paths[1]!, platform)) {
    throw new AudioStemMuxValidationError("System and microphone stems must be different files.");
  }
  return { paths, retained };
}

/** Build a path only; the final hard-link commit provides the no-clobber guarantee. */
export function defaultQuickVideoAudioPath(sourceVideoPath: string, suffix = 1): string {
  if (!Number.isSafeInteger(suffix) || suffix < 1) {
    throw new AudioStemMuxValidationError("Output suffix must be a positive integer.");
  }
  const source = path.parse(path.resolve(sourceVideoPath));
  const collisionSuffix = suffix === 1 ? "" : ` (${suffix})`;
  return path.join(source.dir, `${source.name} (with audio)${collisionSuffix}.mp4`);
}

function audioFilter(inputIndex: number, outputLabel: string): string {
  return `[${inputIndex}:a:0]aresample=48000:async=1:first_pts=0,` +
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${outputLabel}]`;
}

/**
 * Compile the argv and path-free filter graph used by the service. File paths
 * remain individual argv entries; they are never interpolated into a shell or
 * filter expression.
 */
export function buildAudioStemMuxPlan(input: {
  sourceVideoPath: string;
  stemPaths: readonly string[];
  graphPath: string;
  partialPath: string;
  durationUs: number;
  audioBitRateKbps?: number;
}): AudioStemMuxPlan {
  if (input.stemPaths.length < 1 || input.stemPaths.length > 2) {
    throw new AudioStemMuxValidationError("Quick Video supports one system stem and one microphone stem.");
  }
  if (!Number.isSafeInteger(input.durationUs) || input.durationUs <= 0) {
    throw new AudioStemMuxValidationError("The source video has no usable duration.");
  }
  const audioBitRateKbps = input.audioBitRateKbps ?? DEFAULT_AUDIO_BIT_RATE_KBPS;
  assertBitRate(audioBitRateKbps);

  const filters = input.stemPaths.map((_, index) => audioFilter(index + 1, `stem${index}`));
  const mixedInput = input.stemPaths.map((_, index) => `[stem${index}]`).join("");
  const mix = input.stemPaths.length === 1
    ? "[stem0]anull"
    : `${mixedInput}amix=inputs=${input.stemPaths.length}:duration=longest:` +
      "dropout_transition=0:normalize=1";
  filters.push(
    `${mix},apad=whole_dur=${seconds(input.durationUs)},` +
      `atrim=duration=${seconds(input.durationUs)},asetpts=N/SR/TB[aout]`,
  );

  return {
    filterGraph: filters.join(";\n"),
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-i",
      input.sourceVideoPath,
      ...input.stemPaths.flatMap((stemPath) => ["-i", stemPath]),
      "-/filter_complex",
      input.graphPath,
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      `${audioBitRateKbps}k`,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "0",
      "-map_chapters",
      "-1",
      "-y",
      input.partialPath,
    ],
  };
}

function parseOutTimeUs(progressValues: ReadonlyMap<string, string>): number {
  const direct = Number.parseInt(progressValues.get("out_time_us") ?? "", 10);
  if (Number.isSafeInteger(direct) && direct >= 0) return direct;
  const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(
    progressValues.get("out_time") ?? "",
  );
  if (!clock) return 0;
  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const clockSeconds = Number(clock[3]);
  const parsed = Math.round(
    (hours * 3_600 + minutes * 60 + clockSeconds) * MICROSECONDS_PER_SECOND,
  );
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function runFfmpeg(
  binary: string,
  args: readonly string[],
  durationUs: number,
  options: Pick<QuickVideoAudioMuxOptions, "signal" | "onProgress">,
): Promise<void> {
  if (options.signal?.aborted) throw new AudioStemMuxCancelledError();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let cancelled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let progressBuffer = "";
    let stderr = "";
    const progressValues = new Map<string, string>();

    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        // A concurrent process exit can make termination race; settlement is
        // still authoritative and pipe errors remain contained below.
      }
    };

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (hardKillTimer) clearTimeout(hardKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };

    const emitProgress = (): void => {
      const outTimeUs = parseOutTimeUs(progressValues);
      const fraction = progressValues.get("progress") === "end"
        ? 1
        : Math.min(1, Math.max(0, outTimeUs / durationUs));
      try {
        options.onProgress?.({ fraction, outTimeUs });
      } catch {
        // UI progress is observational and must never break a completed mux.
      }
      progressValues.clear();
    };

    const consumeProgress = (text: string): void => {
      progressBuffer += text;
      if (progressBuffer.length > MAX_STDERR_BYTES) {
        finish(new AudioStemMuxProcessError("FFmpeg progress output exceeded the safety limit."));
        killChild();
        return;
      }
      let newline = progressBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = progressBuffer.slice(0, newline).trimEnd();
        progressBuffer = progressBuffer.slice(newline + 1);
        const separator = line.indexOf("=");
        if (separator > 0) {
          const key = line.slice(0, separator);
          progressValues.set(key, line.slice(separator + 1));
          if (key === "progress") emitProgress();
        }
        newline = progressBuffer.indexOf("\n");
      }
    };

    const abort = (): void => {
      if (cancelled) return;
      cancelled = true;
      try {
        child.stdin.write("q\n");
      } catch {
        killChild();
      }
      hardKillTimer = setTimeout(killChild, 1_000);
    };

    child.stdin.on("error", () => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    guardAudioStemMuxPipes(child, (pipe, error) => {
      if (settled) return;
      const failure = cancelled || options.signal?.aborted
        ? new AudioStemMuxCancelledError()
        : new AudioStemMuxProcessError(
            `FFmpeg ${pipe} pipe failed: ${error.message}`,
            stderr,
            undefined,
            { cause: error },
          );
      finish(failure);
      killChild();
    });
    child.stdout.on("data", (chunk: Buffer) => consumeProgress(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      finish(
        new AudioStemMuxProcessError(
          `Could not start FFmpeg: ${error.message}`,
          stderr,
          undefined,
          { cause: error },
        ),
      );
    });
    child.on("close", (code) => {
      if (cancelled || options.signal?.aborted) {
        finish(new AudioStemMuxCancelledError());
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        finish(
          new AudioStemMuxProcessError(
            `FFmpeg audio mux failed${detail ? `: ${detail.slice(-4_096)}` : "."}`,
            detail,
            code ?? undefined,
          ),
        );
        return;
      }
      finish();
    });
  });
}

async function assertSourceVideo(
  sourceVideoPath: string,
  options: QuickVideoAudioMuxOptions,
): Promise<MediaProbeResult & { durationUs: number }> {
  const metadata = await probeMedia(sourceVideoPath, {
    binaryPath: options.ffprobePath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
    signal: options.signal,
  });
  if (metadata.videoStreams.length !== 1 || metadata.video?.codec.toLowerCase() !== "h264") {
    throw new AudioStemMuxValidationError("The native Quick Video source is not H.264.");
  }
  if (metadata.audioStreams.length > 0) {
    throw new AudioStemMuxValidationError(
      "The native Quick Video source already has audio; refusing to replace it with separate stems.",
    );
  }
  if (!Number.isSafeInteger(metadata.durationUs) || metadata.durationUs === undefined || metadata.durationUs <= 0) {
    throw new AudioStemMuxValidationError("The native Quick Video source has no usable duration.");
  }
  return metadata as MediaProbeResult & { durationUs: number };
}

async function assertAudioStems(
  stemPaths: readonly string[],
  options: QuickVideoAudioMuxOptions,
): Promise<MediaProbeResult[]> {
  return await Promise.all(stemPaths.map(async (stemPath, index) => {
    const metadata = await probeMedia(stemPath, {
      binaryPath: options.ffprobePath,
      resourcesPath: options.resourcesPath,
      developmentRoot: options.developmentRoot,
      allowPathFallback: options.allowPathFallback,
      platform: options.platform,
      arch: options.arch,
      env: options.env,
      exists: options.exists,
      signal: options.signal,
    });
    if (metadata.videoStreams.length > 0 || metadata.audioStreams.length !== 1) {
      throw new AudioStemMuxValidationError(`Audio stem ${index + 1} is not a single-stream audio file.`);
    }
    if (!metadata.audio?.codec.toLowerCase().startsWith("pcm_")) {
      throw new AudioStemMuxValidationError(`Audio stem ${index + 1} is not uncompressed PCM WAV audio.`);
    }
    if (metadata.durationUs === undefined || metadata.durationUs <= 0) {
      throw new AudioStemMuxValidationError(`Audio stem ${index + 1} has no usable duration.`);
    }
    return metadata;
  }));
}

async function verifyMuxedVideo(
  partialPath: string,
  source: MediaProbeResult & { durationUs: number },
  options: QuickVideoAudioMuxOptions,
): Promise<MediaProbeResult> {
  const file = await stat(partialPath);
  if (!file.isFile() || file.size === 0) {
    throw new AudioStemMuxProcessError("FFmpeg did not create a usable Quick Video file.");
  }
  const metadata = await probeMedia(partialPath, {
    binaryPath: options.ffprobePath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
    signal: options.signal,
  });
  if (
    metadata.videoStreams.length !== 1 ||
    metadata.video?.codec.toLowerCase() !== "h264" ||
    metadata.video.width !== source.video?.width ||
    metadata.video.height !== source.video.height
  ) {
    throw new AudioStemMuxProcessError("The completed Quick Video did not retain its H.264 video stream.");
  }
  if (
    metadata.audioStreams.length !== 1 ||
    metadata.audio?.codec.toLowerCase() !== "aac" ||
    metadata.audio.sampleRate !== 48_000 ||
    metadata.audio.channels !== 2
  ) {
    throw new AudioStemMuxProcessError("The completed Quick Video has no AAC audio track.");
  }
  if (metadata.durationUs === undefined || Math.abs(metadata.durationUs - source.durationUs) > 100_000) {
    throw new AudioStemMuxProcessError("The completed Quick Video duration does not match the capture.");
  }
  return metadata;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function commitWithoutClobber(
  partialPath: string,
  sourceVideoPath: string,
  stemPaths: readonly string[],
  requestedOutputPath: string | undefined,
  platform: NodeJS.Platform,
): Promise<{ outputPath: string; recoveryMarkerPath: string }> {
  const commitCandidate = async (outputPath: string): Promise<{ outputPath: string; recoveryMarkerPath: string }> => {
    const recoveryMarkerPath = await prepareQuickVideoMuxRecoveryMarker({
      finalPath: outputPath,
      verifiedOutputPath: partialPath,
      sourceVideoPath,
      stemPaths,
      destinationMode: requestedOutputPath === undefined ? "automatic" : "explicit",
      platform,
    });
    try {
      await link(partialPath, outputPath);
      return { outputPath, recoveryMarkerPath };
    } catch (error) {
      // A marker without its identity-matching final is abandoned. Retire it
      // eagerly when possible; startup recovery also handles a process exit at
      // any point between marker preparation and this cleanup.
      await rm(recoveryMarkerPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  if (requestedOutputPath !== undefined) {
    const outputPath = path.resolve(requestedOutputPath);
    try {
      return await commitCandidate(outputPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new AudioStemMuxValidationError("The Quick Video destination already exists; nothing was overwritten.");
      }
      throw error;
    }
  }

  for (let suffix = 1; suffix <= MAX_AUTO_DESTINATIONS; suffix += 1) {
    const outputPath = defaultQuickVideoAudioPath(sourceVideoPath, suffix);
    if (samePath(outputPath, sourceVideoPath, platform)) continue;
    try {
      return await commitCandidate(outputPath);
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw new AudioStemMuxValidationError("Could not reserve a unique Quick Video destination.");
}

/**
 * Stream-copy native H.264 video and encode only the aligned WAV stems to one
 * AAC track. The source video and both stems are read-only. The output becomes
 * visible in one same-directory hard-link operation after it passes ffprobe.
 */
export async function muxQuickVideoAudio(
  request: QuickVideoAudioMuxRequest,
  options: QuickVideoAudioMuxOptions = {},
): Promise<QuickVideoAudioMuxResult> {
  const platform = options.platform ?? process.platform;
  assertMp4Path("Source video", request.sourceVideoPath);
  const sourceVideoPath = path.resolve(request.sourceVideoPath);
  const requestedOutputPath = request.outputPath === undefined
    ? undefined
    : path.resolve(request.outputPath);
  if (requestedOutputPath !== undefined) {
    assertMp4Path("Output", requestedOutputPath);
    if (samePath(sourceVideoPath, requestedOutputPath, platform)) {
      throw new AudioStemMuxValidationError("Quick Video output must not overwrite the native source.");
    }
  }
  const { paths: stemPaths, retained } = normalizeStemPaths(request, platform);
  const destinationDirectory = path.dirname(requestedOutputPath ?? defaultQuickVideoAudioPath(sourceVideoPath));
  if (
    !samePath(path.dirname(sourceVideoPath), destinationDirectory, platform) ||
    stemPaths.some((stemPath) => !samePath(path.dirname(stemPath), destinationDirectory, platform))
  ) {
    throw new AudioStemMuxValidationError("Quick Video source, stems, and output must be sibling files.");
  }
  for (const stemPath of stemPaths) {
    if (samePath(stemPath, sourceVideoPath, platform) ||
        (requestedOutputPath !== undefined && samePath(stemPath, requestedOutputPath, platform))) {
      throw new AudioStemMuxValidationError("Video and audio stem paths must be different files.");
    }
  }
  const audioBitRateKbps = request.audioBitRateKbps ?? DEFAULT_AUDIO_BIT_RATE_KBPS;
  assertBitRate(audioBitRateKbps);

  if (requestedOutputPath !== undefined) {
    try {
      await stat(requestedOutputPath);
      throw new AudioStemMuxValidationError(
        "The Quick Video destination already exists; nothing was overwritten.",
      );
    } catch (error) {
      if (error instanceof AudioStemMuxValidationError) throw error;
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  let source: MediaProbeResult & { durationUs: number };
  try {
    const [validatedSource, stems] = await Promise.all([
      assertSourceVideo(sourceVideoPath, options),
      assertAudioStems(stemPaths, options),
    ]);
    source = validatedSource;
    for (const [index, stem] of stems.entries()) {
      if (Math.abs(stem.durationUs! - source.durationUs) > 250_000) {
        throw new AudioStemMuxValidationError(
          `Audio stem ${index + 1} is not aligned to the native video duration.`,
        );
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new AudioStemMuxCancelledError();
    if (error instanceof AudioStemMuxValidationError) throw error;
    throw new AudioStemMuxValidationError("Could not validate the native video and WAV stems.", {
      cause: error,
    });
  }

  await mkdir(destinationDirectory, { recursive: true });
  const token = randomUUID();
  const partialPath = path.join(destinationDirectory, `.${token}.audio-mux.partial.mp4`);
  const graphPath = path.join(destinationDirectory, `.${token}.audio-mux.ffgraph`);
  const ffmpeg = resolveBundledMediaBinary("ffmpeg", {
    explicitPath: options.ffmpegPath,
    resourcesPath: options.resourcesPath,
    developmentRoot: options.developmentRoot,
    allowPathFallback: options.allowPathFallback,
    platform: options.platform,
    arch: options.arch,
    env: options.env,
    exists: options.exists,
  });
  const plan = buildAudioStemMuxPlan({
    sourceVideoPath,
    stemPaths,
    graphPath,
    partialPath,
    durationUs: source.durationUs,
    audioBitRateKbps,
  });

  let outputPath: string | undefined;
  try {
    await writeFile(graphPath, plan.filterGraph, { encoding: "utf8", flag: "wx" });
    await runFfmpeg(ffmpeg, plan.args, source.durationUs, options);
    if (options.signal?.aborted) throw new AudioStemMuxCancelledError();
    const metadata = await verifyMuxedVideo(partialPath, source, options);
    if (options.signal?.aborted) throw new AudioStemMuxCancelledError();

    const committed = await commitWithoutClobber(
      partialPath,
      sourceVideoPath,
      stemPaths,
      requestedOutputPath,
      platform,
    );
    outputPath = committed.outputPath;
    const clipboard = request.copyToClipboard === true
      ? await copyVideoFileToClipboard(outputPath, {
          ...options.clipboardOptions,
          resourcesPath: options.clipboardOptions?.resourcesPath ?? options.resourcesPath,
          developmentRoot: options.clipboardOptions?.developmentRoot ?? options.developmentRoot,
          platform: options.clipboardOptions?.platform ?? options.platform,
          env: options.clipboardOptions?.env ?? options.env,
          exists: options.clipboardOptions?.exists ?? options.exists,
        })
      : undefined;
    return {
      sourceVideoPath,
      outputPath,
      recoveryMarkerPath: committed.recoveryMarkerPath,
      durationUs: source.durationUs,
      metadata: { ...metadata, path: outputPath },
      retainedStemPaths: retained,
      clipboard,
    };
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof AudioStemMuxCancelledError)) {
      throw new AudioStemMuxCancelledError();
    }
    throw error;
  } finally {
    // Only token-owned artifacts are removed. Native video/stems and a
    // successfully linked final output are deliberately outside this list.
    await Promise.allSettled([
      rm(partialPath, { force: true }),
      rm(graphPath, { force: true }),
    ]);
  }
}
