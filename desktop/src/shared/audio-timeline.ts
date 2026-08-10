export const AUDIO_TIMELINE_SCHEMA_VERSION = 1 as const;
export const WAVEFORM_CACHE_VERSION = 1 as const;
const MAX_AUDIO_ASSETS = 512;
const MAX_AUDIO_LANES = 16;
const MAX_AUDIO_CLIPS_PER_LANE = 256;
const MAX_AUDIO_CLIPS = 512;
const MAX_DUCKING_RULES = 32;
const MAX_AUDIO_PLAN_INPUTS = 64;

export type TimeUs = number;
export type AudioLaneKind = "system" | "microphone" | "music";
export type AudioSpeedMode = "preserve-pitch" | "change-pitch";

export type AudioAssetLocator =
  | { kind: "library" }
  | { kind: "bundled"; key: string };

export interface AudioAssetSignature {
  byteLength: number;
  modifiedMs: number;
}

/**
 * Source-time units consumed for each timeline-time unit. A 2/1 rate is 2x.
 * Rational rates keep long recordings aligned without accumulating float drift.
 */
export interface PlaybackRate {
  numerator: number;
  denominator: number;
}

export interface AudioAsset {
  id: string;
  kind: AudioLaneKind;
  name: string;
  /** Path-free identity resolved only by the trusted main process. */
  locator: AudioAssetLocator;
  signature?: AudioAssetSignature;
  durationUs: TimeUs;
  sampleRate: number;
  channels: number;
}

export interface AudioClip {
  id: string;
  assetId: string;
  timelineStartUs: TimeUs;
  sourceInUs: TimeUs;
  sourceOutUs: TimeUs;
  playbackRate: PlaybackRate;
  speedMode: AudioSpeedMode;
  gainDb: number;
  muted: boolean;
  fadeInUs: TimeUs;
  fadeOutUs: TimeUs;
}

export interface AudioLane {
  id: string;
  kind: AudioLaneKind;
  name: string;
  gainDb: number;
  muted: boolean;
  clips: AudioClip[];
}

export interface DuckingRule {
  id: string;
  triggerLaneId: string;
  targetLaneId: string;
  /** Compressor threshold in dBFS. */
  thresholdDb: number;
  ratio: number;
  attackUs: TimeUs;
  releaseUs: TimeUs;
  makeupDb: number;
}

export interface AudioTimeline {
  schemaVersion: typeof AUDIO_TIMELINE_SCHEMA_VERSION;
  durationUs: TimeUs;
  assets: Record<string, AudioAsset>;
  lanes: AudioLane[];
  ducking: DuckingRule[];
}

export interface CreateAudioTimelineOptions {
  durationUs: TimeUs;
  assets?: Record<string, AudioAsset>;
  lanes?: AudioLane[];
  ducking?: DuckingRule[];
}

export interface CreateAudioLaneOptions {
  id: string;
  kind: AudioLaneKind;
  name?: string;
  gainDb?: number;
  muted?: boolean;
  clips?: AudioClip[];
}

export interface CreateAudioClipOptions {
  id: string;
  assetId: string;
  timelineStartUs?: TimeUs;
  sourceInUs?: TimeUs;
  sourceOutUs: TimeUs;
  playbackRate?: PlaybackRate;
  speedMode?: AudioSpeedMode;
  gainDb?: number;
  muted?: boolean;
  fadeInUs?: TimeUs;
  fadeOutUs?: TimeUs;
}

export class AudioTimelineValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "AudioTimelineValidationError";
    this.path = path;
  }
}

export class AudioTimelineEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioTimelineEditError";
  }
}

export class AudioPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioPlanError";
  }
}

export function createAudioTimeline(options: CreateAudioTimelineOptions): AudioTimeline {
  const timeline: AudioTimeline = {
    schemaVersion: AUDIO_TIMELINE_SCHEMA_VERSION,
    durationUs: options.durationUs,
    assets: cloneRecord(options.assets ?? {}),
    lanes: (options.lanes ?? []).map(cloneLane),
    ducking: (options.ducking ?? []).map((rule) => ({ ...rule })),
  };
  validateAudioTimeline(timeline);
  return timeline;
}

export function createAudioLane(options: CreateAudioLaneOptions): AudioLane {
  const lane: AudioLane = {
    id: options.id,
    kind: options.kind,
    name: options.name?.trim() || defaultLaneName(options.kind),
    gainDb: options.gainDb ?? 0,
    muted: options.muted ?? false,
    clips: (options.clips ?? []).map(cloneClip),
  };
  validateLaneShape(lane, "lane");
  return lane;
}

export function createAudioClip(options: CreateAudioClipOptions): AudioClip {
  const clip: AudioClip = {
    id: options.id,
    assetId: options.assetId,
    timelineStartUs: options.timelineStartUs ?? 0,
    sourceInUs: options.sourceInUs ?? 0,
    sourceOutUs: options.sourceOutUs,
    playbackRate: normalizePlaybackRate(options.playbackRate ?? { numerator: 1, denominator: 1 }),
    speedMode: options.speedMode ?? "preserve-pitch",
    gainDb: options.gainDb ?? 0,
    muted: options.muted ?? false,
    fadeInUs: options.fadeInUs ?? 0,
    fadeOutUs: options.fadeOutUs ?? 0,
  };
  validateClipShape(clip, "clip");
  return clip;
}

