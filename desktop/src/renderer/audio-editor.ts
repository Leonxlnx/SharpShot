import {
  AudioTimelineEditError,
  applyAudioTimelineEdit,
  clipTimelineEndUs,
  createAudioClip,
  createAudioLane,
  trimAudioClip,
  type AudioAsset,
  type AudioClip,
  type AudioLane,
  type AudioTimeline,
} from "../shared/audio-timeline";
import {
  createEmptyProjectAudio,
  SOURCE_AUDIO_LANE_ID,
  validateSavedProjectAudio,
} from "../shared/project-audio";

const MAX_IDENTIFIER_LENGTH = 128;
export const MUSIC_LANE_ID = "music";
export const MUSIC_DUCKING_RULE_ID = "source-audio-ducks-music";
export const MUSIC_DUCKING_DEFAULTS = Object.freeze({
  thresholdDb: -24,
  ratio: 8,
  attackUs: 20_000,
  releaseUs: 250_000,
  makeupDb: 0,
});

export interface AudioEditorSelection {
  laneId: string;
  clipId?: string;
}

export interface FoundAudioSelection {
  lane: AudioLane;
  clip?: AudioClip;
}

export interface InsertMusicClipOptions {
  timeline?: AudioTimeline;
  durationUs: number;
  asset: AudioAsset;
  playheadUs: number;
  clipIdBase?: string;
}

export interface InsertMusicClipResult {
  timeline: AudioTimeline;
  selection: Required<AudioEditorSelection>;
  assetId: string;
}

export interface SplitMusicClipResult {
  timeline: AudioTimeline;
  leftClipId: string;
  rightClipId: string;
}

export interface ToggleMusicDuckingResult {
  timeline: AudioTimeline;
  enabled: boolean;
  ruleId?: string;
}

export type SelectedAudioEdit =
  | { type: "clip.trim"; timelineInUs: number; timelineOutUs: number }
  | { type: "clip.gain"; gainDb: number }
  | { type: "clip.mute"; muted: boolean }
  | { type: "clip.fades"; fadeInUs: number; fadeOutUs: number }
  | { type: "lane.gain"; gainDb: number }
  | { type: "lane.mute"; muted: boolean };

/** Keeps saved music at absolute project positions while the video duration changes. */
export function reconcileAudioTimeline(
  timeline: AudioTimeline | undefined,
  durationUs: number,
): AudioTimeline {
  assertDuration(durationUs);
  if (timeline === undefined) return createEmptyProjectAudio(durationUs);
  validateSavedProjectAudio(timeline);

  const next = structuredClone(timeline);
  next.durationUs = durationUs;
  next.lanes = next.lanes.map((lane) => ({
    ...lane,
    clips: lane.id === SOURCE_AUDIO_LANE_ID
      ? []
      : lane.clips.flatMap((clip) => {
        if (clip.timelineStartUs >= durationUs) return [];
        if (clipTimelineEndUs(clip) <= durationUs) return [clip];
        return [trimAudioClip(clip, {
          timelineInUs: clip.timelineStartUs,
          timelineOutUs: durationUs,
        })];
      }),
  }));
  next.assets = removeUnusedAssets(next);
  validateSavedProjectAudio(next);
  return next;
}

/** Returns the first music lane, creating one only when the project has none. */
export function ensureMusicLane(
  timeline: AudioTimeline | undefined,
  durationUs: number,
): { timeline: AudioTimeline; laneId: string } {
  if (timeline?.durationUs === durationUs) {
    const existing = timeline.lanes.find((lane) => lane.kind === "music");
    if (existing !== undefined) return { timeline, laneId: existing.id };
  }

  const next = reconcileAudioTimeline(timeline, durationUs);
  const reconciled = next.lanes.find((lane) => lane.kind === "music");
  if (reconciled !== undefined) return { timeline: next, laneId: reconciled.id };

  const laneId = uniqueIdentifier(MUSIC_LANE_ID, new Set(next.lanes.map((lane) => lane.id)));
  next.lanes.push(createAudioLane({ id: laneId, kind: "music", name: "Music" }));
  validateSavedProjectAudio(next);
  return { timeline: next, laneId };
}

