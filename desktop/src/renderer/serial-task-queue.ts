/** Serializes persistence writes so a close-time flush cannot overtake a debounce write. */
export class SerialTaskQueue {
    private tail: Promise<void> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
