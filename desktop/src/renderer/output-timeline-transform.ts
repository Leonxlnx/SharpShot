const MICROSECONDS_PER_SECOND = 1_000_000;
const MAX_IDENTIFIER_LENGTH = 128;

export interface OutputTimelineSlice {
  readonly oldStartUs: number;
  readonly oldEndUs: number;
  readonly newStartUs: number;
  readonly newEndUs: number;
}

export interface OutputTimelineTransform {
  readonly oldDurationUs: number;
  readonly newDurationUs: number;
  readonly slices: readonly OutputTimelineSlice[];
  readonly trailing: "shift-by-duration-delta";
}

/** The subset of one old timed range retained by an output-timeline edit. */
export interface MappedRangeFragment {
  readonly oldStartUs: number;
  readonly oldEndUs: number;
  readonly startUs: number;
  readonly endUs: number;
  readonly retainsOriginalStart: boolean;
  readonly retainsOriginalEnd: boolean;
  /** Fragment order in the new output timeline. */
  readonly index: number;
}

/** Structural subset of EditorClip needed to build a timeline transform. */
export interface OutputTimelineClip {
  readonly id: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly speed: number;
}

interface ClipSpan {
  readonly clip: OutputTimelineClip;
  readonly startUs: number;
  readonly endUs: number;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
}

interface WorkingFragment extends Omit<MappedRangeFragment, "index"> {
  readonly slopeOldUs: number;
  readonly slopeNewUs: number;
}

export function identityOutputTimelineTransform(durationUs: number): OutputTimelineTransform {
  expectTime(durationUs, "durationUs");
  return {
    oldDurationUs: durationUs,
    newDurationUs: durationUs,
    slices: durationUs === 0
      ? []
      : [{ oldStartUs: 0, oldEndUs: durationUs, newStartUs: 0, newEndUs: durationUs }],
    trailing: "shift-by-duration-delta",
  };
}

/**
 * Builds retained-content slices for same-ID clip edits (trim, delete, speed,
 * and reorder). A split changes IDs without changing time, so its reducer must
 * use identityOutputTimelineTransform instead.
 */
export function outputTimelineTransformForClips(
  oldClips: readonly OutputTimelineClip[],
  newClips: readonly OutputTimelineClip[],
): OutputTimelineTransform {
  const oldSpans = clipSpans(oldClips, "oldClips");
  const newSpans = clipSpans(newClips, "newClips");
  const newById = new Map(newSpans.map((span) => [span.clip.id, span]));
  const slices: OutputTimelineSlice[] = [];

  for (const oldSpan of oldSpans) {
    const newSpan = newById.get(oldSpan.clip.id);
    if (newSpan === undefined) continue;
    const sourceStart = Math.max(oldSpan.clip.sourceStart, newSpan.clip.sourceStart);
    const sourceEnd = Math.min(oldSpan.clip.sourceEnd, newSpan.clip.sourceEnd);
    if (sourceEnd <= sourceStart) continue;
    const slice = {
      oldStartUs: sourceTimeToOutputTime(sourceStart, oldSpan),
      oldEndUs: sourceTimeToOutputTime(sourceEnd, oldSpan),
      newStartUs: sourceTimeToOutputTime(sourceStart, newSpan),
      newEndUs: sourceTimeToOutputTime(sourceEnd, newSpan),
    };
    if (slice.oldEndUs <= slice.oldStartUs || slice.newEndUs <= slice.newStartUs) {
      throw new RangeError(`clip ${JSON.stringify(oldSpan.clip.id)} has retained content shorter than one microsecond`);
    }
    slices.push(slice);
  }

  const transform: OutputTimelineTransform = {
    oldDurationUs: Math.round(oldSpans.at(-1)?.endUs ?? 0),
    newDurationUs: Math.round(newSpans.at(-1)?.endUs ?? 0),
    slices,
    trailing: "shift-by-duration-delta",
  };
  validateOutputTimelineTransform(transform);
  return transform;
}

