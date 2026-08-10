import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import type { Plugin, UserConfig } from "vite"

const BACKGROUND_THUMBNAILS = [
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
] as const

type RendererBundleItem = {
  type: string
  originalFileNames?: string[]
}

export function assertRendererBackgroundAssets(outputs: readonly RendererBundleItem[]): void {
  const thumbnails = new Set<string>()
  const masters: string[] = []
  for (const output of outputs) {
    if (output.type !== "asset") continue
    for (const original of output.originalFileNames ?? []) {
      const normalized = original.replaceAll("\\", "/")
      const marker = "resources/backgrounds/"
      const markerIndex = normalized.lastIndexOf(marker)
      if (markerIndex < 0) continue
      const relative = normalized.slice(markerIndex + marker.length)
      if (relative.startsWith("thumbnails/")) thumbnails.add(relative.slice("thumbnails/".length))
      else masters.push(relative)
    }
  }
  if (masters.length > 0) throw new Error(`Renderer bundled full background masters: ${masters.join(", ")}`)
  const missing = BACKGROUND_THUMBNAILS.filter((file) => !thumbnails.has(file))
  if (missing.length > 0) throw new Error(`Renderer omitted background thumbnails: ${missing.join(", ")}`)
}

const rendererBackgroundAssetContractPlugin: Plugin = {
  name: "sharpshot-renderer-background-assets",
  generateBundle(_options, bundle) {
    assertRendererBackgroundAssets(Object.values(bundle))
  },
}

function rendererEntryPathPlugin(): Plugin {
  return {
    name: "sharpshot-renderer-entry-path",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace('/src/renderer/main.tsx', '/main.tsx')
      },
    },
  }
}

/**
 * The renderer configuration shared by Electron and browser-only visual QA.
 * Keep Electron APIs out of this module so the standalone Vite command cannot
 * initialize an Electron main process as a side effect of loading its config.
 */
export function createRendererViteConfig(): UserConfig {
  return {
    root: resolve("src/renderer"),
    plugins: [rendererEntryPathPlugin(), react(), rendererBackgroundAssetContractPlugin],
    server: {
      fs: {
        allow: [resolve(".")],
      },
    },
    build: {
      assetsInlineLimit(filePath) {
        return filePath.replaceAll("\\", "/").includes("/resources/backgrounds/thumbnails/")
          ? false
          : undefined
      },
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
      },
    },
  }
}
