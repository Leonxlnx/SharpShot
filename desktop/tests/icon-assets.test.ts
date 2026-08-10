import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const iconsRoot = join(process.cwd(), "resources", "icons")

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe("Studio icon assets", () => {
  it("keeps the generated raster source and a square transparent master", async () => {
    const source = await readFile(join(iconsRoot, "sharpshot-studio-imagegen-source.png"))
    const master = await readFile(join(iconsRoot, "sharpshot-studio.png"))
    const preview = await readFile(join(iconsRoot, "sharpshot-studio-preview.png"))

    expect(pngSize(source)).toEqual({ width: 1254, height: 1254 })
    expect(pngSize(master)).toEqual({ width: 1024, height: 1024 })
    expect(pngSize(preview)).toEqual({ width: 512, height: 512 })
    expect(master.readUInt8(25) & 4).toBe(4)
  })

  it("ships a real multi-resolution Windows icon", async () => {
    const ico = await readFile(join(iconsRoot, "sharpshot-studio.ico"))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)

    const count = ico.readUInt16LE(4)
    expect(count).toBe(10)
    const sizes = Array.from({ length: count }, (_, index) => {
      const offset = 6 + index * 16
      return ico[offset] === 0 ? 256 : ico[offset]
    })
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256])
  })
})
