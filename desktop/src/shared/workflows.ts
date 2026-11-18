export const WORKFLOW_VERSION = 1 as const;
export const SHORTCUT_BINDING_VERSION = 1 as const;
export const WORKFLOW_STORE_SCHEMA_VERSION = 1 as const;

export type WorkflowKind = "screenshot" | "video";
export type CaptureSource = "area" | "window" | "display" | "picker";
export type CursorMode = "hidden" | "visible" | "editable-metadata";
export type VideoFps = 30 | 60;
export type VideoQuality = "balanced" | "high" | "maximum";
export type ClipboardDelivery = "none" | "image" | "file";
export type AfterCaptureAction =
  | "nothing"
  | "open-editor"
  | "open-library"
  | "reveal-file";

export interface WorkflowCaptureOptions {
  readonly source: CaptureSource;
  readonly cursor: CursorMode;
  readonly countdownMs: number;
}

export interface WorkflowVideoOptions {
  readonly fps: VideoFps;
  readonly quality: VideoQuality;
  readonly systemAudio: boolean;
  readonly microphoneDeviceId?: string;
}

export interface WorkflowFinishOptions {
  readonly saveOriginal: true;
  readonly clipboard: ClipboardDelivery;
  readonly afterCapture: AfterCaptureAction;
  readonly editorPresetId?: string;
  readonly exportPresetId?: string;
}

export interface Workflow {
  readonly version: typeof WORKFLOW_VERSION;
  readonly id: string;
  readonly name: string;
  readonly kind: WorkflowKind;
  readonly enabled: boolean;
  readonly capture: WorkflowCaptureOptions;
  readonly video?: WorkflowVideoOptions;
  readonly finish: WorkflowFinishOptions;
}

export type ShortcutAction =
  | { readonly type: "workflow.run"; readonly workflowId: string }
  | { readonly type: "recording.stop" }
  | { readonly type: "recording.pause-toggle" }
  | { readonly type: "recording.restart" }
  | { readonly type: "capture.cancel" }
  | {
      readonly type: "app.open";
      readonly page: "library" | "workflows" | "settings";
    };

export interface ShortcutBinding {
  readonly version: typeof SHORTCUT_BINDING_VERSION;
  readonly id: string;
  readonly accelerator: string;
  readonly enabled: boolean;
  readonly action: ShortcutAction;
}

export interface WorkflowStore {
  readonly schemaVersion: typeof WORKFLOW_STORE_SCHEMA_VERSION;
  readonly workflows: readonly Workflow[];
  readonly shortcutBindings: readonly ShortcutBinding[];
}

export const QUICK_SCREENSHOT_WORKFLOW_ID = "quick-screenshot";
export const QUICK_VIDEO_WORKFLOW_ID = "quick-video";
export const VIDEO_STUDIO_WORKFLOW_ID = "video-studio";

export const DEFAULT_WORKFLOWS: readonly Workflow[] = Object.freeze([
  Object.freeze({
    version: WORKFLOW_VERSION,
    id: QUICK_SCREENSHOT_WORKFLOW_ID,
    name: "Quick Screenshot",
    kind: "screenshot",
    enabled: true,
    capture: Object.freeze({
      source: "area",
      cursor: "hidden",
      countdownMs: 0,
    }),
    finish: Object.freeze({
      saveOriginal: true,
      clipboard: "image",
      afterCapture: "nothing",
    }),
  }),
  Object.freeze({
    version: WORKFLOW_VERSION,
    id: QUICK_VIDEO_WORKFLOW_ID,
    name: "Quick Video",
    kind: "video",
    enabled: true,
    capture: Object.freeze({
      source: "area",
      cursor: "visible",
      countdownMs: 3_000,
    }),
    video: Object.freeze({
      fps: 60,
      quality: "high",
      systemAudio: false,
    }),
    finish: Object.freeze({
      saveOriginal: true,
      clipboard: "file",
      afterCapture: "nothing",
    }),
  }),
  Object.freeze({
    version: WORKFLOW_VERSION,
    id: VIDEO_STUDIO_WORKFLOW_ID,
    name: "Video to Studio",
    kind: "video",
    enabled: true,
    capture: Object.freeze({
      source: "area",
      cursor: "visible",
      countdownMs: 3_000,
    }),
    video: Object.freeze({
      fps: 60,
      quality: "maximum",
      systemAudio: false,
    }),
    finish: Object.freeze({
      saveOriginal: true,
      clipboard: "none",
      afterCapture: "open-editor",
    }),
  }),
]);

