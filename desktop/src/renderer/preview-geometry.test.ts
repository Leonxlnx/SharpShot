import { describe, expect, it } from "vitest";
import { computeRendererPreviewGeometry } from "./preview-geometry";
import type { EditorProject } from "./types";
import { createEmptyOverlayDocument } from "../shared/overlays";

function project(fitMode: "fit" | "fill"): EditorProject {
    return {
        name: "Geometry",
        sourceDuration: 5,
        sourceWidth: 1_920,
        sourceHeight: 1_080,
        sourceAspect: 16 / 9,
        canvasWidth: 1_920,
        canvasHeight: 1_080,
        clips: [{ id: "clip", name: "Clip", sourceStart: 0, sourceEnd: 5, speed: 1, color: "#7897e8" }],
        zoomSegments: [],
        overlays: createEmptyOverlayDocument(),
        backgroundId: "cobalt",
        aspectRatio: "1:1",
        padding: 0,
        cornerRadius: 16,
        shadow: 28,
        fitMode,
        scale: 100,
        offsetX: 0,
        offsetY: 0,
        cursorScale: 1,
        hideCursorIdle: true,
        clickEmphasis: true,
        systemVolume: 100,
        microphoneVolume: 0,
    };
}

describe("renderer preview geometry", () => {
    it("matches the canonical 16:9 to square Fit rectangle", () => {
        const geometry = computeRendererPreviewGeometry(project("fit"));
        expect(geometry.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
        expect(geometry.layout.screenRectPx).toEqual({ x: 0, y: 236, width: 1_080, height: 608 });
    });

    it("matches the canonical 16:9 to square Fill crop and rectangle", () => {
        const geometry = computeRendererPreviewGeometry(project("fill"));
        expect(geometry.crop.x).toBeCloseTo(0.21875, 6);
        expect(geometry.crop.width).toBeCloseTo(0.5625, 6);
        expect(geometry.layout.screenRectPx).toEqual({ x: 0, y: 0, width: 1_080, height: 1_080 });
    });

    it("never reverses horizontal direction above 100% scale", () => {
        const centered = { ...project("fit"), scale: 150 };
        const left = computeRendererPreviewGeometry({ ...centered, offsetX: -60 }).layout.screenRectPx.x;
        const center = computeRendererPreviewGeometry(centered).layout.screenRectPx.x;
        const right = computeRendererPreviewGeometry({ ...centered, offsetX: 60 }).layout.screenRectPx.x;
        expect(left).toBeLessThan(center);
        expect(right).toBeGreaterThan(center);
    });

    it("uses an explicit normalized crop instead of the fit-mode preset", () => {
        const crop = { x: 0.1, y: 0.05, width: 0.7, height: 0.8 };
        const geometry = computeRendererPreviewGeometry({ ...project("fit"), crop });

        expect(geometry.crop).toBe(crop);
        expect(geometry.canvas.screen.crop).toEqual(crop);
        expect(geometry.layout.sourceCropPx).toEqual({ x: 192, y: 54, width: 1_344, height: 864 });
    });
});
