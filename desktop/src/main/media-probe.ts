import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export type MediaTool = "ffmpeg" | "ffprobe";

export interface MediaBinaryResolutionOptions {
  explicitPath?: string;
  resourcesPath?: string;
  developmentRoot?: string;
  allowPathFallback?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

export interface ProbeMediaOptions extends MediaBinaryResolutionOptions {
  binaryPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MediaVideoStream {
  index: number;
  codec: string;
  profile?: string;
  pixelFormat?: string;
  width: number;
  height: number;
  frameRate?: number;
  durationUs?: number;
  rotationDegrees: number;
}

export interface MediaAudioStream {
  index: number;
  codec: string;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  durationUs?: number;
}

export interface MediaProbeResult {
  path: string;
  formatName?: string;
  formatLongName?: string;
  durationUs?: number;
  sizeBytes?: number;
  bitRate?: number;
  video?: MediaVideoStream;
  audio?: MediaAudioStream;
  videoStreams: MediaVideoStream[];
  audioStreams: MediaAudioStream[];
}

interface RawProbeStream {
  index?: unknown;
  codec_type?: unknown;
  codec_name?: unknown;
  profile?: unknown;
  pix_fmt?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
  duration?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  channel_layout?: unknown;
  disposition?: { attached_pic?: unknown };
  tags?: { rotate?: unknown };
  side_data_list?: Array<{ rotation?: unknown }>;
}

interface RawProbeDocument {
  streams?: RawProbeStream[];
  format?: {
    format_name?: unknown;
    format_long_name?: unknown;
    duration?: unknown;
    size?: unknown;
    bit_rate?: unknown;
  };
}

export class MediaToolNotFoundError extends Error {
  readonly tool: MediaTool;
  readonly candidates: string[];

  constructor(tool: MediaTool, candidates: string[]) {
    super(
      `Could not find ${tool}. Expected a bundled binary or the ${environmentVariable(tool)} development override.`,
    );
    this.name = "MediaToolNotFoundError";
    this.tool = tool;
    this.candidates = candidates;
  }
}

export class MediaProbeError extends Error {
  readonly exitCode?: number;

