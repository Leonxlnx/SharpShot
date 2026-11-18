import { describe, expect, it } from "vitest"
import {
  recordingCursorPolicyForWorkflow,
  shouldMuxQuickVideoAudio,
} from "../src/main/capture-completion-policy.js"
import { createDefaultWorkflowStore } from "../src/shared/workflows.js"

describe("capture completion policy snapshot", () => {
  it("keeps Quick Copy mux behavior from the workflow that started recording", () => {
    const startedPolicy = {
      workflowKind: "video" as const,
      clipboard: "file" as const,
      afterCapture: "nothing" as const,
    }
    const editedWhileRecording = {
      workflowKind: "video" as const,
      clipboard: "none" as const,
      afterCapture: "open-editor" as const,
    }

    expect(shouldMuxQuickVideoAudio(startedPolicy)).toBe(true)
    expect(shouldMuxQuickVideoAudio(editedWhileRecording)).toBe(false)
  })

  it("never retires Studio stems for an open-editor completion", () => {
    expect(shouldMuxQuickVideoAudio({
      workflowKind: "video",
      clipboard: "file",
      afterCapture: "open-editor",
    })).toBe(false)
  })

  it("collects click metadata only for visible-cursor Studio recordings", () => {
    const video = createDefaultWorkflowStore().workflows.find((workflow) => workflow.kind === "video")!
    const studio = { ...video, finish: { ...video.finish, afterCapture: "open-editor" as const } }
    const quick = { ...video, finish: { ...video.finish, afterCapture: "nothing" as const } }
    const hiddenStudio = {
      ...studio,
      capture: { ...studio.capture, cursor: "hidden" as const },
    }
    const legacyStudio = {
      ...studio,
      capture: { ...studio.capture, cursor: "editable-metadata" as const },
    }

    expect(recordingCursorPolicyForWorkflow(studio)).toEqual({
      includeInVideo: true,
      captureMetadata: true,
    })
    expect(recordingCursorPolicyForWorkflow(quick)).toEqual({
      includeInVideo: true,
      captureMetadata: false,
    })
    expect(recordingCursorPolicyForWorkflow(hiddenStudio)).toEqual({
      includeInVideo: false,
      captureMetadata: false,
    })
    expect(recordingCursorPolicyForWorkflow(legacyStudio)).toEqual({
      includeInVideo: true,
      captureMetadata: true,
    })
  })
})
