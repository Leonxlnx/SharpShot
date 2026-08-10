import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export type VideoClipboardMode = "file" | "text";

export interface VideoClipboardResult {
  mode: VideoClipboardMode;
  path: string;
  warning?: string;
}

export interface CopyVideoOptions {
  nativeHelperPath?: string;
  resourcesPath?: string;
  developmentRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  writeText?: (value: string) => void | Promise<void>;
  exists?: (candidate: string) => boolean;
}

function resolveNativeHelper(options: CopyVideoOptions): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = options.env ?? process.env;
  const developmentRoot = path.resolve(options.developmentRoot ?? process.cwd());
  const exists =
    options.exists ??
    ((candidate: string): boolean => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const override = options.nativeHelperPath ?? env.SHARPSHOT_NATIVE_HELPER_PATH;
  if (override?.trim()) {
    const candidate = path.isAbsolute(override)
      ? path.normalize(override)
      : path.resolve(developmentRoot, override);
    return exists(candidate) ? candidate : undefined;
  }

  const candidates: string[] = [];
  if (options.resourcesPath) {
    candidates.push(
      path.join(options.resourcesPath, "native", "win32-x64", "SharpShot.Native.exe"),
    );
  }
  candidates.push(
    path.join(developmentRoot, "resources", "native", "win32-x64", "SharpShot.Native.exe"),
  );
  return candidates.find(exists);
}

async function runClipboardHelper(
  helperPath: string,
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // The native command publishes a persistent Windows CF_HDROP data object.
    // argv is used directly so paths never pass through cmd.exe/PowerShell.
    const child = spawn(helperPath, ["--clipboard-file", filePath], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Native clipboard helper timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Native clipboard helper exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function writeTextFallback(
  value: string,
  injected?: (value: string) => void | Promise<void>,
): Promise<void> {
  if (injected) {
    await injected(value);
    return;
  }
  const { clipboard } = await import("electron");
  clipboard.writeText(value);
}

/**
 * Copy a completed video as a pasteable file on Windows. If the native helper
 * is unavailable, copy the absolute path as plain text instead of pretending
 * that Electron's arbitrary clipboard buffers are a file attachment.
 */
export async function copyVideoFileToClipboard(
  filePath: string,
  options: CopyVideoOptions = {},
): Promise<VideoClipboardResult> {
  const absolutePath = path.resolve(filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Clipboard source is not a file.");

  const helperPath = resolveNativeHelper(options);
  if (helperPath) {
    try {
      await runClipboardHelper(helperPath, absolutePath, options.timeoutMs ?? 5_000);
      return { mode: "file", path: absolutePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeTextFallback(absolutePath, options.writeText);
      return {
        mode: "text",
        path: absolutePath,
        warning: `Could not publish the Windows file clipboard format; copied the path instead. ${message}`,
      };
    }
  }

  await writeTextFallback(absolutePath, options.writeText);
  return {
    mode: "text",
    path: absolutePath,
    warning:
      (options.platform ?? process.platform) === "win32"
        ? "Native CF_HDROP helper is unavailable; copied the path as text."
        : "File attachments are not implemented on this platform; copied the path as text.",
  };
}

export const copyVideoToClipboard = copyVideoFileToClipboard;
