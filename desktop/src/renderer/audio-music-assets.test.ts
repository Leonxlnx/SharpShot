import { describe, expect, it } from "vitest";
import type { BundledAudioTrack, MediaItem, MediaProbe } from "../shared/api";
import { bundledMusicAsset, probedLibraryMusicAsset } from "./audio-music-assets";

const item: MediaItem = {
  id: "library-track",
  name: "Field Notes.mp3",
  kind: "audio",
  origin: "import",
  mimeType: "audio/mpeg",
  byteLength: 4_096,
  createdAt: "2026-08-10T10:00:00.000Z",
  modifiedAt: "2026-08-10T10:01:00.000Z",
  url: "sharpshot-media://asset/library-track",
};

const probe: MediaProbe = {
  mediaId: item.id,
  durationUs: 8_000_000,
  audio: { codec: "mp3", sampleRate: 48_000, channels: 2 },
};

describe("audio music assets", () => {
  it("rebuilds path-free library and bundled assets from trusted fields", () => {
    const library = probedLibraryMusicAsset(item, probe);
    const bundled = bundledMusicAsset({
      id: "soft-focus",
      title: "Soft Focus",
      creator: "SharpShot",
      durationUs: 12_000_000,
      sampleRate: 48_000,
      channels: 2,
      license: "CC0-1.0",
      url: "sharpshot-media://audio/soft-focus",
    } satisfies BundledAudioTrack);

    expect(library).toEqual({
      id: item.id,
      kind: "music",
      name: item.name,
      locator: { kind: "library" },
      signature: { byteLength: item.byteLength, modifiedMs: Date.parse(item.modifiedAt) },
      durationUs: 8_000_000,
      sampleRate: 48_000,
      channels: 2,
    });
    expect(library).not.toHaveProperty("url");
    expect(bundled).toMatchObject({
      id: "bundled-audio-soft-focus",
      locator: { kind: "bundled", key: "soft-focus" },
    });
    expect(bundled).not.toHaveProperty("url");
  });

  it("rejects unverified audio facts and omits an unsafe signature", () => {
    expect(() => probedLibraryMusicAsset(item, { ...probe, audio: undefined })).toThrow(/audio sample rate/i);
    expect(probedLibraryMusicAsset({ ...item, byteLength: -1, modifiedAt: "invalid" }, probe)).not.toHaveProperty("signature");
  });

  it.each([0, -1])("falls back from a nonpositive stream duration (%s) to the container duration", (durationUs) => {
    expect(probedLibraryMusicAsset(item, {
      ...probe,
      durationUs: 9_000_000,
      audio: { ...probe.audio!, durationUs },
    }).durationUs).toBe(9_000_000);
  });

  it("prefers a positive stream duration over the container duration", () => {
    expect(probedLibraryMusicAsset(item, {
      ...probe,
      durationUs: 9_000_000,
      audio: { ...probe.audio!, durationUs: 7_000_000 },
    }).durationUs).toBe(7_000_000);
  });
});
