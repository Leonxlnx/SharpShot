import { describe, expect, it } from "vitest";
import {
  AudioPlanError,
  AudioTimelineEditError,
  applyAudioTimelineEdit,
  atempoFilterChain,
  buildAudioFilterPlan,
  buildAudioInputArgs,
  clipTimelineEndUs,
  createAudioClip,
  createAudioLane,
  createAudioTimeline,
  createWaveformCacheDescriptor,
  mapClipSourceToTimelineUs,
  mapClipTimelineToSourceUs,
  mapSourceUsToTimelineUs,
  mapTimelineUsToSourceUs,
  playbackRateFromNumber,
  splitAudioClip,
  trimAudioClip,
  validateAudioTimeline,
  validateCaptionCues,
  validateCaptionSidecar,
  waveformCacheFileName,
  type AudioAsset,
  type AudioClip,
  type AudioTimeline,
  type DuckingRule,
  type SpeedMapSegment,
} from "../src/shared/audio-timeline.js";

function asset(id: string, kind: AudioAsset["kind"], durationUs = 20_000_000): AudioAsset {
  return {
    id,
    kind,
    name: `${kind} source`,
    locator: { kind: "library" },
    durationUs,
    sampleRate: 48_000,
    channels: kind === "microphone" ? 1 : 2,
  };
}

function clip(overrides: Partial<AudioClip> = {}): AudioClip {
  return createAudioClip({
    id: "clip-system",
    assetId: "asset-system",
    timelineStartUs: 1_000_000,
    sourceInUs: 2_000_000,
    sourceOutUs: 10_000_000,
    fadeInUs: 500_000,
    fadeOutUs: 750_000,
    ...overrides,
  });
}

function timeline(): AudioTimeline {
  const system = asset("asset-system", "system");
  const mic = asset("asset-mic", "microphone");
  const music = asset("asset-music", "music", 60_000_000);
  return createAudioTimeline({
    durationUs: 20_000_000,
    assets: { [system.id]: system, [mic.id]: mic, [music.id]: music },
    lanes: [
      createAudioLane({ id: "lane-system", kind: "system", clips: [clip()] }),
      createAudioLane({
        id: "lane-mic",
        kind: "microphone",
        clips: [createAudioClip({ id: "clip-mic", assetId: mic.id, sourceOutUs: 8_000_000 })],
      }),
      createAudioLane({
        id: "lane-music",
        kind: "music",
        gainDb: -6,
        clips: [
          createAudioClip({
            id: "clip-music",
            assetId: music.id,
            sourceOutUs: 16_000_000,
            playbackRate: { numerator: 2, denominator: 1 },
            fadeInUs: 1_000_000,
            fadeOutUs: 2_000_000,
          }),
        ],
      }),
    ],
  });
}

const duckingRule: DuckingRule = {
  id: "duck-music-under-mic",
  triggerLaneId: "lane-mic",
  targetLaneId: "lane-music",
  thresholdDb: -28,
  ratio: 8,
  attackUs: 15_000,
  releaseUs: 240_000,
  makeupDb: 0,
};

describe("audio timeline validation", () => {
  it("models system, microphone, and music lanes with integer microseconds", () => {
    const value = timeline();
    expect(value.lanes.map((lane) => lane.kind)).toEqual(["system", "microphone", "music"]);
    expect(value.lanes[0]!.name).toBe("System audio");
    expect(() => validateAudioTimeline(value)).not.toThrow();
  });

  it("rejects fractional time, mismatched asset kinds, and overlong clips", () => {
    const fractional = timeline();
    fractional.lanes[0]!.clips[0]!.sourceInUs = 1.5;
    expect(() => validateAudioTimeline(fractional)).toThrow(/integer/);

    const mismatch = timeline();
    mismatch.lanes[0]!.clips[0]!.assetId = "asset-music";
    expect(() => validateAudioTimeline(mismatch)).toThrow(/system asset/);

    const overlong = timeline();
    overlong.lanes[0]!.clips[0]!.timelineStartUs = 19_000_000;
    expect(() => validateAudioTimeline(overlong)).toThrow(/extends beyond/);
  });
});

