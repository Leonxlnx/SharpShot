import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHORTCUT_BINDINGS,
  DEFAULT_WORKFLOWS,
  QUICK_SCREENSHOT_WORKFLOW_ID,
  QUICK_VIDEO_WORKFLOW_ID,
  SHORTCUT_BINDING_VERSION,
  VIDEO_STUDIO_WORKFLOW_ID,
  WORKFLOW_VERSION,
  WorkflowValidationError,
  createDefaultWorkflowStore,
  findInternalShortcutCollisions,
  migratePersistedWorkflowStore,
  normalizeAccelerator,
  removeWorkflow,
  summarizeWorkflow,
  updateWorkflow,
  upsertShortcutBinding,
  validateAccelerator,
  validatePersistedWorkflowStore,
  type ShortcutBinding,
} from "../src/shared/workflows.js";

describe("workflow defaults", () => {
  it("ships quick screenshot, quick video and Studio video recipes", () => {
    expect(DEFAULT_WORKFLOWS.map((workflow) => workflow.id)).toEqual([
      QUICK_SCREENSHOT_WORKFLOW_ID,
      QUICK_VIDEO_WORKFLOW_ID,
      VIDEO_STUDIO_WORKFLOW_ID,
    ]);
    expect(DEFAULT_SHORTCUT_BINDINGS.map((binding) => binding.accelerator)).toEqual([
      "Win+Shift+D",
      "Win+Shift+A",
      "Win+Shift+E",
    ]);

    const quickVideo = DEFAULT_WORKFLOWS.find(
      (workflow) => workflow.id === QUICK_VIDEO_WORKFLOW_ID,
    );
    const studioVideo = DEFAULT_WORKFLOWS.find(
      (workflow) => workflow.id === VIDEO_STUDIO_WORKFLOW_ID,
    );
    expect(quickVideo?.finish).toMatchObject({
      saveOriginal: true,
      clipboard: "file",
      afterCapture: "nothing",
    });
    expect(studioVideo?.finish).toMatchObject({
      saveOriginal: true,
      clipboard: "none",
      afterCapture: "open-editor",
    });
  });

  it("returns fresh mutable-safe copies of the defaults", () => {
    const first = createDefaultWorkflowStore();
    const second = createDefaultWorkflowStore();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.workflows).not.toBe(second.workflows);
    expect(first.workflows[0]).not.toBe(second.workflows[0]);
  });

  it("builds concise human-readable summaries", () => {
    const store = createDefaultWorkflowStore();
    expect(summarizeWorkflow(store.workflows[0]!)).toBe(
      "Area screenshot · Save + copy image",
    );
    expect(summarizeWorkflow(store.workflows[1]!)).toBe(
      "Area video · 60 FPS · Save + copy file",
    );
    expect(summarizeWorkflow(store.workflows[2]!)).toBe(
      "Area video · 60 FPS · Save + open Studio",
    );
  });
});

describe("accelerators", () => {
  it("normalizes aliases, casing and modifier order", () => {
    expect(normalizeAccelerator(" shift + windows + d ")).toBe("Win+Shift+D");
    expect(normalizeAccelerator("ALT+control+f12")).toBe("Ctrl+Alt+F12");
    expect(normalizeAccelerator("super+arrowleft")).toBe("Win+Left");
  });

  it("reports malformed and reserved shortcuts without throwing", () => {
    expect(validateAccelerator("D")).toMatchObject({ valid: false });
    expect(validateAccelerator("Win+Shift")).toMatchObject({ valid: false });
    expect(validateAccelerator("Ctrl+Alt+Delete")).toEqual({
      valid: false,
      errors: ["Ctrl+Alt+Delete is reserved by Windows."],
    });
    expect(() => normalizeAccelerator("Win+wat")).toThrow(TypeError);
  });

  it("detects normalized collisions but ignores disabled bindings", () => {
    const bindings: ShortcutBinding[] = [
      {
        version: SHORTCUT_BINDING_VERSION,
        id: "one",
        accelerator: "Win+Shift+D",
        enabled: true,
        action: { type: "recording.stop" },
      },
      {
        version: SHORTCUT_BINDING_VERSION,
        id: "two",
        accelerator: "shift+super+d",
        enabled: true,
        action: { type: "capture.cancel" },
      },
      {
        version: SHORTCUT_BINDING_VERSION,
        id: "disabled",
        accelerator: "Win+Shift+D",
        enabled: false,
        action: { type: "recording.restart" },
      },
    ];

    expect(findInternalShortcutCollisions(bindings)).toEqual([
      { accelerator: "Win+Shift+D", bindingIds: ["one", "two"] },
    ]);
  });
});

