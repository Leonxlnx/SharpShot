import { describe, expect, it } from "vitest";
import { nextTabIndex } from "./tablist-navigation";

describe("roving tablist navigation", () => {
    it("wraps arrows and supports Home/End", () => {
        expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
        expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
        expect(nextTabIndex("Home", 2, 3)).toBe(0);
        expect(nextTabIndex("End", 0, 3)).toBe(2);
        expect(nextTabIndex("Enter", 1, 3)).toBeNull();
    });
});
