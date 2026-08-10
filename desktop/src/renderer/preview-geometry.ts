import {
    computeFitModeCrop,
    computeScreenLayout,
    screenPositionFromEditorOffset,
    type ScreenLayout,
} from "../shared/export-plan";
import {
    createDefaultProject,
    DEFAULT_CANVAS_STYLE,
    type CanvasStyle,
    type VideoAsset,
} from "../shared/project";
import type { EditorProject } from "./types";

export type RendererPreviewGeometry = {
    canvas: CanvasStyle;
    crop: { x: number; y: number; width: number; height: number };
    layout: ScreenLayout;
};

const ASPECTS: ReadonlyArray<readonly [EditorProject["aspectRatio"], number]> = [
    ["16:9", 16 / 9],
    ["16:10", 16 / 10],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["4:5", 4 / 5],
    ["9:16", 9 / 16],
];

export function computeRendererPreviewGeometry(renderer: EditorProject): RendererPreviewGeometry {
    const dimensions = previewCanvasDimensions(renderer);
    const source = {
        width: renderer.sourceWidth ?? Math.max(2, Math.round((renderer.sourceAspect ?? 16 / 9) * 1_080)),
        height: renderer.sourceHeight ?? 1_080,
    };
    const shortestEdge = Math.min(dimensions.width, dimensions.height);
    const padding = renderer.padding / shortestEdge;
    const crop = renderer.crop ?? computeFitModeCrop(renderer.fitMode, source, dimensions, padding);
    const canvas: CanvasStyle = {
        ...DEFAULT_CANVAS_STYLE,
        ...dimensions,
        preset: "custom",
        background: { ...DEFAULT_CANVAS_STYLE.background },
        screen: {
            ...DEFAULT_CANVAS_STYLE.screen,
            crop,
            padding,
            scale: renderer.scale / 100,
            position: { x: 0.5, y: 0.5 },
            cornerRadius: 0,
            border: {
                widthPx: renderer.borderWidthPx ?? 0,
                color: renderer.borderColor ?? "#FFFFFF",
                opacity: renderer.borderOpacity ?? 0,
            },
            shadow: {
                offsetX: renderer.shadowOffsetX ?? 0,
                offsetY: renderer.shadowOffsetY ?? 18,
                blurPx: renderer.shadowBlurPx ?? 42,
                opacity: renderer.shadow / 100,
            },
        },
    };
    const project = createDefaultProject({ id: "renderer-preview", now: "2026-01-01T00:00:00.000Z", canvas });
    const asset: VideoAsset = {
        id: "renderer-preview-source",
        kind: "video",
        name: "Preview source",
        locator: { kind: "managed", relativePath: "library/renderer-preview-source" },
        durationUs: 1,
        width: source.width,
        height: source.height,
        frameRate: { numerator: 60, denominator: 1 },
    };
    project.canvas.screen.position = screenPositionFromEditorOffset(
        { x: renderer.offsetX, y: renderer.offsetY },
        project,
        asset,
    );
    const initialLayout = computeScreenLayout(project, asset);
    project.canvas.screen.cornerRadius = renderer.cornerRadius /
        Math.max(1, Math.min(initialLayout.screenRectPx.width, initialLayout.screenRectPx.height));
    return { canvas: project.canvas, crop, layout: computeScreenLayout(project, asset) };
}

function previewCanvasDimensions(renderer: EditorProject): { width: number; height: number } {
    if (renderer.canvasWidth !== undefined && renderer.canvasHeight !== undefined) {
        const storedAspect = nearestAspect(renderer.canvasWidth / renderer.canvasHeight);
        if (storedAspect === renderer.aspectRatio) return { width: renderer.canvasWidth, height: renderer.canvasHeight };
    }
    if (renderer.aspectRatio === "9:16") return { width: 1_080, height: 1_920 };
    if (renderer.aspectRatio === "4:5") return { width: 1_080, height: 1_350 };
    if (renderer.aspectRatio === "16:10") return { width: 1_920, height: 1_200 };
    if (renderer.aspectRatio === "4:3") return { width: 1_440, height: 1_080 };
    if (renderer.aspectRatio === "1:1") return { width: 1_080, height: 1_080 };
    return { width: 1_920, height: 1_080 };
}

function nearestAspect(ratio: number): EditorProject["aspectRatio"] {
    return ASPECTS.reduce((best, candidate) =>
        Math.abs(Math.log(ratio / candidate[1])) < Math.abs(Math.log(ratio / best[1])) ? candidate : best,
    )[0];
}
