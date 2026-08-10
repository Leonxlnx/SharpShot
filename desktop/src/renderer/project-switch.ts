export type ProjectSwitchResult<T> =
    | { kind: "blocked" }
    | { kind: "same-media" }
    | { kind: "completed"; value: T };

export async function runLockedProjectSwitch<T>(options: {
    acquire: () => () => void;
    currentProjectId: string;
    sameMedia: boolean;
    persistCurrent: () => Promise<boolean>;
    flushCurrent: (projectId: string) => Promise<boolean>;
    continueSwitch: () => Promise<T>;
}): Promise<ProjectSwitchResult<T>> {
    const release = options.acquire();
    try {
        if (!await options.persistCurrent()) return { kind: "blocked" };
        if (!await options.flushCurrent(options.currentProjectId)) return { kind: "blocked" };
        if (options.sameMedia) return { kind: "same-media" };
        return { kind: "completed", value: await options.continueSwitch() };
    } finally {
        release();
    }
}