export function validateOutputTimelineTransform(transform: OutputTimelineTransform): void {
  expectTime(transform.oldDurationUs, "transform.oldDurationUs");
  expectTime(transform.newDurationUs, "transform.newDurationUs");
  if (!Array.isArray(transform.slices)) throw new TypeError("transform.slices must be an array");
  if (transform.trailing !== "shift-by-duration-delta") {
    throw new RangeError('transform.trailing must be "shift-by-duration-delta"');
  }

  transform.slices.forEach((slice, index) => {
    const path = `transform.slices.${index}`;
    expectTime(slice.oldStartUs, `${path}.oldStartUs`);
    expectTime(slice.oldEndUs, `${path}.oldEndUs`);
    expectTime(slice.newStartUs, `${path}.newStartUs`);
    expectTime(slice.newEndUs, `${path}.newEndUs`);
    if (slice.oldEndUs <= slice.oldStartUs) throw new RangeError(`${path} old range must have positive duration`);
    if (slice.newEndUs <= slice.newStartUs) throw new RangeError(`${path} new range must have positive duration`);
    if (slice.oldEndUs > transform.oldDurationUs) throw new RangeError(`${path}.oldEndUs exceeds oldDurationUs`);
    if (slice.newEndUs > transform.newDurationUs) throw new RangeError(`${path}.newEndUs exceeds newDurationUs`);
  });

  expectNoOverlap(transform.slices, "oldStartUs", "oldEndUs", "old");
  expectNoOverlap(transform.slices, "newStartUs", "newEndUs", "new");
}

export function isIdentityOutputTimelineTransform(transform: OutputTimelineTransform): boolean {
  validateOutputTimelineTransform(transform);
  if (transform.oldDurationUs !== transform.newDurationUs) return false;
  let cursorUs = 0;
  const slices = [...transform.slices].sort((left, right) => left.oldStartUs - right.oldStartUs);
  for (const slice of slices) {
    if (
      slice.oldStartUs !== cursorUs ||
      slice.newStartUs !== cursorUs ||
      slice.oldEndUs !== slice.newEndUs
    ) return false;
    cursorUs = slice.oldEndUs;
  }
  return cursorUs === transform.oldDurationUs;
}

/** Maps one half-open timed range and returns every retained fragment in new-time order. */
export function mapOutputTimedRange(
  range: Readonly<{ startUs: number; endUs: number }>,
  transform: OutputTimelineTransform,
): MappedRangeFragment[] {
  expectTime(range.startUs, "range.startUs");
  expectTime(range.endUs, "range.endUs");
  if (range.endUs <= range.startUs) throw new RangeError("range must have positive duration");
  validateOutputTimelineTransform(transform);

  const fragments = transform.slices.flatMap((slice): WorkingFragment[] => {
    const oldStartUs = Math.max(range.startUs, slice.oldStartUs);
    const oldEndUs = Math.min(range.endUs, slice.oldEndUs);
    if (oldEndUs <= oldStartUs) return [];
    const startUs = mapTime(oldStartUs, slice);
    const endUs = mapTime(oldEndUs, slice);
    if (endUs <= startUs) return [];
    return [{
      oldStartUs,
      oldEndUs,
      startUs,
      endUs,
      retainsOriginalStart: oldStartUs === range.startUs,
      retainsOriginalEnd: oldEndUs === range.endUs,
      slopeOldUs: slice.oldEndUs - slice.oldStartUs,
      slopeNewUs: slice.newEndUs - slice.newStartUs,
    }];
  });

  if (range.endUs > transform.oldDurationUs) {
    const oldStartUs = Math.max(range.startUs, transform.oldDurationUs);
    const deltaUs = transform.newDurationUs - transform.oldDurationUs;
    const startUs = oldStartUs + deltaUs;
    const endUs = range.endUs + deltaUs;
    expectTime(startUs, "mapped trailing startUs");
    expectTime(endUs, "mapped trailing endUs");
    if (endUs > startUs) {
      fragments.push({
        oldStartUs,
        oldEndUs: range.endUs,
        startUs,
        endUs,
        retainsOriginalStart: oldStartUs === range.startUs,
        retainsOriginalEnd: true,
        slopeOldUs: 1,
        slopeNewUs: 1,
      });
    }
  }

  const merged: WorkingFragment[] = [];
  for (const fragment of fragments.sort(compareFragments)) {
    const previous = merged.at(-1);
    if (previous !== undefined && canMerge(previous, fragment)) {
      merged[merged.length - 1] = {
        ...previous,
        oldEndUs: fragment.oldEndUs,
        endUs: fragment.endUs,
        retainsOriginalEnd: fragment.retainsOriginalEnd,
      };
    } else {
      merged.push(fragment);
    }
  }

  return merged.map(({ slopeOldUs: _old, slopeNewUs: _new, ...fragment }, index) => ({ ...fragment, index }));
}

