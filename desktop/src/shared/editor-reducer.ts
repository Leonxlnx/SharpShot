import {
  type BackgroundStyle,
  type CanvasStyle,
  type ClipId,
  type EditorProject,
  type ExportSettings,
  type MediaAsset,
  type ScreenStyle,
  type SpeedAudioMode,
  type TimeUs,
  type TimelineClip,
  type VideoAsset,
  frameDurationUs,
  validateProject,
} from "./project.js";

export interface ClipSpan {
  clip: TimelineClip;
  index: number;
  timelineInUs: TimeUs;
  timelineOutUs: TimeUs;
}

export type EditorOperation =
  | { type: "asset.add"; asset: MediaAsset }
  | { type: "clip.append"; clip: TimelineClip }
  | {
      type: "clip.trim";
      clipId: ClipId;
      edge: "start" | "end";
      sourceUs: TimeUs;
    }
  | {
      type: "clip.split";
      clipId: ClipId;
      timelineUs: TimeUs;
      rightClipId: ClipId;
    }
  | { type: "clip.delete"; clipId: ClipId }
  | { type: "clip.ripple-delete"; clipId: ClipId }
  | { type: "clip.reorder"; clipId: ClipId; toIndex: number }
  | {
      type: "clip.speed";
      clipId: ClipId;
      speed: number;
      audioMode?: SpeedAudioMode;
    }
  | {
      type: "clip.audio";
      clipId: ClipId;
      mode?: SpeedAudioMode;
      gainDb?: number;
    }
  | { type: "clip.rename"; clipId: ClipId; name: string }
  | { type: "project.rename"; title: string }
  | { type: "canvas.set"; canvas: CanvasStyle }
  | {
      type: "canvas.update";
      changes: Partial<Omit<CanvasStyle, "background" | "screen">>;
    }
  | { type: "background.set"; background: BackgroundStyle }
  | { type: "screen.update"; changes: Partial<ScreenStyle> }
  | { type: "export.set"; settings: ExportSettings };

export class EditorOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorOperationError";
  }
}

export function clipDurationUs(clip: TimelineClip): TimeUs {
  return Math.max(1, Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed));
}

export function buildClipSpans(clips: readonly TimelineClip[]): ClipSpan[] {
  let cursor = 0;
  return clips.map((clip, index) => {
    const span: ClipSpan = {
      clip,
      index,
      timelineInUs: cursor,
      timelineOutUs: cursor + clipDurationUs(clip),
    };
    cursor = span.timelineOutUs;
    return span;
  });
}

export function projectDurationUs(project: Pick<EditorProject, "clips">): TimeUs {
  return project.clips.reduce((duration, clip) => duration + clipDurationUs(clip), 0);
}

export function findClipSpanAt(
  clips: readonly TimelineClip[],
  timelineUs: TimeUs,
): ClipSpan | undefined {
  if (!Number.isSafeInteger(timelineUs) || timelineUs < 0) return undefined;
  const spans = buildClipSpans(clips);
  return spans.find((span, index) => {
    const isFinalEndpoint = index === spans.length - 1 && timelineUs === span.timelineOutUs;
    return (
      (timelineUs >= span.timelineInUs && timelineUs < span.timelineOutUs) ||
      isFinalEndpoint
    );
  });
}

export function timelineToSourceUs(span: ClipSpan, timelineUs: TimeUs): TimeUs {
  const localUs = clamp(timelineUs - span.timelineInUs, 0, clipDurationUs(span.clip));
  return Math.round(span.clip.sourceInUs + localUs * span.clip.speed);
}

export function snapSourceUsToFrame(sourceUs: TimeUs, asset: VideoAsset): TimeUs {
  const { numerator, denominator } = asset.frameRate;
  if (numerator <= 0 || denominator <= 0) {
    const frameUs = frameDurationUs(asset);
    return clamp(Math.round(sourceUs / frameUs) * frameUs, 0, asset.durationUs);
  }
  const frameIndex = Math.round((sourceUs * numerator) / (1_000_000 * denominator));
  const snapped = Math.round((frameIndex * 1_000_000 * denominator) / numerator);
  return clamp(snapped, 0, asset.durationUs);
}

