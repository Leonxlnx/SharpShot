import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  applyCaptionAssToPlan,
  applyProbedStreamSelections,
  assertWindowsFfmpegCommandLineBudget,
  commitRenderedFile,
  ExportBusyError,
  ExportProcessError,
  ExportService,
  probedAudioDurationUs,
  runFfmpeg,
  windowsCommandLineUtf16Length,
} from "../src/main/export-service.js";
import { parseProbeOutput } from "../src/main/media-probe.js";
import { buildExportPlan, buildFfmpegArgs } from "../src/shared/export-plan.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  MAX_PROJECT_CLIPS,
  type VideoAsset,
} from "../src/shared/project.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  spawnMock.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sharpshot-export-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeFfmpegChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("export lifecycle arbitration", () => {
  it("reserves the only start slot before asynchronous dialog and preflight work", () => {
    const service = new ExportService();
    expect(service.reserveStart("first-job")).toBe("first-job");
    expect(() => service.reserveStart("ghost-job")).toThrow(ExportBusyError);
    service.releaseStart("different-job");
    expect(() => service.reserveStart("still-blocked")).toThrow(ExportBusyError);
    service.releaseStart("first-job");
    expect(service.reserveStart("next-job")).toBe("next-job");
  });
});

describe("atomic export commit", () => {
  it("does not overwrite a destination that appears after a new path was selected", async () => {
    const directory = await temporaryDirectory();
    const partial = path.join(directory, ".render.partial.mp4");
    const destination = path.join(directory, "Demo.mp4");
    await writeFile(partial, "new render");
    await writeFile(destination, "appeared later");

    await expect(commitRenderedFile(partial, destination, false)).rejects.toThrow(
      "appeared while rendering",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("appeared later");
    await expect(readFile(partial, "utf8")).resolves.toBe("new render");
  });

  it("commits a still-unused destination without a clobber window", async () => {
    const directory = await temporaryDirectory();
    const partial = path.join(directory, ".render.partial.mp4");
    const destination = path.join(directory, "Demo.mp4");
    await writeFile(partial, "verified render");

    await commitRenderedFile(partial, destination, false);
    await expect(readFile(destination, "utf8")).resolves.toBe("verified render");
    await expect(readFile(partial, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces an existing destination only after explicit overwrite intent", async () => {
    const directory = await temporaryDirectory();
    const partial = path.join(directory, ".render.partial.mp4");
    const destination = path.join(directory, "Demo.mp4");
    await writeFile(partial, "replacement");
    await writeFile(destination, "confirmed old output");

    await commitRenderedFile(partial, destination, true);
    await expect(readFile(destination, "utf8")).resolves.toBe("replacement");
  });
});

describe("probed stream binding", () => {
  it("maps the playable MP4 stream instead of attached cover art", () => {
    const metadata = parseProbeOutput(JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "mjpeg", width: 1200, height: 1200, disposition: { attached_pic: 1 } },
        { index: 1, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "60/1", disposition: { attached_pic: 0 } },
        { index: 2, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
      ],
      format: { duration: "5" },
    }), "cover-art.mp4");
    expect(metadata.video?.index).toBe(1);

    const asset: VideoAsset = {
      id: "video",
      kind: "video",
      name: "cover-art.mp4",
      locator: { kind: "external", absolutePath: "C:\\Media\\cover-art.mp4" },
      durationUs: 5_000_000,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 60, denominator: 1 },
      audio: { codec: "aac", sampleRate: 48_000, channels: 2 },
    };
    const project = createDefaultProject({ id: "cover-art-project", now: "2026-08-09T12:00:00.000Z" });
    project.assets = { [asset.id]: asset };
    project.clips = [createClipForVideoAsset(asset, { id: "clip" })];
    const generic = buildExportPlan({
      project,
      assetPaths: { [asset.id]: "C:\\Media\\cover-art.mp4" },
      outputPath: "C:\\Exports\\Demo.mp4",
    });
    const selected = applyProbedStreamSelections(generic, {
      [asset.id]: { videoIndex: metadata.video!.index, audioIndex: metadata.audio!.index },
    });

    expect(selected.filterGraph).toContain("[0:1]");
    expect(selected.filterGraph).toContain("[0:2]");
    expect(selected.filterGraph).not.toContain("[0:v]");
    expect(selected.filterGraph).not.toContain("[0:a]");
  });

  it("falls back to a positive container duration when the audio stream reports zero", () => {
    const zeroStreamDuration = parseProbeOutput(JSON.stringify({
      streams: [{
        index: 0,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        duration: "0",
      }],
      format: { duration: "5" },
    }), "audio.m4a");
    const explicitZeroStreamDuration = {
      ...zeroStreamDuration,
      audio: { ...zeroStreamDuration.audio!, durationUs: 0 },
    };
    const positiveStreamDuration = {
      ...zeroStreamDuration,
      audio: { ...zeroStreamDuration.audio!, durationUs: 4_000_000 },
    };

    expect(probedAudioDurationUs(explicitZeroStreamDuration)).toBe(5_000_000);
    expect(probedAudioDurationUs(positiveStreamDuration)).toBe(4_000_000);
  });
});

