import { describe, expect, it } from "vitest";
import { LIBRARY_BATCH_SIZE, libraryWindow } from "./LibraryPage";

describe("library render window", () => {
    it("renders large libraries in accessible bounded batches", () => {
        const captures = Array.from({ length: 10_000 }, (_, index) => index);
        const first = libraryWindow(captures, LIBRARY_BATCH_SIZE);
        const second = libraryWindow(captures, LIBRARY_BATCH_SIZE * 2);

        expect(first).toMatchObject({ total: 10_000, remaining: 9_800 });
        expect(first.items).toEqual(captures.slice(0, 200));
        expect(second.items).toEqual(captures.slice(0, 400));
        expect(second.remaining).toBe(9_600);
    });

    it("shows every short result set without padding the window", () => {
        expect(libraryWindow(["a", "b"], LIBRARY_BATCH_SIZE)).toEqual({
            items: ["a", "b"],
            remaining: 0,
            total: 2,
        });
    });
});
