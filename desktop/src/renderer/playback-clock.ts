const PLAYBACK_FRAME_MS = 1_000 / 60;

export function playbackDeltaForFrame(previousMs: number | null, nowMs: number): number | null {
    if (previousMs === null || !Number.isFinite(previousMs) || !Number.isFinite(nowMs) || nowMs <= previousMs) return null;
    if (Math.floor(previousMs / PLAYBACK_FRAME_MS) === Math.floor(nowMs / PLAYBACK_FRAME_MS)) return null;
    return Math.min(.1, (nowMs - previousMs) / 1_000);
}
