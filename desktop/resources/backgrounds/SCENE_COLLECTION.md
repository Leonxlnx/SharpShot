# SharpShot Scene Collection

This document records the exact generation brief and source-artifact mapping
for the ten original SharpShot Scene Collection backgrounds generated with the
OpenAI built-in `image_gen` tool on 2026-08-11. No input images or third-party
artwork were used.

Each generated source was processed with the project's pinned FFmpeg runtime:
Lanczos scaling to a 2560 × 1440 WebP master at q82 and a 480 × 270 WebP
thumbnail at q72. The packaged file hashes are recorded in `manifest.json`.

## Shared prompt scaffold

Every image used these three lines verbatim, with the title and image number
substituted:

```text
Use case: stylized-concept
Asset type: SharpShot Studio built-in 16:9 canvas background
Primary request: Create an entirely original background titled "<TITLE>", image <N> in a cohesive ten-image SharpShot Scene Collection.
```

## Quiet Aperture

- Source artifact: `exec-272f1cbf-9405-46a2-afdc-006c2c46b9e9.png`
- Intent: A dark, command-surface-compatible scene with edge-weighted optical geometry and a calm recording-safe center.

```text
Scene/backdrop: A near-black graphite field with one monumental optical-aperture contour assembled from thin layered matte-metal arcs, emerging from the right edge and lower-right corner.
Style: Premium editorial 3D material study, restrained industrial design, physically plausible, precise and quiet.
Composition: Wide 16:9 landscape. Keep the central 60% calm, low-frequency, dark, and readable for a screen recording. Concentrate the aperture geometry at the far right and lower edge. The image must also crop cleanly to a 3:1 horizontal command-card surface.
Lighting: Extremely subtle cool edge light, deep shadow detail, confident and calm.
Palette: Graphite, charcoal, smoked steel, one sparse muted blue-gray accent; not bright blue.
Materials: Fine anodized metal grain, smoked optical glass, satin black ceramic.
Constraints: no text, no letters, no logo, no UI, no buttons, no watermark, no recognizable Apple wallpaper, no copied commercial artwork, completely original, generous negative space.
Avoid: neon cyberpunk, purple gradient, glossy blob, lens flare, starfield, busy center, perfect symmetry, obvious AI artifacts.
```

## Glass Orbit

- Source artifact: `exec-e05a5e8b-c357-4e6d-9eba-d6e73c719fb8.png`
- Intent: A cool optical scene with translucent edge structures and an open central void.

```text
Scene: Nested smoked-glass orbital rings drift in from the upper-left and far-right edges over a deep graphite field, with a quiet transparent void across the center.
Style: Premium editorial 3D material study, optical glass and precision instrument design, restrained and physically plausible.
Composition: Wide 16:9. Preserve the central 60% as calm low-frequency negative space for a screen recording; place the strongest ring intersections at outer edges only.
Lighting: Soft cool studio rim light, subtle depth, calm.
Palette: Charcoal, smoke gray, desaturated ice blue, tiny silver highlights.
Materials: Smoked optical glass, satin aluminum, fine grain.
Constraints: completely original; no text, logo, UI, watermark, Apple wallpaper imitation, or third-party artwork.
Avoid: bright blue flood, neon, purple gradient, chrome sphere, lens flare, busy center, symmetry, obvious AI artifacts.
```

## Mineral Current

- Source artifact: `exec-e39e7245-a4c7-4518-9466-d0565eedc6ac.png`
- Intent: A dark geological material study with restrained teal depth and an uncluttered central stage.

