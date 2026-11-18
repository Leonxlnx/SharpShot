import { join } from "node:path"

export function loadBundledTrayIcon<T extends { isEmpty(): boolean }>(
  resourcesDirectory: string,
  loadImage: (path: string) => T,
): T {
  const icon = loadImage(join(resourcesDirectory, "icons", "sharpshot-studio.ico"))
  if (icon.isEmpty()) {
    throw new Error("SharpShot's bundled Windows tray icon could not be loaded.")
  }
  return icon
}