describe("caption filter binding", () => {
  function videoPlan(format: "mp4" | "gif", mode: "final" | "gif-palette" | "gif-render") {
    const asset: VideoAsset = {
      id: "video",
      kind: "video",
      name: "caption-source.mp4",
      locator: { kind: "external", absolutePath: "C:\\Media\\caption-source.mp4" },
      durationUs: 2_000_000,
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    };
    const project = createDefaultProject({ id: "caption-project", now: "2026-08-10T00:00:00.000Z" });
    project.assets = { [asset.id]: asset };
    project.clips = [createClipForVideoAsset(asset, { id: "caption-clip" })];
    return buildExportPlan(
      {
        project,
        assetPaths: { [asset.id]: "C:\\Media\\caption-source.mp4" },
        outputPath: format === "mp4" ? "C:\\Exports\\caption.mp4" : "C:\\Exports\\caption.gif",
        format,
        gif: { frameRate: 15, maxWidth: 960 },
      },
      { mode, palettePath: mode === "gif-render" ? "C:\\Exports\\palette.png" : undefined, mp4PixelFormat: "nv12" },
    );
  }

  it("leaves every no-caption plan field and graph unchanged", () => {
    const plan = videoPlan("mp4", "final");
    expect(applyCaptionAssToPlan(plan)).toBe(plan);
  });

  it.each([
    ["mp4", "final", "format=nv12"],
    ["gif", "gif-palette", "fps=15"],
    ["gif", "gif-render", "fps=15"],
  ] as const)("burns captions before %s %s output processing", (format, mode, nextFilter) => {
    const plan = videoPlan(format, mode);
    const captioned = applyCaptionAssToPlan(plan, ".123e4567-e89b-12d3-a456-426614174000.captions.ass");

    expect(captioned.filterGraph).toContain(
      "[vcat]ass=filename=.123e4567-e89b-12d3-a456-426614174000.captions.ass[vcaptioned];\n" +
      `[vcaptioned]${nextFilter}`,
    );
    expect(captioned.inputArgs).toBe(plan.inputArgs);
    expect(captioned.outputArgs).toBe(plan.outputArgs);
    expect(captioned.videoLabel).toBe(plan.videoLabel);
  });

  it("rejects a renderer-controlled ASS path", () => {
    const plan = videoPlan("mp4", "final");
    expect(() => applyCaptionAssToPlan(plan, "..\\renderer.ass"))
      .toThrow(/caption filename is unsafe/);
  });
});

