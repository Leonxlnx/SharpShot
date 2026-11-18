import { join, parse } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { resolveSharpShotUserDataDirectory } from "../src/main/development-profile.js"

describe("development user-data profile isolation", () => {
  const appDataDirectory = join(tmpdir(), "SharpShot-AppData")

  it("leaves the packaged profile unchanged without an explicit override", () => {
    expect(resolveSharpShotUserDataDirectory({
      isPackaged: true,
      appDataDirectory,
    })).toBeUndefined()
  })

  it("ignores an inherited packaged override without an explicit smoke opt-in", () => {
    const override = join(tmpdir(), "packaged-smoke-profile")
    expect(resolveSharpShotUserDataDirectory({
      isPackaged: true,
      appDataDirectory,
      override,
    })).toBeUndefined()
  })

  it("allows only the dedicated AppData subtree for an explicit packaged smoke test", () => {
    const override = join(appDataDirectory, "sharpshot-studio-packaged-smoke", "run-1")
    expect(resolveSharpShotUserDataDirectory({
      isPackaged: true,
      appDataDirectory,
      override,
      allowPackagedOverride: true,
    })).toBe(override)

    expect(() => resolveSharpShotUserDataDirectory({
      isPackaged: true,
      appDataDirectory,
      override: join(tmpdir(), "outside-packaged-smoke"),
      allowPackagedOverride: true,
    })).toThrow("packaged smoke profile directory")
  })

  it("uses a dedicated default profile for unpackaged development", () => {
    expect(resolveSharpShotUserDataDirectory({
      isPackaged: false,
      appDataDirectory,
    })).toBe(join(appDataDirectory, "sharpshot-studio-development"))
  })

  it("accepts an explicit absolute smoke-test profile", () => {
    const override = join(tmpdir(), "sharpshot-smoke-profile")
    expect(resolveSharpShotUserDataDirectory({
      isPackaged: false,
      appDataDirectory,
      override,
    })).toBe(override)
  })

  it("rejects relative, padded, and filesystem-root overrides", () => {
    const root = parse(appDataDirectory).root
    for (const override of ["relative-profile", ` ${appDataDirectory}`, root]) {
      expect(() => resolveSharpShotUserDataDirectory({
        isPackaged: false,
        appDataDirectory,
        override,
      })).toThrow("SHARPSHOT_USER_DATA_DIR")
    }
  })
})
