export type ClosePreparationOptions = {
    editorActive: boolean;
    projectId: string | null;
    persistWorkflows: () => Promise<boolean>;
    persistProject: () => Promise<boolean>;
    flushProject: (projectId: string) => Promise<boolean>;
};

/** Returns true only after every renderer-owned durable write is complete. */
export async function prepareWindowClose(options: ClosePreparationOptions): Promise<boolean> {
    try {
        if (!await options.persistWorkflows()) return false;
        if (options.editorActive && !await options.persistProject()) return false;
        if (options.projectId !== null && !await options.flushProject(options.projectId)) return false;
        return true;
    } catch {
        return false;
    }
}
