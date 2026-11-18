import { describe, expect, it } from "vitest";
import { CAPTION_STYLE_PRESETS } from "../shared/overlays";
import { captionPreviewStyle } from "./caption-preview";

describe("caption preview output geometry", () => {
  it("matches ASS horizontal anchors for left, center, and right aligned captions", () => {
    expect(captionPreviewStyle(CAPTION_STYLE_PRESETS.clean, { width: 1_920, height: 1_080 }).transform)
      .toBe("translate(-50%, -50%)");
    expect(captionPreviewStyle(CAPTION_STYLE_PRESETS["lower-third"], { width: 1_920, height: 1_080 }).transform)
      .toBe("translate(0%, -50%)");
    expect(captionPreviewStyle({ ...CAPTION_STYLE_PRESETS.clean, align: "right" }, { width: 1_920, height: 1_080 }).transform)
      .toBe("translate(-100%, -50%)");
  });

  it("scales canonical outline, radius, and shadow pixels against the full canvas", () => {
    const style = captionPreviewStyle(CAPTION_STYLE_PRESETS.boxed, { width: 1_920, height: 1_080 });
    const outlined = captionPreviewStyle(CAPTION_STYLE_PRESETS.clean, { width: 1_920, height: 1_080 });
    expect(style.fontSize).toBe("4.8cqh");
    expect(Number.parseFloat(String(style.borderRadius))).toBeCloseTo(14 * 100 / 1_920, 8);
    expect(String(style.textShadow)).toContain("cqw");
    expect(String(outlined.WebkitTextStroke)).toContain(CAPTION_STYLE_PRESETS.clean.outlineColor);
  });
});
