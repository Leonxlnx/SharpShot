import { describe, expect, it } from "vitest";
import type { WorkflowStore } from "../shared/api";
import { shortcutFailureDetails } from "./shortcut-diagnostics";

describe("startup shortcut diagnostics", () => {
    it("maps failed binding ids to accelerators and excludes Disabled", () => {
        const store: WorkflowStore = {
            schemaVersion: 1,
            workflows: [],
            shortcutBindings: [
                { version: 1, id: "quick", accelerator: "Win+Shift+A", enabled: true, action: { type: "app.open", page: "workflows" } },
                { version: 1, id: "off", accelerator: "Win+Shift+Q", enabled: false, action: { type: "app.open", page: "workflows" } },
            ],
        };
        expect(shortcutFailureDetails([
            { bindingId: "quick", registered: false, reason: "Reserved by Windows" },
            { bindingId: "off", registered: false, reason: "Disabled" },
        ], store)).toEqual(["Win+Shift+A: Reserved by Windows"]);
    });
});
