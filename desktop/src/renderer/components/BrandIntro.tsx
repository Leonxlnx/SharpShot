import { useEffect, useRef, useState } from "react";
import { BrandLogo } from "./BrandLogo";

export const BRAND_INTRO_MINIMUM_MS = 360;
export const BRAND_INTRO_EXIT_MS = 180;
export const BRAND_INTRO_REDUCED_EXIT_MS = 80;

export function resolveBrandIntroTiming(reducedMotion: boolean, elapsedMs: number) {
    return {
        exitDelayMs: reducedMotion ? 0 : Math.max(0, BRAND_INTRO_MINIMUM_MS - Math.max(0, elapsedMs)),
        exitDurationMs: reducedMotion ? BRAND_INTRO_REDUCED_EXIT_MS : BRAND_INTRO_EXIT_MS,
    };
}

export function BrandIntro({ ready }: { ready: boolean }) {
    const mountedAt = useRef(typeof performance === "undefined" ? 0 : performance.now());
    const [exiting, setExiting] = useState(false);
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        if (!ready) return undefined;
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const elapsedMs = performance.now() - mountedAt.current;
        const timing = resolveBrandIntroTiming(reducedMotion, elapsedMs);
        let removeTimer = 0;
        const exitTimer = window.setTimeout(() => {
            setExiting(true);
            removeTimer = window.setTimeout(() => setVisible(false), timing.exitDurationMs);
        }, timing.exitDelayMs);
        return () => {
            window.clearTimeout(exitTimer);
            window.clearTimeout(removeTimer);
        };
    }, [ready]);

    if (!visible) return null;
    return (
        <div
            aria-hidden="true"
            className={`brand-intro${exiting ? " brand-intro--exiting" : ""}`}
            data-state={exiting ? "exiting" : "visible"}
        >
            <BrandLogo className="brand-intro__logo" size={96} />
        </div>
    );
}
