import { describe, expect, it } from "vitest";
import {
  createAudioClip,
  createAudioLane,
  createAudioTimeline,
  validateAudioTimeline,
  type AudioAsset,
} from "../shared/audio-timeline";
import { createEmptyProjectAudio, SOURCE_AUDIO_LANE_ID } from "../shared/project-audio";
import {
  MUSIC_DUCKING_DEFAULTS,
  applySelectedAudioEdit,
  ensureMusicLane,
  findAudioSelection,
  insertMusicClip,
  reconcileAudioTimeline,
  removeAudioClip,
  splitSelectedAudioClip,
  toggleMusicDucking,
} from "./audio-editor";

const SECOND = 1_000_000;

function musicAsset(id = "track", durationUs = 6 * SECOND): AudioAsset {
  return {
    id,
    kind: "music",
    name: "Track",
    locator: { kind: "library" },
    durationUs,
    sampleRate: 48_000,
    channels: 2,
  };
}

describe("renderer audio editor", () => {
  it("inserts adjacent path-free clips with stable unique ids and rejects overlaps", () => {
    const supplied = {
      ...musicAsset("a".repeat(128), 2 * SECOND),
      path: "C:\\never\\persist.mp3",
    } as AudioAsset & { path: string };
    const first = insertMusicClip({
      durationUs: 5 * SECOND,
      asset: supplied,
      playheadUs: 0,
    });
    const firstSnapshot = structuredClone(first.timeline);
    expect(() => insertMusicClip({
      timeline: first.timeline,
      durationUs: 5 * SECOND,
      asset: supplied,
      playheadUs: SECOND,
    })).toThrow(/cannot overlap/i);
    const second = insertMusicClip({
      timeline: first.timeline,
      durationUs: 5 * SECOND,
      asset: supplied,
      playheadUs: 2 * SECOND,
    });
    const replayedAfterUndo = insertMusicClip({
      timeline: first.timeline,
      durationUs: 5 * SECOND,
      asset: supplied,
      playheadUs: 2 * SECOND,
    });

    const music = second.timeline.lanes.find((lane) => lane.kind === "music")!;
    expect(music.clips).toHaveLength(2);
    expect(new Set(music.clips.map((clip) => clip.id)).size).toBe(2);
    expect(music.clips.every((clip) => clip.id.length <= 128)).toBe(true);
    expect(music.clips).toEqual([
      expect.objectContaining({ timelineStartUs: 0, sourceOutUs: 2 * SECOND }),
      expect.objectContaining({ timelineStartUs: 2 * SECOND, sourceOutUs: 2 * SECOND }),
    ]);
    expect(replayedAfterUndo.selection.clipId).toBe(second.selection.clipId);
    expect(first.timeline).toEqual(firstSnapshot);
    expect(second.timeline.lanes[0]).toMatchObject({ id: SOURCE_AUDIO_LANE_ID, clips: [] });
    expect(second.timeline.assets[supplied.id]).not.toHaveProperty("path");
    expect(supplied.path).toBe("C:\\never\\persist.mp3");
    expect(() => validateAudioTimeline(second.timeline)).not.toThrow();
  });

  it("rejects changed same-id media metadata before inserting another clip", () => {
    const originalAsset = {
      ...musicAsset(),
      signature: { byteLength: 4_096, modifiedMs: 1_000 },
    };
    const inserted = insertMusicClip({
      durationUs: 5 * SECOND,
      asset: originalAsset,
      playheadUs: 0,
    });
    const changedAssets: AudioAsset[] = [
      { ...originalAsset, durationUs: 5 * SECOND },
      { ...originalAsset, sampleRate: 44_100 },
      { ...originalAsset, channels: 1 },
      { ...originalAsset, signature: { ...originalAsset.signature, modifiedMs: 2_000 } },
    ];

    for (const asset of changedAssets) {
      expect(() => insertMusicClip({
        timeline: inserted.timeline,
        durationUs: 5 * SECOND,
        asset,
        playheadUs: SECOND,
      })).toThrow(/changed since it was added/i);
    }
    expect(inserted.timeline.lanes.find((lane) => lane.kind === "music")?.clips).toHaveLength(1);
  });

  it("allows a safe name refresh when same-id media metadata is exact", () => {
    const originalAsset = musicAsset("track", SECOND);
    const inserted = insertMusicClip({
      durationUs: 5 * SECOND,
      asset: originalAsset,
      playheadUs: 0,
    });
    const renamed = insertMusicClip({
      timeline: inserted.timeline,
      durationUs: 5 * SECOND,
      asset: { ...originalAsset, name: "Renamed Track" },
      playheadUs: SECOND,
    });

    expect(renamed.timeline.assets.track?.name).toBe("Renamed Track");
    expect(renamed.timeline.lanes.find((lane) => lane.kind === "music")?.clips).toHaveLength(2);
  });

  it("rejects changed metadata for the same bundled asset id and key", () => {
    const asset: AudioAsset = {
      ...musicAsset("bundled-audio-track", SECOND),
      locator: { kind: "bundled", key: "track" },
    };
    const inserted = insertMusicClip({ durationUs: 5 * SECOND, asset, playheadUs: 0 });

    expect(() => insertMusicClip({
      timeline: inserted.timeline,
      durationUs: 5 * SECOND,
      asset: { ...asset, sampleRate: 44_100 },
      playheadUs: SECOND,
    })).toThrow(/changed since it was added/i);
  });

  it("reconciles shrink and expansion without shifting absolute clip positions", () => {
    const asset = musicAsset();
    const original = createAudioTimeline({
      durationUs: 6 * SECOND,
      assets: { [asset.id]: asset },
      lanes: [
        createAudioLane({ id: SOURCE_AUDIO_LANE_ID, kind: "system" }),
        createAudioLane({
          id: "music",
          kind: "music",
          clips: [
            createAudioClip({
              id: "crossing",
              assetId: asset.id,
              timelineStartUs: SECOND,
              sourceOutUs: 4 * SECOND,
            }),
            createAudioClip({
              id: "beyond",
              assetId: asset.id,
              timelineStartUs: 5 * SECOND,
              sourceOutUs: SECOND,
            }),
          ],
        }),
      ],
    });
    const snapshot = structuredClone(original);

    const shrunk = reconcileAudioTimeline(original, 3 * SECOND);
    const expanded = reconcileAudioTimeline(original, 8 * SECOND);

    expect(shrunk.durationUs).toBe(3 * SECOND);
    expect(shrunk.lanes[1]!.clips).toEqual([
      expect.objectContaining({ id: "crossing", timelineStartUs: SECOND, sourceOutUs: 2 * SECOND }),
    ]);
    expect(expanded.lanes[1]!.clips).toEqual(original.lanes[1]!.clips);
    expect(expanded.durationUs).toBe(8 * SECOND);
    expect(original).toEqual(snapshot);
    expect(shrunk).not.toBe(original);
    expect(shrunk.lanes[1]).not.toBe(original.lanes[1]);
  });

  it("preserves an existing music timeline when its duration already matches", () => {
    const inserted = insertMusicClip({
      durationUs: 5 * SECOND,
      asset: musicAsset(),
      playheadUs: 0,
    });

    const ensured = ensureMusicLane(inserted.timeline, inserted.timeline.durationUs);

    expect(ensured.timeline).toBe(inserted.timeline);
    expect(ensured.laneId).toBe(inserted.selection.laneId);
  });

  it("uses shared trim, split, clip and lane edits, then cleans assets after the final removal", () => {
    const inserted = insertMusicClip({
      durationUs: 5 * SECOND,
      asset: musicAsset(),
      playheadUs: 0,
    });
    const original = structuredClone(inserted.timeline);
    const trimmed = applySelectedAudioEdit(inserted.timeline, inserted.selection, {
      type: "clip.trim",
      timelineInUs: SECOND,
      timelineOutUs: 4 * SECOND,
    });
    const gained = applySelectedAudioEdit(trimmed, inserted.selection, { type: "clip.gain", gainDb: -6 });
    const laneMuted = applySelectedAudioEdit(gained, { laneId: inserted.selection.laneId }, {
      type: "lane.mute",
      muted: true,
    });
    const split = splitSelectedAudioClip(laneMuted, inserted.selection, 2 * SECOND);

    expect(findAudioSelection(split.timeline, inserted.selection)?.clip).toMatchObject({
      sourceInUs: SECOND,
      sourceOutUs: 2 * SECOND,
      gainDb: -6,
    });
    expect(findAudioSelection(split.timeline, { laneId: inserted.selection.laneId })?.lane.muted).toBe(true);
    expect(split.rightClipId).not.toBe(split.leftClipId);
    const oneLeft = removeAudioClip(split.timeline, split.rightClipId);
    expect(oneLeft.assets.track).toBeDefined();
    const noneLeft = removeAudioClip(oneLeft, split.leftClipId);
    expect(noneLeft.assets.track).toBeUndefined();
    expect(inserted.timeline).toEqual(original);
  });

  it("toggles one source-to-music duck rule with production defaults immutably", () => {
    const timeline = createEmptyProjectAudio(5 * SECOND);
    const snapshot = structuredClone(timeline);
    const enabled = toggleMusicDucking(timeline, 5 * SECOND);

    expect(enabled.enabled).toBe(true);
    expect(enabled.timeline.ducking).toEqual([{
      id: enabled.ruleId,
      triggerLaneId: SOURCE_AUDIO_LANE_ID,
      targetLaneId: "music",
      ...MUSIC_DUCKING_DEFAULTS,
    }]);
    expect(enabled.timeline.lanes.find((lane) => lane.id === SOURCE_AUDIO_LANE_ID)?.clips).toEqual([]);
    const disabled = toggleMusicDucking(enabled.timeline, 5 * SECOND);
    expect(disabled).toMatchObject({ enabled: false });
    expect(disabled.timeline.ducking).toEqual([]);
    expect(timeline).toEqual(snapshot);
  });
});
