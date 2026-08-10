import type { NormalizedRect } from "../shared/project";
import { computeRendererPreviewGeometry } from "./preview-geometry";
import type { EditorProject } from "./types";

export interface ScreenTransformPatch {
    scale?: number;
    offsetX?: number;
    offsetY?: number;
    crop?: NormalizedRect;
}

export type CanvasPoint = { x: number; y: number };
export type CanvasRect = CanvasPoint & { width: number; height: number };
export type ResizeHandle = "nw" | "ne" | "se" | "sw";
export type CropHandle = ResizeHandle | "n" | "e" | "s" | "w" | "move";

export interface ScreenManipulationResult {
    patch: ScreenTransformPatch;
    rect: CanvasRect;
}

type ManipulableProject = EditorProject & { crop?: NormalizedRect };

const MIN_SCALE = 50;
const MAX_SCALE = 200;
const MIN_CROP_SIZE = 0.02;

export function translateScreen(
    project: ManipulableProject,
    delta: CanvasPoint,
): ScreenManipulationResult {
    const start = screenRect(project);
    const patch = offsetsForCenter(project, {
        x: center(start).x + delta.x,
        y: center(start).y + delta.y,
    });
    const actualCenter = centerForOffsets(project, patch);
    return {
        patch,
        rect: rectAround(actualCenter, start.width, start.height),
    };
}

export function resizeScreen(
    project: ManipulableProject,
    handle: ResizeHandle,
    pointer: CanvasPoint,
    preserveAspect = true,
): ScreenManipulationResult {
    const start = screenRect(project);
    const anchor = oppositeCorner(start, handle);
    const startHandle = corner(start, handle);

    if (!preserveAspect) {
        return resizeScreenFreely(project, handle, pointer, anchor);
    }

    const vector = { x: startHandle.x - anchor.x, y: startHandle.y - anchor.y };
    const pointerVector = { x: pointer.x - anchor.x, y: pointer.y - anchor.y };
    const denominator = vector.x * vector.x + vector.y * vector.y;
    const requestedFactor = denominator === 0
        ? 1
        : (pointerVector.x * vector.x + pointerVector.y * vector.y) / denominator;
    const scale = clamp(project.scale * requestedFactor, MIN_SCALE, MAX_SCALE);
    const factor = scale / project.scale;
    const width = start.width * factor;
    const height = start.height * factor;
    const requestedRect = rectFromAnchor(anchor, handle, width, height);
    const patch = {
        scale: round(scale, 4),
        ...offsetsForCenter(project, center(requestedRect)),
    };
    const actualCenter = centerForOffsets(project, patch);
    return { patch, rect: rectAround(actualCenter, width, height) };
}

export function resizeCropRect(
    start: NormalizedRect,
    handle: CropHandle,
    delta: CanvasPoint,
    preserveAspect = false,
): NormalizedRect {
    if (handle === "move") {
        return cleanRect({
            ...start,
            x: clamp(start.x + delta.x, 0, 1 - start.width),
            y: clamp(start.y + delta.y, 0, 1 - start.height),
        });
    }

    if (preserveAspect && isResizeHandle(handle)) {
        return resizeCropFromCorner(start, handle, delta);
    }

    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (handle.includes("w")) left = clamp(left + delta.x, 0, right - MIN_CROP_SIZE);
    if (handle.includes("e")) right = clamp(right + delta.x, left + MIN_CROP_SIZE, 1);
    if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - MIN_CROP_SIZE);
    if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + MIN_CROP_SIZE, 1);
    return cleanRect({ x: left, y: top, width: right - left, height: bottom - top });
}

export function composeCrop(outer: NormalizedRect, inner: NormalizedRect): NormalizedRect {
    return cleanRect({
        x: outer.x + inner.x * outer.width,
        y: outer.y + inner.y * outer.height,
        width: inner.width * outer.width,
        height: inner.height * outer.height,
    });
}

export function isFullCrop(crop: NormalizedRect): boolean {
    return Math.abs(crop.x) < 1e-6
        && Math.abs(crop.y) < 1e-6
        && Math.abs(crop.width - 1) < 1e-6
        && Math.abs(crop.height - 1) < 1e-6;
}

function resizeScreenFreely(
    project: ManipulableProject,
    handle: ResizeHandle,
    pointer: CanvasPoint,
    anchor: CanvasPoint,
): ScreenManipulationResult {
    const canvas = computeRendererPreviewGeometry(project).canvas;
    const sourceAspect = (project.sourceWidth ?? 1_920) / (project.sourceHeight ?? 1_080);
    const width = clamp(Math.abs(pointer.x - anchor.x), 24, canvas.width * 2);
    const height = clamp(Math.abs(pointer.y - anchor.y), 24, canvas.height * 2);
    const crop = cropToVisualAspect(
        project.crop ?? computeRendererPreviewGeometry(project).crop,
        width / height,
        sourceAspect,
    );
    const baseProject = withPatch(project, { crop, scale: 100 });
    const base = screenRect(baseProject);
    const scale = clamp(100 * width / base.width, MIN_SCALE, MAX_SCALE);
    const positionedProject = withPatch(project, { crop, scale });
    const scaled = screenRect(positionedProject);
    const requestedRect = rectFromAnchor(anchor, handle, scaled.width, scaled.height);
    const patch: ScreenTransformPatch = {
        crop,
        scale: round(scale, 4),
        ...offsetsForCenter(positionedProject, center(requestedRect)),
    };
    return { patch, rect: screenRect(withPatch(project, patch)) };
}