export function validateAudioTimeline(value: unknown): asserts value is AudioTimeline {
  expectRecord(value, "audioTimeline");
  expect(
    value.schemaVersion === AUDIO_TIMELINE_SCHEMA_VERSION,
    "audioTimeline.schemaVersion",
    `unsupported version ${String(value.schemaVersion)}`,
  );
  expectTimeUs(value.durationUs, "audioTimeline.durationUs", 1);

  expectRecord(value.assets, "audioTimeline.assets");
  const assets = value.assets as Record<string, unknown>;
  expect(
    Object.keys(assets).length <= MAX_AUDIO_ASSETS,
    "audioTimeline.assets",
    `must contain at most ${MAX_AUDIO_ASSETS} assets`,
  );
  for (const [assetId, assetValue] of Object.entries(assets)) {
    validateAsset(assetValue, `audioTimeline.assets.${assetId}`);
    expect(assetValue.id === assetId, `audioTimeline.assets.${assetId}.id`, "must match its record key");
  }

  expect(Array.isArray(value.lanes), "audioTimeline.lanes", "must be an array");
  expect(
    value.lanes.length <= MAX_AUDIO_LANES,
    "audioTimeline.lanes",
    `must contain at most ${MAX_AUDIO_LANES} lanes`,
  );
  const laneIds = new Set<string>();
  const clipIds = new Set<string>();
  let clipCount = 0;
  for (let laneIndex = 0; laneIndex < value.lanes.length; laneIndex += 1) {
    const laneValue: unknown = value.lanes[laneIndex];
    const lanePath = `audioTimeline.lanes.${laneIndex}`;
    validateLaneShape(laneValue, lanePath);
    expect(
      laneValue.clips.length <= MAX_AUDIO_CLIPS_PER_LANE,
      `${lanePath}.clips`,
      `must contain at most ${MAX_AUDIO_CLIPS_PER_LANE} clips`,
    );
    clipCount += laneValue.clips.length;
    expect(
      clipCount <= MAX_AUDIO_CLIPS,
      "audioTimeline.lanes",
      `must contain at most ${MAX_AUDIO_CLIPS} clips`,
    );
    expect(!laneIds.has(laneValue.id), `${lanePath}.id`, "must be unique");
    laneIds.add(laneValue.id);

    for (let clipIndex = 0; clipIndex < laneValue.clips.length; clipIndex += 1) {
      const clip = laneValue.clips[clipIndex]!;
      const clipPath = `${lanePath}.clips.${clipIndex}`;
      expect(!clipIds.has(clip.id), `${clipPath}.id`, "must be globally unique");
      clipIds.add(clip.id);
      const asset = assets[clip.assetId];
      expect(asset !== undefined, `${clipPath}.assetId`, "references a missing asset");
      validateAsset(asset, `audioTimeline.assets.${clip.assetId}`);
      expect(asset.kind === laneValue.kind, `${clipPath}.assetId`, `must reference a ${laneValue.kind} asset`);
      expect(clip.sourceOutUs <= asset.durationUs, `${clipPath}.sourceOutUs`, "exceeds source duration");
      expect(
        clipTimelineEndUs(clip) <= value.durationUs,
        clipPath,
        "extends beyond the audio timeline",
      );
    }
  }

  expect(Array.isArray(value.ducking), "audioTimeline.ducking", "must be an array");
  expect(
    value.ducking.length <= MAX_DUCKING_RULES,
    "audioTimeline.ducking",
    `must contain at most ${MAX_DUCKING_RULES} rules`,
  );
  const duckingIds = new Set<string>();
  for (let index = 0; index < value.ducking.length; index += 1) {
    const ruleValue: unknown = value.ducking[index];
    const rulePath = `audioTimeline.ducking.${index}`;
    validateDuckingRule(ruleValue, rulePath);
    expect(!duckingIds.has(ruleValue.id), `${rulePath}.id`, "must be unique");
    duckingIds.add(ruleValue.id);
    expect(laneIds.has(ruleValue.triggerLaneId), `${rulePath}.triggerLaneId`, "references a missing lane");
    expect(laneIds.has(ruleValue.targetLaneId), `${rulePath}.targetLaneId`, "references a missing lane");
    expect(
      ruleValue.triggerLaneId !== ruleValue.targetLaneId,
      rulePath,
      "cannot use the same lane as trigger and target",
    );
  }
}

export function normalizePlaybackRate(rate: PlaybackRate): PlaybackRate {
  validatePlaybackRate(rate, "playbackRate");
  const divisor = greatestCommonDivisor(rate.numerator, rate.denominator);
  return {
    numerator: rate.numerator / divisor,
    denominator: rate.denominator / divisor,
  };
}

export function playbackRateFromNumber(rate: number): PlaybackRate {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 8) {
    throw new AudioTimelineEditError("Playback rate must be between 0.25 and 8");
  }
  const denominator = 1_000_000;
  return normalizePlaybackRate({ numerator: Math.round(rate * denominator), denominator });
}

export function playbackRateAsNumber(rate: PlaybackRate): number {
  validatePlaybackRate(rate, "playbackRate");
  return rate.numerator / rate.denominator;
}

export function sourceDurationToTimelineUs(sourceDurationUs: TimeUs, rate: PlaybackRate): TimeUs {
  expectTimeUsForEdit(sourceDurationUs, "Source duration", 0);
  validatePlaybackRateForEdit(rate);
  if (sourceDurationUs === 0) return 0;
  return Math.max(1, multiplyDivideRounded(sourceDurationUs, rate.denominator, rate.numerator));
}

export function timelineDurationToSourceUs(timelineDurationUs: TimeUs, rate: PlaybackRate): TimeUs {
  expectTimeUsForEdit(timelineDurationUs, "Timeline duration", 0);
  validatePlaybackRateForEdit(rate);
  if (timelineDurationUs === 0) return 0;
  return Math.max(1, multiplyDivideRounded(timelineDurationUs, rate.numerator, rate.denominator));
}

export function clipSourceDurationUs(clip: AudioClip): TimeUs {
  return clip.sourceOutUs - clip.sourceInUs;
}

export function clipTimelineDurationUs(clip: AudioClip): TimeUs {
  return sourceDurationToTimelineUs(clipSourceDurationUs(clip), clip.playbackRate);
}

export function clipTimelineEndUs(clip: AudioClip): TimeUs {
  return checkedAdd(clip.timelineStartUs, clipTimelineDurationUs(clip), "Clip end");
}

export function mapClipTimelineToSourceUs(clip: AudioClip, timelineUs: TimeUs): TimeUs {
  const timelineEndUs = clipTimelineEndUs(clip);
  if (!Number.isSafeInteger(timelineUs) || timelineUs < clip.timelineStartUs || timelineUs > timelineEndUs) {
    throw new AudioTimelineEditError("Timeline position must be inside the clip");
  }
  if (timelineUs === clip.timelineStartUs) return clip.sourceInUs;
  if (timelineUs === timelineEndUs) return clip.sourceOutUs;
  const sourceOffset = timelineDurationToSourceUs(timelineUs - clip.timelineStartUs, clip.playbackRate);
  return Math.min(clip.sourceOutUs, clip.sourceInUs + sourceOffset);
}

