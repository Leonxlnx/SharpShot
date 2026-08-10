import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import type { OutputChunk } from "rollup"
import type { Plugin } from "vite"
import { resolve } from "node:path"
import { createRendererViteConfig } from "./renderer.vite.shared.js"

// Electron's sandboxed preload runtime supports a limited CommonJS `require`
// surface, not ESM imports. Keep this assertion next to the build configuration
// so a future package/module change cannot silently emit an unusable `.mjs`
// preload again.
const sandboxedPreloadArtifactPlugin: Plugin = {
  name: "sharpshot-sandboxed-preload-artifact",
  generateBundle(_options, bundle) {
    const entries = Object.values(bundle).filter(
      (output): output is OutputChunk => output.type === "chunk" && output.isEntry,
    )
    if (entries.length !== 1 || entries[0]?.fileName !== "index.cjs") {
      this.error("SharpShot's sandboxed preload must emit exactly out/preload/index.cjs.")
    }
    const entry = entries[0]
    if (entry === undefined || !/\brequire\(["']electron["']\)/.test(entry.code)) {
      this.error("The sandboxed preload must load Electron through the supported CommonJS require bridge.")
    }
    if (/\bimport\s*(?:\(|[\s{*])/.test(entry.code)) {
      this.error("The sandboxed preload artifact must not contain ESM imports.")
    }
  },
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), sandboxedPreloadArtifactPlugin],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: createRendererViteConfig(),
})
