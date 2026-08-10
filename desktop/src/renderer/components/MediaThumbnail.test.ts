import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { MediaThumbnail } from "./MediaThumbnail";
import type { CaptureItem } from "../types";

describe("media thumbnail loading", () => {
    it("does not eagerly request video metadata for library cards", () => {
        const capture: CaptureItem = {
            id: "video",
            name: "Recording.mp4",
            kind: "video",
            createdLabel: "Now",
            dimensions: "1920 × 1080",
            duration: "00:10",
            size: "1 MB",
            workflow: "Recording",
            thumbnail: "sharpshot-media://asset/video",
            accent: "#000",
        };

        const element = MediaThumbnail({ capture }) as ReactElement<{ preload?: string }>;
        expect(element.props.preload).toBe("none");
    });
});