export function mapClipSourceToTimelineUs(clip: AudioClip, sourceUs: TimeUs): TimeUs {
  if (!Number.isSafeInteger(sourceUs) || sourceUs < clip.sourceInUs || sourceUs > clip.sourceOutUs) {
    throw new AudioTimelineEditError("Source position must be inside the clip");
  }
  if (sourceUs === clip.sourceInUs) return clip.timelineStartUs;
  if (sourceUs === clip.sourceOutUs) return clipTimelineEndUs(clip);
  return checkedAdd(
    clip.timelineStartUs,
    sourceDurationToTimelineUs(sourceUs - clip.sourceInUs, clip.playbackRate),
    "Mapped timeline position",
  );
}

export interface SpeedMapSegment {
  timelineInUs: TimeUs;
  timelineOutUs: TimeUs;
  sourceInUs: TimeUs;
  sourceOutUs: TimeUs;
}

export function validateSpeedMap(segments: readonly SpeedMapSegment[]): void {
  if (segments.length === 0) throw new AudioTimelineEditError("Speed map must contain at least one segment");
  let previous: SpeedMapSegment | undefined;
  segments.forEach((segment, index) => {
    expectTimeUsForEdit(segment.timelineInUs, `Speed segment ${index} timeline start`, 0);
    expectTimeUsForEdit(segment.timelineOutUs, `Speed segment ${index} timeline end`, 1);
    expectTimeUsForEdit(segment.sourceInUs, `Speed segment ${index} source start`, 0);
    expectTimeUsForEdit(segment.sourceOutUs, `Speed segment ${index} source end`, 1);
    if (segment.timelineOutUs <= segment.timelineInUs || segment.sourceOutUs <= segment.sourceInUs) {
      throw new AudioTimelineEditError(`Speed segment ${index} must have positive duration`);
    }
    if (previous &&
      (previous.timelineOutUs !== segment.timelineInUs || previous.sourceOutUs !== segment.sourceInUs)) {
      throw new AudioTimelineEditError("Speed map segments must be contiguous in timeline and source time");
    }
    previous = segment;
  });
}

export function mapTimelineUsToSourceUs(
  segments: readonly SpeedMapSegment[],
  timelineUs: TimeUs,
): TimeUs {
  validateSpeedMap(segments);
  const segment = findSegment(segments, timelineUs, "timelineInUs", "timelineOutUs");
  if (!segment) throw new AudioTimelineEditError("Timeline position is outside the speed map");
  if (timelineUs === segment.timelineOutUs) return segment.sourceOutUs;
  const offset = interpolateInteger(
    timelineUs - segment.timelineInUs,
    segment.sourceOutUs - segment.sourceInUs,
    segment.timelineOutUs - segment.timelineInUs,
  );
  return segment.sourceInUs + offset;
}

export function mapSourceUsToTimelineUs(
  segments: readonly SpeedMapSegment[],
  sourceUs: TimeUs,
): TimeUs {
  validateSpeedMap(segments);
  const segment = findSegment(segments, sourceUs, "sourceInUs", "sourceOutUs");
  if (!segment) throw new AudioTimelineEditError("Source position is outside the speed map");
  if (sourceUs === segment.sourceOutUs) return segment.timelineOutUs;
  const offset = interpolateInteger(
    sourceUs - segment.sourceInUs,
    segment.timelineOutUs - segment.timelineInUs,
    segment.sourceOutUs - segment.sourceInUs,
  );
  return segment.timelineInUs + offset;
}

export interface TrimAudioClipOptions {
  timelineInUs: TimeUs;
  timelineOutUs: TimeUs;
}

export function trimAudioClip(clip: AudioClip, options: TrimAudioClipOptions): AudioClip {
  const oldEndUs = clipTimelineEndUs(clip);
  if (
    !Number.isSafeInteger(options.timelineInUs) ||
    !Number.isSafeInteger(options.timelineOutUs) ||
    options.timelineInUs < clip.timelineStartUs ||
    options.timelineOutUs > oldEndUs ||
    options.timelineInUs >= options.timelineOutUs
  ) {
    throw new AudioTimelineEditError("Trim range must be a positive range inside the clip");
  }
  const sourceInUs = mapClipTimelineToSourceUs(clip, options.timelineInUs);
  const sourceOutUs = mapClipTimelineToSourceUs(clip, options.timelineOutUs);
  if (sourceInUs >= sourceOutUs) {
    throw new AudioTimelineEditError("Trim range is shorter than the source timebase can represent");
  }
  const nextDurationUs = sourceDurationToTimelineUs(sourceOutUs - sourceInUs, clip.playbackRate);
  return {
    ...cloneClip(clip),
    timelineStartUs: options.timelineInUs,
    sourceInUs,
    sourceOutUs,
    fadeInUs: Math.min(clip.fadeInUs, nextDurationUs),
    fadeOutUs: Math.min(clip.fadeOutUs, nextDurationUs),
  };
}

export interface SplitAudioClipIds {
  leftId: string;
  rightId: string;
}

export function splitAudioClip(
  clip: AudioClip,
  splitTimelineUs: TimeUs,
  ids: SplitAudioClipIds,
): readonly [AudioClip, AudioClip] {
  expectIdentifierForEdit(ids.leftId, "Left clip ID");
  expectIdentifierForEdit(ids.rightId, "Right clip ID");
  if (ids.leftId === ids.rightId) throw new AudioTimelineEditError("Split clip IDs must be unique");
  const clipEndUs = clipTimelineEndUs(clip);
  if (!Number.isSafeInteger(splitTimelineUs) || splitTimelineUs <= clip.timelineStartUs || splitTimelineUs >= clipEndUs) {
    throw new AudioTimelineEditError("Split point must be strictly inside the clip");
  }
  const sourceSplitUs = mapClipTimelineToSourceUs(clip, splitTimelineUs);
  if (sourceSplitUs <= clip.sourceInUs || sourceSplitUs >= clip.sourceOutUs) {
    throw new AudioTimelineEditError("Split point is shorter than the source timebase can represent");
  }
  const leftDurationUs = sourceDurationToTimelineUs(sourceSplitUs - clip.sourceInUs, clip.playbackRate);
  const normalizedSplitUs = clip.timelineStartUs + leftDurationUs;
  const left: AudioClip = {
    ...cloneClip(clip),
    id: ids.leftId,
    sourceOutUs: sourceSplitUs,
    fadeOutUs: 0,
  };
  const right: AudioClip = {
    ...cloneClip(clip),
    id: ids.rightId,
    timelineStartUs: normalizedSplitUs,
    sourceInUs: sourceSplitUs,
    fadeInUs: 0,
  };
  return [left, right];
}