export const DEFAULT_SHORTCUT_BINDINGS: readonly ShortcutBinding[] = Object.freeze([
  Object.freeze({
    version: SHORTCUT_BINDING_VERSION,
    id: "shortcut-quick-screenshot",
    accelerator: "Win+Shift+D",
    enabled: true,
    action: Object.freeze({
      type: "workflow.run",
      workflowId: QUICK_SCREENSHOT_WORKFLOW_ID,
    }),
  }),
  Object.freeze({
    version: SHORTCUT_BINDING_VERSION,
    id: "shortcut-quick-video",
    accelerator: "Win+Shift+A",
    enabled: true,
    action: Object.freeze({
      type: "workflow.run",
      workflowId: QUICK_VIDEO_WORKFLOW_ID,
    }),
  }),
  Object.freeze({
    version: SHORTCUT_BINDING_VERSION,
    id: "shortcut-video-studio",
    accelerator: "Win+Shift+E",
    enabled: true,
    action: Object.freeze({
      type: "workflow.run",
      workflowId: VIDEO_STUDIO_WORKFLOW_ID,
    }),
  }),
]);

const MODIFIER_ORDER = ["Win", "Ctrl", "Alt", "Shift"] as const;
const MODIFIER_ALIASES: Readonly<Record<string, (typeof MODIFIER_ORDER)[number]>> =
  Object.freeze({
    win: "Win",
    windows: "Win",
    super: "Win",
    meta: "Win",
    ctrl: "Ctrl",
    control: "Ctrl",
    commandorcontrol: "Ctrl",
    cmdorctrl: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
  });

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  ins: "Insert",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  printscreen: "PrintScreen",
  prtsc: "PrintScreen",
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  backslash: "Backslash",
  semicolon: "Semicolon",
  quote: "Quote",
  minus: "Minus",
  plus: "Plus",
  equal: "Equal",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
});

const RESERVED_ACCELERATORS = new Set(["Win+L", "Ctrl+Alt+Delete"]);

export interface AcceleratorValidation {
  readonly valid: boolean;
  readonly normalized?: string;
  readonly errors: readonly string[];
}

function canonicalKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias !== undefined) {
    return alias;
  }

  if (/^[a-z]$/i.test(token)) {
    return token.toUpperCase();
  }

  if (/^[0-9]$/.test(token)) {
    return token;
  }

  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (functionKey !== null) {
    return `F${functionKey[1]}`;
  }

  return undefined;
}

export function validateAccelerator(input: string): AcceleratorValidation {
  const errors: string[] = [];
  const tokens = input
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { valid: false, errors: ["Enter a keyboard shortcut."] };
  }

  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  let key: string | undefined;

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) {
        errors.push(`Modifier ${modifier} appears more than once.`);
      }
      modifiers.add(modifier);
      continue;
    }

    const candidateKey = canonicalKey(token);
    if (candidateKey === undefined) {
      errors.push(`Unknown key \"${token}\".`);
      continue;
    }

    if (key !== undefined) {
      errors.push("A shortcut must contain exactly one non-modifier key.");
      continue;
    }
    key = candidateKey;
  }

  if (key === undefined) {
    errors.push("Choose a non-modifier key.");
  }
  if (modifiers.size === 0) {
    errors.push("Global shortcuts require at least one modifier.");
  }

  if (errors.length > 0 || key === undefined) {
    return { valid: false, errors };
  }

  const normalized = [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");

  if (RESERVED_ACCELERATORS.has(normalized)) {
    return {
      valid: false,
      errors: [`${normalized} is reserved by Windows.`],
    };
  }

  return { valid: true, normalized, errors: [] };
}

