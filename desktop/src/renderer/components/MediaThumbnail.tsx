import type { CaptureItem } from "../types";

/** Lightweight library preview: video cards only load container metadata and never autoplay. */
export function MediaThumbnail({ capture, className }: { capture: CaptureItem; className?: string }) {
    const imageFallback = /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i.test(capture.thumbnail);
    if (capture.kind === "video" && !imageFallback) {
        return (
            <video
                aria-hidden="true"
                className={className}
                muted
                playsInline
                preload="none"
                src={capture.thumbnail}
            />
        );
    }
    return <img alt="" className={className} decoding="async" loading="lazy" src={capture.thumbnail} />;
}
