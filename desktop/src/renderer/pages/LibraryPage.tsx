import { useEffect, useMemo, useRef, useState } from "react";
import { revealCapture } from "../bridge";
import type { CaptureItem } from "../types";
import { Icon } from "../components/Icon";
import { MediaThumbnail } from "../components/MediaThumbnail";
import { IconButton } from "../components/ui";
import { focusTabAt, nextTabIndex } from "../tablist-navigation";

type LibraryFilter = "All" | "Screenshots" | "Videos";
export const LIBRARY_BATCH_SIZE = 200;

export function libraryWindow<T>(items: readonly T[], visibleLimit: number): {
    items: T[];
    remaining: number;
    total: number;
} {
    const count = Math.min(items.length, Math.max(0, Math.floor(visibleLimit)));
    return { items: items.slice(0, count), remaining: items.length - count, total: items.length };
}

export function LibraryPage({
    captures,
    selectedId,
    onSelect,
    onOpenEditor,
    onImport,
}: {
    captures: CaptureItem[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onOpenEditor: (mediaId: string) => void;
    onImport: () => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<LibraryFilter>("All");
    const [view, setView] = useState<"grid" | "list">("grid");
    const [viewerOpen, setViewerOpen] = useState(false);
    const [visibleLimit, setVisibleLimit] = useState(LIBRARY_BATCH_SIZE);
    const previewButtonRef = useRef<HTMLButtonElement>(null);
    const viewerCloseRef = useRef<HTMLButtonElement>(null);
    const selected = captures.find((capture) => capture.id === selectedId) ?? null;
    const filtered = useMemo(() => captures.filter((capture) => {
        const matchesQuery = capture.name.toLowerCase().includes(query.trim().toLowerCase());
        const matchesFilter = filter === "All" || (filter === "Screenshots" ? capture.kind === "screenshot" : capture.kind === "video");
        return matchesQuery && matchesFilter;
    }), [captures, filter, query]);
    const visible = useMemo(() => libraryWindow(filtered, visibleLimit), [filtered, visibleLimit]);

    useEffect(() => {
        if (!viewerOpen) return undefined;
        if (selected?.kind !== "screenshot") {
            setViewerOpen(false);
            return undefined;
        }
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setViewerOpen(false);
            } else if (event.key === "Tab") {
                event.preventDefault();
                viewerCloseRef.current?.focus();
            }
        };
        viewerCloseRef.current?.focus();
        window.addEventListener("keydown", onKeyDown, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            (previewButtonRef.current ?? previouslyFocused)?.focus();
        };
    }, [selected?.id, selected?.kind, viewerOpen]);

    return (
        <div className={`page library-page${selected ? " has-inspector" : ""}`}>
            <header className="page-header page-header--library">
                <div>
                    <h1>Captures</h1>
                    <p>{captures.length} {captures.length === 1 ? "item" : "items"} stored on this device.</p>
                </div>
                <div className="library-search">
                    <Icon name="search" size={16} />
                    <input aria-label="Search captures" onChange={(event) => { setQuery(event.currentTarget.value); setVisibleLimit(LIBRARY_BATCH_SIZE); }} placeholder="Search captures" type="search" value={query} />
                    <kbd>Ctrl K</kbd>
                </div>
            </header>

            <div className="library-toolbar">
                <div className="filter-tabs" role="tablist" aria-label="Capture type">
                    {(["All", "Screenshots", "Videos"] as const).map((item, index, items) => (
                        <button aria-selected={filter === item} className={filter === item ? "is-active" : ""} key={item} onClick={() => { setFilter(item); setVisibleLimit(LIBRARY_BATCH_SIZE); }} onKeyDown={(event) => { const next = nextTabIndex(event.key, index, items.length); if (next === null) return; event.preventDefault(); setFilter(items[next]!); setVisibleLimit(LIBRARY_BATCH_SIZE); focusTabAt(event.currentTarget.parentElement!, next); }} role="tab" tabIndex={filter === item ? 0 : -1} type="button">{item}</button>
                    ))}
                </div>
                <span aria-live="polite" className="library-result-count" id="library-result-count">
                    Showing {visible.items.length} of {visible.total} {visible.total === 1 ? "result" : "results"}
                </span>
                <div className="view-toggle" aria-label="Library actions">
                    <button className="button button--secondary" onClick={onImport} type="button"><Icon name="plus" size={15} /> Import</button>
                    <IconButton className={view === "grid" ? "is-active" : ""} icon="grid" label="Grid view" onClick={() => setView("grid")} />
                    <IconButton className={view === "list" ? "is-active" : ""} icon="list" label="List view" onClick={() => setView("list")} />
                </div>
            </div>

            <div className="library-content">
                <main aria-describedby="library-result-count" aria-label="Capture library" className={`capture-collection capture-collection--${view}`}>
                    {filtered.length === 0 ? (
                        <div className="library-empty"><Icon name={captures.length === 0 ? "image" : "search"} /><strong>{captures.length === 0 ? "No captures yet" : "No captures found"}</strong><span>{captures.length === 0 ? "Import local media or use a capture shortcut to begin." : "Try another search or filter."}</span>{captures.length === 0 ? <button className="button button--secondary" onClick={onImport} type="button"><Icon name="plus" size={15} /> Import media</button> : null}</div>
                    ) : visible.items.map((capture) => (
                        <article className={`capture-card${selectedId === capture.id ? " is-selected" : ""}`} key={capture.id}>
                            <button className="capture-card__select" onClick={() => onSelect(capture.id)} onDoubleClick={capture.kind === "video" ? () => onOpenEditor(capture.id) : undefined} type="button">
                                <span className="capture-card__visual">
                                    <MediaThumbnail capture={capture} />
                                    <span className={`type-badge type-badge--${capture.kind}`}><Icon name={capture.kind === "video" ? "video" : "capture"} size={12} /></span>
                                    {capture.duration ? <span className="duration-badge">{capture.duration}</span> : null}
                                </span>
                                <span className="capture-card__copy">
                                    <strong>{capture.name}</strong>
                                    <small>{capture.createdLabel}</small>
                                </span>
                            </button>
                            <div className="capture-card__actions">
                                {capture.kind === "video" ? <IconButton icon="edit" label={`Edit ${capture.name}`} onClick={() => onOpenEditor(capture.id)} /> : null}
                                <IconButton icon="folder" label={`Show ${capture.name} in folder`} onClick={() => revealCapture(capture.id)} />
                            </div>
                        </article>
                    ))}
                    {visible.remaining > 0 ? (
                        <div className="library-load-more">
                            <button
                                className="button button--secondary"
                                onClick={() => setVisibleLimit((current) => Math.min(visible.total, current + LIBRARY_BATCH_SIZE))}
                                type="button"
                            >Load {Math.min(LIBRARY_BATCH_SIZE, visible.remaining)} more</button>
                        </div>
                    ) : null}
                </main>

                {selected ? (
                    <aside className="capture-inspector" aria-label={`${selected.name} details`}>
                        <div className="capture-inspector__header">
                            <span>Details</span>
                            <IconButton icon="close" label="Close details" onClick={() => onSelect(null)} />
                        </div>
                        {selected.kind === "screenshot" ? (
                            <button
                                aria-label={`View ${selected.name} at full size`}
                                className="capture-inspector__preview capture-inspector__preview--button"
                                onClick={() => setViewerOpen(true)}
                                ref={previewButtonRef}
                                type="button"
                            >
                                <MediaThumbnail capture={selected} />
                                <span><Icon name="search" size={14} /> View</span>
                            </button>
                        ) : <div className="capture-inspector__preview"><MediaThumbnail capture={selected} /></div>}
                        <div className="capture-inspector__title"><span className={`workflow-icon workflow-icon--${selected.kind}`}><Icon name={selected.kind === "video" ? "video" : "capture"} size={16} /></span><div><strong>{selected.name}</strong><small>{selected.kind === "video" ? "Video recording" : "Screenshot"}</small></div></div>
                        <dl className="metadata-list">
                            <div><dt>Created</dt><dd>{selected.createdLabel}</dd></div>
                            <div><dt>Dimensions</dt><dd>{selected.dimensions}</dd></div>
                            {selected.duration ? <div><dt>Duration</dt><dd>{selected.duration}</dd></div> : null}
                            <div><dt>File size</dt><dd>{selected.size}</dd></div>
                            <div><dt>Workflow</dt><dd>{selected.workflow}</dd></div>
                        </dl>
                        <div className="capture-inspector__actions">
                            {selected.kind === "video" ? <button className="button button--primary" onClick={() => onOpenEditor(selected.id)} type="button"><Icon name="edit" size={16} /> Open editor</button> : null}
                            <button className="button button--ghost" onClick={() => revealCapture(selected.id)} type="button"><Icon name="folder" size={16} /> Show in folder</button>
                        </div>
                    </aside>
                ) : null}
            </div>

            {viewerOpen && selected?.kind === "screenshot" ? (
                <div className="screenshot-viewer" onClick={(event) => { if (event.target === event.currentTarget) setViewerOpen(false); }}>
                    <section aria-describedby="screenshot-viewer-detail" aria-labelledby="screenshot-viewer-title" aria-modal="true" className="screenshot-viewer__panel" role="dialog">
                        <header>
                            <span>
                                <strong id="screenshot-viewer-title">{selected.name}</strong>
                                <small id="screenshot-viewer-detail">{selected.dimensions} · {selected.size}</small>
                            </span>
                            <button aria-label="Close screenshot viewer" className="icon-button" onClick={() => setViewerOpen(false)} ref={viewerCloseRef} type="button"><Icon name="close" size={16} /></button>
                        </header>
                        <div className="screenshot-viewer__image">
                            <img alt={`Full-size preview of ${selected.name}`} decoding="async" src={selected.thumbnail} />
                        </div>
                    </section>
                </div>
            ) : null}
        </div>
    );
}
