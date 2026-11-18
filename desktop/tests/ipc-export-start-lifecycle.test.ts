import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => Promise<unknown>>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showSaveDialog: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: electronMocks.showSaveDialog,
  },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
  shell: {
    openExternal: vi.fn(),
    openPath: electronMocks.openPath,
    showItemInFolder: vi.fn(),
  },
}));

import { registerIpcHandlers } from "../src/main/ipc.js";
import { IPC_CHANNELS } from "../src/shared/api.js";
import {
  createClipForVideoAsset,
  createDefaultProject,
  type VideoAsset,
} from "../src/shared/project.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.removeHandler.mockReset();
  electronMocks.showSaveDialog.mockReset();
  electronMocks.openPath.mockReset();
  electronMocks.openPath.mockResolvedValue("");
  electronMocks.handle.mockImplementation((channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => {
    electronMocks.handlers.set(channel, handler);
  });
  electronMocks.removeHandler.mockImplementation((channel: string) => {
    electronMocks.handlers.delete(channel);
  });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function projectFixture() {
  const asset: VideoAsset = {
    id: "video",
    kind: "video",
    name: "Source.mp4",
    locator: { kind: "external", absolutePath: "C:\\Media\\Source.mp4" },
    durationUs: 1_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 60, denominator: 1 },
  };
  const project = createDefaultProject({ id: "project", now: "2026-08-09T12:00:00.000Z" });
  project.assets = { [asset.id]: asset };
  project.clips = [createClipForVideoAsset(asset, { id: "clip" })];
  return project;
}

async function fixture() {
  const exportDirectory = await mkdtemp(path.join(tmpdir(), "sharpshot-ipc-export-"));
  temporaryDirectories.push(exportDirectory);
  const engine = new EventEmitter() as EventEmitter & { getStatus: () => unknown };
  engine.getStatus = () => ({ mode: "native", available: true, operationState: "idle", protocolVersion: 1 });
  const storage = {
    flushProjectAutosaves: vi.fn(async () => ({ flushedProjectIds: [] })),
    drainMetadataMutations: vi.fn(async () => undefined),
    loadProject: vi.fn(async () => projectFixture()),
    resolveProjectAssetPath: vi.fn(async () => "C:\\Media\\Source.mp4"),
    getWorkflowStore: vi.fn(() => ({ schemaVersion: 1, workflows: [], shortcutBindings: [] })),
    getOutputDirectory: vi.fn(() => exportDirectory),
    updateSettingsWithLoginItem: vi.fn(async () => ({
      schemaVersion: 1 as const,
      launchAtLogin: false,
      closeToTray: true,
      showNotifications: true,
      theme: "dark" as const,
    })),
    removeMedia: vi.fn(async () => false),
  };
  const mainFrame = {};
  const sender = { mainFrame };
  const windows = {
    window: null,
    broadcast: vi.fn(),
    isTrustedSender: vi.fn(() => true),
  };
  const lifecycle = registerIpcHandlers({
    appVersion: "0.1.0-test",
    storage: storage as never,
    engine: engine as never,
    windows: windows as never,
    resourcesDirectory: "C:\\SharpShot\\resources",
    developmentRoot: "C:\\SharpShot\\desktop",
    exportDirectory,
    allowMediaPathFallback: false,
    updateLoginItem: vi.fn(),
  });
  return {
    lifecycle,
    storage,
    event: { senderFrame: mainFrame, sender },
    exportStart: electronMocks.handlers.get(IPC_CHANNELS.exportStart)!,
    exportStatus: electronMocks.handlers.get(IPC_CHANNELS.exportStatus)!,
    settingsUpdate: electronMocks.handlers.get(IPC_CHANNELS.settingsUpdate)!,
    libraryRemove: electronMocks.handlers.get(IPC_CHANNELS.libraryRemove)!,
    foldersReveal: electronMocks.handlers.get(IPC_CHANNELS.foldersReveal)!,
    exportDirectory,
  };
}