export function normalizeAccelerator(input: string): string {
  const result = validateAccelerator(input);
  if (!result.valid || result.normalized === undefined) {
    throw new TypeError(result.errors.join(" "));
  }
  return result.normalized;
}

export interface ShortcutCollision {
  readonly accelerator: string;
  readonly bindingIds: readonly string[];
}

export function findInternalShortcutCollisions(
  bindings: readonly ShortcutBinding[],
): readonly ShortcutCollision[] {
  const byAccelerator = new Map<string, string[]>();

  for (const binding of bindings) {
    if (!binding.enabled) {
      continue;
    }
    const validation = validateAccelerator(binding.accelerator);
    if (!validation.valid || validation.normalized === undefined) {
      continue;
    }
    const ids = byAccelerator.get(validation.normalized) ?? [];
    ids.push(binding.id);
    byAccelerator.set(validation.normalized, ids);
  }

  return [...byAccelerator.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accelerator, ids]) => ({
      accelerator,
      bindingIds: [...ids].sort(),
    }));
}

const SOURCE_LABELS: Readonly<Record<CaptureSource, string>> = Object.freeze({
  area: "Area",
  window: "Window",
  display: "Display",
  picker: "Picker",
});

export function summarizeWorkflow(workflow: Workflow): string {
  const parts = [
    `${SOURCE_LABELS[workflow.capture.source]} ${workflow.kind}`,
  ];

  if (workflow.kind === "video" && workflow.video !== undefined) {
    parts.push(`${workflow.video.fps} FPS`);
    if (workflow.video.systemAudio) {
      parts.push("system audio");
    }
    if (workflow.video.microphoneDeviceId !== undefined) {
      parts.push("microphone");
    }
  }

  const deliveries = ["Save"];
  if (workflow.finish.clipboard === "image") {
    deliveries.push("copy image");
  } else if (workflow.finish.clipboard === "file") {
    deliveries.push("copy file");
  }

  if (workflow.finish.afterCapture === "open-editor") {
    deliveries.push("open Studio");
  } else if (workflow.finish.afterCapture === "open-library") {
    deliveries.push("open Library");
  } else if (workflow.finish.afterCapture === "reveal-file") {
    deliveries.push("reveal file");
  }

  parts.push(deliveries.join(" + "));
  return parts.join(" · ");
}

function cloneAction(action: ShortcutAction): ShortcutAction {
  return action.type === "workflow.run"
    ? { type: action.type, workflowId: action.workflowId }
    : action.type === "app.open"
      ? { type: action.type, page: action.page }
      : { type: action.type };
}

function cloneWorkflow(workflow: Workflow): Workflow {
  return {
    ...workflow,
    capture: { ...workflow.capture },
    video: workflow.video === undefined ? undefined : { ...workflow.video },
    finish: { ...workflow.finish },
  };
}

function cloneBinding(binding: ShortcutBinding): ShortcutBinding {
  return {
    ...binding,
    action: cloneAction(binding.action),
  };
}

export function createDefaultWorkflowStore(): WorkflowStore {
  return {
    schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    workflows: DEFAULT_WORKFLOWS.map(cloneWorkflow),
    shortcutBindings: DEFAULT_SHORTCUT_BINDINGS.map(cloneBinding),
  };
}

export interface WorkflowPatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly capture?: Partial<WorkflowCaptureOptions>;
  readonly video?: Partial<WorkflowVideoOptions>;
  readonly finish?: Partial<WorkflowFinishOptions>;
}

