import { describe, expect, it } from "vitest";
import { MAX_EXPORTED_SAFE_REDACTIONS } from "../shared/export-plan";
import { createEmptyOverlayDocument, type ShapeOverlay } from "../shared/overlays";
import {
    SAFE_REDACTION_COLORS,
    SafeRedactionError,
    addSafeRedaction,
    deleteSafeRedaction,
    isSafeRedaction,
    presetForSafeRedaction,
    resizeSafeRedactionRange,
    safeRedactions,
    setSafeRedactionArea,
    setSafeRedactionPreset,
    setSafeRedactionRange,
} from "./safe-redaction";

function redaction(overrides: Partial<ShapeOverlay> = {}): ShapeOverlay {
    return {
        kind: "shape",
        id: "redaction-1",
        startUs: 1_000_000,
        endUs: 4_000_000,
        opacity: 1,
        shape: "rectangle",
        area: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
        fillColor: SAFE_REDACTION_COLORS.black,
        strokeColor: "#00000000",
        strokeWidthPx: 0,
        cornerRadius: 0,
        rotationDeg: 0,
        ...overrides,
    };
}

describe("safe redaction editor model", () => {
    it("creates a centered three-second export-safe redaction at the playhead", () => {
        const added = addSafeRedaction({
            document: createEmptyOverlayDocument(),
            playheadUs: 2_000_000,
            projectDurationUs: 10_000_000,
        });

        expect(added.redaction).toMatchObject({
            id: "redaction-1",
            startUs: 2_000_000,
            endUs: 5_000_000,
            area: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
            fillColor: "#000000FF",
        });
        expect(isSafeRedaction(added.redaction)).toBe(true);
        expect(safeRedactions(added.document)).toEqual([added.redaction]);
    });

    it("clamps creation to the last project microsecond and rejects an empty timeline", () => {
        const added = addSafeRedaction({
            document: createEmptyOverlayDocument(),
            playheadUs: 99_000_000,
            projectDurationUs: 7,
            preset: "white",
        });
        expect(added.redaction).toMatchObject({ startUs: 6, endUs: 7, fillColor: "#FFFFFFFF" });
        expect(() => addSafeRedaction({
            document: createEmptyOverlayDocument(),
            playheadUs: 0,
            projectDurationUs: 0,
        })).toThrow(SafeRedactionError);
    });

    it("allocates the first deterministic ID unused across captions and visuals", () => {
        const document = createEmptyOverlayDocument();
        document.captions.push({
            id: "redaction-1",
            startUs: 0,
            endUs: 1,
            text: "Collision",
            style: { preset: "clean" },
        });
        document.overlays.push(redaction({ id: "redaction-2" }));

        const first = addSafeRedaction({ document, playheadUs: 0, projectDurationUs: 10 }).redaction;
        const second = addSafeRedaction({ document, playheadUs: 0, projectDurationUs: 10 }).redaction;
        expect(first.id).toBe("redaction-3");
        expect(second.id).toBe("redaction-3");
        expect(first.id.length).toBeLessThanOrEqual(128);
    });

    it("enforces the shared export capacity", () => {
        const document = createEmptyOverlayDocument();
        document.overlays = Array.from({ length: MAX_EXPORTED_SAFE_REDACTIONS }, (_, index) =>
            redaction({ id: `redaction-${index + 1}` }));
        expect(() => addSafeRedaction({ document, playheadUs: 0, projectDurationUs: 10 }))
            .toThrow(`at most ${MAX_EXPORTED_SAFE_REDACTIONS}`);
    });

    it("updates area and opaque color immutably, then deletes only safe redactions", () => {
        const document = { ...createEmptyOverlayDocument(), overlays: [redaction()] };
        const moved = setSafeRedactionArea(document, "redaction-1", { x: 0, y: 0.1, width: 0.2, height: 0.3 });
        const white = setSafeRedactionPreset(moved, "redaction-1", "white");
        expect(white.overlays[0]).toMatchObject({
            area: { x: 0, y: 0.1, width: 0.2, height: 0.3 },
            fillColor: "#FFFFFFFF",
        });
        expect(presetForSafeRedaction(white.overlays[0] as ShapeOverlay)).toBe("white");
        expect(document.overlays[0]).toEqual(redaction());
        expect(deleteSafeRedaction(white, "redaction-1").overlays).toEqual([]);
    });

    it("trims either edge to project bounds while keeping a positive range", () => {
        const source = redaction();
        expect(resizeSafeRedactionRange(source, "start", 8_000_000, 10_000_000))
            .toMatchObject({ startUs: 3_999_999, endUs: 4_000_000 });
        const endTrimmed = resizeSafeRedactionRange(source, "end", -5, 10_000_000);
        expect(endTrimmed).toMatchObject({ startUs: 1_000_000, endUs: 1_000_001 });

        const document = { ...createEmptyOverlayDocument(), overlays: [source] };
        const committed = setSafeRedactionRange(document, endTrimmed);
        expect(committed.overlays[0]).toEqual(endTrimmed);
        expect(document.overlays[0]).toEqual(source);
    });

    it("keeps every shipped color preset fully opaque and export-safe", () => {
        for (const preset of ["black", "dark", "white"] as const) {
            const added = addSafeRedaction({
                document: createEmptyOverlayDocument(),
                playheadUs: 0,
                projectDurationUs: 10,
                preset,
            });
            expect(added.redaction.fillColor.endsWith("FF")).toBe(true);
            expect(isSafeRedaction(added.redaction)).toBe(true);
        }
    });
});