/** Inserts a trusted, path-free music asset into a non-overlapping music lane. */
export function insertMusicClip(options: InsertMusicClipOptions): InsertMusicClipResult {
  const ensured = ensureMusicLane(options.timeline, options.durationUs);
  if (!Number.isSafeInteger(options.playheadUs)
      || options.playheadUs < 0
      || options.playheadUs >= ensured.timeline.durationUs) {
    throw new AudioTimelineEditError("Music playhead must be inside the project timeline");
  }

  const asset = sanitizeMusicAsset(options.asset);
  const existing = ensured.timeline.assets[asset.id];
  if (existing !== undefined && !sameAssetMedia(existing, asset)) {
    throw new AudioTimelineEditError(
      `Audio asset ${asset.id} changed since it was added; remove its existing clips before adding it again`,
    );
  }
  const timeline = ensured.timeline === options.timeline
    ? structuredClone(ensured.timeline)
    : ensured.timeline;
  timeline.assets[asset.id] = existing === undefined
    ? asset
    : { ...existing, name: asset.name };

  const usedClipIds = new Set(timeline.lanes.flatMap((lane) => lane.clips.map((clip) => clip.id)));
  const clipId = uniqueIdentifier(options.clipIdBase ?? `music-${asset.id}`, usedClipIds);
  const sourceOutUs = Math.min(
    timeline.assets[asset.id]!.durationUs,
    timeline.durationUs - options.playheadUs,
  );
  const lane = timeline.lanes.find((candidate) => candidate.id === ensured.laneId)!;
  const proposedEndUs = options.playheadUs + sourceOutUs;
  if (lane.clips.some((clip) =>
    options.playheadUs < clipTimelineEndUs(clip) && proposedEndUs > clip.timelineStartUs)) {
    throw new AudioTimelineEditError("Music clips cannot overlap");
  }
  lane.clips.push(createAudioClip({
    id: clipId,
    assetId: asset.id,
    timelineStartUs: options.playheadUs,
    sourceOutUs,
  }));
  validateSavedProjectAudio(timeline);
  return {
    timeline,
    selection: { laneId: ensured.laneId, clipId },
    assetId: asset.id,
  };
}

export function removeAudioClip(timeline: AudioTimeline, clipId: string): AudioTimeline {
  validateSavedProjectAudio(timeline);
  const found = findAudioClip(timeline, clipId);
  if (found === undefined) throw new AudioTimelineEditError(`Audio clip ${clipId} does not exist`);

  const next = structuredClone(timeline);
  const lane = next.lanes.find((candidate) => candidate.id === found.lane.id)!;
  lane.clips = lane.clips.filter((clip) => clip.id !== clipId);
  next.assets = removeUnusedAssets(next);
  validateSavedProjectAudio(next);
  return next;
}

export function findAudioLane(timeline: AudioTimeline, laneId: string): AudioLane | undefined {
  return timeline.lanes.find((lane) => lane.id === laneId);
}

export function findAudioClip(
  timeline: AudioTimeline,
  clipId: string,
): { lane: AudioLane; clip: AudioClip } | undefined {
  for (const lane of timeline.lanes) {
    const clip = lane.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return { lane, clip };
  }
  return undefined;
}

export function findAudioSelection(
  timeline: AudioTimeline,
  selection: AudioEditorSelection | undefined,
): FoundAudioSelection | undefined {
  if (selection === undefined) return undefined;
  const lane = findAudioLane(timeline, selection.laneId);
  if (lane === undefined) return undefined;
  if (selection.clipId === undefined) return { lane };
  const clip = lane.clips.find((candidate) => candidate.id === selection.clipId);
  return clip === undefined ? undefined : { lane, clip };
}

/** Applies the shared audio edits while supplying the current selection ids. */
export function applySelectedAudioEdit(
  timeline: AudioTimeline,
  selection: AudioEditorSelection,
  edit: SelectedAudioEdit,
): AudioTimeline {
  validateSavedProjectAudio(timeline);
  const found = findAudioSelection(timeline, selection);
  if (found === undefined) throw new AudioTimelineEditError("The selected audio item no longer exists");

  let next: AudioTimeline;
  if (edit.type === "lane.gain") {
    next = applyAudioTimelineEdit(timeline, { ...edit, laneId: found.lane.id });
  } else if (edit.type === "lane.mute") {
    next = applyAudioTimelineEdit(timeline, { ...edit, laneId: found.lane.id });
  } else {
    if (found.clip === undefined) throw new AudioTimelineEditError("Select an audio clip first");
    if (edit.type === "clip.trim") {
      next = applyAudioTimelineEdit(timeline, {
        ...edit,
        laneId: found.lane.id,
        clipId: found.clip.id,
      });
    } else if (edit.type === "clip.gain") {
      next = applyAudioTimelineEdit(timeline, {
        ...edit,
        laneId: found.lane.id,
        clipId: found.clip.id,
      });
    } else if (edit.type === "clip.mute") {
      next = applyAudioTimelineEdit(timeline, {
        ...edit,
        laneId: found.lane.id,
        clipId: found.clip.id,
      });
    } else {
      next = applyAudioTimelineEdit(timeline, {
        ...edit,
        laneId: found.lane.id,
        clipId: found.clip.id,
      });
    }
  }
  validateSavedProjectAudio(next);
  return next;
}