function cropToVisualAspect(
    crop: NormalizedRect,
    visualAspect: number,
    sourceAspect: number,
): NormalizedRect {
    const requestedNormalizedAspect = visualAspect / sourceAspect;
    const currentNormalizedAspect = crop.width / crop.height;
    if (currentNormalizedAspect > requestedNormalizedAspect) {
        const width = crop.height * requestedNormalizedAspect;
        return cleanRect({ ...crop, x: crop.x + (crop.width - width) / 2, width });
    }
    const height = crop.width / requestedNormalizedAspect;
    return cleanRect({ ...crop, y: crop.y + (crop.height - height) / 2, height });
}

function isResizeHandle(handle: CropHandle): handle is ResizeHandle {
    return handle === "nw" || handle === "ne" || handle === "se" || handle === "sw";
}

function resizeCropFromCorner(
    start: NormalizedRect,
    handle: ResizeHandle,
    delta: CanvasPoint,
): NormalizedRect {
    const startRect: CanvasRect = start;
    const anchor = oppositeCorner(startRect, handle);
    const startHandle = corner(startRect, handle);
    const vector = { x: startHandle.x - anchor.x, y: startHandle.y - anchor.y };
    const moved = { x: startHandle.x + delta.x - anchor.x, y: startHandle.y + delta.y - anchor.y };
    const denominator = vector.x * vector.x + vector.y * vector.y;
    const requestedFactor = denominator === 0 ? 1 : (moved.x * vector.x + moved.y * vector.y) / denominator;
    const horizontalLimit = vector.x > 0 ? (1 - anchor.x) / start.width : anchor.x / start.width;
    const verticalLimit = vector.y > 0 ? (1 - anchor.y) / start.height : anchor.y / start.height;
    const factor = clamp(
        requestedFactor,
        Math.max(MIN_CROP_SIZE / start.width, MIN_CROP_SIZE / start.height),
        Math.min(horizontalLimit, verticalLimit),
    );
    return cleanRect(rectFromAnchor(anchor, handle, start.width * factor, start.height * factor));
}

function offsetsForCenter(project: ManipulableProject, requested: CanvasPoint): ScreenTransformPatch {
    const current = center(screenRect(project));
    const slope = offsetSlope(project);
    return {
        offsetX: round(clamp(project.offsetX + (requested.x - current.x) / slope.x, -100, 100), 4),
        offsetY: round(clamp(project.offsetY + (requested.y - current.y) / slope.y, -100, 100), 4),
    };
}

function centerForOffsets(project: ManipulableProject, patch: ScreenTransformPatch): CanvasPoint {
    const current = center(screenRect(project));
    const slope = offsetSlope(project);
    return {
        x: current.x + ((patch.offsetX ?? project.offsetX) - project.offsetX) * slope.x,
        y: current.y + ((patch.offsetY ?? project.offsetY) - project.offsetY) * slope.y,
    };
}

function offsetSlope(project: ManipulableProject): CanvasPoint {
    const lowX = center(screenRect({ ...project, offsetX: -100 })).x;
    const highX = center(screenRect({ ...project, offsetX: 100 })).x;
    const lowY = center(screenRect({ ...project, offsetY: -100 })).y;
    const highY = center(screenRect({ ...project, offsetY: 100 })).y;
    return {
        x: Math.max(1e-6, (highX - lowX) / 200),
        y: Math.max(1e-6, (highY - lowY) / 200),
    };
}

function withPatch(project: ManipulableProject, patch: ScreenTransformPatch): ManipulableProject {
    return {
        ...project,
        ...(patch.scale === undefined ? {} : { scale: patch.scale }),
        ...(patch.offsetX === undefined ? {} : { offsetX: patch.offsetX }),
        ...(patch.offsetY === undefined ? {} : { offsetY: patch.offsetY }),
        ...(patch.crop === undefined ? {} : { crop: patch.crop }),
    };
}

function screenRect(project: ManipulableProject): CanvasRect {
    return computeRendererPreviewGeometry(project).layout.screenRectPx;
}

function corner(rect: CanvasRect, handle: ResizeHandle): CanvasPoint {
    return {
        x: handle.includes("w") ? rect.x : rect.x + rect.width,
        y: handle.includes("n") ? rect.y : rect.y + rect.height,
    };
}

function oppositeCorner(rect: CanvasRect, handle: ResizeHandle): CanvasPoint {
    return {
        x: handle.includes("w") ? rect.x + rect.width : rect.x,
        y: handle.includes("n") ? rect.y + rect.height : rect.y,
    };
}

function rectFromAnchor(
    anchor: CanvasPoint,
    handle: ResizeHandle,
    width: number,
    height: number,
): CanvasRect {
    return {
        x: handle.includes("w") ? anchor.x - width : anchor.x,
        y: handle.includes("n") ? anchor.y - height : anchor.y,
        width,
        height,
    };
}

function rectAround(point: CanvasPoint, width: number, height: number): CanvasRect {
    return { x: point.x - width / 2, y: point.y - height / 2, width, height };
}

function center(rect: CanvasRect): CanvasPoint {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function cleanRect(rect: NormalizedRect): NormalizedRect {
    const x = round(clamp(rect.x, 0, 1 - MIN_CROP_SIZE), 6);
    const y = round(clamp(rect.y, 0, 1 - MIN_CROP_SIZE), 6);
    return {
        x,
        y,
        width: round(clamp(rect.width, MIN_CROP_SIZE, round(1 - x, 6)), 6),
        height: round(clamp(rect.height, MIN_CROP_SIZE, round(1 - y, 6)), 6),
    };
}

function round(value: number, precision: number): number {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