describe("immutable updates", () => {
  it("updates nested workflow settings without mutating prior state", () => {
    const before = createDefaultWorkflowStore();
    const original = before.workflows[1]!;
    const after = updateWorkflow(before, QUICK_VIDEO_WORKFLOW_ID, {
      name: "Silent quick clip",
      capture: { countdownMs: 0 },
      video: { fps: 30 },
    });

    expect(after).not.toBe(before);
    expect(after.workflows[1]).not.toBe(original);
    expect(after.workflows[1]).toMatchObject({
      name: "Silent quick clip",
      capture: { countdownMs: 0 },
      video: { fps: 30 },
    });
    expect(original.name).toBe("Quick Video");
    expect(original.capture.countdownMs).toBe(3_000);
    expect(original.video?.fps).toBe(60);
    expect(after.workflows[0]).toBe(before.workflows[0]);
  });

  it("removes a workflow and only its referring shortcut bindings", () => {
    const before = createDefaultWorkflowStore();
    const after = removeWorkflow(before, QUICK_VIDEO_WORKFLOW_ID);
    expect(after.workflows.some((item) => item.id === QUICK_VIDEO_WORKFLOW_ID)).toBe(
      false,
    );
    expect(
      after.shortcutBindings.some(
        (item) =>
          item.action.type === "workflow.run" &&
          item.action.workflowId === QUICK_VIDEO_WORKFLOW_ID,
      ),
    ).toBe(false);
    expect(before.workflows).toHaveLength(3);
    expect(before.shortcutBindings).toHaveLength(3);
  });

  it("normalizes added bindings and prevents internal conflicts", () => {
    const before = createDefaultWorkflowStore();
    const added = upsertShortcutBinding(before, {
      version: SHORTCUT_BINDING_VERSION,
      id: "pause",
      accelerator: "alt + ctrl + p",
      enabled: true,
      action: { type: "recording.pause-toggle" },
    });
    expect(added.shortcutBindings.at(-1)?.accelerator).toBe("Ctrl+Alt+P");
    expect(before.shortcutBindings).toHaveLength(3);

    expect(() =>
      upsertShortcutBinding(before, {
        version: SHORTCUT_BINDING_VERSION,
        id: "duplicate",
        accelerator: "shift+win+d",
        enabled: true,
        action: { type: "capture.cancel" },
      }),
    ).toThrow(/assigned more than once/i);
  });
});

describe("persistence", () => {
  it("validates and canonicalizes a current store", () => {
    const persisted = createDefaultWorkflowStore();
    const result = validatePersistedWorkflowStore({
      ...persisted,
      shortcutBindings: persisted.shortcutBindings.map((binding, index) =>
        index === 0 ? { ...binding, accelerator: "shift+win+d" } : binding,
      ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.shortcutBindings[0]!.accelerator).toBe("Win+Shift+D");
    }
  });

  it("migrates an unversioned store with an embedded shortcut", () => {
    const legacyWorkflow = {
      ...createDefaultWorkflowStore().workflows[0],
      version: undefined,
      shortcut: "shift+win+q",
    };
    const migrated = migratePersistedWorkflowStore({
      workflows: [legacyWorkflow],
    });

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.workflows[0]).toMatchObject({
      version: WORKFLOW_VERSION,
      id: QUICK_SCREENSHOT_WORKFLOW_ID,
    });
    expect(migrated.shortcutBindings).toEqual([
      {
        version: SHORTCUT_BINDING_VERSION,
        id: `shortcut-${QUICK_SCREENSHOT_WORKFLOW_ID}`,
        accelerator: "Win+Shift+Q",
        enabled: true,
        action: {
          type: "workflow.run",
          workflowId: QUICK_SCREENSHOT_WORKFLOW_ID,
        },
      },
    ]);
  });

  it("rejects unsupported versions, dangling actions and collisions", () => {
    expect(() => migratePersistedWorkflowStore({ schemaVersion: 99 })).toThrow(
      WorkflowValidationError,
    );

    const store = createDefaultWorkflowStore();
    const dangling = validatePersistedWorkflowStore({
      ...store,
      shortcutBindings: [
        {
          version: SHORTCUT_BINDING_VERSION,
          id: "dangling",
          accelerator: "Win+Shift+Q",
          enabled: true,
          action: { type: "workflow.run", workflowId: "missing" },
        },
      ],
    });
    expect(dangling.ok).toBe(false);

    const collision = validatePersistedWorkflowStore({
      ...store,
      shortcutBindings: [
        store.shortcutBindings[0],
        {
          ...store.shortcutBindings[1],
          accelerator: "shift+win+d",
        },
      ],
    });
    expect(collision.ok).toBe(false);
  });

  it("uses defaults only when no persisted value exists", () => {
    expect(migratePersistedWorkflowStore(undefined)).toEqual(
      createDefaultWorkflowStore(),
    );
    expect(() => migratePersistedWorkflowStore("corrupt")).toThrow(
      WorkflowValidationError,
    );
  });
});
