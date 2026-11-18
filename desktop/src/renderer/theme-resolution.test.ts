import { describe, expect, it } from "vitest";
import { resolveThemePreference } from "./App";

describe("theme preference resolution", () => {
    it("follows the system preference while preserving explicit choices", () => {
        expect(resolveThemePreference("system", true)).toBe("dark");
        expect(resolveThemePreference("system", false)).toBe("light");
        expect(resolveThemePreference("light", true)).toBe("light");
        expect(resolveThemePreference("dark", false)).toBe("dark");
    });
});