export function setAudioClipGain(clip: AudioClip, gainDb: number): AudioClip {
  expectFiniteForEdit(gainDb, "Clip gain", -96, 24);
  return { ...cloneClip(clip), gainDb };
}

export function setAudioClipMuted(clip: AudioClip, muted: boolean): AudioClip {
  return { ...cloneClip(clip), muted };
}

export function setAudioClipFades(clip: AudioClip, fadeInUs: TimeUs, fadeOutUs: TimeUs): AudioClip {
  const durationUs = clipTimelineDurationUs(clip);
  expectTimeUsForEdit(fadeInUs, "Fade in", 0);
  expectTimeUsForEdit(fadeOutUs, "Fade out", 0);
  if (fadeInUs > durationUs || fadeOutUs > durationUs) {
    throw new AudioTimelineEditError("Fades cannot exceed the clip duration");
  }
  return { ...cloneClip(clip), fadeInUs, fadeOutUs };
}

export function setAudioLaneGain(lane: AudioLane, gainDb: number): AudioLane {
  expectFiniteForEdit(gainDb, "Lane gain", -96, 24);
  return { ...cloneLane(lane), gainDb };
}

export function setAudioLaneMuted(lane: AudioLane, muted: boolean): AudioLane {
  return { ...cloneLane(lane), muted };
}

export type AudioTimelineEdit =
  | { type: "clip.trim"; laneId: string; clipId: string; timelineInUs: TimeUs; timelineOutUs: TimeUs }
  | { type: "clip.split"; laneId: string; clipId: string; splitTimelineUs: TimeUs; leftId: string; rightId: string }
  | { type: "clip.gain"; laneId: string; clipId: string; gainDb: number }
  | { type: "clip.mute"; laneId: string; clipId: string; muted: boolean }
  | { type: "clip.fades"; laneId: string; clipId: string; fadeInUs: TimeUs; fadeOutUs: TimeUs }
  | { type: "lane.gain"; laneId: string; gainDb: number }
  | { type: "lane.mute"; laneId: string; muted: boolean }
  | { type: "ducking.upsert"; rule: DuckingRule }
  | { type: "ducking.remove"; ruleId: string };

export function applyAudioTimelineEdit(timeline: AudioTimeline, edit: AudioTimelineEdit): AudioTimeline {
  validateAudioTimeline(timeline);
  let next: AudioTimeline;
  if (edit.type === "ducking.upsert") {
    const ruleIndex = timeline.ducking.findIndex((rule) => rule.id === edit.rule.id);
    const ducking = timeline.ducking.map((rule) => ({ ...rule }));
    if (ruleIndex === -1) ducking.push({ ...edit.rule });
    else ducking[ruleIndex] = { ...edit.rule };
    next = { ...timeline, assets: cloneRecord(timeline.assets), lanes: timeline.lanes.map(cloneLane), ducking };
  } else if (edit.type === "ducking.remove") {
    const ducking = timeline.ducking.filter((rule) => rule.id !== edit.ruleId).map((rule) => ({ ...rule }));
    if (ducking.length === timeline.ducking.length) {
      throw new AudioTimelineEditError(`Ducking rule ${edit.ruleId} does not exist`);
    }
    next = { ...timeline, assets: cloneRecord(timeline.assets), lanes: timeline.lanes.map(cloneLane), ducking };
  } else {
    const laneIndex = timeline.lanes.findIndex((lane) => lane.id === edit.laneId);
    if (laneIndex < 0) throw new AudioTimelineEditError(`Audio lane ${edit.laneId} does not exist`);
    const lanes = timeline.lanes.map(cloneLane);
    const lane = lanes[laneIndex]!;
    if (edit.type === "lane.gain") lanes[laneIndex] = setAudioLaneGain(lane, edit.gainDb);
    else if (edit.type === "lane.mute") lanes[laneIndex] = setAudioLaneMuted(lane, edit.muted);
    else {
      const clipIndex = lane.clips.findIndex((clip) => clip.id === edit.clipId);
      if (clipIndex < 0) throw new AudioTimelineEditError(`Audio clip ${edit.clipId} does not exist`);
      const clip = lane.clips[clipIndex]!;
      if (edit.type === "clip.trim") {
        lane.clips[clipIndex] = trimAudioClip(clip, edit);
      } else if (edit.type === "clip.split") {
        const split = splitAudioClip(clip, edit.splitTimelineUs, edit);
        lane.clips.splice(clipIndex, 1, ...split);
      } else if (edit.type === "clip.gain") {
        lane.clips[clipIndex] = setAudioClipGain(clip, edit.gainDb);
      } else if (edit.type === "clip.mute") {
        lane.clips[clipIndex] = setAudioClipMuted(clip, edit.muted);
      } else {
        lane.clips[clipIndex] = setAudioClipFades(clip, edit.fadeInUs, edit.fadeOutUs);
      }
    }
    next = {
      ...timeline,
      assets: cloneRecord(timeline.assets),
      lanes,
      ducking: timeline.ducking.map((rule) => ({ ...rule })),
    };
  }
  validateAudioTimeline(next);
  return next;
}

export type WaveformChannelMode = "mixdown" | "split";

export interface WaveformCacheDescriptor {
  version: typeof WAVEFORM_CACHE_VERSION;
  assetId: string;
  /** Content hash or stable file signature, never a file path. */
  fingerprint: string;
  sourceInUs: TimeUs;
  sourceOutUs: TimeUs;
  pointsPerSecond: number;
  channelMode: WaveformChannelMode;
  algorithm: "peak-rms-v1";
}

