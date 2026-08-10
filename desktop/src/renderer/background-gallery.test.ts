import { describe, expect, it } from "vitest";
import type { MediaItem } from "../shared/api";
import {
  BACKGROUND_PRESETS,
  WALLPAPER_SOURCES,
  backgroundDisplayName,
  backgroundPresetIdForStyle,
  backgroundStyleForPreset,
  registeredBackgroundImages,
} from "./background-gallery";

const image = (id: string, overrides: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name: `${id}.png`,
  kind: "image",
  origin: "import",
  mimeType: "image/png",
  byteLength: 1_024,
  createdAt: "2026-08-10T00:00:00.000Z",
  modifiedAt: "2026-08-10T00:00:00.000Z",
  url: `sharpshot-media://asset/${id}`,
  ...overrides,
});

describe("background gallery", () => {
  it("offers stable solid and gradient presets with preview sources", () => {
    expect(BACKGROUND_PRESETS.map(({ id }) => id)).toEqual([
      "style-graphite",
      "style-porcelain",
      "style-ember",
      "style-tide",
    ]);
    expect(BACKGROUND_PRESETS.map(({ kind }) => kind)).toEqual(["solid", "solid", "gradient", "gradient"]);
    expect(BACKGROUND_PRESETS.every(({ source }) => source.startsWith("data:image/svg+xml,"))).toBe(true);
  });

  it("round-trips preset styles without sharing mutable gradient stops", () => {
    const first = backgroundStyleForPreset("style-ember");
    expect(first?.kind).toBe("gradient");
    if (first?.kind !== "gradient") throw new Error("Expected gradient preset");
    expect(backgroundPresetIdForStyle(first)).toBe("style-ember");
    first.stops[0]!.color = "#000000";
    const fresh = backgroundStyleForPreset("style-ember");
    expect(fresh?.kind === "gradient" ? fresh.stops[0]?.color : undefined).toBe("#21150F");
  });

  it("shows only uniquely registered library images", () => {
    const first = image("background-01");
    const second = image("background-02", { name: "Paper texture.webp", mimeType: "image/webp" });
    const unsafe = image("background-03", { url: "https://example.com/background.png" });
    const video = image("recording-01", { kind: "video", mimeType: "video/mp4" });

    expect(registeredBackgroundImages([first, second, first, unsafe, video])).toEqual([first, second]);
    expect(backgroundDisplayName(second.name)).toBe("Paper texture");
  });

  it("lists the requested external wallpaper sources without bundled artwork", () => {
    expect(WALLPAPER_SOURCES).toEqual([
      {
        id: "512-pixels",
        name: "512 Pixels",
        description: "Classic macOS wallpaper archive",
        url: "https://512pixels.net/projects/default-mac-wallpapers-in-5k/",
      },
      {
        id: "applewalls",
        name: "AppleWalls",
        description: "Searchable Apple wallpaper archive",
        url: "https://www.applewalls.com/en/macos-wallpapers",
      },
      {
        id: "basic-apple-guy",
        name: "Basic Apple Guy",
        description: "Independent Apple-inspired artwork",
        url: "https://basicappleguy.com/",
      },
      {
        id: "black-pixel-studio",
        name: "Black Pixel Studio",
        description: "Independent wallpaper studio",
        url: "https://blackpixel.studio/",
      },
    ]);
    expect(WALLPAPER_SOURCES.every(({ url }) => new URL(url).protocol === "https:")).toBe(true);
    expect(WALLPAPER_SOURCES.every((source) => !("image" in source) && !("thumbnail" in source))).toBe(true);
  });
});
