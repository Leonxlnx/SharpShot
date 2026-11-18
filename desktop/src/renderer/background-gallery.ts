import type { MediaItem } from "../shared/api";
import type { BackgroundStyle } from "../shared/project";

export interface WallpaperSource {
    id: string;
    name: string;
    description: string;
    url: string;
}

export const WALLPAPER_SOURCES: readonly WallpaperSource[] = [
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
];

type ColorBackground = Exclude<BackgroundStyle, { kind: "image" }>;

export interface BackgroundPreset {
    id: string;
    name: string;
    kind: ColorBackground["kind"];
    source: string;
    style: ColorBackground;
}

const PRESET_STYLES: ReadonlyArray<readonly [string, string, ColorBackground]> = [
    ["style-graphite", "Graphite", { kind: "solid", color: "#171819" }],
    ["style-porcelain", "Porcelain", { kind: "solid", color: "#E9E5DC" }],
    ["style-ember", "Ember", {
        kind: "gradient",
        angleDeg: 132,
        stops: [
            { offset: 0, color: "#21150F" },
            { offset: 0.52, color: "#8D472B" },
            { offset: 1, color: "#E4A867" },
        ],
    }],
    ["style-tide", "Tide", {
        kind: "gradient",
        angleDeg: 138,
        stops: [
            { offset: 0, color: "#07131C" },
            { offset: 0.55, color: "#275069" },
            { offset: 1, color: "#9ABBB9" },
        ],
    }],
];

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = PRESET_STYLES.map(([id, name, style]) => ({
    id,
    name,
    kind: style.kind,
    source: backgroundStyleSource(style),
    style,
}));

export function backgroundPresetSource(id: string): string | undefined {
    return BACKGROUND_PRESETS.find((preset) => preset.id === id)?.source;
}

export function backgroundStyleForPreset(id: string): ColorBackground | undefined {
    const style = BACKGROUND_PRESETS.find((preset) => preset.id === id)?.style;
    if (!style) return undefined;
    return style.kind === "solid"
        ? { ...style }
        : { ...style, stops: style.stops.map((stop) => ({ ...stop })) };
}

export function backgroundPresetIdForStyle(style: BackgroundStyle): string | undefined {
    if (style.kind === "image") return undefined;
    return BACKGROUND_PRESETS.find((preset) => sameColorBackground(preset.style, style))?.id;
}

export function registeredBackgroundImages(items: readonly MediaItem[]): MediaItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (item.kind !== "image" || seen.has(item.id) || !isRegisteredMediaUrl(item.url, item.id)) return false;
        seen.add(item.id);
        return true;
    });
}

export function backgroundDisplayName(name: string): string {
    return name.replace(/\.(?:avif|bmp|gif|heic|jpe?g|png|webp)$/i, "") || "Untitled image";
}

function backgroundStyleSource(style: ColorBackground): string {
    const fill = style.kind === "solid"
        ? style.color
        : `url(#gradient)`;
    const definition = style.kind === "gradient"
        ? `<defs><linearGradient id="gradient" gradientTransform="rotate(${style.angleDeg} .5 .5)">${style.stops.map((stop) => `<stop offset="${stop.offset * 100}%" stop-color="${stop.color}"/>`).join("")}</linearGradient></defs>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" preserveAspectRatio="none">${definition}<rect width="16" height="9" fill="${fill}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function sameColorBackground(left: ColorBackground, right: ColorBackground): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "solid" && right.kind === "solid") return left.color === right.color;
    if (left.kind !== "gradient" || right.kind !== "gradient" || left.angleDeg !== right.angleDeg || left.stops.length !== right.stops.length) return false;
    return left.stops.every((stop, index) => stop.offset === right.stops[index]?.offset && stop.color === right.stops[index]?.color);
}

function isRegisteredMediaUrl(value: string, expectedId: string): boolean {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedId)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "sharpshot-media:"
            && url.hostname === "asset"
            && decodeURIComponent(url.pathname.replace(/^\//, "")) === expectedId;
    } catch {
        return false;
    }
}
