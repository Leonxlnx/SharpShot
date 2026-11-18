export interface ProjectOperationToken {
    epoch: number;
    projectId: string;
}

export function isProjectOperationCurrent(
    token: ProjectOperationToken,
    currentEpoch: number,
    currentProjectId: string | null | undefined,
): boolean {
    return token.epoch === currentEpoch && token.projectId === currentProjectId;
}

export function projectDocument(project: unknown): string {
    return JSON.stringify(project);
}
