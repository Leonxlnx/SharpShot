import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"

const MAX_PROFILE_PATH_LENGTH = 1_024

export function resolveSharpShotUserDataDirectory(options: {
  isPackaged: boolean
  appDataDirectory: string
  override?: string
  allowPackagedOverride?: boolean
}): string | undefined {
  if (options.override === undefined) {
    return options.isPackaged
      ? undefined
      : join(options.appDataDirectory, "sharpshot-studio-development")
  }

  // Environment variables are not a production configuration surface. A
  // packaged smoke run must opt in explicitly and stays inside its dedicated
  // AppData subtree; ordinary packaged launches ignore inherited overrides.
  if (options.isPackaged && options.allowPackagedOverride !== true) return undefined

  const value = options.override
  if (
    value.length === 0 ||
    value.length > MAX_PROFILE_PATH_LENGTH ||
    value.trim() !== value ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new Error("SHARPSHOT_USER_DATA_DIR must be a clean absolute directory path.")
  }
  const normalized = resolve(value)
  if (normalized === parse(normalized).root) {
    throw new Error("SHARPSHOT_USER_DATA_DIR cannot be a filesystem root.")
  }
  if (options.isPackaged) {
    const smokeRoot = resolve(options.appDataDirectory, "sharpshot-studio-packaged-smoke")
    const pathFromRoot = relative(smokeRoot, normalized)
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new Error("SHARPSHOT_USER_DATA_DIR must stay inside the packaged smoke profile directory.")
    }
  }
  return normalized
}