describe("FFmpeg pipe failure containment", () => {
  it.each([
    ["stdout", "progress"],
    ["stderr", "diagnostic"],
  ] as const)("turns a %s error into one bounded export failure", async (pipe, label) => {
    const child = fakeFfmpegChild();
    spawnMock.mockReturnValue(child);
    const pending = runFfmpeg("ffmpeg", [], {
      totalDurationUs: 1_000_000,
      phase: "rendering",
      phaseStart: 0,
      phaseEnd: 1,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "ExportProcessError",
      message: `FFmpeg ${label} stream failed: broken ${pipe}`,
    } satisfies Partial<ExportProcessError>);

    child[pipe].emit("error", new Error(`broken ${pipe}`));
    child.emit("close", 0);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();

    // Late stream errors remain observed and cannot become uncaught main-process errors.
    child.stdout.emit("error", new Error("late stdout"));
    child.stderr.emit("error", new Error("late stderr"));
  });

  it("preserves the pipe failure even when process cleanup itself throws", async () => {
    const child = fakeFfmpegChild();
    child.kill.mockImplementation(() => { throw new Error("kill raced with exit"); });
    spawnMock.mockReturnValue(child);
    const firstFailure = new Error("stdout transport failed");
    const pending = runFfmpeg("ffmpeg", [], {
      totalDurationUs: 1_000_000,
      phase: "rendering",
      phaseStart: 0,
      phaseEnd: 1,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "ExportProcessError",
      message: "FFmpeg progress stream failed: stdout transport failed",
      cause: firstFailure,
    });

    child.stdout.emit("error", firstFailure);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("Windows FFmpeg command-line budget", () => {
  function maxCutArgs(sourcePath: string): string[] {
    const asset: VideoAsset = {
      id: "max-cut-video",
      kind: "video",
      name: "source.mp4",
      locator: { kind: "external", absolutePath: sourcePath },
      durationUs: MAX_PROJECT_CLIPS * 1_000_000,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 60, denominator: 1 },
    };
    const project = createDefaultProject({ id: "max-cut-project", now: "2026-08-10T00:00:00.000Z" });
    project.assets = { [asset.id]: asset };
    project.clips = Array.from({ length: MAX_PROJECT_CLIPS }, (_, index) => createClipForVideoAsset(asset, {
      id: `clip-${index}`,
      sourceInUs: index * 1_000_000,
      sourceOutUs: (index + 1) * 1_000_000,
    }));
    return buildFfmpegArgs(buildExportPlan({
      project,
      assetPaths: { [asset.id]: sourcePath },
      outputPath: "C:\\Exports\\finished.mp4",
    }), { filterGraphPath: "C:\\Temp\\export graph.txt" });
  }

  it("accepts a normal project at the 200-cut schema maximum", () => {
    const binary = "C:\\Program Files\\SharpShot\\ffmpeg.exe";
    const args = maxCutArgs("C:\\Media\\source.mp4");

    expect(windowsCommandLineUtf16Length(binary, args)).toBeLessThanOrEqual(32_767);
    expect(() => assertWindowsFfmpegCommandLineBudget(binary, args, "win32")).not.toThrow();
  });

  it("rejects a long-path 200-cut project as INVALID_EXPORT before spawn", async () => {
    const binary = "C:\\Program Files\\SharpShot\\ffmpeg.exe";
    const sourcePath = `C:\\Recordings\\${"deep-folder\\".repeat(18)}source.mp4`;
    const args = maxCutArgs(sourcePath);
    const required = windowsCommandLineUtf16Length(binary, args);

    expect(required).toBeGreaterThan(32_767);
    await expect(runFfmpeg(binary, args, {
      platform: "win32",
      totalDurationUs: MAX_PROJECT_CLIPS * 1_000_000,
      phase: "rendering",
      phaseStart: 0,
      phaseEnd: 1,
    })).rejects.toMatchObject({
      name: "ExportValidationError",
      message: `This project needs a ${required}-unit Windows FFmpeg command line; the limit is 32767 UTF-16 units including the terminator. Shorten the source media path or reduce the number of cuts.`,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
