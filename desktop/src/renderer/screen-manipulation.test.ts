import { describe, expect, it } from "vitest";
import type { NormalizedRect } from "../shared/project";
import { computeRendererPreviewGeometry } from "./preview-geometry";
import {
    composeCrop,
    resizeCropRect,
    resizeScreen,
    translateScreen,
    type CanvasRect,
    type ScreenTransformPatch,
} from "./screen-manipulation";
import type { EditorProject } from "./types";
import { createEmptyOverlayDocument } from "../shared/overlays";

function project(change: Partial<EditorProject> = {}): EditorProject {
    return {
        name: "Direct manipulation",
        sourceDuration: 5,
        sourceWidth: 1_920,
        sourceHeight: 1_080,
        sourceAspect: 16 / 9,
        canvasWidth: 1_920,
        canvasHeight: 1_080,
        clips: [{ id: "clip", name: "Clip", sourceStart: 0, sourceEnd: 5, speed: 1, color: "#7897e8" }],
        zoomSegments: [],
        backgroundId: "cobalt",
        aspectRatio: "16:9",
        padding: 72,
        cornerRadius: 16,
        shadow: 28,
        fitMode: "fit",
        scale: 100,
        offsetX: 0,
        offsetY: 0,
        cursorScale: 1,
        hideCursorIdle: true,
        clickEmphasis: true,
        systemVolume: 100,
        microphoneVolume: 0,
        ...change,
        overlays: change.overlays ?? createEmptyOverlayDocument(),
    };
}

function patched(value: EditorProject, patch: ScreenTransformPatch): EditorProject {
    return { ...value, ...patch };
}

function rect(value: EditorProject): CanvasRect {
    return computeRendererPreviewGeometry(value).layout.screenRectPx;
}

describe("screen direct manipulation", () => {
    it("tracks a drag in canvas pixels and produces matching committed geometry", () => {
        const startProject = project();
        const start = rect(startProject);
        const result = translateScreen(startProject, { x: 120, y: -70 });
        const committed = rect(patched(startProject, result.patch));

        expect(result.rect.x - start.x).toBeCloseTo(120, 1);
        expect(result.rect.y - start.y).toBeCloseTo(-70, 1);
        expect(committed.x).toBeCloseTo(result.rect.x, 0);
        expect(committed.y).toBeCloseTo(result.rect.y, 0);
    });

    it("resizes from a corner with the opposite corner fixed and aspect preserved", () => {
        const startProject = project();
        const start = rect(startProject);
        const result = resizeScreen(startProject, "se", {
            x: start.x + start.width + 180,
            y: start.y + start.height + 40,
        });

        expect(result.patch.scale).toBeGreaterThan(100);
        expect(result.patch.crop).toBeUndefined();
        expect(result.rect.x).toBeCloseTo(start.x, 0);
        expect(result.rect.y).toBeCloseTo(start.y, 0);
        expect(result.rect.width / result.rect.height).toBeCloseTo(start.width / start.height, 5);
    });

    it("uses a centered source crop for Shift free-aspect resizing without distortion", () => {
        const startProject = project();
        const start = rect(startProject);
        const requestedWidth = start.width * 1.1;
        const requestedHeight = start.height * 0.8;
        const result = resizeScreen(startProject, "se", {
            x: start.x + requestedWidth,
            y: start.y + requestedHeight,
        }, false);
        const committed = rect(patched(startProject, result.patch));

        expect(result.patch.crop).toBeDefined();
        expect(committed.width / committed.height).toBeCloseTo(requestedWidth / requestedHeight, 2);
        expect(committed.x).toBeCloseTo(start.x, 0);
        expect(committed.y).toBeCloseTo(start.y, 0);
    });
});

describe("crop direct manipulation", () => {
    const full: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

    it("resizes every edge inside normalized source bounds", () => {
        expect(resizeCropRect(full, "nw", { x: 0.2, y: 0.1 })).toEqual({
            x: 0.2,
            y: 0.1,
            width: 0.8,
            height: 0.9,
        });
        expect(resizeCropRect(full, "e", { x: -0.25, y: 0 })).toEqual({
            x: 0,
            y: 0,
            width: 0.75,
            height: 1,
        });
    });

    it("moves a crop without allowing any edge past the source", () => {
        const start = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 };
        expect(resizeCropRect(start, "move", { x: 0.9, y: -0.9 })).toEqual({
            x: 0.5,
            y: 0,
            width: 0.5,
            height: 0.4,
        });
    });

    it("composes the local crop selection into the canonical source crop", () => {
        expect(composeCrop(
            { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
            { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
        )).toEqual({ x: 0.3, y: 0.5, width: 0.4, height: 0.15 });
    });
});