export function updateWorkflow(
  store: WorkflowStore,
  workflowId: string,
  patch: WorkflowPatch,
): WorkflowStore {
  const index = store.workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) {
    throw new RangeError(`Unknown workflow \"${workflowId}\".`);
  }

  const current = store.workflows[index];
  if (current === undefined) {
    throw new RangeError(`Unknown workflow \"${workflowId}\".`);
  }
  const next: Workflow = {
    ...current,
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    capture: { ...current.capture, ...patch.capture },
    video:
      current.video === undefined
        ? undefined
        : { ...current.video, ...patch.video },
    finish: { ...current.finish, ...patch.finish },
  };

  assertValidWorkflow(next, `workflows[${index}]`);
  return {
    ...store,
    workflows: store.workflows.map((workflow, workflowIndex) =>
      workflowIndex === index ? next : workflow,
    ),
  };
}

export function upsertWorkflow(
  store: WorkflowStore,
  workflow: Workflow,
): WorkflowStore {
  assertValidWorkflow(workflow, "workflow");
  const next = cloneWorkflow(workflow);
  const exists = store.workflows.some((item) => item.id === workflow.id);
  return {
    ...store,
    workflows: exists
      ? store.workflows.map((item) => (item.id === workflow.id ? next : item))
      : [...store.workflows, next],
  };
}

export function removeWorkflow(
  store: WorkflowStore,
  workflowId: string,
): WorkflowStore {
  return {
    ...store,
    workflows: store.workflows.filter((workflow) => workflow.id !== workflowId),
    shortcutBindings: store.shortcutBindings.filter(
      (binding) =>
        binding.action.type !== "workflow.run" ||
        binding.action.workflowId !== workflowId,
    ),
  };
}

export function upsertShortcutBinding(
  store: WorkflowStore,
  binding: ShortcutBinding,
): WorkflowStore {
  const normalized = normalizeAccelerator(binding.accelerator);
  const next = cloneBinding({ ...binding, accelerator: normalized });
  assertValidBinding(next, "shortcutBinding");

  const referencedWorkflowId =
    next.action.type === "workflow.run" ? next.action.workflowId : undefined;
  if (
    referencedWorkflowId !== undefined &&
    !store.workflows.some((workflow) => workflow.id === referencedWorkflowId)
  ) {
    throw new RangeError(`Unknown workflow \"${referencedWorkflowId}\".`);
  }

  const exists = store.shortcutBindings.some((item) => item.id === next.id);
  const shortcutBindings = exists
    ? store.shortcutBindings.map((item) => (item.id === next.id ? next : item))
    : [...store.shortcutBindings, next];

  const collisions = findInternalShortcutCollisions(shortcutBindings);
  const collision = collisions[0];
  if (collision !== undefined) {
    throw new RangeError(
      `Shortcut ${collision.accelerator} is assigned more than once.`,
    );
  }

  return { ...store, shortcutBindings };
}

export function removeShortcutBinding(
  store: WorkflowStore,
  bindingId: string,
): WorkflowStore {
  return {
    ...store,
    shortcutBindings: store.shortcutBindings.filter(
      (binding) => binding.id !== bindingId,
    ),
  };
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type WorkflowStoreValidation =
  | { readonly ok: true; readonly value: WorkflowStore }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export class WorkflowValidationError extends TypeError {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return undefined;
  }
  return value.trim();
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): boolean | undefined {
  const value = record[key];
  if (typeof value !== "boolean") {
    issues.push({ path: `${path}.${key}`, message: "must be a boolean" });
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
  issues: ValidationIssue[],
): T | undefined {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    issues.push({
      path: `${path}.${key}`,
      message: `must be one of ${values.join(", ")}`,
    });
    return undefined;
  }
  return value as T;
}

