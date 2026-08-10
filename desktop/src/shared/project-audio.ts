import {
  AudioTimelineValidationError,
  clipTimelineEndUs,
  createAudioClip,
  createAudioLane,
  createAudioTimeline,
  normalizePlaybackRate,
  sourceDurationToTimelineUs,
  validateAudioTimeline,
  type AudioAsset,
  type AudioTimeline,
} from "./audio-timeline.js";
import type { EditorProject } from "./project.js";

export const SOURCE_AUDIO_LANE_ID = "source-audio" as const;
const MAX_SAVED_AUDIO_ASSETS = 32;
const MAX_SAVED_AUDIO_LANES = 8;
const MAX_SAVED_AUDIO_CLIPS_PER_LANE = 128;
const MAX_SAVED_AUDIO_CLIPS = 256;
const MAX_SAVED_DUCKING_RULES = 16;

export interface MaterializedProjectAudio {
  timeline: AudioTimeline;
  /** Existing video inputs are already seeked to the matching source range. */
  preboundClipInputIndexes: Readonly<Record<string, number>>;
}

export class ProjectAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectAudioError";
  }
}

export function createEmptyProjectAudio(durationUs: number): AudioTimeline {
  return createAudioTimeline({
    durationUs,
    lanes: [createAudioLane({ id: SOURCE_AUDIO_LANE_ID, kind: "system", name: "Source audio" })],
  });
}

/**
 * Saved projects keep the source lane empty. Export derives it from the video
 * timeline so cuts, speed, pitch mode, gain, and mute have one authority.
 */
export function materializeProjectAudio(project: EditorProject): MaterializedProjectAudio | undefined {
  if (project.audio === undefined) return undefined;
  validateAudioTimeline(project.audio);

  const sourceLane = project.audio.lanes.find((lane) => lane.id === SOURCE_AUDIO_LANE_ID);
  if (sourceLane !== undefined && sourceLane.kind !== "system") {
    throw new ProjectAudioError(`${SOURCE_AUDIO_LANE_ID} must be a system-audio lane`);
  }
  if (sourceLane !== undefined && sourceLane.clips.length > 0) {
    throw new ProjectAudioError(`${SOURCE_AUDIO_LANE_ID} must remain empty in saved projects`);
  }

  const assets: Record<string, AudioAsset> = structuredClone(project.audio.assets);
  const persistedAssetIds = new Set(Object.keys(project.audio.assets));
  for (const assetId of persistedAssetIds) {
    if (Object.hasOwn(project.assets, assetId)) {
      throw new ProjectAudioError(`Audio asset ${assetId} collides with a project media asset`);
    }
  }
  const sourceClips = [] as ReturnType<typeof createAudioClip>[];
  const preboundClipInputIndexes: Record<string, number> = {};
  const usedClipIds = new Set(project.audio.lanes.flatMap((lane) => lane.clips.map((clip) => clip.id)));
  let timelineStartUs = 0;

  project.clips.forEach((clip, inputIndex) => {
    const durationUs = Math.max(1, Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed));
    const sourceDurationUs = clip.sourceOutUs - clip.sourceInUs;
    const video = project.assets[clip.assetId];
    if (video?.kind !== "video") {
      throw new ProjectAudioError(`Video clip ${clip.id} has no video asset`);
    }
    if (video.audio !== undefined) {
      assets[video.id] = {
        id: video.id,
        kind: "system",
        name: video.name,
        locator: { kind: "library" },
        ...(video.signature === undefined ? {} : { signature: { ...video.signature } }),
        durationUs: video.durationUs,
        sampleRate: video.audio.sampleRate,
        channels: video.audio.channels,
      };
      const sourceClipId = uniqueSourceClipId(inputIndex, usedClipIds);
      const sourceClip = createAudioClip({
        id: sourceClipId,
        assetId: video.id,
        timelineStartUs,
        sourceInUs: clip.sourceInUs,
        sourceOutUs: clip.sourceOutUs,
        playbackRate: playbackRateForExactDuration(sourceDurationUs, durationUs),
        speedMode: clip.audio.mode === "change-pitch" ? "change-pitch" : "preserve-pitch",
        gainDb: clip.audio.gainDb,
        muted: clip.audio.mode === "mute",
      });
      sourceClips.push(sourceClip);
      preboundClipInputIndexes[sourceClipId] = inputIndex;
    }
    timelineStartUs += durationUs;
  });

  const materializedSourceLane = {
    ...(sourceLane ?? createAudioLane({ id: SOURCE_AUDIO_LANE_ID, kind: "system", name: "Source audio" })),
    clips: sourceClips,
  };
  const lanes = sourceLane === undefined
    ? [materializedSourceLane, ...project.audio.lanes.map((lane) => structuredClone(lane))]
    : project.audio.lanes.map((lane) => lane.id === SOURCE_AUDIO_LANE_ID
      ? materializedSourceLane
      : structuredClone(lane));
  const timeline = createAudioTimeline({
    durationUs: project.audio.durationUs,
    assets,
    lanes,
    ducking: project.audio.ducking,
  });
  return { timeline, preboundClipInputIndexes };
}

