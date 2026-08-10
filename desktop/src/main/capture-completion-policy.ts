import type {
  AfterCaptureAction,
  ClipboardDelivery,
  Workflow,
  WorkflowKind,
} from "../shared/workflows.js"

export type CaptureCompletionPolicy = {
  workflowKind: WorkflowKind
  clipboard: ClipboardDelivery
  afterCapture: AfterCaptureAction
}

export function shouldMuxQuickVideoAudio(policy: CaptureCompletionPolicy): boolean {
  return policy.workflowKind === "video" &&
    policy.clipboard === "file" &&
    policy.afterCapture !== "open-editor"
}

export function recordingCursorPolicyForWorkflow(workflow: Workflow): {
  includeInVideo: boolean
  captureMetadata: boolean
} {
  // Persisted legacy "editable-metadata" values are normalized to visible,
  // but treating every non-hidden value as visible keeps a stale value from
  // ever producing a cursorless recording.
  const includeInVideo = workflow.capture.cursor !== "hidden"
  return {
    includeInVideo,
    captureMetadata: includeInVideo && workflow.finish.afterCapture === "open-editor",
  }
}
