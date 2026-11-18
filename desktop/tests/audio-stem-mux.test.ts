import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AudioStemMuxCancelledError,
  AudioStemMuxProcessError,
  AudioStemMuxValidationError,
  buildAudioStemMuxPlan,
  defaultQuickVideoAudioPath,
  muxQuickVideoAudio,
} from "../src/main/audio-stem-mux.js";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcessMocks.spawn }));

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
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

describe("buildAudioStemMuxPlan", () => {
  it("stream-copies H.264 and encodes one WAV stem to bounded AAC audio", () => {
    const plan = buildAudioStemMuxPlan({
      sourceVideoPath: "C:/captures/video & unquoted.mp4",
      stemPaths: ["C:/captures/system $(literal).wav"],
      graphPath: "C:/captures/filter graph.ffgraph",
      partialPath: "C:/captures/.owned.partial.mp4",
      durationUs: 2_345_678,
      audioBitRateKbps: 192,
    });

    expect(plan.filterGraph).toContain("[1:a:0]aresample=48000:async=1:first_pts=0");
    expect(plan.filterGraph).toContain("[stem0]anull");
    expect(plan.filterGraph).not.toContain("amix=");
    expect(plan.filterGraph).toContain("apad=whole_dur=2.345678");
    expect(plan.filterGraph).toContain("atrim=duration=2.345678");
    expect(plan.args).toContain("-/filter_complex");
    expect(plan.args).toContain("C:/captures/filter graph.ffgraph");
    expect(plan.args).toContain("C:/captures/video & unquoted.mp4");
    expect(plan.args).toContain("C:/captures/system $(literal).wav");
    expect(plan.args.slice(plan.args.indexOf("-c:v"), plan.args.indexOf("-c:v") + 2))
      .toEqual(["-c:v", "copy"]);
    expect(plan.args.slice(plan.args.indexOf("-c:a"), plan.args.indexOf("-c:a") + 2))
      .toEqual(["-c:a", "aac"]);
  });

  it("mixes two normalized stems without re-encoding the screen video", () => {
    const plan = buildAudioStemMuxPlan({
      sourceVideoPath: "video.mp4",
      stemPaths: ["system.wav", "microphone.wav"],
      graphPath: "graph.ffgraph",
      partialPath: "partial.mp4",
      durationUs: 1_000_000,
      audioBitRateKbps: 256,
    });

    expect(plan.filterGraph).toContain("[2:a:0]aresample=48000:async=1:first_pts=0");
    expect(plan.filterGraph).toContain(
      "[stem0][stem1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=1",
    );
    expect(plan.args.filter((argument) => argument === "-i")).toHaveLength(3);
    expect(plan.args).toContain("256k");
    expect(plan.args).not.toContain("-shortest");
  });

  it("rejects ambiguous stem counts, durations, and bitrates", () => {
    const base = {
      sourceVideoPath: "video.mp4",
      graphPath: "graph.ffgraph",
      partialPath: "partial.mp4",
      durationUs: 1_000_000,
    };
    expect(() => buildAudioStemMuxPlan({ ...base, stemPaths: [] }))
      .toThrow(AudioStemMuxValidationError);
    expect(() => buildAudioStemMuxPlan({
      ...base,
      stemPaths: ["one.wav", "two.wav", "three.wav"],
    })).toThrow(AudioStemMuxValidationError);
    expect(() => buildAudioStemMuxPlan({ ...base, stemPaths: ["one.wav"], durationUs: 0 }))
      .toThrow(AudioStemMuxValidationError);
    expect(() => buildAudioStemMuxPlan({
      ...base,
      stemPaths: ["one.wav"],
      audioBitRateKbps: 12,
    })).toThrow(AudioStemMuxValidationError);
  });
});

