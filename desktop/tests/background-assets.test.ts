import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type BackgroundManifest = {
    items: Array<{
        id: string;
        file: string;
        dimensions: { width: number; height: number };
        provenance: {
            sha256: string;
            type: string;
            sourceCommit?: string;
            generator?: string;
            generatedOn?: string;
            sourceArtifact?: string;
            thirdPartyInputs?: string[];
            postProcess?: string;
        };
        thumbnail?: {
            file: string;
            dimensions: { width: number; height: number };
            sha256: string;
        };
        promptReference?: string;
    }>;
};

const backgroundRoot = resolve("resources/backgrounds");
const sceneSources = new Map([
    ["quiet-aperture", "exec-272f1cbf-9405-46a2-afdc-006c2c46b9e9.png"],
    ["glass-orbit", "exec-e05a5e8b-c357-4e6d-9eba-d6e73c719fb8.png"],
    ["mineral-current", "exec-e39e7245-a4c7-4518-9466-d0565eedc6ac.png"],
    ["warm-signal", "exec-06c19f97-8d1a-4ace-9406-02af5ad63c1b.png"],
    ["lunar-fold", "exec-5855ff84-2213-4dac-813b-1ad0cf00adfc.png"],
    ["cobalt-veil", "exec-5edbb9fb-69bd-4446-a10f-ff126c099ae3.png"],
    ["moss-circuit", "exec-a07b6631-2e75-43cc-8486-0da3dee4535e.png"],
    ["porcelain-wave", "exec-4e368cee-8be1-414e-8e4f-ed3c9b16ab82.png"],
    ["crimson-thread", "exec-19cbe784-4731-49e2-8f23-d517243f4eb4.png"],
    ["sandstone-echo", "exec-2b78a653-b20e-4982-85c4-62ba30ca8289.png"],
]);

describe("bundled background assets", () => {
    it("keeps every master and thumbnail present and hash-matched to the manifest", async () => {
        const manifest = JSON.parse(await readFile(resolve(backgroundRoot, "manifest.json"), "utf8")) as BackgroundManifest;
        expect(manifest.items).toHaveLength(22);

        for (const item of manifest.items) {
            const master = await readFile(resolve(backgroundRoot, item.file));
            expect(createHash("sha256").update(master).digest("hex"), item.file).toBe(item.provenance.sha256);
            const thumbnailPath = resolve(backgroundRoot, item.thumbnail?.file ?? `thumbnails/${item.id}.webp`);
            await expect(stat(thumbnailPath)).resolves.toMatchObject({ size: expect.any(Number) });
            if (item.thumbnail) {
                const thumbnail = await readFile(thumbnailPath);
                expect(createHash("sha256").update(thumbnail).digest("hex"), item.thumbnail.file).toBe(item.thumbnail.sha256);
            }
        }

        const cc0Items = manifest.items.filter((item) => item.provenance.type === "third-party-cc0-unmodified");
        expect(cc0Items).toHaveLength(4);
        expect(new Set(cc0Items.map((item) => item.provenance.sourceCommit))).toEqual(new Set(["e2e314bef84fca804e1bd802898c7c7e72629de1"]));
        await expect(stat(resolve(backgroundRoot, "LICENSE-BUDGIE-BACKGROUNDS-CC0-1.0.txt"))).resolves.toMatchObject({ size: 7_048 });
    });

    it("pins the Scene Collection generation and packaging provenance", async () => {
        const manifest = JSON.parse(await readFile(resolve(backgroundRoot, "manifest.json"), "utf8")) as BackgroundManifest;
        const sceneItems = manifest.items.filter((item) => sceneSources.has(item.id));
        const sourceNotes = await readFile(resolve(backgroundRoot, "SCENE_COLLECTION.md"), "utf8");

        expect(sceneItems).toHaveLength(10);
        for (const item of sceneItems) {
            const sourceArtifact = sceneSources.get(item.id);
            expect(item.dimensions).toEqual({ width: 2560, height: 1440 });
            expect(item.provenance).toMatchObject({
                type: "ai-generated-original",
                generator: "OpenAI built-in image_gen tool",
                generatedOn: "2026-08-11",
                sourceArtifact,
                thirdPartyInputs: [],
            });
            expect(item.provenance.postProcess).toMatch(/Lanczos.*2560x1440.*q82.*480x270.*q72/i);
            expect(item.thumbnail).toMatchObject({
                file: `thumbnails/${item.id}.webp`,
                dimensions: { width: 480, height: 270 },
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            });
            expect(item.promptReference).toBe(`SCENE_COLLECTION.md#${item.id}`);
            expect(sourceNotes).toContain(sourceArtifact);
        }
    });
});