/** Returns a deterministic safe ID; callers pass the full track namespace as occupied. */
export function deriveTimedFragmentId(
  baseId: string,
  fragmentIndex: number,
  occupied: ReadonlySet<string> = new Set(),
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(baseId)) {
    throw new RangeError("baseId must be a safe identifier");
  }
  if (!Number.isSafeInteger(fragmentIndex) || fragmentIndex < 1) {
    throw new RangeError("fragmentIndex must be a positive safe integer");
  }
  for (let attempt = 1; ; attempt += 1) {
    const suffix = `.part${fragmentIndex}${attempt === 1 ? "" : `.${attempt}`}`;
    const candidate = `${baseId.slice(0, MAX_IDENTIFIER_LENGTH - suffix.length)}${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function clipSpans(clips: readonly OutputTimelineClip[], path: string): ClipSpan[] {
  const ids = new Set<string>();
  let cursorUs = 0;
  return clips.map((clip, index) => {
    const clipPath = `${path}.${index}`;
    if (typeof clip.id !== "string" || clip.id.length === 0) throw new TypeError(`${clipPath}.id must be non-empty`);
    if (ids.has(clip.id)) throw new RangeError(`${clipPath}.id must be unique`);
    ids.add(clip.id);
    expectFinite(clip.sourceStart, `${clipPath}.sourceStart`);
    expectFinite(clip.sourceEnd, `${clipPath}.sourceEnd`);
    expectFinite(clip.speed, `${clipPath}.speed`);
    if (clip.sourceStart < 0 || clip.sourceEnd <= clip.sourceStart) {
      throw new RangeError(`${clipPath} source range must have positive duration`);
    }
    if (clip.speed <= 0) throw new RangeError(`${clipPath}.speed must be positive`);
    const sourceStartUs = Math.round(clip.sourceStart * MICROSECONDS_PER_SECOND);
    const sourceEndUs = Math.round(clip.sourceEnd * MICROSECONDS_PER_SECOND);
    const durationUs = Math.max(1, Math.round((sourceEndUs - sourceStartUs) / clip.speed));
    const startUs = cursorUs;
    cursorUs += durationUs;
    if (!Number.isSafeInteger(cursorUs)) throw new RangeError(`${clipPath} output end is out of range`);
    return { clip, startUs, endUs: cursorUs, sourceStartUs, sourceEndUs };
  });
}

function sourceTimeToOutputTime(sourceTime: number, span: ClipSpan): number {
  const sourceTimeUs = Math.round(sourceTime * MICROSECONDS_PER_SECOND);
  const result = sourceTimeUs <= span.sourceStartUs
    ? span.startUs
    : sourceTimeUs >= span.sourceEndUs
      ? span.endUs
      : Math.min(span.endUs, span.startUs + Math.round(
          (sourceTimeUs - span.sourceStartUs) / span.clip.speed,
        ));
  expectTime(result, `clip ${JSON.stringify(span.clip.id)} mapped time`);
  return result;
}

function mapTime(timeUs: number, slice: OutputTimelineSlice): number {
  const oldDurationUs = slice.oldEndUs - slice.oldStartUs;
  const newDurationUs = slice.newEndUs - slice.newStartUs;
  const mapped = Math.round(
    slice.newStartUs + (timeUs - slice.oldStartUs) / oldDurationUs * newDurationUs,
  );
  expectTime(mapped, "mapped time");
  return mapped;
}

function compareFragments(left: WorkingFragment, right: WorkingFragment): number {
  return left.startUs - right.startUs || left.endUs - right.endUs || left.oldStartUs - right.oldStartUs;
}

function canMerge(left: WorkingFragment, right: WorkingFragment): boolean {
  return left.oldEndUs === right.oldStartUs
    && left.endUs === right.startUs
    && BigInt(left.slopeNewUs) * BigInt(right.slopeOldUs)
      === BigInt(right.slopeNewUs) * BigInt(left.slopeOldUs);
}

function expectNoOverlap(
  slices: readonly OutputTimelineSlice[],
  start: "oldStartUs" | "newStartUs",
  end: "oldEndUs" | "newEndUs",
  label: string,
): void {
  const sorted = [...slices].sort((left, right) => left[start] - right[start]);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]![start] < sorted[index - 1]![end]) {
      throw new RangeError(`transform ${label} slices must not overlap`);
    }
  }
}

function expectTime(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative safe integer number of microseconds`);
  }
}

function expectFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${path} must be finite`);
}
