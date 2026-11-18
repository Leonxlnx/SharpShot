import type { ZoomSegment } from "../shared/cursor-zoom";

export type ZoomEdge = "start" | "end";

export interface ZoomTimelinePlacement {
    leftPercent: number;
    widthPercent: number;
}

export interface ZoomRange {
    startUs: number;
    endUs: number;
    easeInUs: number;
    easeOutUs: number;
}

export function zoomSegmentPlacement(segment: ZoomSegment, durationUs: number): ZoomTimelinePlacement {
    const duration = Math.max(1, durationUs);
    return {
        leftPercent: clamp(segment.startUs / duration * 100, 0, 100),
        widthPercent: clamp((segment.endUs - segment.startUs) / duration * 100, 0, 100),
    };
}

export function availableZoomRangeAtPlayhead(
    segments: readonly ZoomSegment[],
    playheadUs: number,
    durationUs: number,
    requestedDurationUs = 2_000_000,
    minimumDurationUs = 250_000,
): ZoomRange | undefined {
    const startUs = clamp(Math.round(playheadUs), 0, durationUs);
    if (startUs >= durationUs || segments.some((segment) => startUs >= segment.startUs && startUs < segment.endUs)) {
        return undefined;
    }
    const nextStartUs = segments.find((segment) => segment.startUs >= startUs)?.startUs ?? durationUs;
    const endUs = Math.min(durationUs, nextStartUs, startUs + requestedDurationUs);
    if (endUs - startUs < minimumDurationUs) return undefined;
    const easeInUs = Math.min(180_000, Math.floor((endUs - startUs) / 2));
    return {
        startUs,
        endUs,
        easeInUs,
        easeOutUs: Math.min(220_000, endUs - startUs - easeInUs),
    };
}

export function resizeZoomSegmentRange(
    segments: readonly ZoomSegment[],
    id: string,
    edge: ZoomEdge,
    requestedUs: number,
    durationUs: number,
    minimumDurationUs = 100_000,
): ZoomRange | undefined {
    const index = segments.findIndex((segment) => segment.id === id);
    const segment = segments[index];
    if (segment === undefined) return undefined;
    const minimum = Math.min(minimumDurationUs, segment.endUs - segment.startUs);
    const startUs = edge === "start"
        ? clamp(Math.round(requestedUs), segments[index - 1]?.endUs ?? 0, segment.endUs - minimum)
        : segment.startUs;
    const endUs = edge === "end"
        ? clamp(Math.round(requestedUs), segment.startUs + minimum, segments[index + 1]?.startUs ?? durationUs)
        : segment.endUs;
    const segmentDurationUs = endUs - startUs;
    const easeInUs = Math.min(segment.easeInUs, segmentDurationUs);
    return {
        startUs,
        endUs,
        easeInUs,
        easeOutUs: Math.min(segment.easeOutUs, segmentDurationUs - easeInUs),
    };
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
