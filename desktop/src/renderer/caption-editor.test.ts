import { describe, expect, it, vi } from "vitest";
import { createEmptyOverlayDocument, type TimedCaptionCue } from "../shared/overlays";
import {
  assertCaptionCueCapacity,
  assertSubtitleFileSize,
  MAX_PROJECT_CAPTION_CUES,
  MAX_SUBTITLE_FILE_BYTES,
  mergeImportedCaptions,
  runSubtitleImportTask,
  subtitleImportTaskIsCurrent,
} from "./caption-editor";
import { editorReducer, INITIAL_EDITOR_STATE } from "./state";
import type { EditorState } from "./types";

const cue: TimedCaptionCue = {
  id: "file-provided-id",
  startUs: 1_000_000,
  endUs: 2_000_000,
  text: "Keep this local",
  style: { preset: "clean", overrides: { color: "#FFEEDDFF" } },
};

describe("caption editor imports", () => {
  it("remaps file ids against captions and visual overlays while preserving the full document", () => {
    const document = createEmptyOverlayDocument();
    document.captions.push({ ...cue, id: "import-0001" });
    document.overlays.push({
      id: "annotation-kept",
      kind: "blur-mask",
      startUs: 0,
      endUs: 3_000_000,
      opacity: 1,
      shape: "rectangle",
      area: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      blurPx: 12,
      featherPx: 4,
    });

    const merged = mergeImportedCaptions(document, [cue], "import");

    expect(merged.captions.map((item) => item.id)).toEqual(["import-0001", "import-0001-2"]);
    expect(merged.captions[1]).toMatchObject({ text: cue.text, style: cue.style });
    expect(merged.overlays).toEqual(document.overlays);
    expect(merged.overlays).not.toBe(document.overlays);
  });

  it("rejects oversized subtitle files before their contents are read", () => {
    expect(() => assertSubtitleFileSize(MAX_SUBTITLE_FILE_BYTES)).not.toThrow();
    expect(() => assertSubtitleFileSize(MAX_SUBTITLE_FILE_BYTES + 1)).toThrow("8 MB or smaller");
  });

  it("bounds the number of cues mounted by an imported subtitle file", () => {
    expect(() => assertCaptionCueCapacity(MAX_PROJECT_CAPTION_CUES - 1, 1)).not.toThrow();
    expect(() => assertCaptionCueCapacity(MAX_PROJECT_CAPTION_CUES, 1)).toThrow("1,000 caption cues");
  });

  it.each([
    ["a slider is cancelled", (context: ImportContext) => {
      context.state = editorReducer(context.state, { type: "BEGIN_CONTINUOUS_EDIT" });
      context.generation += 1;
      context.state = editorReducer(context.state, {
        type: "SET_PADDING",
        value: context.state.project.padding + 1,
      });
      context.state = editorReducer(context.state, { type: "CANCEL_CONTINUOUS_EDIT" });
      expect(context.state.project).toBe(context.taskProject);
    }],
    ["the window close lock starts", (context: ImportContext) => { context.mutationsLocked = true; }],
    ["the project is edited", (context: ImportContext) => {
      context.state = editorReducer(context.state, {
        type: "SET_PADDING",
        value: context.state.project.padding + 1,
      });
    }],
  ])("drops a deferred subtitle read when %s", async (_name, invalidate) => {
    const source = deferred<string>();
    const project = structuredClone(INITIAL_EDITOR_STATE.project);
    const context: ImportContext = {
      generation: 1,
      mutationsLocked: false,
      taskProject: project,
      state: { ...INITIAL_EDITOR_STATE, project },
    };
    const taskIdentity = {
      generation: 1,
      project,
      projectId: "project-a",
      mediaId: "media-a",
    };
    const commit = vi.fn(() => true);
    const task = runSubtitleImportTask({
      file: { name: "captions.srt", size: 48, text: () => source.promise },
      preset: "clean",
      idPrefix: "deferred-caption",
      isCurrent: () => subtitleImportTaskIsCurrent(taskIdentity, {
        generation: context.generation,
        state: context.state,
        projectId: "project-a",
        mediaId: "media-a",
        mutationsLocked: context.mutationsLocked,
      }),
      currentDocument: createEmptyOverlayDocument,
      commit,
    });

    invalidate(context);
    source.resolve("1\n00:00:01,000 --> 00:00:02,000\nNever committed\n");

    await expect(task).resolves.toEqual({ status: "stale" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("treats a MutationLock-rejected dispatch as stale instead of import success", async () => {
    const commit = vi.fn(() => false);
    await expect(runSubtitleImportTask({
      file: {
        name: "captions.vtt",
        size: 48,
        text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNot acknowledged\n",
      },
      preset: "clean",
      idPrefix: "locked-caption",
      isCurrent: () => true,
      currentDocument: createEmptyOverlayDocument,
      commit,
    })).resolves.toEqual({ status: "stale" });
    expect(commit).toHaveBeenCalledOnce();
  });
});

interface ImportContext {
  generation: number;
  mutationsLocked: boolean;
  taskProject: EditorState["project"];
  state: EditorState;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
