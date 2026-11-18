import { describe, expect, it } from "vitest";
import { escapeAssText, generateCaptionAss } from "../src/shared/caption-ass.js";
import type { TimedCaptionCue } from "../src/shared/overlays.js";

function cue(overrides: Partial<TimedCaptionCue> = {}): TimedCaptionCue {
  return {
    id: "caption-1",
    startUs: 1_230_000,
    endUs: 3_450_000,
    text: "Hello",
    style: { preset: "clean" },
    ...overrides,
  };
}

describe("ASS caption generation", () => {
  it("uses canvas-relative style, position, color, and cue timing", () => {
    const ass = generateCaptionAss({ captions: [cue()], canvas: { width: 1920, height: 1080 } });

    expect(ass).toContain("PlayResX: 1920\nPlayResY: 1080");
    expect(ass).toContain("Style: Cue0001,Segoe UI,56.16,&H00FFFFFF");
    expect(ass).toContain("Dialogue: 0,0:00:01.23,0:00:03.45,Cue0001,,0,0,0,,{\\an5\\pos(960,929)\\b700\\fsp-1.404\\xshad0\\yshad3}Hello");
  });

  it.each([
    ["left", 4, 96],
    ["center", 5, 960],
    ["right", 6, 1_824],
  ] as const)("anchors %s text at its canvas-relative position", (align, anchor, x) => {
    const ass = generateCaptionAss({
      captions: [cue({
        style: { preset: "clean", overrides: { align, position: { x: x / 1_920, y: 0.5 } } },
      })],
      canvas: { width: 1920, height: 1080 },
    });
    expect(ass).toContain(`{\\an${anchor}\\pos(${x},540)`);
  });

  it("sorts cues deterministically and safely escapes user-authored ASS syntax", () => {
    const injected = cue({
      id: "late",
      startUs: 2_000_001,
      endUs: 2_000_002,
      text: "{\\pos(1,1)} nope\r\nnext",
      style: { preset: "bold" },
    });
    const early = cue({ id: "early", startUs: 0, endUs: 10_000, text: "First" });
    const ass = generateCaptionAss({ captions: [injected, early], canvas: { width: 1280, height: 720 } });
    const dialogue = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    expect(dialogue[0]).toContain("First");
    expect(dialogue[1]).toContain("0:00:02.00,0:00:02.01");
    expect(dialogue[1]).toContain("\\{\\\\POS(1,1)\\} NOPE\\NNEXT");
    expect(escapeAssText("a{b}\\N\nc")).toBe("a\\{b\\}\\\\N\\Nc");
  });

  it("rejects invalid cue and canvas values at the pure boundary", () => {
    expect(() => generateCaptionAss({ captions: [cue()], canvas: { width: 0, height: 1080 } }))
      .toThrow(/positive integers/);
    expect(() => generateCaptionAss({
      captions: [cue({ text: "" })],
      canvas: { width: 1920, height: 1080 },
    })).toThrow(/must be a non-empty string/);
  });
});