export function createWaveformCacheDescriptor(
  options: Omit<WaveformCacheDescriptor, "version" | "algorithm">,
): WaveformCacheDescriptor {
  const descriptor: WaveformCacheDescriptor = {
    version: WAVEFORM_CACHE_VERSION,
    algorithm: "peak-rms-v1",
    ...options,
  };
  validateWaveformCacheDescriptor(descriptor);
  return descriptor;
}

export function validateWaveformCacheDescriptor(value: unknown): asserts value is WaveformCacheDescriptor {
  expectRecord(value, "waveformCache");
  expect(value.version === WAVEFORM_CACHE_VERSION, "waveformCache.version", "is unsupported");
  expectIdentifier(value.assetId, "waveformCache.assetId");
  expect(
    typeof value.fingerprint === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.fingerprint),
    "waveformCache.fingerprint",
    "must be an 8-128 character path-safe signature",
  );
  expectTimeUs(value.sourceInUs, "waveformCache.sourceInUs", 0);
  expectTimeUs(value.sourceOutUs, "waveformCache.sourceOutUs", 1);
  expect(value.sourceOutUs > value.sourceInUs, "waveformCache", "source range must have positive duration");
  expectInteger(value.pointsPerSecond, "waveformCache.pointsPerSecond", 10, 2_000);
  expect(
    value.channelMode === "mixdown" || value.channelMode === "split",
    "waveformCache.channelMode",
    "is invalid",
  );
  expect(value.algorithm === "peak-rms-v1", "waveformCache.algorithm", "is unsupported");
}

export function waveformCacheFileName(descriptor: WaveformCacheDescriptor): string {
  validateWaveformCacheDescriptor(descriptor);
  return [
    `wf-v${descriptor.version}`,
    descriptor.assetId,
    descriptor.fingerprint.slice(0, 24),
    `${descriptor.sourceInUs}-${descriptor.sourceOutUs}`,
    `${descriptor.pointsPerSecond}pps`,
    descriptor.channelMode,
    descriptor.algorithm,
  ].join("_") + ".json";
}

export type CaptionSidecarFormat = "srt" | "vtt";

export interface CaptionSidecarDescriptor {
  id: string;
  format: CaptionSidecarFormat;
  /** Opaque storage key resolved outside the filter graph. */
  locatorKey: string;
  language?: string;
  offsetUs: TimeUs;
  encoding: "utf-8";
}

export interface CaptionCue {
  id: string;
  startUs: TimeUs;
  endUs: TimeUs;
  text: string;
}

export function validateCaptionSidecar(value: unknown): asserts value is CaptionSidecarDescriptor {
  expectRecord(value, "captionSidecar");
  expectIdentifier(value.id, "captionSidecar.id");
  expect(value.format === "srt" || value.format === "vtt", "captionSidecar.format", "is invalid");
  expectIdentifier(value.locatorKey, "captionSidecar.locatorKey");
  if (value.language !== undefined) {
    expect(
      typeof value.language === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value.language),
      "captionSidecar.language",
      "must be a valid language tag",
    );
  }
  expect(
    Number.isSafeInteger(value.offsetUs),
    "captionSidecar.offsetUs",
    "must be an integer number of microseconds",
  );
  expect(value.encoding === "utf-8", "captionSidecar.encoding", "must be utf-8");
}

export function validateCaptionCues(cues: readonly CaptionCue[]): void {
  let previousStartUs = -1;
  const ids = new Set<string>();
  cues.forEach((cue, index) => {
    const path = `captionCues.${index}`;
    expectIdentifier(cue.id, `${path}.id`);
    expect(!ids.has(cue.id), `${path}.id`, "must be unique");
    ids.add(cue.id);
    expectTimeUs(cue.startUs, `${path}.startUs`, 0);
    expectTimeUs(cue.endUs, `${path}.endUs`, 1);
    expect(cue.endUs > cue.startUs, path, "must have positive duration");
    expect(cue.startUs >= previousStartUs, `${path}.startUs`, "must be sorted");
    expect(typeof cue.text === "string" && cue.text.trim().length > 0, `${path}.text`, "must not be empty");
    previousStartUs = cue.startUs;
  });
}

export interface AudioPlanInput {
  inputIndex: number;
  assetId: string;
  path: string;
  beforeInputArgs: string[];
}

export interface AudioFilterPlanFragment {
  inputs: AudioPlanInput[];
  filterGraph: string;
  outputLabel: "[audio_out]";
  durationUs: TimeUs;
  sampleRate: number;
}

export interface BuildAudioFilterPlanOptions {
  timeline: AudioTimeline;
  assetPaths: Readonly<Record<string, string>>;
  baseInputIndex?: number;
  sampleRate?: 44_100 | 48_000 | 96_000;
  /** Exact absolute FFmpeg stream index selected by the trusted main process. */
  assetStreamIndexes?: Readonly<Record<string, number>>;
  /** Existing, already source-trimmed inputs keyed by audio clip id. */
  preboundClipInputIndexes?: Readonly<Record<string, number>>;
}

/**
 * Builds a filter fragment and argv-safe inputs. Paths are never interpolated into
 * the filter graph; callers must pass each returned path as one process argv item.
 */
