import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoomSegment } from "../../shared/cursor-zoom";
import { INITIAL_EDITOR_STATE } from "../state";
import type { EditorState } from "../types";
import {
    EditorInspector,
    zoomMotionPresetChanges,
    zoomMotionPresetFor,
} from "./EditorInspector";
import { addSafeRedaction } from "../safe-redaction";
import { MAX_EXPORTED_SAFE_REDACTIONS } from "../../shared/export-plan";

afterEach(() => vi.unstubAllGlobals());

function renderInspector(state: EditorState): string {
    vi.stubGlobal("window", {});
    const props: ComponentProps<typeof EditorInspector> = {
        state,
        dispatch: vi.fn(() => true),
        onNotify: vi.fn(),
        media: null,
        projectId: null,
        onPrepareAutoZoom: async () => true,
        sourceHasAudio: false,
        audioCatalog: [],
        libraryAudio: [],
        libraryImages: [],
        mutationsLocked: false,
        onLibraryAudioImported: vi.fn(),
        onLibraryImagesImported: vi.fn(),
    };
    return renderToStaticMarkup(createElement(EditorInspector, props));
}

function zoom(overrides: Partial<ZoomSegment> = {}): ZoomSegment {
    return {
        id: "zoom-a",
        startUs: 1_000_000,
        endUs: 3_000_000,
        focus: { x: 0.5, y: 0.5 },
        scale: 2,
        easeInUs: 180_000,
        easeOutUs: 220_000,
        source: "manual",
        ...overrides,
    };
}

describe("EditorInspector direct controls", () => {
    it("offers text-only external wallpaper sources beside the local import flow", () => {
        const state: EditorState = { ...structuredClone(INITIAL_EDITOR_STATE), activeTool: "background" };
        const html = renderInspector(state);
        const sources = html.slice(html.indexOf('class="background-browser__sources"'));

        expect(sources).toContain("512 Pixels");
        expect(sources).toContain("AppleWalls");
        expect(sources).toContain("Basic Apple Guy");
        expect(sources).toContain("Black Pixel Studio");
        expect(sources.match(/External · not bundled/g)).toHaveLength(4);
        expect(sources).toContain("Download from each source, then choose <strong>Import images…</strong> above.");
        expect(sources).not.toContain("<img");
    });

    it("keeps layout framing direct and moves clip timing into a closed disclosure", () => {
        const state: EditorState = { ...structuredClone(INITIAL_EDITOR_STATE), activeTool: "layout" };
        const html = renderInspector(state);

        expect(html).toContain('<div class="inspector-header"><h2 id="inspector-tool-title">Layout</h2></div>');
        expect(html).not.toContain("<h3>Layout</h3>");
        expect(html).toContain('aria-label="Fit recording inside canvas" aria-pressed="true"');
        expect(html).toContain('aria-label="Fill canvas with recording" aria-pressed="false"');
        expect(html).toContain('aria-label="Frame quick actions"');
        expect(html).toContain(" Center</button>");
        expect(html).toContain(" Reset frame</button>");
        expect(html).toContain('<details class="inspector-advanced inspector-section--clip"><summary>Clip timing');
        expect(html).not.toContain('<details class="inspector-advanced inspector-section--clip" open="">');
        expect(html).not.toContain('aria-label="Scale"');
        expect(html).not.toContain('aria-label="Horizontal"');
        expect(html).not.toContain('aria-label="Vertical"');
        expect(html).not.toContain('type="range"');
    });

    it("uses accessible zoom and motion presets while hiding exact timing by default", () => {
        const segment = zoom();
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const state: EditorState = {
            ...initial,
            activeTool: "zoom",
            selectedZoomId: segment.id,
            project: { ...initial.project, zoomSegments: [segment] },
        };
        const html = renderInspector(state);

        expect(html).toContain('aria-label="Set zoom magnification to 2×" aria-pressed="true"');
        expect(html).toContain('aria-label="Use smooth zoom motion" aria-pressed="true"');
        expect(html).toContain('<details class="zoom-advanced"><summary>Exact timing');
        expect(html).not.toContain('<details class="zoom-advanced" open="">');
        expect(html).not.toContain("Focus X");
        expect(html).not.toContain("Focus Y");
        expect(html).not.toContain("Zoom ease in");
        expect(html).not.toContain("Zoom ease out");
        expect(html).not.toContain('type="range"');
    });

    it("shows a custom magnification and clamps every motion preset to short segments", () => {
        const segment = zoom({ endUs: 1_150_000, scale: 2.25, easeInUs: 60_000, easeOutUs: 70_000 });
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const state: EditorState = {
            ...initial,
            activeTool: "zoom",
            selectedZoomId: segment.id,
            project: { ...initial.project, zoomSegments: [segment] },
        };

        expect(renderInspector(state)).toContain("Custom · 2.25×");
        const shortPresets = (["Quick", "Smooth", "Gentle"] as const).map((preset) => {
            const easing = zoomMotionPresetChanges(preset, 150_000);
            expect(easing.easeInUs).toBeGreaterThanOrEqual(0);
            expect(easing.easeOutUs).toBeGreaterThanOrEqual(0);
            expect(easing.easeInUs + easing.easeOutUs).toBeLessThanOrEqual(150_000);
            return easing;
        });
        expect(new Set(shortPresets.map(({ easeInUs, easeOutUs }) => `${easeInUs}:${easeOutUs}`)).size).toBe(3);
        expect(zoomMotionPresetChanges("Smooth", Number.NaN)).toEqual({ easeInUs: 0, easeOutUs: 0 });
        expect(zoomMotionPresetFor(zoom())).toBe("Smooth");
    });

    it("presents only bounded opaque redactions without coordinate sliders", () => {
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const added = addSafeRedaction({
            document: initial.project.overlays,
            playheadUs: 1_000_000,
            projectDurationUs: 10_000_000,
        });
        const state: EditorState = {
            ...initial,
            activeTool: "annotations",
            selectedOverlayId: added.redaction.id,
            project: { ...initial.project, overlays: added.document },
        };
        const html = renderInspector(state);

        expect(html).toContain('<h2 id="inspector-tool-title">Redact</h2>');
        expect(html).toContain("Add redaction");
        expect(html).toContain("Black redaction");
        expect(html).toContain("Dark redaction");
        expect(html).toContain("White redaction");
        expect(html).toContain("Drag on preview · trim on timeline · opaque in export");
        expect(html).not.toContain("Blur");
        expect(html).not.toContain("Spotlight");
        expect(html).not.toContain('type="range"');

        let document = initial.project.overlays;
        for (let index = 0; index < MAX_EXPORTED_SAFE_REDACTIONS; index += 1) {
            document = addSafeRedaction({ document, playheadUs: index, projectDurationUs: 10_000_000 }).document;
        }
        const fullHtml = renderInspector({ ...state, project: { ...state.project, overlays: document } });
        expect(fullHtml).toContain(`Maximum ${MAX_EXPORTED_SAFE_REDACTIONS} redactions reached.`);
        expect(fullHtml).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?)?Add redaction/);
    });
});
