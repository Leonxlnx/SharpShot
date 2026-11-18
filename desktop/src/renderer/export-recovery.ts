import type { ExportJobSnapshot } from "../shared/api";

/**
 * Returns work that still needs to be represented after a renderer restart.
 * Terminal jobs are replayed exactly once; the caller persists the acknowledged
 * job ID only after it has surfaced the result to the user.
 */
export function recoverableExport(
    snapshot: ExportJobSnapshot | null,
    acknowledgedTerminalJobId?: string | null,
): ExportJobSnapshot | null {
    if (snapshot === null || snapshot.state === "cancelled") return null;
    if (
        snapshot.jobId === acknowledgedTerminalJobId
        && (snapshot.state === "completed" || snapshot.state === "completed-unindexed" || snapshot.state === "failed")
    ) {
        return null;
    }
    return snapshot;
}
