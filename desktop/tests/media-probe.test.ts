import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaProbeError,
  MediaToolNotFoundError,
  parseProbeOutput,
  parseRational,
  probeMedia,
  resolveBundledMediaBinary,
} from "../src/main/media-probe.js";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcessMocks.spawn }));

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", 1, null));
    return true;
  });
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  childProcessMocks.spawn.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("parseRational", () => {
  it("parses normal and NTSC rates", () => {
    expect(parseRational("60/1")).toBe(60);
    expect(parseRational("60000/1001")).toBeCloseTo(59.940_06, 5);
  });

  it("rejects zero, negative, and malformed rates", () => {
    expect(parseRational("0/0")).toBeUndefined();
    expect(parseRational("-30/1")).toBeUndefined();
    expect(parseRational("variable")).toBeUndefined();
    expect(parseRational(undefined)).toBeUndefined();
  });
});

describe("parseProbeOutput", () => {
  it("normalizes video, audio, duration, and rotation", () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            profile: "High",
            pix_fmt: "yuv420p",
            width: 1920,
            height: 1080,
            avg_frame_rate: "60000/1001",
            duration: "2.500000",
            side_data_list: [{ rotation: -90 }],
            disposition: { attached_pic: 0 },
          },
          {
            index: 1,
            codec_type: "audio",
            codec_name: "aac",
            sample_rate: "48000",
            channels: 2,
            channel_layout: "stereo",
            duration: "2.490000",
          },
        ],
        format: {
          format_name: "mov,mp4,m4a,3gp,3g2,mj2",
          format_long_name: "QuickTime / MOV",
          duration: "2.500000",
          size: "1200000",
          bit_rate: "3840000",
        },
      }),
      "relative/video.mp4",
    );

    expect(result.path).toBe(path.resolve("relative/video.mp4"));
    expect(result.durationUs).toBe(2_500_000);
    expect(result.sizeBytes).toBe(1_200_000);
    expect(result.bitRate).toBe(3_840_000);
    expect(result.video).toMatchObject({
      index: 0,
      codec: "h264",
      profile: "High",
      pixelFormat: "yuv420p",
      width: 1920,
      height: 1080,
      rotationDegrees: 270,
    });
    expect(result.video?.frameRate).toBeCloseTo(59.940_06, 5);
    expect(result.audio).toMatchObject({
      index: 1,
      codec: "aac",
      sampleRate: 48_000,
      channels: 2,
      channelLayout: "stereo",
    });
  });

  it("ignores cover-art streams and falls back to stream duration", () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "mjpeg",
            width: 600,
            height: 600,
            disposition: { attached_pic: 1 },
          },
          {
            index: 2,
            codec_type: "video",
            codec_name: "vp9",
            width: 1280,
            height: 720,
            duration: "4.25",
          },
        ],
      }),
      "clip.webm",
    );

    expect(result.videoStreams).toHaveLength(1);
    expect(result.video?.index).toBe(2);
    expect(result.durationUs).toBe(4_250_000);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseProbeOutput("not-json", "clip.mp4")).toThrow(MediaProbeError);
    expect(() => parseProbeOutput("[]", "clip.mp4")).toThrow(MediaProbeError);
  });
});

describe("resolveBundledMediaBinary", () => {
  it("uses the explicit development override first", () => {
    const expected = path.resolve("C:/tools/ffmpeg/ffprobe.exe");
    const resolved = resolveBundledMediaBinary("ffprobe", {
      developmentRoot: "C:/project",
      platform: "win32",
      arch: "x64",
      env: { SHARPSHOT_FFPROBE_PATH: expected, NODE_ENV: "development" },
      exists: (candidate) => candidate === expected,
    });
    expect(resolved).toBe(expected);
  });

  it("prefers the packaged platform-architecture binary", () => {
    const expected = path.normalize("C:/app/resources/ffmpeg/win32-x64/ffmpeg.exe");
    const resolved = resolveBundledMediaBinary("ffmpeg", {
      resourcesPath: "C:/app/resources",
      developmentRoot: "C:/project",
      platform: "win32",
      arch: "x64",
      env: { NODE_ENV: "production" },
      exists: (candidate) => candidate === expected,
    });
    expect(resolved).toBe(expected);
  });

  it("allows PATH only when explicitly enabled or in development", () => {
    expect(
      resolveBundledMediaBinary("ffmpeg", {
        platform: "win32",
        arch: "x64",
        developmentRoot: "C:/missing",
        env: { NODE_ENV: "development" },
        exists: () => false,
      }),
    ).toBe("ffmpeg.exe");

    expect(() =>
      resolveBundledMediaBinary("ffmpeg", {
        platform: "win32",
        arch: "x64",
        developmentRoot: "C:/missing",
        env: { NODE_ENV: "production" },
        exists: () => false,
      }),
    ).toThrow(MediaToolNotFoundError);
  });

  it("fails loudly when an override points nowhere", () => {
    expect(() =>
      resolveBundledMediaBinary("ffprobe", {
        explicitPath: "C:/missing/ffprobe.exe",
        platform: "win32",
        env: { NODE_ENV: "development" },
        exists: () => false,
      }),
    ).toThrow(MediaToolNotFoundError);
  });
});

describe("probeMedia process containment", () => {
  it.each(["stdout", "stderr"] as const)(
    "contains a %s pipe failure, kills ffprobe once, and preserves the first failure",
    async (pipe) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sharpshot-probe-pipe-"));
      temporaryRoots.push(root);
      const sourcePath = path.join(root, "capture.mp4");
      await writeFile(sourcePath, "video");
      const child = new FakeChild();
      childProcessMocks.spawn.mockReturnValue(child);

      const probe = probeMedia(sourcePath, {
        binaryPath: path.join(root, "ffprobe.exe"),
        exists: () => true,
        timeoutMs: 1_000,
      });

      await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledOnce());
      if (pipe === "stderr") {
        child.kill.mockImplementationOnce(() => {
          throw new Error("process already exited");
        });
      }
      const first = new Error(`${pipe} disconnected`);
      child[pipe].emit("error", first);
      const otherPipe = pipe === "stdout" ? "stderr" : "stdout";
      child[otherPipe].emit("error", new Error("late duplicate"));
      child[pipe].emit("error", new Error("another late duplicate"));

      await expect(probe).rejects.toMatchObject({
        name: MediaProbeError.name,
        message: `ffprobe ${pipe} pipe failed: ${pipe} disconnected`,
        cause: first,
      });
      expect(child.kill).toHaveBeenCalledOnce();
    },
  );
});