function parseWorkflow(value: unknown, path: string): WorkflowStoreValidation {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "must be an object" }] };
  }

  const id = readString(value, "id", path, issues);
  const name = readString(value, "name", path, issues);
  const kind = readEnum(value, "kind", ["screenshot", "video"], path, issues);
  const enabled = readBoolean(value, "enabled", path, issues);

  if (value.version !== WORKFLOW_VERSION) {
    issues.push({ path: `${path}.version`, message: "must equal 1" });
  }

  let capture: WorkflowCaptureOptions | undefined;
  if (!isRecord(value.capture)) {
    issues.push({ path: `${path}.capture`, message: "must be an object" });
  } else {
    const source = readEnum(
      value.capture,
      "source",
      ["area", "window", "display", "picker"],
      `${path}.capture`,
      issues,
    );
    const cursor = readEnum(
      value.capture,
      "cursor",
      ["hidden", "visible", "editable-metadata"],
      `${path}.capture`,
      issues,
    );
    const countdownMs = value.capture.countdownMs;
    if (
      typeof countdownMs !== "number" ||
      !Number.isInteger(countdownMs) ||
      countdownMs < 0 ||
      countdownMs > 10_000
    ) {
      issues.push({
        path: `${path}.capture.countdownMs`,
        message: "must be an integer from 0 to 10000",
      });
    }
    if (source !== undefined && cursor !== undefined && typeof countdownMs === "number") {
      capture = { source, cursor, countdownMs };
    }
  }

  let video: WorkflowVideoOptions | undefined;
  if (kind === "video") {
    if (!isRecord(value.video)) {
      issues.push({ path: `${path}.video`, message: "is required for video workflows" });
    } else {
      const fps = value.video.fps;
      if (fps !== 30 && fps !== 60) {
        issues.push({ path: `${path}.video.fps`, message: "must be 30 or 60" });
      }
      const quality = readEnum(
        value.video,
        "quality",
        ["balanced", "high", "maximum"],
        `${path}.video`,
        issues,
      );
      const systemAudio = readBoolean(
        value.video,
        "systemAudio",
        `${path}.video`,
        issues,
      );
      const microphoneDeviceId = value.video.microphoneDeviceId;
      if (
        microphoneDeviceId !== undefined &&
        (typeof microphoneDeviceId !== "string" || microphoneDeviceId.length === 0)
      ) {
        issues.push({
          path: `${path}.video.microphoneDeviceId`,
          message: "must be a non-empty string when provided",
        });
      }
      if (
        (fps === 30 || fps === 60) &&
        quality !== undefined &&
        systemAudio !== undefined
      ) {
        video = {
          fps,
          quality,
          systemAudio,
          ...(typeof microphoneDeviceId === "string"
            ? { microphoneDeviceId }
            : {}),
        };
      }
    }
  } else if (kind === "screenshot" && value.video !== undefined) {
    issues.push({
      path: `${path}.video`,
      message: "is not allowed for screenshot workflows",
    });
  }

  let finish: WorkflowFinishOptions | undefined;
  if (!isRecord(value.finish)) {
    issues.push({ path: `${path}.finish`, message: "must be an object" });
  } else {
    if (value.finish.saveOriginal !== true) {
      issues.push({ path: `${path}.finish.saveOriginal`, message: "must be true" });
    }
    const clipboard = readEnum(
      value.finish,
      "clipboard",
      ["none", "image", "file"],
      `${path}.finish`,
      issues,
    );
    const afterCapture = readEnum(
      value.finish,
      "afterCapture",
      ["nothing", "open-editor", "open-library", "reveal-file"],
      `${path}.finish`,
      issues,
    );
    if (kind === "video" && clipboard === "image") {
      issues.push({
        path: `${path}.finish.clipboard`,
        message: "video workflows cannot copy an image",
      });
    }
    const editorPresetId = value.finish.editorPresetId;
    const exportPresetId = value.finish.exportPresetId;
    for (const [key, candidate] of [
      ["editorPresetId", editorPresetId],
      ["exportPresetId", exportPresetId],
    ] as const) {
      if (candidate !== undefined && (typeof candidate !== "string" || candidate.length === 0)) {
        issues.push({
          path: `${path}.finish.${key}`,
          message: "must be a non-empty string when provided",
        });
      }
    }
    if (clipboard !== undefined && afterCapture !== undefined) {
      finish = {
        saveOriginal: true,
        clipboard,
        afterCapture,
        ...(typeof editorPresetId === "string" ? { editorPresetId } : {}),
        ...(typeof exportPresetId === "string" ? { exportPresetId } : {}),
      };
    }
  }

  if (name !== undefined && name.length > 80) {
    issues.push({ path: `${path}.name`, message: "must be 80 characters or fewer" });
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    name === undefined ||
    kind === undefined ||
    enabled === undefined ||
    capture === undefined ||
    finish === undefined
  ) {
    return { ok: false, issues };
  }

  const workflow: Workflow = {
    version: WORKFLOW_VERSION,
    id,
    name,
    kind,
    enabled,
    capture,
    ...(video === undefined ? {} : { video }),
    finish,
  };
  return {
    ok: true,
    value: {
      schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      workflows: [workflow],
      shortcutBindings: [],
    },
  };
}

