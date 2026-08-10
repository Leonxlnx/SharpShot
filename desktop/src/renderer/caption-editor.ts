import {
  canonicalizeOverlayDocument,
  importSrt,
  importWebVtt,
  type CaptionStylePresetId,
  type OverlayDocument,
  type TimedCaptionCue,
} from "../shared/overlays";
import type { EditorState } from "./types";

export const MAX_SUBTITLE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_CAPTION_CUES = 1_000;

export type SubtitleImportFile = Pick<File, "name" | "size" | "text">;

export type SubtitleImportTaskResult =
  | { status: "imported"; cueCount: number }
  | { status: "stale" };

export interface SubtitleImportTaskIdentity {
  generation: number;
  project: EditorState["project"];
  projectId: string | null;
  mediaId: string | null;
}

export interface SubtitleImportCurrentIdentity {
  generation: number;
  state: Pick<EditorState, "project" | "continuousEditStart" | "exportOpen">;
  projectId: string | null;
  mediaId: string | null;
  mutationsLocked: boolean;
}

export function assertSubtitleFileSize(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength < 0 || byteLength > MAX_SUBTITLE_FILE_BYTES) {
    throw new Error("Subtitle files must be 8 MB or smaller.");
  }
}

export function assertCaptionCueCapacity(existingCount: number, addedCount: number): void {
  if (!Number.isSafeInteger(existingCount) || !Number.isSafeInteger(addedCount)
      || existingCount < 0 || addedCount < 0 || existingCount + addedCount > MAX_PROJECT_CAPTION_CUES) {
    throw new Error(`A project can contain up to ${MAX_PROJECT_CAPTION_CUES.toLocaleString("en-US")} caption cues.`);
  }
}

export function subtitleImportTaskIsCurrent(
  task: SubtitleImportTaskIdentity,
  current: SubtitleImportCurrentIdentity,
): boolean {
  return task.generation === current.generation
    && task.project === current.state.project
    && task.projectId === current.projectId
    && task.mediaId === current.mediaId
    && current.state.continuousEditStart === null
    && !current.state.exportOpen
    && !current.mutationsLocked;
}

/** Adds parsed subtitle cues without trusting file-provided ids to be project-unique. */
export function mergeImportedCaptions(
  document: OverlayDocument,
  cues: readonly TimedCaptionCue[],
  idPrefix: string,
): OverlayDocument {
  assertCaptionCueCapacity(document.captions.length, cues.length);
  const usedIds = new Set([
    ...document.captions.map((cue) => cue.id),
    ...document.overlays.map((overlay) => overlay.id),
  ]);
  const imported = cues.map((cue, index) => {
    const id = uniqueImportedId(idPrefix, index, usedIds);
    usedIds.add(id);
    return { ...cue, id, style: structuredClone(cue.style) };
  });
  return canonicalizeOverlayDocument({
    ...document,
    captions: [...document.captions, ...imported],
  });
}

/** Reads and commits one subtitle file only while its editor snapshot remains current. */
export async function runSubtitleImportTask({
  file,
  preset,
  idPrefix,
  isCurrent,
  currentDocument,
  commit,
}: {
  file: SubtitleImportFile;
  preset: CaptionStylePresetId;
  idPrefix: string;
  isCurrent: () => boolean;
  currentDocument: () => OverlayDocument;
  commit: (document: OverlayDocument, selectedCaptionId: string | null, playheadSeconds: number | null) => boolean;
}): Promise<SubtitleImportTaskResult> {
  if (!isCurrent()) return { status: "stale" };
  assertSubtitleFileSize(file.size);
  const source = await file.text();
  if (!isCurrent()) return { status: "stale" };

  const style = { preset };
  const cues = file.name.toLowerCase().endsWith(".vtt")
    ? importWebVtt(source, { style })
    : importSrt(source, { style });
  if (cues.length === 0) throw new Error("The subtitle file does not contain any cues.");

  const next = mergeImportedCaptions(currentDocument(), cues, idPrefix);
  if (!isCurrent()) return { status: "stale" };
  const firstAdded = next.captions.find((cue) => cue.id.startsWith(`${idPrefix}-`));
  return commit(next, firstAdded?.id ?? null, firstAdded === undefined ? null : firstAdded.startUs / 1_000_000)
    ? { status: "imported", cueCount: cues.length }
    : { status: "stale" };
}

function uniqueImportedId(prefix: string, index: number, usedIds: ReadonlySet<string>): string {
  const ordinal = `-${String(index + 1).padStart(4, "0")}`;
  const base = `${prefix.slice(0, 128 - ordinal.length)}${ordinal}`;
  if (!usedIds.has(base)) return base;
  let attempt = 2;
  while (true) {
    const collision = `-${attempt}`;
    const candidate = `${base.slice(0, 128 - collision.length)}${collision}`;
    if (!usedIds.has(candidate)) return candidate;
    attempt += 1;
  }
}