describe("speed-synchronised time mapping", () => {
  it("maps clip source and timeline positions exactly at rational-speed boundaries", () => {
    const fast = clip({ playbackRate: { numerator: 2, denominator: 1 } });
    expect(clipTimelineEndUs(fast)).toBe(5_000_000);
    expect(mapClipTimelineToSourceUs(fast, 3_500_000)).toBe(7_000_000);
    expect(mapClipSourceToTimelineUs(fast, 7_000_000)).toBe(3_500_000);
    expect(mapClipTimelineToSourceUs(fast, clipTimelineEndUs(fast))).toBe(fast.sourceOutUs);
  });

  it("uses contiguous integer speed maps without cumulative floating-point drift", () => {
    const segments: SpeedMapSegment[] = [
      { timelineInUs: 0, timelineOutUs: 3_000_000, sourceInUs: 0, sourceOutUs: 3_000_000 },
      { timelineInUs: 3_000_000, timelineOutUs: 4_000_000, sourceInUs: 3_000_000, sourceOutUs: 5_000_000 },
      { timelineInUs: 4_000_000, timelineOutUs: 8_000_000, sourceInUs: 5_000_000, sourceOutUs: 7_000_000 },
    ];
    expect(mapTimelineUsToSourceUs(segments, 3_500_000)).toBe(4_000_000);
    expect(mapSourceUsToTimelineUs(segments, 6_000_000)).toBe(6_000_000);
    expect(mapTimelineUsToSourceUs(segments, 8_000_000)).toBe(7_000_000);
  });

  it("normalizes decimal playback rates and builds bounded atempo chains", () => {
    expect(playbackRateFromNumber(1.5)).toEqual({ numerator: 3, denominator: 2 });
    expect(atempoFilterChain({ numerator: 1, denominator: 4 })).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(atempoFilterChain({ numerator: 8, denominator: 1 })).toEqual([
      "atempo=2",
      "atempo=2",
      "atempo=2",
    ]);
  });
});

describe("non-destructive audio edits", () => {
  it("trims by timeline time, maps source time, and clamps existing fades", () => {
    const original = clip({ playbackRate: { numerator: 2, denominator: 1 } });
    const trimmed = trimAudioClip(original, { timelineInUs: 2_000_000, timelineOutUs: 4_000_000 });

    expect(trimmed.timelineStartUs).toBe(2_000_000);
    expect(trimmed.sourceInUs).toBe(4_000_000);
    expect(trimmed.sourceOutUs).toBe(8_000_000);
    expect(original.sourceInUs).toBe(2_000_000);
  });

  it("splits on a shared source boundary and preserves only the outer fades", () => {
    const original = clip();
    const [left, right] = splitAudioClip(original, 5_000_000, { leftId: "clip-left", rightId: "clip-right" });

    expect(left.sourceOutUs).toBe(right.sourceInUs);
    expect(left.fadeInUs).toBe(original.fadeInUs);
    expect(left.fadeOutUs).toBe(0);
    expect(right.fadeInUs).toBe(0);
    expect(right.fadeOutUs).toBe(original.fadeOutUs);
    expect(right.timelineStartUs).toBe(5_000_000);
  });

  it("applies clip, lane, and ducking edits immutably", () => {
    const original = timeline();
    const gained = applyAudioTimelineEdit(original, {
      type: "clip.gain",
      laneId: "lane-system",
      clipId: "clip-system",
      gainDb: -9,
    });
    const muted = applyAudioTimelineEdit(gained, { type: "lane.mute", laneId: "lane-system", muted: true });
    const ducked = applyAudioTimelineEdit(muted, { type: "ducking.upsert", rule: duckingRule });

    expect(original.lanes[0]!.clips[0]!.gainDb).toBe(0);
    expect(gained.lanes[0]!.clips[0]!.gainDb).toBe(-9);
    expect(muted.lanes[0]!.muted).toBe(true);
    expect(ducked.ducking).toEqual([duckingRule]);
  });

  it("rejects impossible edit boundaries", () => {
    expect(() => trimAudioClip(clip(), { timelineInUs: 0, timelineOutUs: 2_000_000 })).toThrow(
      AudioTimelineEditError,
    );
    expect(() => splitAudioClip(clip(), 1_000_000, { leftId: "same", rightId: "same" })).toThrow(
      /unique/,
    );
  });
});

describe("cache and caption descriptors", () => {
  it("creates deterministic, path-safe waveform cache names", () => {
    const descriptor = createWaveformCacheDescriptor({
      assetId: "asset-system",
      fingerprint: "94ae71dd63f7367a9c30f0ffb21487e6",
      sourceInUs: 0,
      sourceOutUs: 10_000_000,
      pointsPerSecond: 120,
      channelMode: "mixdown",
    });
    const fileName = waveformCacheFileName(descriptor);
    expect(fileName).toBe(
      "wf-v1_asset-system_94ae71dd63f7367a9c30f0ff_0-10000000_120pps_mixdown_peak-rms-v1.json",
    );
    expect(fileName).not.toContain("\\");
    expect(fileName).not.toContain("/");
  });

  it("validates safe SRT/VTT sidecars and ordered caption cues", () => {
    expect(() => validateCaptionSidecar({
      id: "captions-en",
      format: "vtt",
      locatorKey: "captions-en-v1",
      language: "en-US",
      offsetUs: -250_000,
      encoding: "utf-8",
    })).not.toThrow();
    expect(() => validateCaptionCues([
      { id: "cue-1", startUs: 0, endUs: 1_000_000, text: "Hello" },
      { id: "cue-2", startUs: 900_000, endUs: 2_000_000, text: "World" },
    ])).not.toThrow();
    expect(() => validateCaptionCues([
      { id: "cue-2", startUs: 900_000, endUs: 2_000_000, text: "World" },
      { id: "cue-1", startUs: 0, endUs: 1_000_000, text: "Hello" },
    ])).toThrow(/sorted/);
  });
});

