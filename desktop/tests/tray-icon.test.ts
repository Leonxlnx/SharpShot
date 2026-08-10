import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadBundledTrayIcon } from "../src/main/tray-icon.js"

describe("Windows tray icon", () => {
  it("loads the packaged ICO instead of relying on Windows SVG support", () => {
    const image = { isEmpty: () => false }
    const loadImage = vi.fn(() => image)

    expect(loadBundledTrayIcon("C:\\SharpShot\\resources", loadImage)).toBe(image)
    expect(loadImage).toHaveBeenCalledWith(
      join("C:\\SharpShot\\resources", "icons", "sharpshot-studio.ico"),
    )
  })

  it("fails clearly instead of creating an invisible silent-start tray", () => {
    expect(() => loadBundledTrayIcon("C:\\SharpShot\\resources", () => ({
      isEmpty: () => true,
    }))).toThrow("bundled Windows tray icon could not be loaded")
  })
})
