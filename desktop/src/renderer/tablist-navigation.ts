export function nextTabIndex(key: string, current: number, count: number): number | null {
    if (count <= 0) return null;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
    if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
    return null;
}

export function focusTabAt(container: HTMLElement, index: number): void {
    container.querySelectorAll<HTMLElement>("[role='tab']").item(index)?.focus();
}
