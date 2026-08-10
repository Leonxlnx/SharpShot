import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type BackgroundManifest = {
    items: Array<{
        id: string;
        file: string;
        provenance: { sha256: string; type: string; sourceCommit?: string };
    }>;
};

const backgroundRoot = resolve("resources/backgrounds");

describe("bundled background assets", () => {
    it("keeps every master and thumbnail present and hash-matched to the manifest", async () => {
        const manifest = JSON.parse(await readFile(resolve(backgroundRoot, "manifest.json"), "utf8")) as BackgroundManifest;
        expect(manifest.items).toHaveLength(12);

        for (const item of manifest.items) {
            const master = await readFile(resolve(backgroundRoot, item.file));
            expect(createHash("sha256").update(master).digest("hex"), item.file).toBe(item.provenance.sha256);
            await expect(stat(resolve(backgroundRoot, "thumbnails", `${item.id}.webp`))).resolves.toMatchObject({ size: expect.any(Number) });
        }

        const cc0Items = manifest.items.filter((item) => item.provenance.type === "third-party-cc0-unmodified");
        expect(cc0Items).toHaveLength(4);
        expect(new Set(cc0Items.map((item) => item.provenance.sourceCommit))).toEqual(new Set(["e2e314bef84fca804e1bd802898c7c7e72629de1"]));
        await expect(stat(resolve(backgroundRoot, "LICENSE-BUDGIE-BACKGROUNDS-CC0-1.0.txt"))).resolves.toMatchObject({ size: 7_048 });
    });
});