describe("FFmpeg-safe audio planning", () => {
  it("keeps paths out of the graph and emits trim, speed, fade, gain, and timeline placement filters", () => {
    const value = timeline();
    value.lanes[0]!.clips[0]!.gainDb = -3;
    const hostilePath = "C:\\Odd folder\\song;[x]' $name.wav";
    const plan = buildAudioFilterPlan({
      timeline: value,
      assetPaths: {
        "asset-system": hostilePath,
        "asset-mic": "C:\\Media\\mic.wav",
        "asset-music": "C:\\Media\\music.wav",
      },
      baseInputIndex: 2,
    });
    const argv = buildAudioInputArgs(plan);

    expect(plan.inputs[0]).toMatchObject({ inputIndex: 2, assetId: "asset-system", path: hostilePath });
    expect(plan.filterGraph).not.toContain(hostilePath);
    expect(argv.filter((item) => item === hostilePath)).toHaveLength(1);
    expect(plan.filterGraph).toContain("atempo=2");
    expect(plan.filterGraph).toContain("afade=t=in");
    expect(plan.filterGraph).toContain("volume=-3dB");
    expect(plan.filterGraph).toContain("adelay=1000:all=1,asetpts=PTS-STARTPTS");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=20[lane_silence0]");
    expect(plan.filterGraph).toContain("amix=inputs=2:duration=longest:normalize=0[lane_raw0]");
    expect(plan.outputLabel).toBe("[audio_out]");
  });

  it("reuses pretrimmed video inputs and exact imported-audio stream indexes", () => {
    const value = timeline();
    const plan = buildAudioFilterPlan({
      timeline: value,
      assetPaths: {
        "asset-mic": "mic.wav",
        "asset-music": "music.m4a",
      },
      baseInputIndex: 4,
      preboundClipInputIndexes: { "clip-system": 1 },
      assetStreamIndexes: { "asset-music": 3 },
    });

    expect(plan.inputs.map(({ inputIndex, assetId }) => ({ inputIndex, assetId }))).toEqual([
      { inputIndex: 4, assetId: "asset-mic" },
      { inputIndex: 5, assetId: "asset-music" },
    ]);
    expect(plan.filterGraph).toContain("[1:a]atrim=start=0");
    expect(plan.filterGraph).toContain("[5:3]atrim=start=0");
  });

  it("reuses one argv input when several clips reference the same imported asset", () => {
    const value = timeline();
    value.lanes[2]!.clips.push(createAudioClip({
      id: "clip-music-second",
      assetId: "asset-music",
      timelineStartUs: 10_000_000,
      sourceInUs: 20_000_000,
      sourceOutUs: 24_000_000,
    }));
    const plan = buildAudioFilterPlan({
      timeline: value,
      assetPaths: {
        "asset-system": "system.wav",
        "asset-mic": "mic.wav",
        "asset-music": "music.wav",
      },
    });

    expect(plan.inputs.filter((input) => input.assetId === "asset-music")).toHaveLength(1);
    expect(plan.inputs.find((input) => input.assetId === "asset-music")?.beforeInputArgs).toEqual([
      "-accurate_seek", "-ss", "0", "-t", "24",
    ]);
    expect(plan.filterGraph).toContain("atrim=start=20:end=24");
  });

  it("seeks a shared imported input to its earliest active source range", () => {
    const music = asset("asset-music", "music", 86_400_000_000);
    const value = createAudioTimeline({
      durationUs: 1_000_000,
      assets: { [music.id]: music },
      lanes: [createAudioLane({
        id: "lane-music",
        kind: "music",
        clips: [createAudioClip({
          id: "far-clip",
          assetId: music.id,
          sourceInUs: 86_399_000_000,
          sourceOutUs: 86_400_000_000,
        })],
      })],
    });
    const plan = buildAudioFilterPlan({ timeline: value, assetPaths: { [music.id]: "long.wav" } });

    expect(plan.inputs[0]?.beforeInputArgs).toEqual([
      "-accurate_seek", "-ss", "86399", "-t", "1",
    ]);
    expect(plan.filterGraph).toContain("atrim=start=0:end=1");
  });

  it("skips muted media inputs and builds sidechain ducking with reusable trigger splits", () => {
    const value = timeline();
    value.lanes[0]!.muted = true;
    value.ducking = [duckingRule];
    const plan = buildAudioFilterPlan({
      timeline: value,
      assetPaths: { "asset-mic": "mic.wav", "asset-music": "music.wav" },
    });

    expect(plan.inputs.map((input) => input.assetId)).toEqual(["asset-mic", "asset-music"]);
    expect(plan.filterGraph).toContain("asplit=2");
    expect(plan.filterGraph).toContain("sidechaincompress=");
    expect(plan.filterGraph).toContain("attack=15:release=240");
    expect(plan.filterGraph).toContain("volume=0");
  });

  it("rejects unresolved active media without leaking it into a shell string", () => {
    expect(() => buildAudioFilterPlan({ timeline: timeline(), assetPaths: {} })).toThrow(AudioPlanError);
  });
});
