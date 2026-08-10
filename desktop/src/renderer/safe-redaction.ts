import { MAX_EXPORTED_SAFE_REDACTIONS } from "../shared/export-plan";
import {
    canonicalizeOverlayDocument,
    validateVisualOverlay,
    type OverlayDocument,
    type ShapeOverlay,
    type VisualOverlay,
} from "../shared/overlays";
import type { NormalizedRect } from "../shared/project";

export type SafeRedactionPreset = "black" | "dark" | "white";
export type SafeRedactionEdge = "start" | "end";

export const SAFE_REDACTION_COLORS: Readonly<Record<SafeRedactionPreset, string>> = {
    black: "#000000FF",
    dark: "#151619FF",
    white: "#FFFFFFFF",
};

const DEFAULT_AREA: Readonly<NormalizedRect> = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
const DEFAULT_DURATION_US = 3_000_000;

export class SafeRedactionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SafeRedactionError";
    }
}

export function isSafeRedaction(overlay: VisualOverlay): overlay is ShapeOverlay {
    return overlay.kind === "shape"
        && overlay.shape === "rectangle"
        && overlay.opacity === 1
        && (overlay.fillColor.length === 7 || overlay.fillColor.slice(7).toUpperCase() === "FF")
        && overlay.strokeWidthPx === 0
        && overlay.cornerRadius === 0
        && overlay.rotationDeg === 0;
}

export function safeRedactions(document: OverlayDocument): ShapeOverlay[] {
    return document.overlays.filter(isSafeRedaction);
}

export function addSafeRedaction(options: {
    document: OverlayDocument;
    playheadUs: number;
    projectDurationUs: number;
    preset?: SafeRedactionPreset;
}): { document: OverlayDocument; redaction: ShapeOverlay } {
    if (options.document.overlays.length >= MAX_EXPORTED_SAFE_REDACTIONS) {
        throw new SafeRedactionError(`A project can contain at most ${MAX_EXPORTED_SAFE_REDACTIONS} redactions.`);
    }
    const projectDurationUs = Math.round(options.projectDurationUs);
    if (!Number.isSafeInteger(projectDurationUs) || projectDurationUs < 1) {
        throw new SafeRedactionError("Add timeline media before creating a redaction.");
    }
    const startUs = clamp(Math.round(options.playheadUs), 0, projectDurationUs - 1);
    const preset = options.preset ?? "black";
    const redaction: ShapeOverlay = {
        kind: "shape",
        id: nextRedactionId(options.document),
        startUs,
        endUs: Math.min(projectDurationUs, startUs + DEFAULT_DURATION_US),
        opacity: 1,
        shape: "rectangle",
        area: { ...DEFAULT_AREA },
        fillColor: SAFE_REDACTION_COLORS[preset],
        strokeColor: "#00000000",
        strokeWidthPx: 0,
        cornerRadius: 0,
        rotationDeg: 0,
    };
    validateVisualOverlay(redaction);
    return {
        document: canonicalizeOverlayDocument({
            ...options.document,
            overlays: [...options.document.overlays, redaction],
        }),
        redaction,
    };
}

export function setSafeRedactionArea(
    document: OverlayDocument,
    id: string,
    area: NormalizedRect,
): OverlayDocument {
    return replaceSafeRedaction(document, id, (redaction) => ({ ...redaction, area: { ...area } }));
}

export function setSafeRedactionPreset(
    document: OverlayDocument,
    id: string,
    preset: SafeRedactionPreset,
): OverlayDocument {
    return replaceSafeRedaction(document, id, (redaction) => ({
        ...redaction,
        fillColor: SAFE_REDACTION_COLORS[preset],
    }));
}

export function presetForSafeRedaction(redaction: ShapeOverlay): SafeRedactionPreset {
    const match = (Object.entries(SAFE_REDACTION_COLORS) as Array<[SafeRedactionPreset, string]>)
        .find(([, color]) => color === redaction.fillColor.toUpperCase());
    return match?.[0] ?? "black";
}

export function resizeSafeRedactionRange(
    redaction: ShapeOverlay,
    edge: SafeRedactionEdge,
    requestedUs: number,
    projectDurationUs: number,
): ShapeOverlay {
    const durationUs = Math.max(1, Math.round(projectDurationUs));
    const requested = Math.round(Number.isFinite(requestedUs) ? requestedUs : edge === "start" ? redaction.startUs : redaction.endUs);
    const next = edge === "start"
        ? { ...redaction, startUs: clamp(requested, 0, Math.min(durationUs - 1, redaction.endUs - 1)) }
        : { ...redaction, endUs: clamp(requested, redaction.startUs + 1, durationUs) };
    validateVisualOverlay(next);
    return next;
}

export function setSafeRedactionRange(
    document: OverlayDocument,
    redaction: ShapeOverlay,
): OverlayDocument {
    return replaceSafeRedaction(document, redaction.id, () => redaction);
}

export function deleteSafeRedaction(document: OverlayDocument, id: string): OverlayDocument {
    if (!document.overlays.some((overlay) => overlay.id === id && isSafeRedaction(overlay))) return document;
    return canonicalizeOverlayDocument({
        ...document,
        overlays: document.overlays.filter((overlay) => overlay.id !== id),
    });
}

function replaceSafeRedaction(
    document: OverlayDocument,
    id: string,
    update: (redaction: ShapeOverlay) => ShapeOverlay,
): OverlayDocument {
    let replaced = false;
    const overlays = document.overlays.map((overlay) => {
        if (overlay.id !== id || !isSafeRedaction(overlay)) return overlay;
        const next = update(overlay);
        validateVisualOverlay(next);
        if (!isSafeRedaction(next)) throw new SafeRedactionError("A redaction must remain fully opaque and rectangular.");
        replaced = true;
        return next;
    });
    return replaced ? canonicalizeOverlayDocument({ ...document, overlays }) : document;
}

function nextRedactionId(document: OverlayDocument): string {
    const occupied = new Set([
        ...document.captions.map((caption) => caption.id),
        ...document.overlays.map((overlay) => overlay.id),
    ]);
    for (let index = 1; index <= occupied.size + 1; index += 1) {
        const candidate = `redaction-${index}`;
        if (!occupied.has(candidate)) return candidate;
    }
    throw new SafeRedactionError("Could not allocate a redaction identifier.");
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
