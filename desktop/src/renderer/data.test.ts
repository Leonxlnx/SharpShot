import { describe, expect, it } from "vitest";
import { BACKGROUND_PRESETS } from "./background-gallery";
import { CAPTURES, WALLPAPERS, resolveBackgroundSource } from "./data";

describe("wallpaper sources", () => {
  it("keeps stable IDs while separating picker thumbnails from canvas masters", () => {
    expect(WALLPAPERS.map(({ id }) => id)).toEqual([
      "cobalt",
      "lunar",
      "midnight",
      "glacier",
      "solar",
      "dusk",
      "moss",
      "obsidian",
      "sherburne",
      "valley-night",
      "blue-current",
      "beacon-sunset",
    ]);

    for (const wallpaper of WALLPAPERS) {
      expect(wallpaper.thumbnailSource).not.toBe(wallpaper.source);
      expect(wallpaper.source).toMatch(/^sharpshot-media:\/\/background\/[a-z0-9-]+$/);
      expect(resolveBackgroundSource(wallpaper.id, true)).toBe(wallpaper.source);
      expect(resolveBackgroundSource(wallpaper.id, false)).toBe(wallpaper.thumbnailSource);
    }
    expect(CAPTURES.every((capture) => WALLPAPERS.some((wallpaper) => wallpaper.thumbnailSource === capture.thumbnail))).toBe(true);
  });

  it("resolves color presets to their generated preview artwork", () => {
    for (const preset of BACKGROUND_PRESETS) {
      expect(resolveBackgroundSource(preset.id)).toBe(preset.source);
    }
  });
});