export function buildAudioFilterPlan(options: BuildAudioFilterPlanOptions): AudioFilterPlanFragment {
  validateAudioTimeline(options.timeline);
  const timeline = options.timeline;
  const baseInputIndex = options.baseInputIndex ?? 0;
  const sampleRate = options.sampleRate ?? 48_000;
  if (!Number.isSafeInteger(baseInputIndex) || baseInputIndex < 0) {
    throw new AudioPlanError("Base input index must be a non-negative integer");
  }

  const graph: string[] = [];
  const inputs: AudioPlanInput[] = [];
  const assetInputIndexes = new Map<string, number>();
  const assetInputWindows = new Map<string, { startUs: TimeUs; endUs: TimeUs }>();
  const laneBaseLabels = new Map<string, string>();
  const durationSeconds = seconds(timeline.durationUs);
  let clipSequence = 0;

  for (const lane of timeline.lanes) {
    if (lane.muted) continue;
    for (const clip of lane.clips) {
      if (clip.muted || options.preboundClipInputIndexes?.[clip.id] !== undefined) continue;
      const current = assetInputWindows.get(clip.assetId);
      assetInputWindows.set(clip.assetId, current === undefined
        ? { startUs: clip.sourceInUs, endUs: clip.sourceOutUs }
        : {
            startUs: Math.min(current.startUs, clip.sourceInUs),
            endUs: Math.max(current.endUs, clip.sourceOutUs),
          });
    }
  }

  timeline.lanes.forEach((lane, laneIndex) => {
    const activeClips = lane.muted ? [] : lane.clips.filter((clip) => !clip.muted);
    const clipLabels: string[] = [];
    activeClips.forEach((clip) => {
      const sourceDurationUs = clipSourceDurationUs(clip);
      const outputDurationUs = clipTimelineDurationUs(clip);
      const preboundInputIndex = options.preboundClipInputIndexes?.[clip.id];
      let inputIndex: number;
      if (preboundInputIndex !== undefined) {
        if (!Number.isSafeInteger(preboundInputIndex) || preboundInputIndex < 0) {
          throw new AudioPlanError(`Audio clip ${clip.id} has an invalid prebound input index`);
        }
        inputIndex = preboundInputIndex;
      } else {
        const path = options.assetPaths[clip.assetId];
        if (!path || !path.trim()) throw new AudioPlanError(`No resolved path for audio asset ${clip.assetId}`);
        const existingInputIndex = assetInputIndexes.get(clip.assetId);
        if (existingInputIndex !== undefined) {
          inputIndex = existingInputIndex;
        } else {
          if (inputs.length >= MAX_AUDIO_PLAN_INPUTS) {
            throw new AudioPlanError(`An audio export may use at most ${MAX_AUDIO_PLAN_INPUTS} source files`);
          }
          const inputWindow = assetInputWindows.get(clip.assetId)!;
          inputIndex = baseInputIndex + inputs.length;
          inputs.push({
            inputIndex,
            assetId: clip.assetId,
            path,
            beforeInputArgs: [
              "-accurate_seek",
              "-ss",
              seconds(inputWindow.startUs),
              "-t",
              seconds(inputWindow.endUs - inputWindow.startUs),
            ],
          });
          assetInputIndexes.set(clip.assetId, inputIndex);
        }
      }

      const streamIndex = options.assetStreamIndexes?.[clip.assetId];
      if (streamIndex !== undefined && (!Number.isSafeInteger(streamIndex) || streamIndex < 0)) {
        throw new AudioPlanError(`Audio asset ${clip.assetId} has an invalid stream index`);
      }
      const inputLabel = streamIndex === undefined
        ? preboundInputIndex === undefined ? `${inputIndex}:a:0` : `${inputIndex}:a`
        : `${inputIndex}:${streamIndex}`;

      const clipLabel = `ac${clipSequence}`;
      const inputWindowStartUs = assetInputWindows.get(clip.assetId)?.startUs ?? 0;
      const filters = [
        preboundInputIndex === undefined
          ? `atrim=start=${seconds(clip.sourceInUs - inputWindowStartUs)}:` +
            `end=${seconds(clip.sourceOutUs - inputWindowStartUs)}`
          : `atrim=start=0:duration=${seconds(sourceDurationUs)}`,
        "asetpts=PTS-STARTPTS",
        `aresample=${sampleRate}`,
      ];
      const rate = playbackRateAsNumber(clip.playbackRate);
      if (clip.speedMode === "change-pitch" && Math.abs(rate - 1) > 1e-12) {
        filters.push(`asetrate=${Math.round(sampleRate * rate)}`, `aresample=${sampleRate}`);
      } else {
        filters.push(...atempoFilterChain(clip.playbackRate));
      }
      filters.push(`aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`);
      if (clip.gainDb !== 0) filters.push(`volume=${decimal(clip.gainDb)}dB`);
      if (clip.fadeInUs > 0) {
        filters.push(`afade=t=in:st=0:d=${seconds(clip.fadeInUs)}:curve=tri`);
      }
      if (clip.fadeOutUs > 0) {
        const fadeStartUs = Math.max(0, outputDurationUs - clip.fadeOutUs);
        filters.push(`afade=t=out:st=${seconds(fadeStartUs)}:d=${seconds(clip.fadeOutUs)}:curve=tri`);
      }
      filters.push(
        `apad=whole_dur=${seconds(outputDurationUs)}`,
        `atrim=duration=${seconds(outputDurationUs)}`,
      );
      if (clip.timelineStartUs > 0) {
        filters.push(`adelay=${milliseconds(clip.timelineStartUs)}:all=1`);
      }
      filters.push("asetpts=PTS-STARTPTS");
      graph.push(`[${inputLabel}]${filters.join(",")}[${clipLabel}]`);
      clipLabels.push(`[${clipLabel}]`);
      clipSequence += 1;
    });

    const silenceLabel = `lane_silence${laneIndex}`;
    graph.push(`anullsrc=r=${sampleRate}:cl=stereo:d=${durationSeconds}[${silenceLabel}]`);
    const rawLabel = `lane_raw${laneIndex}`;
    if (clipLabels.length === 0) {
      graph.push(`[${silenceLabel}]anull[${rawLabel}]`);
    } else {
      graph.push(
        `[${silenceLabel}]${clipLabels.join("")}amix=inputs=${clipLabels.length + 1}:` +
          `duration=longest:normalize=0[${rawLabel}]`,
      );
    }

    const laneLabel = `lane${laneIndex}`;
    const volume = lane.muted ? "0" : lane.gainDb === 0 ? "1" : `${decimal(lane.gainDb)}dB`;
    graph.push(
      `[${rawLabel}]volume=${volume},apad=whole_dur=${durationSeconds},` +
        `atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[${laneLabel}]`,
    );
    laneBaseLabels.set(lane.id, laneLabel);
  });

  if (timeline.lanes.length === 0) {
    graph.push(`anullsrc=r=${sampleRate}:cl=stereo:d=${durationSeconds},asetpts=PTS-STARTPTS[audio_out]`);
    return { inputs, filterGraph: graph.join(";"), outputLabel: "[audio_out]", durationUs: timeline.durationUs, sampleRate };
  }

  const triggerRules = new Map<string, { rule: DuckingRule; ruleIndex: number }[]>();
  timeline.ducking.forEach((rule, ruleIndex) => {
    const entries = triggerRules.get(rule.triggerLaneId) ?? [];
    entries.push({ rule, ruleIndex });
    triggerRules.set(rule.triggerLaneId, entries);
  });

  const currentLaneLabels = new Map<string, string>();
  const triggerLabels = new Map<number, string>();
  timeline.lanes.forEach((lane, laneIndex) => {
    const baseLabel = laneBaseLabels.get(lane.id)!;
    const rules = triggerRules.get(lane.id) ?? [];
    if (rules.length === 0) {
      currentLaneLabels.set(lane.id, baseLabel);
      return;
    }
    const primaryLabel = `lane_primary${laneIndex}`;
    const splitLabels = rules.map(({ ruleIndex }) => `duck_trigger${ruleIndex}`);
    graph.push(
      `[${baseLabel}]asplit=${rules.length + 1}[${primaryLabel}]` +
        splitLabels.map((label) => `[${label}]`).join(""),
    );
    currentLaneLabels.set(lane.id, primaryLabel);
    rules.forEach(({ ruleIndex }, index) => triggerLabels.set(ruleIndex, splitLabels[index]!));
  });

  timeline.ducking.forEach((rule, ruleIndex) => {
    const targetLabel = currentLaneLabels.get(rule.targetLaneId)!;
    const triggerLabel = triggerLabels.get(ruleIndex)!;
    const outputLabel = `ducked${ruleIndex}`;
    graph.push(
      `[${targetLabel}][${triggerLabel}]sidechaincompress=` +
        `threshold=${decimal(dbToLinear(rule.thresholdDb))}:ratio=${decimal(rule.ratio)}:` +
        `attack=${milliseconds(rule.attackUs)}:release=${milliseconds(rule.releaseUs)}:` +
        `makeup=${decimal(dbToLinear(rule.makeupDb))}[${outputLabel}]`,
    );
    currentLaneLabels.set(rule.targetLaneId, outputLabel);
  });

  const finalLaneLabels = timeline.lanes.map((lane) => `[${currentLaneLabels.get(lane.id)!}]`);
  if (finalLaneLabels.length === 1) {
    graph.push(`${finalLaneLabels[0]}alimiter=limit=0.98:level=false:latency=1[audio_out]`);
  } else {
    graph.push(
      `${finalLaneLabels.join("")}amix=inputs=${finalLaneLabels.length}:duration=longest:normalize=0,` +
        "alimiter=limit=0.98:level=false:latency=1[audio_out]",
    );
  }
  return {
    inputs,
    filterGraph: graph.join(";"),
    outputLabel: "[audio_out]",
    durationUs: timeline.durationUs,
    sampleRate,
  };
}