export function activeProjectAudioAssetIds(timeline: AudioTimeline): Set<string> {
  const ids = new Set<string>();
  for (const lane of timeline.lanes) {
    if (lane.id === SOURCE_AUDIO_LANE_ID || lane.muted) continue;
    for (const clip of lane.clips) if (!clip.muted) ids.add(clip.assetId);
  }
  return ids;
}

export function validateSavedProjectAudio(timeline: AudioTimeline): void {
  validateAudioTimeline(timeline);
  const assetCount = Object.keys(timeline.assets).length;
  if (assetCount > MAX_SAVED_AUDIO_ASSETS) {
    throw new AudioTimelineValidationError(
      "audioTimeline.assets",
      `saved projects may contain at most ${MAX_SAVED_AUDIO_ASSETS} audio assets`,
    );
  }
  if (timeline.lanes.length > MAX_SAVED_AUDIO_LANES) {
    throw new AudioTimelineValidationError(
      "audioTimeline.lanes",
      `saved projects may contain at most ${MAX_SAVED_AUDIO_LANES} audio lanes`,
    );
  }
  let clipCount = 0;
  timeline.lanes.forEach((lane, laneIndex) => {
    if (lane.clips.length > MAX_SAVED_AUDIO_CLIPS_PER_LANE) {
      throw new AudioTimelineValidationError(
        `audioTimeline.lanes.${laneIndex}.clips`,
        `saved lanes may contain at most ${MAX_SAVED_AUDIO_CLIPS_PER_LANE} clips`,
      );
    }
    const orderedClips = [...lane.clips].sort((left, right) =>
      left.timelineStartUs - right.timelineStartUs || left.id.localeCompare(right.id));
    let previousEndUs = 0;
    for (const clip of orderedClips) {
      if (clip.timelineStartUs < previousEndUs) {
        throw new AudioTimelineValidationError(
          `audioTimeline.lanes.${laneIndex}.clips`,
          "saved lane clips must not overlap",
        );
      }
      previousEndUs = clipTimelineEndUs(clip);
    }
    clipCount += lane.clips.length;
  });
  if (clipCount > MAX_SAVED_AUDIO_CLIPS) {
    throw new AudioTimelineValidationError(
      "audioTimeline.lanes",
      `saved projects may contain at most ${MAX_SAVED_AUDIO_CLIPS} audio clips`,
    );
  }
  if (timeline.ducking.length > MAX_SAVED_DUCKING_RULES) {
    throw new AudioTimelineValidationError(
      "audioTimeline.ducking",
      `saved projects may contain at most ${MAX_SAVED_DUCKING_RULES} ducking rules`,
    );
  }
  const sourceLane = timeline.lanes.find((lane) => lane.id === SOURCE_AUDIO_LANE_ID);
  if (sourceLane === undefined) return;
  if (sourceLane.kind !== "system") {
    throw new AudioTimelineValidationError(
      `audioTimeline.lanes.${timeline.lanes.indexOf(sourceLane)}.kind`,
      "the reserved source-audio lane must be a system lane",
    );
  }
  if (sourceLane.clips.length > 0) {
    throw new AudioTimelineValidationError(
      `audioTimeline.lanes.${timeline.lanes.indexOf(sourceLane)}.clips`,
      "the reserved source-audio lane must remain empty in saved projects",
    );
  }
}

function playbackRateForExactDuration(sourceDurationUs: number, timelineDurationUs: number) {
  const exactRate = sourceDurationUs / timelineDurationUs;
  const playbackRate = exactRate > 8
    ? { numerator: 8, denominator: 1 }
    : exactRate < 0.25
      ? { numerator: 1, denominator: 4 }
      : normalizePlaybackRate({ numerator: sourceDurationUs, denominator: timelineDurationUs });
  if (sourceDurationToTimelineUs(sourceDurationUs, playbackRate) !== timelineDurationUs) {
    throw new ProjectAudioError("A video clip speed cannot be represented on the audio timeline");
  }
  return playbackRate;
}

function uniqueSourceClipId(index: number, used: Set<string>): string {
  const base = `source-audio-${index + 1}`;
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}
