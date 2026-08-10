import { describe, expect, it } from "vitest"
import { assertRendererBackgroundAssets } from "../renderer.vite.shared.js"

const thumbnails = [
  "beacon-street-sunset.webp",
  "cobalt-bloom.webp",
  "dusk-fold.webp",
  "glacier-glass.webp",
  "lake-sherburne.webp",
  "lunar-paper.webp",
  "midnight-bloom.webp",
  "moss-alloy.webp",
  "obsidian-tide.webp",
  "ocean-waves.webp",
  "solar-silk.webp",
  "valley-midnight.webp",
]

describe("renderer background asset contract", () => {
  it("accepts all thumbnails without full masters", () => {
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
