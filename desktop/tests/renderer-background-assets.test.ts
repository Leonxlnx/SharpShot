import { describe, expect, it } from "vitest"
import { assertRendererBackgroundAssets } from "../renderer.vite.shared.js"

const thumbnails = [
  "beacon-street-sunset.webp",
  "cobalt-bloom.webp",
  "cobalt-veil.webp",
  "crimson-thread.webp",
  "dusk-fold.webp",
  "glacier-glass.webp",
  "glass-orbit.webp",
  "lake-sherburne.webp",
  "lunar-fold.webp",
  "lunar-paper.webp",
  "midnight-bloom.webp",
  "mineral-current.webp",
  "moss-alloy.webp",
  "moss-circuit.webp",
  "obsidian-tide.webp",
  "ocean-waves.webp",
  "porcelain-wave.webp",
  "quiet-aperture.webp",
  "sandstone-echo.webp",
  "solar-silk.webp",
  "valley-midnight.webp",
  "warm-signal.webp",
]

describe("renderer background asset contract", () => {
  it("accepts all thumbnails without full masters", () => {
    expect(thumbnails).toHaveLength(22)
    expect(() => assertRendererBackgroundAssets(thumbnails.map((file) => ({
      type: "asset",
      originalFileNames: [`C:\\repo\\desktop\\resources\\backgrounds\\thumbnails\\${file}`],
    })))).not.toThrow()
  })

  it("rejects a full master or a missing thumbnail", () => {
    expect(() => assertRendererBackgroundAssets([
      ...thumbnails.map((file) => ({
        type: "asset",
        originalFileNames: [`resources/backgrounds/thumbnails/${file}`],
      })),
      { type: "asset", originalFileNames: ["resources/backgrounds/cobalt-bloom.webp"] },
    ])).toThrow(/full background masters/i)

    expect(() => assertRendererBackgroundAssets(thumbnails.slice(1).map((file) => ({
      type: "asset",
      originalFileNames: [`resources/backgrounds/thumbnails/${file}`],
    })))).toThrow(/omitted background thumbnails/i)
  })
})