```text
Scene: Broad carved slate and sea-glass mineral ribbons sweep quietly along the lower third and far left, like a geological current in a dark gallery.
Style: Photoreal editorial sculptural material study, high-end architectural visualization, restrained.
Composition: Wide 16:9. Keep the central 60% smooth, dark, and uncluttered for captured content. Energy remains along the bottom and corners.
Lighting: Diffuse overcast light with one restrained teal reflection.
Palette: Deep slate, graphite, muted mineral teal, soft stone gray.
Materials: Honed slate, frosted sea glass, microscopic mineral grain.
Constraints: entirely original, no text, logo, UI, watermark, branded wallpaper, or copied composition.
Avoid: literal ocean, neon cyan, landscape photo, glossy blobs, busy center, perfect symmetry, obvious AI artifacts.
```

## Warm Signal

- Source artifact: `exec-06c19f97-8d1a-4ace-9406-02af5ad63c1b.png`
- Intent: A warm motion cue built from sparse copper relief instead of literal recording technology.

```text
Scene: Thin warm signal bands and one broad matte copper arc emerge from the lower-left and dissolve into a charcoal field, suggesting capture and motion without depicting technology.
Style: Premium editorial 3D relief, understated industrial craft, contemporary and tactile.
Composition: Wide 16:9. Keep central 60% dark and calm for screen recordings; visual weight concentrated at lower-left and far-right rim.
Lighting: Quiet warm grazing light, soft depth, confident.
Palette: Charcoal, smoked bronze, muted amber, burnt sienna, tiny ivory highlight; no blue.
Materials: Matte anodized metal, oxidized copper, dry paper grain.
Constraints: completely original; no text, letters, UI, logo, watermark, recognizable commercial wallpaper.
Avoid: orange neon, fire, sunset landscape, steampunk gears, glossy blob, busy center, symmetry, lens flare.
```

## Lunar Fold

- Source artifact: `exec-5855ff84-2213-4dac-813b-1ad0cf00adfc.png`
- Intent: A light paper-sculpture scene with warm texture and broad recording-safe negative space.

```text
Scene: Oversized layers of handmade warm-ivory paper and pale mineral fiber curl softly from the outer edges over a quiet pearl-gray field.
Style: Gallery-quality paper sculpture photography, tactile analog craft, editorial and refined.
Composition: Wide 16:9. Preserve central 60% as smooth lightly textured negative space. One deckled fold enters upper-left and a shallow layer rests at lower-right.
Lighting: Soft moonlike studio light, delicate long shadows, tranquil.
Palette: Warm ivory, pearl, moon silver, soft clay gray, charcoal shadow.
Materials: Cotton paper fibers, deckled edges, embossed ridges, mineral-flecked vellum.
Constraints: completely original; no text, logo, UI, watermark, literal moon, or copied wallpaper.
Avoid: stationery flat-lay, origami animal, bright gradient, glossy plastic, busy center, perfect symmetry.
```

## Cobalt Veil

- Source artifact: `exec-5edbb9fb-69bd-4446-a10f-ff126c099ae3.png`
- Intent: A restrained cobalt edge treatment that adds cool color without flooding the usable center.

```text
Scene: A small number of immense translucent cobalt textile-glass veils enter from the far right and upper-left over an ink-charcoal field, leaving the center open.
Style: Premium editorial 3D material study, glass-fiber sculpture, clean and restrained.
Composition: Wide 16:9. Keep central 60% calm, low-contrast, and readable for captured content. Forms stay at the outer edges in broad simple shapes.
Lighting: Dim gallery light with soft desaturated cobalt translucency.
Palette: Ink black, graphite, subdued cobalt, slate blue, tiny cool-white edge.
Materials: Matte glass fiber, satin resin, fine woven grain.
Constraints: completely original; no text, logo, UI, watermark, Apple wallpaper imitation, or third-party artwork.
Avoid: bright electric blue, purple gradient, literal fabric folds, neon, glossy blobs, busy center, symmetry, obvious AI artifacts.
```

## Moss Circuit

- Source artifact: `exec-a07b6631-2e75-43cc-8486-0da3dee4535e.png`
- Intent: A precision-made dark surface softened by restrained natural seams, without literal circuitry.

