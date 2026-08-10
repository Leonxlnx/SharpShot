import { describe, expect, it, vi } from "vitest";
import type { AppRoute, EngineEvent, ExportEvent, MediaItem } from "../shared/api";
import {
    subscribeAppBridgeEvents,
    type AppBridgeEventHandlers,
    type AppEventBridge,
} from "./App";

describe("app bridge subscriptions", () => {
    it("subscribes once while relaying every event to the latest render handlers", () => {
        const listeners: {
            navigate?: (route: AppRoute) => void;
            library?: (items: MediaItem[]) => void;
            engine?: (event: EngineEvent) => void;
            export?: (event: ExportEvent) => void;
        } = {};
        const unsubscribes = Array.from({ length: 4 }, () => vi.fn());
        const bridge: AppEventBridge = {
            onNavigate: vi.fn((listener) => { listeners.navigate = listener; return unsubscribes[0]!; }),
            onLibraryChanged: vi.fn((listener) => { listeners.library = listener; return unsubscribes[1]!; }),
            engine: { onEvent: vi.fn((listener) => { listeners.engine = listener; return unsubscribes[2]!; }) },
            exporter: { onEvent: vi.fn((listener) => { listeners.export = listener; return unsubscribes[3]!; }) },
        };
        const seen: string[] = [];
        let render = 0;
        const handlers: AppBridgeEventHandlers = {
            navigate: () => seen.push(`navigate-${render}`),
            libraryChanged: () => seen.push(`library-${render}`),
            engineChanged: () => seen.push(`engine-${render}`),
            exportChanged: () => seen.push(`export-${render}`),
        };
        const unsubscribe = subscribeAppBridgeEvents(bridge, handlers);

        for (let projectChange = 1; projectChange <= 100; projectChange += 1) render = projectChange;
        listeners.navigate?.("library");
        listeners.library?.([]);
        listeners.engine?.({ type: "operation.cancelled" });
        listeners.export?.({ type: "cancelled", jobId: "job" });

        expect(bridge.onNavigate).toHaveBeenCalledOnce();
        expect(bridge.onLibraryChanged).toHaveBeenCalledOnce();
        expect(bridge.engine.onEvent).toHaveBeenCalledOnce();
        expect(bridge.exporter.onEvent).toHaveBeenCalledOnce();
        expect(seen).toEqual(["navigate-100", "library-100", "engine-100", "export-100"]);

        unsubscribe();
        expect(unsubscribes.every((callback) => callback.mock.calls.length === 1)).toBe(true);
    });
});
