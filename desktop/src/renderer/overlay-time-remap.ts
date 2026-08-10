import {
  canonicalizeOverlayDocument,
  type OverlayDocument,
  type TimedCaptionCue,
  type VisualOverlay,
} from "../shared/overlays";
import {
  deriveTimedFragmentId,
  mapOutputTimedRange,
  outputTimelineTransformForClips,
  type OutputTimelineTransform,
} from "./output-timeline-transform";
import type { EditorClip } from "./types";

/** Keeps output-timed captions and visual overlays attached to retained clip content. */
export function remapOverlayDocumentForClips(
  document: OverlayDocument,
  before: readonly EditorClip[],
  after: readonly EditorClip[],
): OverlayDocument {
  return remapOverlayDocument(document, outputTimelineTransformForClips(before, after));
}

/** Applies an explicit output timeline transform without losing split/reordered fragments. */
export function remapOverlayDocument(
  document: OverlayDocument,
  transform: OutputTimelineTransform,
): OverlayDocument {
  const occupiedIds = new Set([
    ...document.captions.map((cue) => cue.id),
    ...document.overlays.map((overlay) => overlay.id),
  ]);
  const remap = <T extends TimedCaptionCue | VisualOverlay>(item: T): T[] =>
    mapOutputTimedRange(item, transform).map((fragment, index) => {
      const id = index === 0 ? item.id : deriveTimedFragmentId(item.id, index + 1, occupiedIds);
      occupiedIds.add(id);
      return { ...item, id, startUs: fragment.startUs, endUs: fragment.endUs };
    });

  return canonicalizeOverlayDocument({
    ...document,
    captions: document.captions.flatMap(remap),
    overlays: document.overlays.flatMap(remap),
  });
}
