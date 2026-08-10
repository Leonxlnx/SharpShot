import cobaltBloomThumbnail from "../../resources/backgrounds/thumbnails/cobalt-bloom.webp";
import duskFoldThumbnail from "../../resources/backgrounds/thumbnails/dusk-fold.webp";
import glacierGlassThumbnail from "../../resources/backgrounds/thumbnails/glacier-glass.webp";
import lunarPaperThumbnail from "../../resources/backgrounds/thumbnails/lunar-paper.webp";
import midnightBloomThumbnail from "../../resources/backgrounds/thumbnails/midnight-bloom.webp";
import mossAlloyThumbnail from "../../resources/backgrounds/thumbnails/moss-alloy.webp";
import obsidianTideThumbnail from "../../resources/backgrounds/thumbnails/obsidian-tide.webp";
import solarSilkThumbnail from "../../resources/backgrounds/thumbnails/solar-silk.webp";
import { backgroundPresetSource } from "./background-gallery";
import type { CaptureItem, EditorProject, Wallpaper, Workflow } from "./types";
import { createEmptyOverlayDocument } from "../shared/overlays";

export const WALLPAPERS: Wallpaper[] = [
    { id: "cobalt", name: "Cobalt Bloom", thumbnailSource: cobaltBloomThumbnail, source: bundledBackgroundUrl("cobalt-bloom"), accent: "#1d5cff", textColor: "light" },
    { id: "lunar", name: "Lunar Paper", thumbnailSource: lunarPaperThumbnail, source: bundledBackgroundUrl("lunar-paper"), accent: "#f2efe7", textColor: "dark" },
    { id: "midnight", name: "Midnight Bloom", thumbnailSource: midnightBloomThumbnail, source: bundledBackgroundUrl("midnight-bloom"), accent: "#7f94ff", textColor: "light" },
    { id: "glacier", name: "Glacier Glass", thumbnailSource: glacierGlassThumbnail, source: bundledBackgroundUrl("glacier-glass"), accent: "#95c9e8", textColor: "dark" },
    { id: "solar", name: "Solar Silk", thumbnailSource: solarSilkThumbnail, source: bundledBackgroundUrl("solar-silk"), accent: "#e9a85e", textColor: "light" },
    { id: "dusk", name: "Dusk Fold", thumbnailSource: duskFoldThumbnail, source: bundledBackgroundUrl("dusk-fold"), accent: "#b78fd5", textColor: "light" },
    { id: "moss", name: "Moss Alloy", thumbnailSource: mossAlloyThumbnail, source: bundledBackgroundUrl("moss-alloy"), accent: "#8ea97b", textColor: "light" },
    { id: "obsidian", name: "Obsidian Tide", thumbnailSource: obsidianTideThumbnail, source: bundledBackgroundUrl("obsidian-tide"), accent: "#5e6670", textColor: "light" },
];

export function resolveBackgroundSource(
    backgroundId: string,
    bundledProtocolAvailable = hasDesktopBridge(),
): string {
    const wallpaper = WALLPAPERS.find((item) => item.id === backgroundId);
    return (wallpaper === undefined ? undefined : bundledProtocolAvailable ? wallpaper.source : wallpaper.thumbnailSource)
        ?? backgroundPresetSource(backgroundId)
        ?? (backgroundId.startsWith("sharpshot-media:") || backgroundId.startsWith("blob:") || backgroundId.startsWith("data:") ? backgroundId : bundledProtocolAvailable ? bundledBackgroundUrl("cobalt-bloom") : cobaltBloomThumbnail);
}

function bundledBackgroundUrl(id: string): string {
    return `sharpshot-media://background/${encodeURIComponent(id)}`;
}

function hasDesktopBridge(): boolean {
    return typeof window !== "undefined" && Boolean((window as unknown as { sharpShot?: unknown }).sharpShot);
}