export function buildAudioInputArgs(plan: AudioFilterPlanFragment): string[] {
  return plan.inputs.flatMap((input) => [...input.beforeInputArgs, "-i", input.path]);
}

export function atempoFilterChain(rate: PlaybackRate): string[] {
  validatePlaybackRateForEdit(rate);
  let remainder = playbackRateAsNumber(rate);
  if (Math.abs(remainder - 1) < 1e-12) return [];
  const filters: string[] = [];
  while (remainder < 0.5 - 1e-12) {
    filters.push("atempo=0.5");
    remainder /= 0.5;
  }
  while (remainder > 2 + 1e-12) {
    filters.push("atempo=2");
    remainder /= 2;
  }
  if (Math.abs(remainder - 1) > 1e-12) filters.push(`atempo=${decimal(remainder)}`);
  return filters;
}

function validateAsset(value: unknown, path: string): asserts value is AudioAsset {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectLaneKind(value.kind, `${path}.kind`);
  expectNonEmptyString(value.name, `${path}.name`);
  expectRecord(value.locator, `${path}.locator`);
  if (value.locator.kind === "library") {
    expect(
      Object.keys(value.locator).length === 1,
      `${path}.locator`,
      "contains unsupported fields",
    );
  } else {
    expect(value.locator.kind === "bundled", `${path}.locator.kind`, "is invalid");
    expectIdentifier(value.locator.key, `${path}.locator.key`);
    expect(
      Object.keys(value.locator).every((key) => key === "kind" || key === "key"),
      `${path}.locator`,
      "contains unsupported fields",
    );
  }
  if (value.signature !== undefined) {
    expectRecord(value.signature, `${path}.signature`);
    expectTimeUs(value.signature.byteLength, `${path}.signature.byteLength`, 0);
    expectFinite(value.signature.modifiedMs, `${path}.signature.modifiedMs`, 0, Number.MAX_SAFE_INTEGER);
  }
  expectTimeUs(value.durationUs, `${path}.durationUs`, 1);
  expectInteger(value.sampleRate, `${path}.sampleRate`, 8_000, 384_000);
  expectInteger(value.channels, `${path}.channels`, 1, 32);
}

function validateLaneShape(value: unknown, path: string): asserts value is AudioLane {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectLaneKind(value.kind, `${path}.kind`);
  expectNonEmptyString(value.name, `${path}.name`);
  expectFinite(value.gainDb, `${path}.gainDb`, -96, 24);
  expect(typeof value.muted === "boolean", `${path}.muted`, "must be a boolean");
  expect(Array.isArray(value.clips), `${path}.clips`, "must be an array");
  value.clips.forEach((clip: unknown, index: number) => validateClipShape(clip, `${path}.clips.${index}`));
}