describe("Quick Video mux contract", () => {
  it("derives clean, distinct, deterministic sibling names", () => {
    const source = path.resolve("C:/captures/Recording 2026-08-09.mp4");
    expect(defaultQuickVideoAudioPath(source)).toBe(
      path.join(path.dirname(source), "Recording 2026-08-09 (with audio).mp4"),
    );
    expect(defaultQuickVideoAudioPath(source, 2)).toBe(
      path.join(path.dirname(source), "Recording 2026-08-09 (with audio) (2).mp4"),
    );
  });

  it("rejects source overwrite and missing stems before touching FFmpeg", async () => {
    await expect(muxQuickVideoAudio({
      sourceVideoPath: "C:/captures/video.mp4",
      outputPath: "C:/captures/video.mp4",
      systemAudioPath: "C:/captures/system.wav",
    }, { platform: "win32" })).rejects.toThrow("must not overwrite");

    await expect(muxQuickVideoAudio({
      sourceVideoPath: "C:/captures/video.mp4",
    }, { platform: "win32" })).rejects.toThrow("At least one completed WAV stem");
  });

  it("rejects duplicate stems case-insensitively on Windows", async () => {
    await expect(muxQuickVideoAudio({
      sourceVideoPath: "C:/captures/video.mp4",
      systemAudioPath: "C:/captures/audio.wav",
      microphoneAudioPath: "c:/CAPTURES/AUDIO.wav",
    }, { platform: "win32" })).rejects.toThrow("must be different files");
  });

  it("rejects a non-sibling explicit bundle before probing or starting FFmpeg", async () => {
    await expect(muxQuickVideoAudio({
      sourceVideoPath: "C:/captures/video.mp4",
      outputPath: "C:/exports/custom.mp4",
      systemAudioPath: "C:/captures/video.system.wav",
    }, { platform: "win32" })).rejects.toThrow("must be sibling files");
  });

  it("reports a pre-aborted job as cancellation, not missing-media fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(muxQuickVideoAudio({
      sourceVideoPath: "C:/captures/not-present.mp4",
      systemAudioPath: "C:/captures/not-present.wav",
    }, {
      platform: "win32",
      signal: controller.signal,
    })).rejects.toBeInstanceOf(AudioStemMuxCancelledError);
  });

  it.each(["stdout", "stderr"] as const)(
    "contains a %s pipe failure, kills FFmpeg once, and preserves the first failure",
    async (pipe) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sharpshot-mux-pipe-"));
      temporaryRoots.push(root);
      const sourceVideoPath = path.join(root, "capture.mp4");
      const systemAudioPath = path.join(root, "capture.system.wav");
      await Promise.all([
        writeFile(sourceVideoPath, "video"),
        writeFile(systemAudioPath, "audio"),
      ]);

      let ffmpegChild: FakeChild | undefined;
      childProcessMocks.spawn.mockImplementation((command: string, args: string[]) => {
        const child = new FakeChild();
        if (String(command).toLowerCase().includes("ffprobe")) {
          const sourcePath = String(args.at(-1));
          const isAudio = path.extname(sourcePath).toLowerCase() === ".wav";
          queueMicrotask(() => {
            child.stdout.write(JSON.stringify(isAudio
              ? {
                  streams: [{
                    index: 0,
                    codec_type: "audio",
                    codec_name: "pcm_s16le",
                    sample_rate: "48000",
                    channels: 2,
                    duration: "1.000000",
                  }],
                  format: { duration: "1.000000" },
                }
              : {
                  streams: [{
                    index: 0,
                    codec_type: "video",
                    codec_name: "h264",
                    width: 1280,
                    height: 720,
                    duration: "1.000000",
                  }],
                  format: { duration: "1.000000" },
                }));
            child.emit("close", 0, null);
          });
        } else {
          ffmpegChild = child;
        }
        return child;
      });

      const job = muxQuickVideoAudio({
        sourceVideoPath,
        systemAudioPath,
      }, {
        ffmpegPath: path.join(root, "ffmpeg.exe"),
        ffprobePath: path.join(root, "ffprobe.exe"),
        exists: () => true,
      });

      await vi.waitFor(() => expect(ffmpegChild).toBeDefined());
      if (pipe === "stderr") {
        ffmpegChild!.kill.mockImplementationOnce(() => {
          throw new Error("process already exited");
        });
      }
      const first = new Error(`${pipe} disconnected`);
      ffmpegChild![pipe].emit("error", first);
      const otherPipe = pipe === "stdout" ? "stderr" : "stdout";
      ffmpegChild![otherPipe].emit("error", new Error("late duplicate"));
      ffmpegChild![pipe].emit("error", new Error("another late duplicate"));

      await expect(job).rejects.toMatchObject({
        name: AudioStemMuxProcessError.name,
        message: `FFmpeg ${pipe} pipe failed: ${pipe} disconnected`,
        cause: first,
      });
      expect(ffmpegChild!.kill).toHaveBeenCalledOnce();
    },
  );
});