```text
Scene: Precision-cut gunmetal planes interlock at the far edges of a quiet dark mineral field, softened by thin velvety moss-green seams that suggest a circuit without drawing one.
Style: Photoreal industrial sculpture, Japanese-European editorial product art, tactile and understated.
Composition: Wide 16:9. Central 60% remains calm and almost empty. One layered plane enters bottom-left, one recedes upper-right.
Lighting: Diffuse overcast studio light with a restrained warm reflection.
Palette: Graphite, gunmetal, lichen olive, deep moss, tiny brass highlight.
Materials: Brushed aluminum, aged patina, matte stone dust, micro moss fibers.
Constraints: completely original; no text, logo, UI, watermark, recognizable commercial wallpaper.
Avoid: literal forest, camouflage, military styling, circuit-board lines, gears, neon, busy center, symmetry.
```

## Porcelain Wave

- Source artifact: `exec-4e368cee-8be1-414e-8e4f-ed3c9b16ab82.png`
- Intent: A quiet light-mode ceramic scene with gentle depth and large neutral breathing room.

```text
Scene: Broad matte porcelain waves and pale gray ceramic plates overlap softly along the bottom and far right of a warm off-white field.
Style: Premium product-studio still life, sculptural ceramic minimalism, tactile and human.
Composition: Wide 16:9. Preserve central 60% as soft warm negative space for a screen recording. Large simple forms only at edges.
Lighting: Gentle north-window light, soft contact shadows, tranquil.
Palette: Warm porcelain, fog gray, bone white, tiny muted blue-gray edge; mostly neutral.
Materials: Unglazed porcelain, fine ceramic grain, soft chalk.
Constraints: completely original; no text, logo, UI, watermark, literal wave landscape, copied wallpaper.
Avoid: sterile pure white, glossy plastic, gradient blob, busy center, perfect symmetry, lens flare.
```

## Crimson Thread

- Source artifact: `exec-19cbe784-4731-49e2-8f23-d517243f4eb4.png`
- Intent: A dark luxury scene with sparse burgundy edge detail and no bright red glow.

```text
Scene: A few deep burgundy glass threads and one wide oxblood ribbon trace a slow diagonal along the far left and lower-right over a blackened charcoal field.
Style: Luxury editorial material study, restrained glass and textile sculpture, precise.
Composition: Wide 16:9. Keep central 60% dark, low-frequency, and empty for captured content. Thread detail remains near edges.
Lighting: Low warm gallery light, quiet and dramatic without glow.
Palette: Charcoal, oxblood, deep burgundy, smoked rose, tiny copper highlight.
Materials: Satin glass thread, matte woven ribbon, fine graphite grain.
Constraints: completely original; no text, logo, UI, watermark, branded wallpaper.
Avoid: neon red, fire, roses, literal fabric drapery, glossy blob, busy center, symmetry, obvious AI artifacts.
```

## Sandstone Echo

- Source artifact: `exec-2b78a653-b20e-4982-85c4-62ba30ca8289.png`
- Intent: A warm architectural neutral with abstract strata at the edges rather than a literal desert scene.

```text
Scene: Monumental thin layers of warm sandstone and smoked clay echo outward from the lower-left and far-right edges over a calm taupe-gray atmospheric field.
Style: High-end architectural material study, quiet desert-modern editorial art, abstract rather than landscape.
Composition: Wide 16:9. Keep central 60% spacious, smooth, and readable for a screen recording. Edge layers are broad and sparse.
Lighting: Soft late-afternoon studio light with subdued shadow.
Palette: Sandstone, warm taupe, smoked clay, charcoal, tiny pale-gold highlight.
Materials: Honed sandstone, dry clay, mineral dust, fine strata.
Constraints: completely original; no text, logo, UI, watermark, literal desert, recognizable commercial wallpaper.
Avoid: dunes, sun, sky, orange gradient, boho decor, busy center, perfect symmetry, obvious AI artifacts.
```
