import type { CSSProperties } from "react";
import type { CaptionStyle } from "../shared/overlays";

/** Maps canonical output-canvas caption geometry into the responsive artboard. */
export function captionPreviewStyle(
  style: CaptionStyle,
  canvas: { width: number; height: number },
): CSSProperties {
  const canvasUnit = 100 / canvas.width;
  const translateX = style.align === "left" ? 0 : style.align === "right" ? -100 : -50;
  return {
    left: `${style.position.x * 100}%`,
    top: `${style.position.y * 100}%`,
    maxWidth: `${style.maxWidth * 100}%`,
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSizeRatio * 100}cqh`,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: `${style.letterSpacingEm}em`,
    textAlign: style.align,
    textTransform: style.uppercase ? "uppercase" : "none",
    padding: `${style.backgroundPaddingEm}em`,
    borderRadius: `${style.backgroundRadiusPx * canvasUnit}cqw`,
    textShadow: `${style.shadowOffset.xPx * canvasUnit}cqw ${style.shadowOffset.yPx * canvasUnit}cqw ${style.shadowBlurPx * canvasUnit}cqw ${style.shadowColor}`,
    transform: `translate(${translateX}%, -50%)`,
    transformOrigin: `${style.align} center`,
    WebkitTextStroke: style.outlineWidthPx > 0
      ? `${style.outlineWidthPx * canvasUnit}cqw ${style.outlineColor}`
      : undefined,
  };
}
