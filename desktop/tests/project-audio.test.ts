import { describe, expect, it } from "vitest";
import {
  clipTimelineEndUs,
  createAudioClip,
  createAudioLane,
  type AudioAsset,
} from "../src/shared/audio-timeline.js";
import {
  SOURCE_AUDIO_LANE_ID,
  activeProjectAudioAssetIds,
  createEmptyProjectAudio,
  materializeProjectAudio,
  validateSavedProjectAudio,
} from "../src/shared/project-audio.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  type VideoAsset,
} from "../src/shared/project.js";

function projectWithAudio() {
  const video: VideoAsset = {
    id: "video-source",
    kind: "video",
    name: "Recording.mp4",
    locator: { kind: "managed", relativePath: "library/video-source" },
    durationUs: 10_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 60, denominator: 1 },
    audio: { codec: "aac", sampleRate: 48_000, channels: 2 },
  };
  const project = createDefaultProject({ id: "project-audio", now: "2026-08-10T00:00:00.000Z" });
  project.assets[video.id] = video;
  project.clips = [
    createClipForVideoAsset(video, {
      id: "video-clip-a",
      sourceOutUs: 4_000_000,
      speed: 2,
      audioMode: "change-pitch",
      gainDb: -3,
    }),
    createClipForVideoAsset(video, {
      id: "video-clip-b",
      sourceInUs: 4_000_000,
      sourceOutUs: 10_000_000,
      speed: 0.5,
      audioMode: "mute",
    }),
  ];
  project.audio = createEmptyProjectAudio(14_000_000);
  const music: AudioAsset = {
    id: "music-asset",
    kind: "music",
    name: "Music",
    locator: { kind: "library" },
    durationUs: 30_000_000,
    sampleRate: 44_100,
    channels: 2,
  };
  project.audio.assets[music.id] = music;
  project.audio.lanes.push(createAudioLane({
    id: "music-lane",
    kind: "music",
    clips: [createAudioClip({ id: "music-clip", assetId: music.id, sourceOutUs: 14_000_000 })],
  }));
  project.audio.ducking.push({
    id: "duck-source-music",
    triggerLaneId: SOURCE_AUDIO_LANE_ID,
    targetLaneId: "music-lane",
    thresholdDb: -28,
    ratio: 8,
    attackUs: 15_000,
    releaseUs: 240_000,
    makeupDb: 0,
  });
  return project;
}

describe("project audio materialization", () => {
  it("derives cut, speed, gain, mute, and prebound source clips without mutating saved audio", () => {
    const project = projectWithAudio();
    const savedAudio = structuredClone(project.audio);
    const materialized = materializeProjectAudio(project);

    expect(materialized).toBeDefined();
    const source = materialized!.timeline.lanes.find((lane) => lane.id === SOURCE_AUDIO_LANE_ID)!;
    expect(source.clips).toHaveLength(2);
    expect(source.clips[0]).toMatchObject({
      timelineStartUs: 0,
      sourceInUs: 0,
      sourceOutUs: 4_000_000,
      playbackRate: { numerator: 2, denominator: 1 },
      speedMode: "change-pitch",
      gainDb: -3,
      muted: false,
    });
    expect(source.clips[1]).toMatchObject({
      timelineStartUs: 2_000_000,
      sourceInUs: 4_000_000,
      sourceOutUs: 10_000_000,
      playbackRate: { numerator: 1, denominator: 2 },
      muted: true,
    });
    expect(materialized!.preboundClipInputIndexes).toEqual({
      "source-audio-1": 0,
      "source-audio-2": 1,
    });
    expect(materialized!.timeline.assets["video-source"]).toMatchObject({
      kind: "system",
      durationUs: 10_000_000,
      locator: { kind: "library" },
    });
    expect(project.audio).toEqual(savedAudio);
  });

  it("reports only active persisted audio assets for trusted path resolution", () => {
    const project = projectWithAudio();
    expect([...activeProjectAudioAssetIds(project.audio!)]).toEqual(["music-asset"]);
    project.audio!.lanes.find((lane) => lane.id === "music-lane")!.muted = true;
    expect([...activeProjectAudioAssetIds(project.audio!)]).toEqual([]);
  });

  it("derives a rational source rate that exactly matches the canonical video duration", () => {
    const project = projectWithAudio();
    const speed = 5.29432616481183;
    project.clips = [createClipForVideoAsset(project.assets["video-source"] as VideoAsset, {
      id: "precision-clip",
      sourceOutUs: 10_000_000,
      speed,
    })];
    project.audio = createEmptyProjectAudio(1_888_814);

    const materialized = materializeProjectAudio(project)!;
    const sourceClip = materialized.timeline.lanes[0]!.clips[0]!;
    expect(clipTimelineEndUs(sourceClip)).toBe(1_888_814);
  });

  it("caps persisted per-lane clip fan-in before export planning", () => {
    const audio = createEmptyProjectAudio(1_000_000);
    audio.assets.music = {
      id: "music",
      kind: "music",
      name: "Music",
      locator: { kind: "library" },
      durationUs: 1_000_000,
      sampleRate: 44_100,
      channels: 2,
    };
    audio.lanes.push(createAudioLane({
      id: "music",
      kind: "music",
      clips: Array.from({ length: 129 }, (_, index) => createAudioClip({
        id: `clip-${index}`,
        assetId: "music",
        sourceOutUs: 1,
      })),
    }));

    expect(() => validateSavedProjectAudio(audio)).toThrow(/at most 128 clips/);
  });

  it("rejects overlapping clips inside a saved lane while allowing overlap across lanes", () => {
    const audio = createEmptyProjectAudio(2_000_000);
    audio.assets.music = {
      id: "music",
      kind: "music",
      name: "Music",
      locator: { kind: "library" },
      durationUs: 2_000_000,
      sampleRate: 44_100,
      channels: 2,
    };
    audio.lanes.push(createAudioLane({
      id: "music-a",
      kind: "music",
      clips: [
        createAudioClip({ id: "first", assetId: "music", sourceOutUs: 1_500_000 }),
        createAudioClip({
          id: "overlap",
          assetId: "music",
          timelineStartUs: 1_000_000,
          sourceOutUs: 1_000_000,
        }),
      ],
    }));

    expect(() => validateSavedProjectAudio(audio)).toThrow(/must not overlap/);
    audio.lanes[1]!.clips.pop();
    audio.lanes.push(createAudioLane({
      id: "music-b",
      kind: "music",
      clips: [createAudioClip({ id: "parallel", assetId: "music", sourceOutUs: 1_500_000 })],
    }));
    expect(() => validateSavedProjectAudio(audio)).not.toThrow();
  });
});
