import {
  resolveCaptionStyle,
  validateCaptionCue,
  type CaptionStyle,
  type TimedCaptionCue,
} from "./overlays.js";

const CENTISECOND_US = 10_000;

export interface CaptionAssRequest {
  captions: readonly TimedCaptionCue[];
  canvas: { width: number; height: number };
}

/** Builds a deterministic UTF-8 ASS document for libass/FFmpeg burn-in. */
export function generateCaptionAss(request: CaptionAssRequest): string {
  const { width, height } = request.canvas;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("ASS canvas dimensions must be positive integers.");
  }

  const captions = request.captions.map((cue, index) => {
    validateCaptionCue(cue, `captions.${index}`);
    return cue;
  }).sort((left, right) =>
    left.startUs - right.startUs ||
    left.endUs - right.endUs ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const styles = captions.map((cue, index) =>
    assStyle(`Cue${String(index + 1).padStart(4, "0")}`, resolveCaptionStyle(cue.style), width, height),
  );
  const events = captions.map((cue, index) =>
    assEvent(cue, `Cue${String(index + 1).padStart(4, "0")}`, width, height),
  );

  return [
    "[Script Info]",
    "Title: SharpShot Studio captions",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Escapes untrusted caption content without allowing ASS override injection. */
export function escapeAssText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r\n|\r|\n/gu, "\\N");
}

function assStyle(name: string, style: CaptionStyle, width: number, height: number): string {
  const fontSize = style.fontSizeRatio * height;
  const hasBox = alpha(style.backgroundColor) > 0;
  const boxPadding = style.backgroundPaddingEm * fontSize;
  const maximumWidth = Math.max(1, Math.round(style.maxWidth * width));
  const horizontalMargin = Math.max(0, Math.round((width - maximumWidth) / 2));
  return [
    `Style: ${name}`,
    safeFontFamily(style.fontFamily),
    decimal(fontSize),
    assColor(style.color),
    assColor(style.color),
    assColor(hasBox ? style.backgroundColor : style.outlineColor),
    assColor(style.shadowColor),
    style.fontWeight >= 700 ? "-1" : "0",
    "0",
    "0",
    "0",
    "100",
    "100",
    decimal(style.letterSpacingEm * fontSize),
    "0",
    hasBox ? "3" : "1",
    decimal(hasBox ? boxPadding : style.outlineWidthPx),
    decimal(Math.max(Math.abs(style.shadowOffset.xPx), Math.abs(style.shadowOffset.yPx))),
    String(assAlignment(style.align)),
    String(horizontalMargin),
    String(horizontalMargin),
    "0",
    "1",
  ].join(",");
}

function assEvent(
  cue: TimedCaptionCue,
  styleName: string,
  width: number,
  height: number,
): string {
  const style = resolveCaptionStyle(cue.style);
  // ASS stores centiseconds. Expanding outward preserves the full authored cue
  // without ever dropping a sub-centisecond cue at either boundary.
  const startCentiseconds = Math.floor(cue.startUs / CENTISECOND_US);
  const endCentiseconds = Math.max(
    startCentiseconds + 1,
    Math.ceil(cue.endUs / CENTISECOND_US),
  );
  const x = Math.round(style.position.x * width);
  const y = Math.round(style.position.y * height);
  const text = style.uppercase ? cue.text.toUpperCase() : cue.text;
  const tags = [
    `{\\an${assAlignment(style.align)}`,
    `\\pos(${x},${y})`,
    `\\b${style.fontWeight}`,
    `\\fsp${decimal(style.letterSpacingEm * style.fontSizeRatio * height)}`,
    `\\xshad${decimal(style.shadowOffset.xPx)}`,
    `\\yshad${decimal(style.shadowOffset.yPx)}}`,
  ].join("");
  return [
    "Dialogue: 0",
    assTimestamp(startCentiseconds),
    assTimestamp(endCentiseconds),
    styleName,
    "",
    "0",
    "0",
    "0",
    "",
    `${tags}${escapeAssText(text)}`,
  ].join(",");
}

function assTimestamp(totalCentiseconds: number): string {
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor(totalCentiseconds / 6_000) % 60;
  const seconds = Math.floor(totalCentiseconds / 100) % 60;
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function assAlignment(align: CaptionStyle["align"]): 4 | 5 | 6 {
  if (align === "left") return 4;
  if (align === "right") return 6;
  return 5;
}

function safeFontFamily(value: string): string {
  const firstFamily = value.split(",", 1)[0]!.replace(/[\r\n]/gu, " ").trim();
  return firstFamily || "Arial";
}

/** ASS uses inverted alpha followed by BGR channels. */
function assColor(value: string): string {
  const hex = value.slice(1);
  const red = hex.slice(0, 2);
  const green = hex.slice(2, 4);
  const blue = hex.slice(4, 6);
  const opacity = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
  const assAlpha = (255 - opacity).toString(16).padStart(2, "0");
  return `&H${assAlpha}${blue}${green}${red}`.toUpperCase();
}

function alpha(value: string): number {
  return value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) : 255;
}

function decimal(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