function parseAction(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ShortcutAction | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    issues.push({ path, message: "must be a shortcut action" });
    return undefined;
  }

  if (value.type === "workflow.run") {
    const workflowId = readString(value, "workflowId", path, issues);
    return workflowId === undefined ? undefined : { type: value.type, workflowId };
  }
  if (
    value.type === "recording.stop" ||
    value.type === "recording.pause-toggle" ||
    value.type === "recording.restart" ||
    value.type === "capture.cancel"
  ) {
    return { type: value.type };
  }
  if (value.type === "app.open") {
    const page = readEnum(
      value,
      "page",
      ["library", "workflows", "settings"],
      path,
      issues,
    );
    return page === undefined ? undefined : { type: value.type, page };
  }

  issues.push({ path: `${path}.type`, message: "is not supported" });
  return undefined;
}

function parseBinding(value: unknown, path: string): WorkflowStoreValidation {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "must be an object" }] };
  }
  if (value.version !== SHORTCUT_BINDING_VERSION) {
    issues.push({ path: `${path}.version`, message: "must equal 1" });
  }
  const id = readString(value, "id", path, issues);
  const accelerator = readString(value, "accelerator", path, issues);
  const enabled = readBoolean(value, "enabled", path, issues);
  const action = parseAction(value.action, `${path}.action`, issues);
  let normalized: string | undefined;
  if (accelerator !== undefined) {
    const result = validateAccelerator(accelerator);
    if (!result.valid || result.normalized === undefined) {
      issues.push({
        path: `${path}.accelerator`,
        message: result.errors.join(" "),
      });
    } else {
      normalized = result.normalized;
    }
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    normalized === undefined ||
    enabled === undefined ||
    action === undefined
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      workflows: [],
      shortcutBindings: [
        {
          version: SHORTCUT_BINDING_VERSION,
          id,
          accelerator: normalized,
          enabled,
          action,
        },
      ],
    },
  };
}

function assertValidWorkflow(workflow: Workflow, path: string): void {
  const result = parseWorkflow(workflow, path);
  if (!result.ok) {
    throw new WorkflowValidationError(result.issues);
  }
}

function assertValidBinding(binding: ShortcutBinding, path: string): void {
  const result = parseBinding(binding, path);
  if (!result.ok) {
    throw new WorkflowValidationError(result.issues);
  }
}

function withCurrentItemVersions(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const rawWorkflows = Array.isArray(value.workflows) ? value.workflows : [];
  const rawBindings = Array.isArray(value.shortcutBindings)
    ? value.shortcutBindings
    : Array.isArray(value.bindings)
      ? value.bindings
      : [];

  const workflows = rawWorkflows.map((workflow) =>
    isRecord(workflow)
      ? { ...workflow, version: WORKFLOW_VERSION }
      : workflow,
  );
  const shortcutBindings = rawBindings.map((binding) =>
    isRecord(binding)
      ? { ...binding, version: SHORTCUT_BINDING_VERSION }
      : binding,
  );

  for (const workflow of workflows) {
    if (!isRecord(workflow) || typeof workflow.shortcut !== "string") {
      continue;
    }
    const workflowId = typeof workflow.id === "string" ? workflow.id : "unknown";
    shortcutBindings.push({
      version: SHORTCUT_BINDING_VERSION,
      id: `shortcut-${workflowId}`,
      accelerator: workflow.shortcut,
      enabled: workflow.enabled !== false,
      action: { type: "workflow.run", workflowId },
    });
    delete workflow.shortcut;
  }

  return {
    schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    workflows,
    shortcutBindings,
  };
}

