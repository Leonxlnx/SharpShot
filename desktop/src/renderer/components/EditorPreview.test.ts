import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CANVAS_STYLE } from "../../shared/project";
import type { ZoomSegment } from "../../shared/cursor-zoom";
import { INITIAL_EDITOR_STATE } from "../state";
import {
    canvasPointForBounds,
    clipAtTime,
    normalizedPointForBounds,
    isEditorShortcutTarget,
    previewScreenBoxShadow,
    previewPointForZoomFocus,
    previewZoomTransformAt,
    readPreviewPointerBounds,
    resolvePreviewVolume,
    resolveSourceClipPreviewVolume,
    redactionAreaForPointerCommit,
    EditorPreview,
    zoomFocusForPreviewPoint,
} from "./EditorPreview";

describe("editor preview pointer geometry", () => {
    it("reads element bounds once and reuses them throughout a gesture", () => {
        const getBoundingClientRect = vi.fn(() => ({
            left: 10,
            top: 20,
            width: 200,
            height: 100,
        } as DOMRect));
        const bounds = readPreviewPointerBounds({ getBoundingClientRect });

        for (let index = 0; index < 100; index += 1) {
            expect(normalizedPointForBounds({ clientX: 110, clientY: 70 }, bounds)).toEqual({ x: 0.5, y: 0.5 });
            expect(canvasPointForBounds({ clientX: 110, clientY: 70 }, bounds, 1_920, 1_080)).toEqual({ x: 960, y: 540 });
        }

        expect(getBoundingClientRect).toHaveBeenCalledOnce();
    });
});

describe("editor redaction pointer transactions", () => {
    it("turns any number of draft frames into one final commit", () => {
        const original = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
        let latest = original;
        for (let index = 0; index < 100; index += 1) latest = { ...latest, x: 0.3 + index / 1_000 };
        const commit = vi.fn();
        const area = redactionAreaForPointerCommit(original, latest, false);
        if (area !== undefined) commit(area);

        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith(latest);
        expect(redactionAreaForPointerCommit(original, latest, true)).toBeUndefined();
        expect(redactionAreaForPointerCommit(original, { ...original }, false)).toBeUndefined();
    });
});

describe("crop completion controls", () => {
    it("renders explicit cancel/apply controls and isolates dialog and form shortcuts", () => {
        const state = structuredClone(INITIAL_EDITOR_STATE);
        state.activeTool = "crop";
        const html = renderToStaticMarkup(createElement(EditorPreview, {
            state,
            media: null,
            cropMode: true,
            onTransformCommit: vi.fn(),
            onZoomFocusCommit: vi.fn(),
            onOverlayAreaCommit: vi.fn(),
            onOverlaySelect: vi.fn(),
            onCropApply: vi.fn(),
            onCropCancel: vi.fn(),
        }));
        expect(html).toContain(">Cancel</button>");
        expect(html).toContain(">Apply crop</span></button>");

        const interactive = { closest: vi.fn(() => ({} as Element)) };
        const plain = { closest: vi.fn(() => null) };
        expect(isEditorShortcutTarget(interactive as unknown as EventTarget)).toBe(true);
        expect(interactive.closest).toHaveBeenCalledWith(expect.stringContaining("[role='dialog']"));
        expect(isEditorShortcutTarget(plain as unknown as EventTarget)).toBe(false);
    });
});

describe("editor preview screen shadow", () => {
    it("maps the canonical default CSS blur radius and offsets into canvas geometry", () => {
        expect(previewScreenBoxShadow(DEFAULT_CANVAS_STYLE.screen.shadow, 1_920)).toBe(
            "0cqw 0.9375cqw 2.1875cqw rgba(0,0,0,0.28)",
        );
    });

    it("keeps custom nonzero blur and signed offsets in the same canvas-pixel scale", () => {
        expect(previewScreenBoxShadow({ offsetX: -16, offsetY: 24, blurPx: 32, opacity: 0.4 }, 1_280)).toBe(
            "-1.25cqw 1.875cqw 2.5cqw rgba(0,0,0,0.4)",
        );
    });
});

