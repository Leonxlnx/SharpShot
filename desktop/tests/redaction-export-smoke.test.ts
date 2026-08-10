import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  exportProjectMedia,
  type ProjectExportRequest,
} from "../src/main/export-service.js";
import { createEmptyOverlayDocument } from "../src/shared/overlays.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  type EditorProject,
  type VideoAsset,
} from "../src/shared/project.js";

const runFile = promisify(execFile);
const runtime = path.resolve("resources", "ffmpeg", "win32-x64");
const ffmpeg = path.join(runtime, "ffmpeg.exe");
const ffprobe = path.join(runtime, "ffprobe.exe");

describe.runIf(process.platform === "win32")("real bundled safe-redaction export", () => {
  let directory: string;
  let sourcePath: string;
  let project: EditorProject;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "SharpShot-Redaction-Smoke-"));
    sourcePath = path.join(directory, "source.mp4");
    await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0xDCE6F0:s=320x180:r=30:d=1",
      "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p",
      "-y", sourcePath,
    ]);

    const asset: VideoAsset = {
      id: "redaction-source",
      kind: "video",
      name: "source.mp4",
      locator: { kind: "external", absolutePath: sourcePath },
      durationUs: 1_000_000,
      width: 320,
      height: 180,
      frameRate: { numerator: 30, denominator: 1 },
    };
    project = createDefaultProject({ id: "redaction-smoke", now: "2026-08-10T00:00:00.000Z" });
    project.assets = { [asset.id]: asset };
    project.clips = [createClipForVideoAsset(asset, {
      id: "redaction-clip",
      sourceInUs: 0,
      sourceOutUs: 1_000_000,
    })];
    project.canvas = {
      ...project.canvas,
      preset: "custom",
      width: 320,
      height: 180,
      background: { kind: "solid", color: "#FFFFFFFF" },
      screen: {
        ...project.canvas.screen,
        padding: 0,
        scale: 1,
        position: { x: 0.5, y: 0.5 },
        crop: { x: 0, y: 0, width: 1, height: 1 },
        cornerRadius: 0,
        border: { widthPx: 0, color: "#FFFFFF", opacity: 0 },
        shadow: { offsetX: 0, offsetY: 0, blurPx: 0, opacity: 0 },
      },
    };
    project.export = { format: "mp4", fps: 30, quality: "small" };
    project.overlays = createEmptyOverlayDocument();
    project.overlays.overlays.push({
      kind: "shape",
      id: "safe-redaction",
      startUs: 200_000,
      endUs: 800_000,
      opacity: 1,
      shape: "rectangle",
      area: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      fillColor: "#08090AFF",
      strokeColor: "#00000000",
      strokeWidthPx: 0,
      cornerRadius: 0,
      rotationDeg: 0,
    });
  }, 30_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["mp4", "gif"] as const)(
    "renders an opaque timed rectangle into a synthetic %s without changing pixels outside it",
    async (format) => {
      const outputPath = path.join(directory, `redacted.${format}`);
      await exportProjectMedia(request(format, outputPath), {
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
      });

      const centerBefore = await regionMd5(outputPath, 0.1, "crop=8:8:156:86");
      const centerDuring = await regionMd5(outputPath, 0.5, "crop=8:8:156:86");
      const centerAfter = await regionMd5(outputPath, 0.9, "crop=8:8:156:86");
      expect(centerDuring).not.toBe(centerBefore);
      expect(centerAfter).toBe(centerBefore);

      const outsideBefore = await regionMd5(outputPath, 0.1, "crop=8:8:8:8");
      const outsideDuring = await regionMd5(outputPath, 0.5, "crop=8:8:8:8");
      expect(outsideDuring).toBe(outsideBefore);
      await expect(ownedTemporaries()).resolves.toEqual([]);
    },
    30_000,
  );

  function request(format: "mp4" | "gif", outputPath: string): ProjectExportRequest {
    return {
      project,
      assetPaths: { "redaction-source": sourcePath },
      outputPath,
      format,
      includeAudio: false,
      hardwareAcceleration: "off",
      gif: { frameRate: 10, maxWidth: 320 },
    };
  }

  async function regionMd5(mediaPath: string, seconds: number, filter: string): Promise<string> {
    const { stdout } = await runFile(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-ss", String(seconds),
      "-vf", filter,
      "-frames:v", "1",
      "-f", "md5", "-",
    ]);
    return stdout.trim();
  }

  async function ownedTemporaries(): Promise<string[]> {
    return (await readdir(directory)).filter((name) =>
      /^\..+\.(?:ffgraph|png|partial\.(?:mp4|gif))$/iu.test(name),
    );
  }
});
