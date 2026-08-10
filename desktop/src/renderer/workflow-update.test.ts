import { describe, expect, it } from "vitest";
import type { WorkflowStore } from "../shared/api";
import { createDefaultWorkflowStore } from "../shared/workflows";
import { failedEnabledBindings, rollbackRejectedWorkflowUpdate } from "./workflow-update";

describe("workflow update outcomes", () => {
    it("reports a rejected enabled shortcut but ignores intentionally disabled bindings", () => {
        const store: WorkflowStore = {
            schemaVersion: 1,
            workflows: [],
            shortcutBindings: [
                { version: 1, id: "reserved", accelerator: "Win+Shift+A", enabled: true, action: { type: "app.open", page: "library" } },
                { version: 1, id: "disabled", accelerator: "Win+Shift+Q", enabled: false, action: { type: "app.open", page: "library" } },
            ],
        };
        const failed = failedEnabledBindings([
            { bindingId: "reserved", registered: false, reason: "Reserved by Windows" },
            { bindingId: "disabled", registered: false, reason: "Disabled" },
        ], store);
        expect(failed.map((binding) => binding.bindingId)).toEqual(["reserved"]);
    });

    it("rolls a rejected shortcut transaction back to the durable workflow store", () => {
        const defaults = createDefaultWorkflowStore();
        const durable: WorkflowStore = {
            ...defaults,
            workflows: defaults.workflows.map((workflow, index) =>
                index === 0 ? { ...workflow, name: "Durable Screenshot" } : workflow,
            ),
        };

        const rollback = rollbackRejectedWorkflowUpdate({
            applied: false,
            store: durable,
            bindings: [{ bindingId: "quick-screenshot-binding", registered: false, reason: "Reserved by Windows" }],
            registrationFailure: {
                code: "SHORTCUT_REGISTRATION_FAILED",
                message: "Win+Shift+D is reserved by Windows.",
                bindingIds: ["quick-screenshot-binding"],
            },
        });

        expect(rollback.workflows[0]?.name).toBe("Durable Screenshot");
        expect(rollback.message).toBe("Win+Shift+D is reserved by Windows.");
        const reconciledDocument = JSON.parse(rollback.document) as WorkflowStore;
        expect(reconciledDocument.workflows[0]?.name).toBe("Durable Screenshot");
        expect(reconciledDocument.shortcutBindings.map((binding) => binding.accelerator))
            .toEqual(durable.shortcutBindings.map((binding) => binding.accelerator));
    });
});
