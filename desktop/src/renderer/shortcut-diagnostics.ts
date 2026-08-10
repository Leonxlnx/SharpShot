import type { BindingRegistration, WorkflowStore } from "../shared/api";

export function shortcutFailureDetails(
    failures: readonly BindingRegistration[] | undefined,
    store: WorkflowStore,
): string[] {
    if (!failures) return [];
    const accelerators = new Map(store.shortcutBindings.map((binding) => [binding.id, binding.accelerator]));
    return failures
        .filter((failure) => !failure.registered && failure.reason?.toLocaleLowerCase("en-US") !== "disabled")
        .map((failure) => `${accelerators.get(failure.bindingId) ?? failure.bindingId}: ${failure.reason ?? "already used by another app"}`);
}
