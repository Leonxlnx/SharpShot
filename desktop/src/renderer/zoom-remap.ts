import { validateZoomSegments, type ZoomSegment } from "../shared/cursor-zoom";
import {
    deriveTimedFragmentId,
    mapOutputTimedRange,
    outputTimelineTransformForClips,
    type MappedRangeFragment,
    type OutputTimelineTransform,
} from "./output-timeline-transform";
import type { EditorClip } from "./types";

/** Keeps zooms attached to retained source content through trim, speed, delete, and reorder edits. */
export function remapZoomSegmentsForClips(
    segments: readonly ZoomSegment[],
    oldClips: readonly EditorClip[],
    newClips: readonly EditorClip[],
): ZoomSegment[] {
    const transform = outputTimelineTransformForClips(oldClips, newClips);
    return remapZoomSegments(segments, transform);
}

/** Applies an already-built output transform so all timed tracks can share one mapping. */
export function remapZoomSegments(
    segments: readonly ZoomSegment[],
    transform: OutputTimelineTransform,
): ZoomSegment[] {
    const occupiedIds = new Set(segments.map((segment) => segment.id));
    const mapped = segments.flatMap((segment) => mapOutputTimedRange(segment, transform).map((fragment, index) => {
        const durationUs = fragment.endUs - fragment.startUs;
        const easeInUs = fragment.retainsOriginalStart
            ? mappedEdgeDuration(segment, fragment, transform, "start")
            : 0;
        const requestedEaseOutUs = fragment.retainsOriginalEnd
            ? mappedEdgeDuration(segment, fragment, transform, "end")
            : 0;
        const easeOutUs = Math.min(requestedEaseOutUs, durationUs - Math.min(easeInUs, durationUs));
        const id = index === 0
            ? segment.id
            : deriveTimedFragmentId(segment.id, index + 1, occupiedIds);
        occupiedIds.add(id);
        return {
            ...segment,
            id,
            startUs: fragment.startUs,
            endUs: fragment.endUs,
            focus: { ...segment.focus },
            easeInUs: Math.min(easeInUs, durationUs),
            easeOutUs,
        };
    }));

    mapped.sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs || left.id.localeCompare(right.id));
    validateZoomSegments(mapped, transform.newDurationUs);
    return mapped;
}

function mappedEdgeDuration(
    segment: ZoomSegment,
    fragment: MappedRangeFragment,
    transform: OutputTimelineTransform,
    edge: "start" | "end",
): number {
    const requestedUs = edge === "start" ? segment.easeInUs : segment.easeOutUs;
    if (requestedUs === 0) return 0;
    const easingRange = edge === "start"
        ? { startUs: segment.startUs, endUs: Math.min(segment.endUs, segment.startUs + requestedUs) }
        : { startUs: Math.max(segment.startUs, segment.endUs - requestedUs), endUs: segment.endUs };
    const mappedEasing = mapOutputTimedRange(easingRange, transform);
    const edgeFragment = edge === "start"
        ? mappedEasing.find((candidate) => candidate.startUs === fragment.startUs)
        : mappedEasing.find((candidate) => candidate.endUs === fragment.endUs);
    if (edgeFragment === undefined) return 0;
    return edge === "start"
        ? edgeFragment.endUs - fragment.startUs
        : fragment.endUs - edgeFragment.startUs;
}
