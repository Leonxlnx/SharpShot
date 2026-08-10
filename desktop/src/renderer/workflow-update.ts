import type { BindingRegistration, WorkflowStore, WorkflowStoreUpdate } from "../shared/api";
import { rendererWorkflowsToStore } from "./bridge";
import { workflowStoreToRenderer } from "./model-adapter";
import type { Workflow } from "./types";

type RejectedWorkflowStoreUpdate = Extract<WorkflowStoreUpdate, { applied: false }>;

export type WorkflowRollback = {
    store: WorkflowStore;
    workflows: Workflow[];
    document: string;
    message: string;
};

/** Reconciles the renderer with the durable store returned by an atomic registration rejection. */
export function rollbackRejectedWorkflowUpdate(
    update: RejectedWorkflowStoreUpdate,
    options: { quickVideoAudioMux?: boolean } = {},
): WorkflowRollback {
    const workflows = workflowStoreToRenderer(update.store, options);
    return {
        store: update.store,
        workflows,
        document: JSON.stringify(rendererWorkflowsToStore(workflows, update.store, options)),
        message: update.registrationFailure.message,
    };
}

export function failedEnabledBindings(
    bindings: readonly BindingRegistration[],
    candidate: WorkflowStore,
): BindingRegistration[] {
    const enabled = new Set(candidate.shortcutBindings.filter((binding) => binding.enabled).map((binding) => binding.id));
    return bindings.filter((binding) => !binding.registered && enabled.has(binding.bindingId));
}
