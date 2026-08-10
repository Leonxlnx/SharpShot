import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    BRAND_INTRO_EXIT_MS,
    BRAND_INTRO_MINIMUM_MS,
    BRAND_INTRO_REDUCED_EXIT_MS,
    BrandIntro,
    resolveBrandIntroTiming,
} from "./BrandIntro";

describe("brand intro", () => {
    it("renders the real bundled logo as non-interactive decoration", () => {
        const html = renderToStaticMarkup(createElement(BrandIntro, { ready: false }));

        expect(html).toContain('class="brand-intro"');
        expect(html).toContain('class="brand-intro__logo"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('alt=""');
        expect(html).toContain("sharpshot-studio-preview.png");
    });

    it("keeps prescribed motion short and removes the hold for reduced motion", () => {
        expect(resolveBrandIntroTiming(false, 0)).toEqual({
            exitDelayMs: BRAND_INTRO_MINIMUM_MS,
            exitDurationMs: BRAND_INTRO_EXIT_MS,
        });
        expect(resolveBrandIntroTiming(false, 500)).toEqual({
            exitDelayMs: 0,
            exitDurationMs: BRAND_INTRO_EXIT_MS,
        });
        expect(resolveBrandIntroTiming(true, 0)).toEqual({
            exitDelayMs: 0,
            exitDurationMs: BRAND_INTRO_REDUCED_EXIT_MS,
        });
        expect(BRAND_INTRO_MINIMUM_MS + BRAND_INTRO_EXIT_MS).toBeLessThan(800);
    });
});