export function splitSelectedAudioClip(
  timeline: AudioTimeline,
  selection: AudioEditorSelection,
  splitTimelineUs: number,
): SplitMusicClipResult {
  validateSavedProjectAudio(timeline);
  const found = findAudioSelection(timeline, selection);
  if (found?.clip === undefined) throw new AudioTimelineEditError("Select an audio clip first");

  const usedClipIds = new Set(timeline.lanes.flatMap((lane) => lane.clips.map((clip) => clip.id)));
  const rightClipId = uniqueIdentifier(`${found.clip.id}-split`, usedClipIds);
  const next = applyAudioTimelineEdit(timeline, {
    type: "clip.split",
    laneId: found.lane.id,
    clipId: found.clip.id,
    splitTimelineUs,
    leftId: found.clip.id,
    rightId: rightClipId,
  });
  validateSavedProjectAudio(next);
  return { timeline: next, leftClipId: found.clip.id, rightClipId };
}

/** Toggles the single production source-audio sidechain rule for music. */
export function toggleMusicDucking(
  timeline: AudioTimeline | undefined,
  durationUs: number,
): ToggleMusicDuckingResult {
  const ensured = ensureMusicLane(timeline, durationUs);
  const next = ensured.timeline;
  if (!next.lanes.some((lane) => lane.id === SOURCE_AUDIO_LANE_ID)) {
    next.lanes.unshift(createEmptyProjectAudio(durationUs).lanes[0]!);
  }

  const musicLaneIds = new Set(next.lanes.filter((lane) => lane.kind === "music").map((lane) => lane.id));
  const matching = next.ducking.filter((rule) =>
    rule.triggerLaneId === SOURCE_AUDIO_LANE_ID && musicLaneIds.has(rule.targetLaneId));
  if (matching.length > 0) {
    const matchingIds = new Set(matching.map((rule) => rule.id));
    next.ducking = next.ducking.filter((rule) => !matchingIds.has(rule.id));
    validateSavedProjectAudio(next);
    return { timeline: next, enabled: false };
  }

  const ruleId = uniqueIdentifier(MUSIC_DUCKING_RULE_ID, new Set(next.ducking.map((rule) => rule.id)));
  next.ducking.push({
    id: ruleId,
    triggerLaneId: SOURCE_AUDIO_LANE_ID,
    targetLaneId: ensured.laneId,
    ...MUSIC_DUCKING_DEFAULTS,
  });
  validateSavedProjectAudio(next);
  return { timeline: next, enabled: true, ruleId };
}

function sanitizeMusicAsset(asset: AudioAsset): AudioAsset {
  if (asset.kind !== "music") throw new AudioTimelineEditError("Only music assets can be added to a music lane");
  return {
    id: asset.id,
    kind: "music",
    name: asset.name,
    locator: asset.locator.kind === "library"
      ? { kind: "library" }
      : { kind: "bundled", key: asset.locator.key },
    ...(asset.signature === undefined ? {} : { signature: { ...asset.signature } }),
    durationUs: asset.durationUs,
    sampleRate: asset.sampleRate,
    channels: asset.channels,
  };
}

function sameAssetMedia(left: AudioAsset, right: AudioAsset): boolean {
  if (left.kind !== "music"
      || left.locator.kind !== right.locator.kind
      || left.durationUs !== right.durationUs
      || left.sampleRate !== right.sampleRate
      || left.channels !== right.channels
      || left.signature?.byteLength !== right.signature?.byteLength
      || left.signature?.modifiedMs !== right.signature?.modifiedMs) {
    return false;
  }
  return left.locator.kind === "library"
    || (right.locator.kind === "bundled" && left.locator.key === right.locator.key);
}

function removeUnusedAssets(timeline: AudioTimeline): Record<string, AudioAsset> {
  const used = new Set(timeline.lanes.flatMap((lane) => lane.clips.map((clip) => clip.assetId)));
  return Object.fromEntries(Object.entries(timeline.assets).filter(([assetId]) => used.has(assetId)));
}

function uniqueIdentifier(base: string, used: ReadonlySet<string>): string {
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "") || "audio";
  let attempt = 1;
  while (true) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = `${cleaned.slice(0, MAX_IDENTIFIER_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
    attempt += 1;
  }
}

function assertDuration(durationUs: number): void {
  if (!Number.isSafeInteger(durationUs) || durationUs < 1) {
    throw new AudioTimelineEditError("Project audio duration must be a positive integer");
  }
}
