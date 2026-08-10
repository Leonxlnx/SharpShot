import { describe, expect, it } from "vitest";
import {
  applyEditorOperation,
  applyTransientEditorOperation,
  beginEditorTransaction,
  buildClipSpans,
  cancelEditorTransaction,
  clipDurationUs,
  commitEditorTransaction,
  createEditorHistory,
  findClipSpanAt,
  projectDurationUs,
  redoEditorHistory,
  reduceEditorProject,
  timelineToSourceUs,
  undoEditorHistory,
} from "../src/shared/editor-reducer.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  type EditorProject,
  type VideoAsset,
} from "../src/shared/project.js";

function asset(id: string, durationUs: number): VideoAsset {
  return {
    id,
    kind: "video",
    name: `${id}.mp4`,
    locator: { kind: "managed", relativePath: `media/${id}.mp4` },
    durationUs,
    width: 1280,
    height: 720,
    frameRate: { numerator: 100, denominator: 1 },
    audio: { sampleRate: 48_000, channels: 2 },
  };
}

function projectWithTwoClips(): EditorProject {
  const firstAsset = asset("asset-a", 10_000_000);
  const secondAsset = asset("asset-b", 5_000_000);
  const project = createDefaultProject({ id: "project", now: "2026-08-09T12:00:00.000Z" });
  project.assets = { [firstAsset.id]: firstAsset, [secondAsset.id]: secondAsset };
  project.clips = [
    createClipForVideoAsset(firstAsset, {
      id: "clip-a",
      sourceInUs: 2_000_000,
      sourceOutUs: 8_000_000,
      speed: 2,
    }),
    createClipForVideoAsset(secondAsset, {
      id: "clip-b",
      sourceInUs: 0,
      sourceOutUs: 4_000_000,
      speed: 0.5,
    }),
  ];
  return project;
}

describe("editor timeline reducer", () => {
  it("derives ripple positions and project duration from clip order", () => {
    const project = projectWithTwoClips();
    const spans = buildClipSpans(project.clips);

    expect(clipDurationUs(project.clips[0]!)).toBe(3_000_000);
    expect(clipDurationUs(project.clips[1]!)).toBe(8_000_000);
    expect(spans[1]!.timelineInUs).toBe(3_000_000);
    expect(projectDurationUs(project)).toBe(11_000_000);
  });

  it("uses half-open clip boundaries", () => {
    const project = projectWithTwoClips();

    expect(findClipSpanAt(project.clips, 2_999_999)?.clip.id).toBe("clip-a");
    expect(findClipSpanAt(project.clips, 3_000_000)?.clip.id).toBe("clip-b");
    expect(findClipSpanAt(project.clips, 11_000_000)?.clip.id).toBe("clip-b");
  });

  it("maps timeline time through speed and splits non-destructively", () => {
    const project = projectWithTwoClips();
    const firstSpan = buildClipSpans(project.clips)[0]!;
    expect(timelineToSourceUs(firstSpan, 1_250_000)).toBe(4_500_000);

    const split = reduceEditorProject(project, {
      type: "clip.split",
      clipId: "clip-a",
      timelineUs: 1_250_000,
      rightClipId: "clip-a-right",
    });

    expect(split.clips.map((clip) => clip.id)).toEqual([
      "clip-a",
      "clip-a-right",
      "clip-b",
    ]);
    expect(split.clips[0]!.sourceOutUs).toBe(4_500_000);
    expect(split.clips[1]!.sourceInUs).toBe(4_500_000);
    expect(split.clips[1]!.speed).toBe(2);
    expect(split.clips[1]!.audio).toEqual(split.clips[0]!.audio);
    expect(project.clips).toHaveLength(2);
  });

  it("rejects splits at clip endpoints", () => {
    const project = projectWithTwoClips();

    expect(() =>
      reduceEditorProject(project, {
        type: "clip.split",
        clipId: "clip-a",
        timelineUs: 0,
        rightClipId: "new",
      }),
    ).toThrow(/strictly inside/);
  });

  it("trims to source-frame boundaries and ripples later clips", () => {
    const project = projectWithTwoClips();
    const trimmed = reduceEditorProject(project, {
      type: "clip.trim",
      clipId: "clip-a",
      edge: "start",
      sourceUs: 3_000_001,
    });

    expect(trimmed.clips[0]!.sourceInUs).toBe(3_000_000);
    expect(buildClipSpans(trimmed.clips)[1]!.timelineInUs).toBe(2_500_000);
    expect(project.clips[0]!.sourceInUs).toBe(2_000_000);
  });

  it("reorders and ripple-deletes without copying media", () => {
    const project = projectWithTwoClips();
    const reordered = reduceEditorProject(project, {
      type: "clip.reorder",
      clipId: "clip-b",
      toIndex: 0,
    });
    expect(reordered.clips.map((clip) => clip.id)).toEqual(["clip-b", "clip-a"]);
    expect(reordered.assets).toBe(project.assets);

    const deleted = reduceEditorProject(reordered, {
      type: "clip.ripple-delete",
      clipId: "clip-b",
    });
    expect(deleted.clips.map((clip) => clip.id)).toEqual(["clip-a"]);
    expect(buildClipSpans(deleted.clips)[0]!.timelineInUs).toBe(0);
  });

  it("changes per-clip speed and audio policy", () => {
    const project = projectWithTwoClips();
    const changed = reduceEditorProject(project, {
      type: "clip.speed",
      clipId: "clip-a",
      speed: 4,
      audioMode: "mute",
    });

    expect(changed.clips[0]!.speed).toBe(4);
    expect(changed.clips[0]!.audio.mode).toBe("mute");
    expect(clipDurationUs(changed.clips[0]!)).toBe(1_500_000);
    expect(() =>
      reduceEditorProject(project, {
        type: "clip.speed",
        clipId: "clip-a",
        speed: 9,
      }),
    ).toThrow(/between 0.25 and 8/);
  });

  it("updates backgrounds and screen styling immutably", () => {
    const project = projectWithTwoClips();
    const background = reduceEditorProject(project, {
      type: "background.set",
      background: { kind: "solid", color: "#2255AA" },
    });
    const styled = reduceEditorProject(background, {
      type: "screen.update",
      changes: { padding: 0.12, cornerRadius: 0.08 },
    });

    expect(styled.canvas.background).toEqual({ kind: "solid", color: "#2255AA" });
    expect(styled.canvas.screen.padding).toBe(0.12);
    expect(styled.canvas.screen.cornerRadius).toBe(0.08);
    expect(project.canvas.screen.padding).not.toBe(0.12);
  });
});