export function reduceEditorProject(
  project: EditorProject,
  operation: EditorOperation,
): EditorProject {
  switch (operation.type) {
    case "asset.add": {
      if (project.assets[operation.asset.id]) {
        throw new EditorOperationError(`Asset ${operation.asset.id} already exists`);
      }
      return finish(project, {
        ...project,
        assets: { ...project.assets, [operation.asset.id]: operation.asset },
      });
    }

    case "clip.append": {
      requireVideoAsset(project, operation.clip.assetId);
      if (project.clips.some((clip) => clip.id === operation.clip.id)) {
        throw new EditorOperationError(`Clip ${operation.clip.id} already exists`);
      }
      return finish(project, { ...project, clips: [...project.clips, operation.clip] });
    }

    case "clip.trim": {
      const { clip, index } = requireClip(project, operation.clipId);
      const asset = requireVideoAsset(project, clip.assetId);
      const minDuration = frameDurationUs(asset);
      const snapped = snapSourceUsToFrame(operation.sourceUs, asset);
      const nextValue =
        operation.edge === "start"
          ? clamp(snapped, 0, clip.sourceOutUs - minDuration)
          : clamp(snapped, clip.sourceInUs + minDuration, asset.durationUs);

      if (
        (operation.edge === "start" && nextValue === clip.sourceInUs) ||
        (operation.edge === "end" && nextValue === clip.sourceOutUs)
      ) {
        return project;
      }

      const nextClip: TimelineClip =
        operation.edge === "start"
          ? { ...clip, sourceInUs: nextValue }
          : { ...clip, sourceOutUs: nextValue };
      return finish(project, replaceClip(project, index, nextClip));
    }

    case "clip.split": {
      const { clip, index } = requireClip(project, operation.clipId);
      if (project.clips.some((item) => item.id === operation.rightClipId)) {
        throw new EditorOperationError(`Clip ${operation.rightClipId} already exists`);
      }

      const span = buildClipSpans(project.clips)[index]!;
      if (operation.timelineUs <= span.timelineInUs || operation.timelineUs >= span.timelineOutUs) {
        throw new EditorOperationError("Split must be strictly inside the clip");
      }

      const asset = requireVideoAsset(project, clip.assetId);
      const minDuration = frameDurationUs(asset);
      const splitSourceUs = snapSourceUsToFrame(
        timelineToSourceUs(span, operation.timelineUs),
        asset,
      );
      if (
        splitSourceUs < clip.sourceInUs + minDuration ||
        splitSourceUs > clip.sourceOutUs - minDuration
      ) {
        throw new EditorOperationError("Split would create a sub-frame clip");
      }

      const left: TimelineClip = { ...clip, sourceOutUs: splitSourceUs };
      const right: TimelineClip = {
        ...clip,
        id: operation.rightClipId,
        sourceInUs: splitSourceUs,
      };
      const clips = [...project.clips];
      clips.splice(index, 1, left, right);
      return finish(project, { ...project, clips });
    }

    case "clip.delete":
    case "clip.ripple-delete": {
      const { index } = requireClip(project, operation.clipId);
      return finish(project, {
        ...project,
        clips: project.clips.filter((_, clipIndex) => clipIndex !== index),
      });
    }

    case "clip.reorder": {
      const { index } = requireClip(project, operation.clipId);
      if (!Number.isInteger(operation.toIndex)) {
        throw new EditorOperationError("Reorder index must be an integer");
      }
      const target = clamp(operation.toIndex, 0, project.clips.length - 1);
      if (target === index) return project;
      const clips = [...project.clips];
      const moved = clips.splice(index, 1)[0]!;
      clips.splice(target, 0, moved);
      return finish(project, { ...project, clips });
    }

    case "clip.speed": {
      if (!Number.isFinite(operation.speed) || operation.speed < 0.25 || operation.speed > 8) {
        throw new EditorOperationError("Clip speed must be between 0.25 and 8");
      }
      const { clip, index } = requireClip(project, operation.clipId);
      const audio = operation.audioMode
        ? { ...clip.audio, mode: operation.audioMode }
        : clip.audio;
      if (clip.speed === operation.speed && audio === clip.audio) return project;
      return finish(
        project,
        replaceClip(project, index, { ...clip, speed: operation.speed, audio }),
      );
    }

    case "clip.audio": {
      const { clip, index } = requireClip(project, operation.clipId);
      const audio = {
        mode: operation.mode ?? clip.audio.mode,
        gainDb: operation.gainDb ?? clip.audio.gainDb,
      };
      if (audio.mode === clip.audio.mode && audio.gainDb === clip.audio.gainDb) return project;
      return finish(project, replaceClip(project, index, { ...clip, audio }));
    }

    case "clip.rename": {
      const name = operation.name.trim();
      if (!name) throw new EditorOperationError("Clip name cannot be empty");
      const { clip, index } = requireClip(project, operation.clipId);
      if (name === clip.name) return project;
      return finish(project, replaceClip(project, index, { ...clip, name }));
    }

    case "project.rename": {
      const title = operation.title.trim();
      if (!title) throw new EditorOperationError("Project title cannot be empty");
      if (title === project.title) return project;
      return finish(project, { ...project, title });
    }

    case "canvas.set":
      return finish(project, { ...project, canvas: operation.canvas });

    case "canvas.update":
      return finish(project, {
        ...project,
        canvas: { ...project.canvas, ...operation.changes },
      });

    case "background.set":
      return finish(project, {
        ...project,
        canvas: { ...project.canvas, background: operation.background },
      });

    case "screen.update":
      return finish(project, {
        ...project,
        canvas: {
          ...project.canvas,
          screen: { ...project.canvas.screen, ...operation.changes },
        },
      });

    case "export.set":
      return finish(project, { ...project, export: operation.settings });

    default:
      return assertNever(operation);
  }
}

