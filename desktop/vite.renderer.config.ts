import { resolve } from "node:path"
import { defineConfig } from "vite"
import { createRendererViteConfig } from "./renderer.vite.shared.js"

// This entry point is intentionally Vite-only. It provides the renderer's
// development fallback data without starting Electron, preload, or native code.
export default defineConfig(() => {
  const config = createRendererViteConfig()
  return {
    ...config,
    build: {
      ...config.build,
      outDir: resolve("out/renderer-browser"),
      emptyOutDir: true,
    },
  }
})
