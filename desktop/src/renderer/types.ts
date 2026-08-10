import type { NormalizedRect } from "../shared/project";
import type { ZoomSegment } from "../shared/cursor-zoom";
import type { OverlayDocument } from "../shared/overlays";
import type { AudioTimeline } from "../shared/audio-timeline";

export type AppRoute = "home" | "library" | "workflows" | "editor" | "settings";

export type CaptureKind = "screenshot" | "video";
export type CaptureTarget = "Region";
export type AfterAction = "Save to Library" | "Copy" | "Open Editor";

export interface Workflow {
    id: string;
    name: string;
    description: string;
    kind: CaptureKind;
    target: CaptureTarget;
    shortcuts: string[][];
    enabled: boolean;
    fps?: 30 | 60;
    quality?: "Balanced" | "High" | "Maximum" | "Lossless";
    cursor: boolean;
    systemAudio: boolean;
    microphone: boolean;
    countdown: 0 | 3;
    after: AfterAction[];
}

export interface CaptureItem {
    id: string;
    name: string;
    kind: CaptureKind;
    createdLabel: string;
    dimensions: string;
    duration?: string;
    size: string;
    workflow: string;
    thumbnail: string;
    accent: string;
}

export interface Wallpaper {
    id: string;
    name: string;
    /** Lightweight picker artwork. The full source is reserved for the active canvas. */
    thumbnailSource: string;
    source: string;
    width: number;
    height: number;
    accent: string;
    textColor: "light" | "dark";
}

export interface EditorClip {
    id: string;
    /** Canonical clip whose asset/audio metadata this edited or split clip inherits. */
    sourceClipId?: string;
    name: string;
    sourceStart: number;
    sourceEnd: number;
    speed: number;
    color: string;
    /** Canonical embedded-source mix retained for clip-accurate preview. */
    sourceAudio?: {
        mode: "preserve-pitch" | "change-pitch" | "mute";
        gainDb: number;
    };
}

export interface EditorProject {
    name: string;
    sourceDuration: number;
    sourceAspect?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    canvasWidth?: number;
    canvasHeight?: number;
    borderWidthPx?: number;
    borderColor?: string;
    borderOpacity?: number;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    shadowBlurPx?: number;
    clips: EditorClip[];
    zoomSegments: ZoomSegment[];
    overlays: OverlayDocument;
    audio?: AudioTimeline;
    backgroundId: string;
    aspectRatio: "16:9" | "16:10" | "4:3" | "1:1" | "9:16" | "4:5";
    padding: number;
    cornerRadius: number;
    shadow: number;
    fitMode: "fit" | "fill";
    crop?: NormalizedRect;
    scale: number;
    offsetX: number;
    offsetY: number;
    cursorScale: number;
    hideCursorIdle: boolean;
    clickEmphasis: boolean;
    systemVolume: number;
    microphoneVolume: number;
}

export interface EditorState {
    project: EditorProject;
    /** Original snapshot while a state-backed slider previews values. */
    continuousEditStart: EditorProject | null;
    history: EditorProject[];
    future: EditorProject[];
    playhead: number;
    playing: boolean;
    selectedClipId: string;
    selectedZoomId: string | null;
    selectedCaptionId: string | null;
    selectedOverlayId: string | null;
    selectedAudioClipId: string | null;
    activeTool: "canvas" | "background" | "layout" | "crop" | "zoom" | "audio" | "captions" | "annotations";
    exportOpen: boolean;
}

export interface ToastMessage {
    id: number;
    title: string;
    detail: string;
    tone?: "neutral" | "success";
}
