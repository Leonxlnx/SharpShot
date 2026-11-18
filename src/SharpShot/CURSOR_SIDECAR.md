# SharpShot editable-cursor sidecar

Cursor rendering and metadata capture are independent native flags:

```text
SharpShot.exe --studio-record --result <result.ini> --include-cursor true --editable-cursor true
```

This is the policy used by Video-to-Studio: the H.264 frames keep the visible
painted pointer while a sidecar records click positions for opt-in auto zoom.
Quick Video uses `--include-cursor true --editable-cursor false`, so it still
paints the pointer and creates no sidecar. Metadata-only capture remains
available by passing `--include-cursor false --editable-cursor true` directly.
The completed sidecar sits beside the video as `<video stem>.cursor.jsonl`;
for example, `Demo.mp4` and `Demo.cursor.jsonl`.

The Studio result protocol remains `protocol=1` and adds an optional line:

```text
cursorPath64=<UTF-8 sidecar path encoded as base64>
```

It is empty for screenshots, cancelled/failed captures, quick video, and Studio
recording without `--editable-cursor true`. Older INI readers can ignore the
unknown line.

## Atomicity

Samples stay in compact value-type memory while recording. After the encoder
has finalized, SharpShot serializes the sidecar to a same-directory unique
temporary file, closes it, commits the MP4, then renames the sidecar into place.
A final `.cursor.jsonl` is therefore never partially readable. Failure to
commit required cursor metadata rolls the newly committed Studio MP4 back.

## JSON Lines format, version 1

Every line is an independent JSON object. The first line is the header:

```json
{"kind":"header","format":"sharpshot-cursor","version":1,"timebase":10000000,"coordinateSpace":"physical-pixels","sampling":"video-frame-state-change","buttonBits":{"left":1,"right":2,"middle":4,"x1":8,"x2":16},"region":{"left":0,"top":0,"width":1920,"height":1080}}
```

- `timebase` is ticks per second; timestamps use 100-nanosecond ticks and align
  with Media Foundation video sample timestamps.
- `region` is the selected desktop area in physical virtual-desktop pixels.
- normalized positions use the pointer hotspot relative to `region`; values are
  deliberately not clamped, so cursor entry/exit motion can be reconstructed.
- state-change sampling means a state holds until the next sample. A closing
  sample at the recording duration makes trim boundaries deterministic.

Each cursor handle first receives a shape definition:

```json
{"kind":"shape","id":1,"name":"arrow","identity":"system:arrow","hotspot":{"x":0,"y":0},"size":{"width":32,"height":32}}
```

`name` identifies Windows system cursors (`arrow`, `ibeam`, `hand`, resize
variants, and others). `identity` is a stable `system:<name>` token for those
shapes. Unknown application cursors are named `custom` and receive a unique
`session:<id>` identity that remains stable for the recording.

Samples contain position, visibility, shape, and button transitions:

```json
{"kind":"sample","t":166667,"screen":{"x":960,"y":540},"normalized":{"x":0.500000,"y":0.500000},"inside":true,"visible":true,"shape":1,"buttons":0,"down":1,"up":0,"click":0}
```

- `buttons` is the state after this sample.
- `down`, `up`, and `click` are transition bitmasks using `buttonBits`.
- A click that begins and ends between video frames is emitted at one timestamp
  with the same bit present in `down`, `up`, and `click`.
- `shape=0` means no visible cursor shape.

The final line is:

```json
{"kind":"end","t":30000000,"samples":143}
```

## Performance probe

The default hidden native self-test uses 10,000 deterministic synthetic cursor
samples, validates normalization and atomic serialization, and never reads live
input. The explicit `--self-test-live` mode additionally samples the actual
Windows cursor and five mouse buttons. A five-run live batch on the 2026-08-09 development machine
measured **3,762 ns median per video-frame sample** (3,359-4,064 ns range, 10,000
samples per run). At 60 FPS the median is about 0.226 ms of one logical core per
second (roughly 0.023% of one core). There is no hook, timer, polling thread,
allocation, or file IO when no recording is active; quick video does not
instantiate the metadata recorder.
