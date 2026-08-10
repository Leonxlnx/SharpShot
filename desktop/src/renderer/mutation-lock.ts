/**
 * Synchronous mutation gate used while a route/window exit persists its final
 * snapshot. Acquisitions are reference-counted so an OS close request can join
 * an already-running editor exit without briefly re-enabling controls.
 */
export class MutationLock {
    private depth = 0;

    get locked(): boolean {
        return this.depth > 0;
    }

    acquire(): () => void {
        this.depth += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.depth = Math.max(0, this.depth - 1);
        };
    }

    run(operation: () => void): boolean {
        if (this.locked) return false;
        operation();
        return true;
    }
}