describe("editor undo and redo", () => {
  it("round-trips a committed operation", () => {
    const project = projectWithTwoClips();
    const changed = applyEditorOperation(createEditorHistory(project), {
      type: "clip.speed",
      clipId: "clip-a",
      speed: 4,
    });

    const undone = undoEditorHistory(changed);
    expect(undone.present).toEqual(project);
    expect(undone.future).toHaveLength(1);

    const redone = redoEditorHistory(undone);
    expect(redone.present.clips[0]!.speed).toBe(4);
  });

  it("coalesces many trim previews into one history entry", () => {
    const project = projectWithTwoClips();
    let history = beginEditorTransaction(createEditorHistory(project));
    history = applyTransientEditorOperation(history, {
      type: "clip.trim",
      clipId: "clip-a",
      edge: "start",
      sourceUs: 2_500_000,
    });
    history = applyTransientEditorOperation(history, {
      type: "clip.trim",
      clipId: "clip-a",
      edge: "start",
      sourceUs: 3_000_000,
    });
    history = commitEditorTransaction(history);

    expect(history.past).toHaveLength(1);
    expect(history.present.clips[0]!.sourceInUs).toBe(3_000_000);
    expect(undoEditorHistory(history).present.clips[0]!.sourceInUs).toBe(2_000_000);
  });

  it("cancels an active gesture without adding history", () => {
    const project = projectWithTwoClips();
    let history = beginEditorTransaction(createEditorHistory(project));
    history = applyTransientEditorOperation(history, {
      type: "screen.update",
      changes: { padding: 0.2 },
    });
    history = cancelEditorTransaction(history);

    expect(history.present).toBe(project);
    expect(history.past).toEqual([]);
  });

  it("clears redo after a new committed edit", () => {
    const project = projectWithTwoClips();
    let history = applyEditorOperation(createEditorHistory(project), {
      type: "clip.speed",
      clipId: "clip-a",
      speed: 4,
    });
    history = undoEditorHistory(history);
    history = applyEditorOperation(history, {
      type: "clip.rename",
      clipId: "clip-a",
      name: "Intro",
    });

    expect(history.future).toEqual([]);
    expect(history.present.clips[0]!.name).toBe("Intro");
  });
});