export function validatePersistedWorkflowStore(input: unknown): WorkflowStoreValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "must be an object" }],
    };
  }
  if (input.schemaVersion !== WORKFLOW_STORE_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          path: "$.schemaVersion",
          message: `must equal ${WORKFLOW_STORE_SCHEMA_VERSION}`,
        },
      ],
    };
  }
  if (!Array.isArray(input.workflows) || !Array.isArray(input.shortcutBindings)) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: "workflows and shortcutBindings must be arrays",
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const workflows: Workflow[] = [];
  const shortcutBindings: ShortcutBinding[] = [];
  const workflowIds = new Set<string>();
  const bindingIds = new Set<string>();

  input.workflows.forEach((value, index) => {
    const result = parseWorkflow(value, `$.workflows[${index}]`);
    if (!result.ok) {
      issues.push(...result.issues);
      return;
    }
    const workflow = result.value.workflows[0];
    if (workflow === undefined) {
      issues.push({ path: `$.workflows[${index}]`, message: "could not be parsed" });
      return;
    }
    if (workflowIds.has(workflow.id)) {
      issues.push({
        path: `$.workflows[${index}].id`,
        message: "must be unique",
      });
      return;
    }
    workflowIds.add(workflow.id);
    workflows.push(workflow);
  });

  input.shortcutBindings.forEach((value, index) => {
    const result = parseBinding(value, `$.shortcutBindings[${index}]`);
    if (!result.ok) {
      issues.push(...result.issues);
      return;
    }
    const binding = result.value.shortcutBindings[0];
    if (binding === undefined) {
      issues.push({
        path: `$.shortcutBindings[${index}]`,
        message: "could not be parsed",
      });
      return;
    }
    if (bindingIds.has(binding.id)) {
      issues.push({
        path: `$.shortcutBindings[${index}].id`,
        message: "must be unique",
      });
      return;
    }
    bindingIds.add(binding.id);
    shortcutBindings.push(binding);
  });

  for (const [index, binding] of shortcutBindings.entries()) {
    if (
      binding.action.type === "workflow.run" &&
      !workflowIds.has(binding.action.workflowId)
    ) {
      issues.push({
        path: `$.shortcutBindings[${index}].action.workflowId`,
        message: "must reference an existing workflow",
      });
    }
  }

  for (const collision of findInternalShortcutCollisions(shortcutBindings)) {
    issues.push({
      path: "$.shortcutBindings",
      message: `${collision.accelerator} is assigned to ${collision.bindingIds.join(", ")}`,
    });
  }

  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
          workflows,
          shortcutBindings,
        },
      };
}

export function migratePersistedWorkflowStore(input: unknown): WorkflowStore {
  if (input === undefined || input === null) {
    return createDefaultWorkflowStore();
  }

  if (!isRecord(input)) {
    throw new WorkflowValidationError([{ path: "$", message: "must be an object" }]);
  }

  const schemaVersion = input.schemaVersion ?? 0;
  if (schemaVersion !== 0 && schemaVersion !== WORKFLOW_STORE_SCHEMA_VERSION) {
    throw new WorkflowValidationError([
      {
        path: "$.schemaVersion",
        message: `unsupported schema version ${String(schemaVersion)}`,
      },
    ]);
  }

  const candidate =
    schemaVersion === 0 ? withCurrentItemVersions(input) : input;
  const result = validatePersistedWorkflowStore(candidate);
  if (!result.ok) {
    throw new WorkflowValidationError(result.issues);
  }
  return result.value;
}