function validateClipShape(value: unknown, path: string): asserts value is AudioClip {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectIdentifier(value.assetId, `${path}.assetId`);
  expectTimeUs(value.timelineStartUs, `${path}.timelineStartUs`, 0);
  expectTimeUs(value.sourceInUs, `${path}.sourceInUs`, 0);
  expectTimeUs(value.sourceOutUs, `${path}.sourceOutUs`, 1);
  expect(value.sourceOutUs > value.sourceInUs, path, "source range must have positive duration");
  validatePlaybackRate(value.playbackRate, `${path}.playbackRate`);
  expect(
    value.speedMode === "preserve-pitch" || value.speedMode === "change-pitch",
    `${path}.speedMode`,
    "is invalid",
  );
  expectFinite(value.gainDb, `${path}.gainDb`, -96, 24);
  expect(typeof value.muted === "boolean", `${path}.muted`, "must be a boolean");
  expectTimeUs(value.fadeInUs, `${path}.fadeInUs`, 0);
  expectTimeUs(value.fadeOutUs, `${path}.fadeOutUs`, 0);
  const durationUs = clipTimelineDurationUs(value as AudioClip);
  expect(value.fadeInUs <= durationUs, `${path}.fadeInUs`, "exceeds clip duration");
  expect(value.fadeOutUs <= durationUs, `${path}.fadeOutUs`, "exceeds clip duration");
}

function validatePlaybackRate(value: unknown, path: string): asserts value is PlaybackRate {
  expectRecord(value, path);
  expectInteger(value.numerator, `${path}.numerator`, 1, Number.MAX_SAFE_INTEGER);
  expectInteger(value.denominator, `${path}.denominator`, 1, Number.MAX_SAFE_INTEGER);
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  expect(numerator * 4n >= denominator, path, "must be at least 0.25x");
  expect(numerator <= denominator * 8n, path, "must be at most 8x");
}

function validateDuckingRule(value: unknown, path: string): asserts value is DuckingRule {
  expectRecord(value, path);
  expectIdentifier(value.id, `${path}.id`);
  expectIdentifier(value.triggerLaneId, `${path}.triggerLaneId`);
  expectIdentifier(value.targetLaneId, `${path}.targetLaneId`);
  expectFinite(value.thresholdDb, `${path}.thresholdDb`, -60, 0);
  expectFinite(value.ratio, `${path}.ratio`, 1, 20);
  expectTimeUs(value.attackUs, `${path}.attackUs`, 10);
  expect(value.attackUs <= 2_000_000, `${path}.attackUs`, "must be at most 2000000");
  expectTimeUs(value.releaseUs, `${path}.releaseUs`, 10);
  expect(value.releaseUs <= 9_000_000, `${path}.releaseUs`, "must be at most 9000000");
  expectFinite(value.makeupDb, `${path}.makeupDb`, 0, 24);
}

function cloneClip(clip: AudioClip): AudioClip {
  return { ...clip, playbackRate: { ...clip.playbackRate } };
}

function cloneLane(lane: AudioLane): AudioLane {
  return { ...lane, clips: lane.clips.map(cloneClip) };
}

function cloneRecord(record: Record<string, AudioAsset>): Record<string, AudioAsset> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, {
    ...value,
    locator: { ...value.locator },
    ...(value.signature === undefined ? {} : { signature: { ...value.signature } }),
  }]));
}

function defaultLaneName(kind: AudioLaneKind): string {
  if (kind === "system") return "System audio";
  if (kind === "microphone") return "Microphone";
  return "Music";
}

function greatestCommonDivisor(first: number, second: number): number {
  let a = first;
  let b = second;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function multiplyDivideRounded(value: number, multiplier: number, divisor: number): number {
  const numerator = BigInt(value) * BigInt(multiplier);
  const denominator = BigInt(divisor);
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AudioTimelineEditError("Mapped time exceeds JavaScript's safe integer range");
  }
  return Number(result);
}

function interpolateInteger(offset: number, outputDuration: number, inputDuration: number): number {
  return multiplyDivideRounded(offset, outputDuration, inputDuration);
}

function checkedAdd(first: number, second: number, label: string): number {
  const result = first + second;
  if (!Number.isSafeInteger(result)) throw new AudioTimelineEditError(`${label} exceeds the safe integer range`);
  return result;
}

function findSegment<KIn extends "timelineInUs" | "sourceInUs", KOut extends "timelineOutUs" | "sourceOutUs">(
  segments: readonly SpeedMapSegment[],
  position: TimeUs,
  startKey: KIn,
  endKey: KOut,
): SpeedMapSegment | undefined {
  if (!Number.isSafeInteger(position)) return undefined;
  return segments.find((segment, index) =>
    position >= segment[startKey] &&
    (position < segment[endKey] || (index === segments.length - 1 && position === segment[endKey])));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function seconds(microseconds: TimeUs): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function milliseconds(microseconds: TimeUs): string {
  return (microseconds / 1_000).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function decimal(value: number): string {
  return value.toFixed(9).replace(/\.?0+$/, "") || "0";
}

function validatePlaybackRateForEdit(rate: PlaybackRate): void {
  try {
    validatePlaybackRate(rate, "playbackRate");
  } catch (error) {
    throw new AudioTimelineEditError(error instanceof Error ? error.message : String(error));
  }
}

function expectTimeUsForEdit(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AudioTimelineEditError(`${label} must be an integer >= ${minimum} microseconds`);
  }
}

function expectFiniteForEdit(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AudioTimelineEditError(`${label} must be between ${minimum} and ${maximum}`);
  }
}

function expectIdentifierForEdit(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AudioTimelineEditError(`${label} must be a safe identifier`);
  }
}

function expectRecord(value: unknown, path: string): asserts value is Record<string, any> {
  expect(typeof value === "object" && value !== null && !Array.isArray(value), path, "must be an object");
}

function expectLaneKind(value: unknown, path: string): asserts value is AudioLaneKind {
  expect(value === "system" || value === "microphone" || value === "music", path, "is invalid");
}

function expectIdentifier(value: unknown, path: string): asserts value is string {
  expect(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    path,
    "must be a safe identifier",
  );
}

function expectNonEmptyString(value: unknown, path: string): asserts value is string {
  expect(typeof value === "string" && value.trim().length > 0, path, "must be a non-empty string");
}

function expectTimeUs(value: unknown, path: string, minimum: number): asserts value is number {
  expect(Number.isSafeInteger(value) && (value as number) >= minimum, path, `must be an integer >= ${minimum}`);
}

function expectInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  expect(
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum,
    path,
    `must be an integer between ${minimum} and ${maximum}`,
  );
}

function expectFinite(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  expect(
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum,
    path,
    `must be between ${minimum} and ${maximum}`,
  );
}

function expect(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new AudioTimelineValidationError(path, message);
}