  constructor(message: string, exitCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaProbeError";
    this.exitCode = exitCode;
  }
}

function guardMediaProbePipes(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  onError: (pipe: "stdout" | "stderr", error: Error) => void,
): void {
  let handled = false;
  const handleError = (pipe: "stdout" | "stderr") => (value: unknown): void => {
    if (handled) return;
    handled = true;
    const error = value instanceof Error
      ? value
      : new Error(`ffprobe ${pipe} emitted an invalid pipe error.`);
    onError(pipe, error);
  };
  child.stdout.on("error", handleError("stdout"));
  child.stderr.on("error", handleError("stderr"));
}

function environmentVariable(tool: MediaTool): string {
  return tool === "ffmpeg" ? "SHARPSHOT_FFMPEG_PATH" : "SHARPSHOT_FFPROBE_PATH";
}

function executableName(tool: MediaTool, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${tool}.exe` : tool;
}

function defaultExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an app-owned FFmpeg tool. Production never silently picks up a random
 * system binary; PATH fallback is intentionally development-only by default.
 */
export function resolveBundledMediaBinary(
  tool: MediaTool,
  options: MediaBinaryResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const developmentRoot = path.resolve(options.developmentRoot ?? process.cwd());
  const exists = options.exists ?? defaultExists;
  const override = options.explicitPath ?? env[environmentVariable(tool)];

  if (override?.trim()) {
    const resolvedOverride = path.isAbsolute(override)
      ? path.normalize(override)
      : path.resolve(developmentRoot, override);
    if (!exists(resolvedOverride)) {
      throw new MediaToolNotFoundError(tool, [resolvedOverride]);
    }
    return resolvedOverride;
  }

  const executable = executableName(tool, platform);
  const platformDirectory = `${platform}-${arch}`;
  const candidates: string[] = [];
  const addCandidate = (candidate: string): void => {
    const normalized = path.normalize(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (options.resourcesPath) {
    addCandidate(path.join(options.resourcesPath, "ffmpeg", platformDirectory, executable));
    addCandidate(path.join(options.resourcesPath, "ffmpeg", executable));
    addCandidate(path.join(options.resourcesPath, "media", executable));
  }

  addCandidate(path.join(developmentRoot, "resources", "ffmpeg", platformDirectory, executable));
  addCandidate(path.join(developmentRoot, "resources", "ffmpeg", executable));
  addCandidate(path.join(developmentRoot, "vendor", "ffmpeg", platformDirectory, executable));

  const bundled = candidates.find(exists);
  if (bundled) return bundled;

  const allowPathFallback =
    options.allowPathFallback ?? env.NODE_ENV !== "production";
  if (allowPathFallback) return executable;
  throw new MediaToolNotFoundError(tool, candidates);
}

export function parseRational(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(-?\d+)\/(-?\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

function secondsToMicroseconds(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds < 0) return undefined;
  const microseconds = Math.round(seconds * 1_000_000);
  return Number.isSafeInteger(microseconds) ? microseconds : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeRotation(stream: RawProbeStream): number {
  const sideRotation = stream.side_data_list
    ?.map((entry) => finiteNumber(entry.rotation))
    .find((value) => value !== undefined);
  const tagRotation = finiteNumber(stream.tags?.rotate);
  const rawRotation = sideRotation ?? tagRotation ?? 0;
  const normalized = ((Math.round(rawRotation / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

function normalizeVideoStream(stream: RawProbeStream): MediaVideoStream | undefined {
  const index = nonNegativeInteger(stream.index);
  const width = nonNegativeInteger(stream.width);
  const height = nonNegativeInteger(stream.height);
  if (index === undefined || width === undefined || height === undefined || width === 0 || height === 0) {
    return undefined;
  }
  return {
    index,
    codec: stringValue(stream.codec_name) ?? "unknown",
    profile: stringValue(stream.profile),
    pixelFormat: stringValue(stream.pix_fmt),
    width,
    height,
    frameRate: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
    durationUs: secondsToMicroseconds(stream.duration),
    rotationDegrees: normalizeRotation(stream),
  };
}

function normalizeAudioStream(stream: RawProbeStream): MediaAudioStream | undefined {
  const index = nonNegativeInteger(stream.index);
  if (index === undefined) return undefined;
  return {
    index,
    codec: stringValue(stream.codec_name) ?? "unknown",
    sampleRate: nonNegativeInteger(stream.sample_rate),
    channels: nonNegativeInteger(stream.channels),
    channelLayout: stringValue(stream.channel_layout),
    durationUs: secondsToMicroseconds(stream.duration),
  };
}

export function parseProbeOutput(json: string, sourcePath: string): MediaProbeResult {
  let document: RawProbeDocument;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("ffprobe output is not an object");
    }
    document = parsed as RawProbeDocument;
  } catch (error) {
    throw new MediaProbeError("ffprobe returned invalid JSON.", undefined, { cause: error });
  }

  const streams = Array.isArray(document.streams) ? document.streams : [];
  const videoStreams = streams
    .filter(
      (stream) =>
        stream.codec_type === "video" && finiteNumber(stream.disposition?.attached_pic) !== 1,
    )
    .map(normalizeVideoStream)
    .filter((stream): stream is MediaVideoStream => stream !== undefined);
  const audioStreams = streams
    .filter((stream) => stream.codec_type === "audio")
    .map(normalizeAudioStream)
    .filter((stream): stream is MediaAudioStream => stream !== undefined);

  const streamDurations = [...videoStreams, ...audioStreams]
    .map((stream) => stream.durationUs)
    .filter((duration): duration is number => duration !== undefined);
  const formatDuration = secondsToMicroseconds(document.format?.duration);

  return {
    path: path.resolve(sourcePath),
    formatName: stringValue(document.format?.format_name),
    formatLongName: stringValue(document.format?.format_long_name),
    durationUs:
      formatDuration ?? (streamDurations.length > 0 ? Math.max(...streamDurations) : undefined),
    sizeBytes: nonNegativeInteger(document.format?.size),
    bitRate: nonNegativeInteger(document.format?.bit_rate),
    video: videoStreams[0],
    audio: audioStreams[0],
    videoStreams,
    audioStreams,
  };
}

interface CollectedProcessResult {
  stdout: string;
  stderr: string;
}

async function collectProcess(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number },
): Promise<CollectedProcessResult> {
  if (options.signal?.aborted) {
    throw new MediaProbeError("Media probe was cancelled.");
  }

  return await new Promise<CollectedProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        // The process may have exited between failure detection and cleanup.
      }
    };

    const finish = (error?: Error, result?: CollectedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const addChunk = (destination: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        finish(new MediaProbeError("ffprobe output exceeded the safety limit."));
        killChild();
        return;
      }
      destination.push(chunk);
    };

    const abort = (): void => {
      finish(new MediaProbeError("Media probe was cancelled."));
      killChild();
    };

    const timeout = setTimeout(() => {
      finish(new MediaProbeError(`ffprobe timed out after ${options.timeoutMs} ms.`));
      killChild();
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    guardMediaProbePipes(child, (pipe, error) => {
      if (settled) return;
      const failure = options.signal?.aborted
        ? new MediaProbeError("Media probe was cancelled.")
        : new MediaProbeError(
            `ffprobe ${pipe} pipe failed: ${error.message}`,
            undefined,
            { cause: error },
          );
      finish(failure);
      killChild();
    });
    child.stdout.on("data", (chunk: Buffer) => addChunk(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => addChunk(stderr, chunk));
    child.on("error", (error) => {
      finish(new MediaProbeError(`Could not start ffprobe: ${error.message}`, undefined, { cause: error }));
    });
    child.on("close", (code) => {
      if (settled) return;
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        finish(
          new MediaProbeError(
            `ffprobe failed${stderrText ? `: ${stderrText.slice(-4_096)}` : "."}`,
            code ?? undefined,
          ),
        );
        return;
      }
      finish(undefined, { stdout: stdoutText, stderr: stderrText });
    });
  });
}

export async function probeMedia(
  sourcePath: string,
  options: ProbeMediaOptions = {},
): Promise<MediaProbeResult> {
  const absolutePath = path.resolve(sourcePath);
  const sourceStat = await stat(absolutePath);
  if (!sourceStat.isFile()) throw new MediaProbeError("Media source is not a file.");

  const binary = resolveBundledMediaBinary("ffprobe", {
    ...options,
    explicitPath: options.binaryPath ?? options.explicitPath,
  });
  const result = await collectProcess(
    binary,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      absolutePath,
    ],
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1_024 * 1_024,
    },
  );
  return parseProbeOutput(result.stdout, absolutePath);
}