export const DEFAULT_WORKFLOWS: Workflow[] = [
    {
        id: "quick-screenshot",
        name: "Quick Screenshot",
        description: "Pixel-perfect region capture",
        kind: "screenshot",
        target: "Region",
        shortcuts: [["Win", "Shift", "D"]],
        enabled: true,
        quality: "Lossless",
        cursor: false,
        systemAudio: false,
        microphone: false,
        countdown: 0,
        after: ["Save to Library", "Copy"],
    },
    {
        id: "quick-video",
        name: "Quick Clip",
        description: "Record, copy, keep moving",
        kind: "video",
        target: "Region",
        shortcuts: [["Win", "Shift", "A"]],
        enabled: true,
        fps: 60,
        quality: "High",
        cursor: true,
        systemAudio: true,
        microphone: false,
        countdown: 3,
        after: ["Save to Library", "Copy"],
    },
    {
        id: "video-studio",
        name: "Studio Clip",
        description: "Record into a polished project",
        kind: "video",
        target: "Region",
        shortcuts: [["Win", "Shift", "E"]],
        enabled: true,
        fps: 60,
        quality: "High",
        cursor: true,
        systemAudio: true,
        microphone: true,
        countdown: 3,
        after: ["Save to Library", "Open Editor"],
    },
];

export const CAPTURES: CaptureItem[] = [
    {
        id: "capture-1",
        name: "Product walkthrough",
        kind: "video",
        createdLabel: "Today, 17:42",
        dimensions: "1920 × 1080",
        duration: "00:24",
        size: "18.4 MB",
        workflow: "Studio Clip",
        thumbnail: midnightBloomThumbnail,
        accent: "#8198ff",
    },
    {
        id: "capture-2",
        name: "Checkout interaction",
        kind: "video",
        createdLabel: "Today, 16:18",
        dimensions: "1280 × 720",
        duration: "00:12",
        size: "7.8 MB",
        workflow: "Quick Clip",
        thumbnail: duskFoldThumbnail,
        accent: "#bc8bd0",
    },
    {
        id: "capture-3",
        name: "Dashboard detail",
        kind: "screenshot",
        createdLabel: "Today, 14:03",
        dimensions: "1640 × 924",
        size: "1.2 MB",
        workflow: "Quick Screenshot",
        thumbnail: glacierGlassThumbnail,
        accent: "#94cae6",
    },
    {
        id: "capture-4",
        name: "Landing page hero",
        kind: "screenshot",
        createdLabel: "Yesterday, 22:51",
        dimensions: "1512 × 982",
        size: "1.6 MB",
        workflow: "Quick Screenshot",
        thumbnail: solarSilkThumbnail,
        accent: "#e2a05a",
    },
    {
        id: "capture-5",
        name: "Search prototype",
        kind: "video",
        createdLabel: "Yesterday, 19:27",
        dimensions: "1920 × 1080",
        duration: "00:38",
        size: "25.1 MB",
        workflow: "Studio Clip",
        thumbnail: glacierGlassThumbnail,
        accent: "#96c8df",
    },
    {
        id: "capture-6",
        name: "Pricing comparison",
        kind: "screenshot",
        createdLabel: "Friday, 11:09",
        dimensions: "1440 × 900",
        size: "980 KB",
        workflow: "Quick Screenshot",
        thumbnail: midnightBloomThumbnail,
        accent: "#8296ee",
    },
];

export const INITIAL_PROJECT: EditorProject = {
    name: "Product walkthrough",
    sourceDuration: 24,
    clips: [
        { id: "clip-a", name: "Intro", sourceStart: 0, sourceEnd: 7.8, speed: 1, color: "#7897e8" },
        { id: "clip-b", name: "Demo", sourceStart: 8.4, sourceEnd: 18.6, speed: 1, color: "#8b8fe8" },
        { id: "clip-c", name: "Finish", sourceStart: 19.1, sourceEnd: 24, speed: 1, color: "#9b82d8" },
    ],
    zoomSegments: [],
    overlays: createEmptyOverlayDocument(),
    backgroundId: "cobalt",
    aspectRatio: "16:9",
    padding: 46,
    cornerRadius: 16,
    shadow: 52,
    fitMode: "fit",
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    cursorScale: 1,
    hideCursorIdle: true,
    clickEmphasis: true,
    systemVolume: 82,
    microphoneVolume: 74,
};
