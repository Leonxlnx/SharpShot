import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExportCancelledError,
  exportProjectMedia,
  type ProjectExportRequest,
} from "../src/main/export-service.js";
import { createEmptyOverlayDocument } from "../src/shared/overlays.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  type EditorProject,
  type ImageAsset,
  type VideoAsset,
} from "../src/shared/project.js";

const runFile = promisify(execFile);
const runtime = path.resolve("resources", "ffmpeg", "win32-x64");
const ffmpeg = path.join(runtime, "ffmpeg.exe");
const ffprobe = path.join(runtime, "ffprobe.exe");

describe.runIf(process.platform === "win32")("real bundled caption export", () => {
  let directory: string;
  let sourcePath: string;
  let wallpaperPath: string;
  let animatedWallpaperPath: string;
  let project: EditorProject;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "SharpShot-Caption-Smoke-"));
    sourcePath = path.join(directory, "source.mp4");
    wallpaperPath = path.join(directory, "wallpaper.png");
    animatedWallpaperPath = path.join(directory, "wallpaper.gif");
    await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x1C2738:s=320x180:r=15:d=1",
      "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p",
      "-y", sourcePath,
    ]);
    await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x4A315F:s=640x360:d=0.1",
      "-frames:v", "1", "-y", wallpaperPath,
    ]);
    await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=0.5",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:r=10:d=0.5",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,fps=2",
      "-loop", "0", "-y", animatedWallpaperPath,
    ]);

    const asset: VideoAsset = {
      id: "caption-source",
      kind: "video",
      name: "source.mp4",
      locator: { kind: "external", absolutePath: sourcePath },
      durationUs: 1_000_000,
      width: 320,
      height: 180,
      frameRate: { numerator: 15, denominator: 1 },
    };
    const wallpaper: ImageAsset = {
      id: "caption-wallpaper",
      kind: "image",
      name: "wallpaper.png",
      locator: { kind: "external", absolutePath: wallpaperPath },
      width: 640,
      height: 360,
    };
    project = createDefaultProject({ id: "caption-smoke", now: "2026-08-10T00:00:00.000Z" });
    project.assets = { [asset.id]: asset, [wallpaper.id]: wallpaper };
    project.clips = [
      createClipForVideoAsset(asset, { id: "caption-clip-a", sourceInUs: 0, sourceOutUs: 500_000 }),
      createClipForVideoAsset(asset, { id: "caption-clip-b", sourceInUs: 500_000, sourceOutUs: 1_000_000 }),
    ];
    project.canvas = {
      ...project.canvas,
      preset: "custom",
      width: 640,
      height: 360,
      background: {
        kind: "image",
        assetId: wallpaper.id,
        fit: "cover",
        blurPx: 0,
        opacity: 1,
      },
    };
    project.export = { format: "mp4", fps: 15, quality: "small" };
    project.overlays = createEmptyOverlayDocument();
    project.overlays.captions.push({
      id: "caption-smoke-cue",
      startUs: 200_000,
      endUs: 800_000,
      text: "{\\alpha&HFF&} CAPTION SMOKE 42",
      style: {
        preset: "bold",
        overrides: { fontSizeRatio: 0.11, position: { x: 0.5, y: 0.5 } },
      },
    });
  }, 30_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["mp4", "gif"] as const)(
    "burns a visible timed caption into a synthetic %s and removes owned temporaries",
    async (format) => {
      const outputPath = path.join(directory, `captioned.${format}`);
      await exportProjectMedia(request(format, outputPath), options());

      const before = await frameMd5(outputPath, 0.05);
      const during = await frameMd5(outputPath, 0.5);
      expect(during).not.toBe(before);
      await expect(ownedTemporaries()).resolves.toEqual([]);
    },
    30_000,
  );

  it.each(["mp4", "gif"] as const)(
    "holds the first frame of an animated GIF background throughout a synthetic %s export",
    async (format) => {
      const sourceFirst = await cornerSignal(animatedWallpaperPath, 0.05);
      const sourceSecond = await cornerSignal(animatedWallpaperPath, 0.75);
      expect(maxSignalDelta(sourceFirst, sourceSecond)).toBeGreaterThan(20);
      const outputPath = path.join(directory, `gif-background.${format}`);
      const backgroundProject = structuredClone(project);
      backgroundProject.overlays = createEmptyOverlayDocument();
      await exportProjectMedia({
        ...request(format, outputPath),
        project: backgroundProject,
        assetPaths: { "caption-source": sourcePath, "caption-wallpaper": animatedWallpaperPath },
      }, options());

      const early = await cornerSignal(outputPath, 0.05);
      const late = await cornerSignal(outputPath, 0.75);
      expect(maxSignalDelta(early, late)).toBeLessThan(3);
      expect(maxSignalDelta(early, sourceFirst)).toBeLessThan(12);
      await expect(ownedTemporaries()).resolves.toEqual([]);
    },
    30_000,
  );

  it.each(["mp4", "gif"] as const)(
    "cancels a captioned %s without committing output or leaving ASS/graph/palette files",
    async (format) => {
      const outputPath = path.join(directory, `cancelled.${format}`);
      const controller = new AbortController();
      let abortRequested = false;
      const pending = exportProjectMedia(request(format, outputPath), options({
        signal: controller.signal,
        onProgress: (progress) => {
          if (abortRequested || (progress.phase !== "rendering" && progress.phase !== "palette")) return;
          abortRequested = true;
          controller.abort();
        },
      }));

      await expect(pending).rejects.toBeInstanceOf(ExportCancelledError);
      expect(abortRequested).toBe(true);
      await expect(ownedTemporaries()).resolves.toEqual([]);
      await expect(readdir(directory)).resolves.not.toContain(path.basename(outputPath));
    },
    30_000,
  );

  function request(format: "mp4" | "gif", outputPath: string): ProjectExportRequest {
    return {
      project,
      assetPaths: { "caption-source": sourcePath, "caption-wallpaper": wallpaperPath },
      outputPath,
      format,
      includeAudio: false,
      hardwareAcceleration: "off",
      gif: { frameRate: 15, maxWidth: 640 },
    };
  }

  function options(overrides: Parameters<typeof exportProjectMedia>[1] = {}) {
    return { ffmpegPath: ffmpeg, ffprobePath: ffprobe, ...overrides };
  }

  async function frameMd5(mediaPath: string, seconds: number): Promise<string> {
    const { stdout } = await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-ss", String(seconds),
      "-frames:v", "1",
      "-f", "md5", "-",
    ]);
    return stdout.trim();
  }

  async function cornerSignal(mediaPath: string, seconds: number): Promise<number[]> {
    const { stdout } = await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-vf", `fps=20,trim=start=${seconds},setpts=PTS-STARTPTS,trim=end_frame=1,crop=24:24:0:0,signalstats,metadata=print:file=-`,
      "-f", "null", "-",
    ]);
    return ["YAVG", "UAVG", "VAVG"].map((key) => {
      const match = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`, "u").exec(stdout);
      if (match?.[1] === undefined) throw new Error(`Missing ${key} signal statistic.`);
      return Number(match[1]);
    });
  }

  function maxSignalDelta(left: readonly number[], right: readonly number[]): number {
    return Math.max(...left.map((value, index) => Math.abs(value - right[index]!)));
  }

  async function ownedTemporaries(): Promise<string[]> {
    return (await readdir(directory)).filter((name) =>
      /^\..+\.(?:ass|ffgraph|png|partial\.(?:mp4|gif))$/iu.test(name),
    );
  }
});