describe("export start IPC lifecycle", () => {
  it("rejects a concurrent start before opening a second dialog or creating a queued snapshot", async () => {
    const saveDialog = deferred<{ canceled: boolean; filePath: string }>();
    electronMocks.showSaveDialog.mockReturnValue(saveDialog.promise);
    const context = await fixture();

    const first = context.exportStart(context.event, { projectId: "project" });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());
    const second = await context.exportStart(context.event, { projectId: "project" });

    expect(second).toEqual({
      ok: false,
      error: { code: "EXPORT_BUSY", message: "Another export is already running." },
    });
    expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(await context.exportStatus(context.event, undefined)).toEqual({ ok: true, value: null });

    saveDialog.resolve({ canceled: true, filePath: "" });
    await expect(first).resolves.toEqual({ ok: true, value: { started: false } });
    expect(await context.exportStatus(context.event, undefined)).toEqual({ ok: true, value: null });
    await context.lifecycle.dispose();
  });

  it("quiesces without waiting on a native dialog and prevents its late result from starting export work", async () => {
    const saveDialog = deferred<{ canceled: boolean; filePath: string }>();
    electronMocks.showSaveDialog.mockReturnValue(saveDialog.promise);
    const context = await fixture();
    const pending = context.exportStart(context.event, { projectId: "project" });
    await vi.waitFor(() => expect(electronMocks.showSaveDialog).toHaveBeenCalledOnce());

    await expect(context.lifecycle.quiesce()).resolves.toBeUndefined();
    saveDialog.resolve({
      canceled: false,
      filePath: path.join(temporaryDirectories[0]!, "Late.mp4"),
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "EXPORT_CANCELLED", message: "Export was cancelled." },
    });
    expect(context.storage.resolveProjectAssetPath).not.toHaveBeenCalled();
    await context.lifecycle.dispose();
  });
});

describe("durable metadata IPC lifecycle", () => {
  it.each([
    ["settings", "settingsUpdate", "updateSettingsWithLoginItem", { theme: "dark" }],
    ["library", "libraryRemove", "removeMedia", "media-1"],
  ] as const)("waits for an in-flight %s mutation and the shared storage queue", async (
    _label,
    handlerName,
    operationName,
    value,
  ) => {
    const operation = deferred<unknown>();
    const drain = deferred<undefined>();
    const context = await fixture();
    context.storage[operationName].mockReturnValueOnce(operation.promise as never);
    context.storage.drainMetadataMutations.mockReturnValueOnce(drain.promise);

    const mutation = context[handlerName](context.event, value);
    await vi.waitFor(() => expect(context.storage[operationName]).toHaveBeenCalledOnce());
    let quiesced = false;
    const shutdown = context.lifecycle.quiesce().then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    operation.resolve(operationName === "removeMedia" ? false : {
      schemaVersion: 1,
      launchAtLogin: false,
      closeToTray: true,
      showNotifications: true,
      theme: "dark",
    });
    await vi.waitFor(() => expect(context.storage.drainMetadataMutations).toHaveBeenCalledOnce());
    expect(quiesced).toBe(false);

    drain.resolve(undefined);
    await shutdown;
    await mutation;
    expect(quiesced).toBe(true);
  });

  it("rejects a durable mutation delivered after quiesce began", async () => {
    const context = await fixture();
    await context.lifecycle.quiesce();

    await expect(context.settingsUpdate(context.event, { theme: "dark" })).resolves.toEqual({
      ok: false,
      error: { code: "APP_SHUTTING_DOWN", message: "SharpShot is shutting down." },
    });
    expect(context.storage.updateSettingsWithLoginItem).not.toHaveBeenCalled();
  });
});

describe("output folder IPC", () => {
  it("maps a fixed identifier in main and rejects path-like renderer input", async () => {
    const context = await fixture();

    await expect(context.foldersReveal(context.event, "screenshots")).resolves.toEqual({ ok: true, value: true });
    expect(context.storage.getOutputDirectory).toHaveBeenCalledWith("screenshots");
    expect(electronMocks.openPath).toHaveBeenCalledWith(context.exportDirectory);

    await expect(context.foldersReveal(context.event, "../screenshots")).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "output folder has an unsupported value." },
    });
    expect(electronMocks.openPath).toHaveBeenCalledTimes(1);
    await context.lifecycle.dispose();
  });
});
