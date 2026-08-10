export interface FrameCoalescer<T> {
    cancel: () => void;
    flush: () => void;
    schedule: (value: T) => void;
}

export function createFrameCoalescer<T>(
    requestFrame: (callback: FrameRequestCallback) => number,
    cancelFrame: (frame: number) => void,
    apply: (value: T) => void,
): FrameCoalescer<T> {
    let frame: number | null = null;
    let pending: T;
    let hasPending = false;

    const applyPending = () => {
        frame = null;
        if (!hasPending) return;
        hasPending = false;
        apply(pending);
    };

    const cancel = () => {
        if (frame !== null) cancelFrame(frame);
        frame = null;
        hasPending = false;
    };

    return {
        cancel,
        flush: () => {
            if (frame !== null) cancelFrame(frame);
            applyPending();
        },
        schedule: (value) => {
            pending = value;
            hasPending = true;
            frame ??= requestFrame(applyPending);
        },
    };
}
