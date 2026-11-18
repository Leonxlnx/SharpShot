import type { BundledAudioTrack, MediaItem, MediaProbe } from "../shared/api";
import type { AudioAsset } from "../shared/audio-timeline";

export function bundledMusicAsset(track: BundledAudioTrack): AudioAsset {
  return {
    id: `bundled-audio-${track.id}`,
    kind: "music",
    name: track.title,
    locator: { kind: "bundled", key: track.id },
    durationUs: track.durationUs,
    sampleRate: track.sampleRate,
    channels: track.channels,
  };
}

export function probedLibraryMusicAsset(item: MediaItem, probe: MediaProbe): AudioAsset {
  if (item.kind !== "audio") throw new Error(`${item.name} is not an audio file.`);
  if (probe.mediaId !== item.id) throw new Error(`The audio probe for ${item.name} did not match the library item.`);

  const streamDurationUs = probe.audio?.durationUs;
  const durationUs = streamDurationUs !== undefined && streamDurationUs > 0
    ? streamDurationUs
    : probe.durationUs;
  const sampleRate = probe.audio?.sampleRate;
  const channels = probe.audio?.channels;
  if (!Number.isSafeInteger(durationUs) || (durationUs ?? 0) < 1) {
    throw new Error(`${item.name} has no usable audio duration.`);
  }
  if (!Number.isSafeInteger(sampleRate) || (sampleRate ?? 0) < 8_000 || (sampleRate ?? 0) > 384_000) {
    throw new Error(`${item.name} has no supported audio sample rate.`);
  }
  if (!Number.isSafeInteger(channels) || (channels ?? 0) < 1 || (channels ?? 0) > 32) {
    throw new Error(`${item.name} has no supported audio channels.`);
  }

  const modifiedMs = Date.parse(item.modifiedAt);
  const hasSignature = Number.isSafeInteger(item.byteLength)
    && item.byteLength >= 0
    && Number.isSafeInteger(modifiedMs)
    && modifiedMs >= 0;
  return {
    id: item.id,
    kind: "music",
    name: item.name.trim() || "Imported audio",
    locator: { kind: "library" },
    ...(hasSignature ? { signature: { byteLength: item.byteLength, modifiedMs } } : {}),
    durationUs: durationUs as number,
    sampleRate: sampleRate as number,
    channels: channels as number,
  };
}