export interface EditorHistory {
  past: EditorProject[];
  present: EditorProject;
  future: EditorProject[];
  limit: number;
  /** Base snapshot while a pointer gesture is being coalesced. */
  transactionBase?: EditorProject;
}

export function createEditorHistory(project: EditorProject, limit = 100): EditorHistory {
  validateProject(project);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new EditorOperationError("History limit must be a positive integer");
  }
  return { past: [], present: project, future: [], limit };
}

export function applyEditorOperation(
  history: EditorHistory,
  operation: EditorOperation,
): EditorHistory {
  if (history.transactionBase) {
    throw new EditorOperationError("Commit or cancel the active transaction first");
  }
  const next = reduceEditorProject(history.present, operation);
  if (next === history.present) return history;
  return {
    ...history,
    past: boundedAppend(history.past, history.present, history.limit),
    present: next,
    future: [],
  };
}

export function beginEditorTransaction(history: EditorHistory): EditorHistory {
  if (history.transactionBase) return history;
  return { ...history, transactionBase: history.present };
}

export function applyTransientEditorOperation(
  history: EditorHistory,
  operation: EditorOperation,
): EditorHistory {
  if (!history.transactionBase) {
    throw new EditorOperationError("Begin a transaction before applying transient edits");
  }
  return { ...history, present: reduceEditorProject(history.present, operation) };
}

export function commitEditorTransaction(history: EditorHistory): EditorHistory {
  const base = history.transactionBase;
  if (!base) return history;
  if (projectsEqual(base, history.present)) {
    return { ...history, present: base, transactionBase: undefined };
  }
  return {
    ...history,
    past: boundedAppend(history.past, base, history.limit),
    future: [],
    transactionBase: undefined,
  };
}

export function cancelEditorTransaction(history: EditorHistory): EditorHistory {
  if (!history.transactionBase) return history;
  return {
    ...history,
    present: history.transactionBase,
    transactionBase: undefined,
  };
}

export function undoEditorHistory(history: EditorHistory): EditorHistory {
  const settled = cancelEditorTransaction(history);
  if (settled.past.length === 0) return settled;
  const previous = settled.past[settled.past.length - 1]!;
  return {
    ...settled,
    past: settled.past.slice(0, -1),
    present: previous,
    future: [settled.present, ...settled.future],
  };
}

export function redoEditorHistory(history: EditorHistory): EditorHistory {
  const settled = cancelEditorTransaction(history);
  if (settled.future.length === 0) return settled;
  const next = settled.future[0]!;
  const future = settled.future.slice(1);
  return {
    ...settled,
    past: boundedAppend(settled.past, settled.present, settled.limit),
    present: next,
    future,
  };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0 || history.transactionBase !== undefined;
}

export function canRedo(history: EditorHistory): boolean {
  return history.transactionBase === undefined && history.future.length > 0;
}

function requireClip(project: EditorProject, clipId: ClipId): { clip: TimelineClip; index: number } {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new EditorOperationError(`Unknown clip ${clipId}`);
  return { clip: project.clips[index]!, index };
}

function requireVideoAsset(project: EditorProject, assetId: string): VideoAsset {
  const asset = project.assets[assetId];
  if (!asset || asset.kind !== "video") {
    throw new EditorOperationError(`Unknown video asset ${assetId}`);
  }
  return asset;
}

function replaceClip(
  project: EditorProject,
  index: number,
  replacement: TimelineClip,
): EditorProject {
  const clips = [...project.clips];
  clips[index] = replacement;
  return { ...project, clips };
}

function finish(original: EditorProject, next: EditorProject): EditorProject {
  if (next === original) return original;
  validateProject(next);
  return next;
}

function boundedAppend<T>(items: readonly T[], item: T, limit: number): T[] {
  const next = [...items, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function projectsEqual(left: EditorProject, right: EditorProject): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertNever(value: never): never {
  throw new EditorOperationError(`Unhandled editor operation ${JSON.stringify(value)}`);
}