describe("editor preview volume", () => {
    it("maps the persisted percent to the HTML media volume range", () => {
        expect(resolvePreviewVolume(0)).toBe(0);
        expect(resolvePreviewVolume(42)).toBe(0.42);
        expect(resolvePreviewVolume(100)).toBe(1);
    });

    it("clamps invalid project values before assigning HTMLVideoElement.volume", () => {
        expect(resolvePreviewVolume(-10)).toBe(0);
        expect(resolvePreviewVolume(180)).toBe(1);
        expect(resolvePreviewVolume(Number.NaN)).toBe(0);
        expect(resolvePreviewVolume(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("uses the active canonical clip mute/gain until the global slider changes", () => {
        const clips = [
            { ...INITIAL_EDITOR_STATE.project.clips[0]!, sourceAudio: { mode: "mute" as const, gainDb: -12 } },
            { ...INITIAL_EDITOR_STATE.project.clips[1]!, sourceAudio: { mode: "change-pitch" as const, gainDb: -6 } },
        ];

        expect(resolveSourceClipPreviewVolume(clips[0], clips, 50)).toBe(0);
        expect(resolveSourceClipPreviewVolume(clips[1], clips, 50)).toBeCloseTo(10 ** (-6 / 20), 8);
        expect(resolveSourceClipPreviewVolume(clips[0], clips, 25)).toBe(0.25);
        expect(resolveSourceClipPreviewVolume(clips[1], clips, 25)).toBe(0.25);
    });
});

describe("editor zoom preview", () => {
    const segment: ZoomSegment = {
        id: "manual-zoom",
        startUs: 1_000_000,
        endUs: 3_000_000,
        focus: { x: 0.4, y: 0.4 },
        scale: 2,
        easeInUs: 0,
        easeOutUs: 0,
        source: "manual",
    };

    it("evaluates focus inside the active crop before transforming the preview", () => {
        const transform = previewZoomTransformAt(
            [segment],
            2_000_000,
            { x: 0.2, y: 0.1, width: 0.4, height: 0.6 },
        );
        expect(transform.scale).toBe(2);
        expect(transform.centerX).toBeCloseTo(0.5, 6);
        expect(transform.centerY).toBeCloseTo(0.5, 6);
        expect(transform.translateX).toBeCloseTo(-0.5, 6);
        expect(transform.translateY).toBeCloseTo(-0.5, 6);
    });

    it("shows the unzoomed source while crop coordinates are being edited", () => {
        expect(previewZoomTransformAt(
            [segment],
            2_000_000,
            { x: 0.2, y: 0.1, width: 0.4, height: 0.6 },
            true,
        )).toMatchObject({ scale: 1, translateX: 0, translateY: 0 });
    });

    it("resolves an exact cut to the next clip instead of the prior end frame", () => {
        const state = structuredClone(INITIAL_EDITOR_STATE);
        const first = state.project.clips[0]!;
        const firstDuration = (first.sourceEnd - first.sourceStart) / first.speed;
        const active = clipAtTime(state, firstDuration);

        expect(active?.clip.id).toBe(state.project.clips[1]!.id);
        expect(active?.sourceTime).toBe(state.project.clips[1]!.sourceStart);
    });

    it("maps direct focus gestures back into source-normalized crop coordinates", () => {
        const focus = zoomFocusForPreviewPoint(
            { x: 0.25, y: 0.75 },
            { x: 0.2, y: 0.1, width: 0.4, height: 0.6 },
            { scale: 1, translateX: 0, translateY: 0, centerX: 0.5, centerY: 0.5 },
        );
        expect(focus.x).toBeCloseTo(0.3, 6);
        expect(focus.y).toBeCloseTo(0.55, 6);
    });

    it("inverts an active zoom when the user picks a visible subject", () => {
        const crop = { x: 0, y: 0, width: 1, height: 1 };
        const transform = previewZoomTransformAt([
            { ...segment, focus: { x: 0.75, y: 0.5 } },
        ], 2_000_000, crop);
        const focus = zoomFocusForPreviewPoint({ x: 0.5, y: 0.5 }, crop, transform);
        expect(focus.x).toBeCloseTo(0.75, 6);
        expect(focus.y).toBeCloseTo(0.5, 6);
        const marker = previewPointForZoomFocus(focus, crop, transform);
        expect(marker.x).toBeCloseTo(0.5, 6);
        expect(marker.y).toBeCloseTo(0.5, 6);
    });
});
