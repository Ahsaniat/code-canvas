import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MatchField, SearchHit } from '../model/search';

export interface SearchBoxHandle {
    focus(): void;
}

interface SearchBoxProps {
    query: string;
    onQueryChange(next: string): void;
    /** Already ranked and capped for display. */
    hits: SearchHit[];
    /** Total matches, which may exceed `hits.length`. */
    totalMatches: number;
    onPick(hit: SearchHit): void;
    filterOn: boolean;
    onToggleFilter(): void;
}

const FIELD_LABEL: Record<MatchField, string> = {
    name: 'name',
    path: 'path',
    symbol: 'export',
    tag: 'tag',
};

/**
 * Search input plus its result list.
 *
 * The active-row index lives here rather than in `App` on purpose: arrowing
 * through results must not re-render the canvas.
 */
export const SearchBox = forwardRef<SearchBoxHandle, SearchBoxProps>(function SearchBox(
    { query, onQueryChange, hits, totalMatches, onPick, filterOn, onToggleFilter },
    ref,
) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const [active, setActive] = useState(0);
    const [open, setOpen] = useState(false);

    useImperativeHandle(ref, () => ({
        focus() {
            inputRef.current?.focus();
            inputRef.current?.select();
            setOpen(true);
        },
    }), []);

    // A new result set invalidates the old cursor position.
    useEffect(() => { setActive(0); }, [query]);

    // Keep the active row in view when arrowing past the visible window.
    useEffect(() => {
        if (!open) return;
        const row = listRef.current?.querySelector<HTMLElement>('.search-hit--active');
        row?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const showList = open && query.trim().length > 0;

    function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(i => (hits.length ? (i + 1) % hits.length : 0));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(i => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const hit = hits[active];
            if (hit) {
                onPick(hit);
                setOpen(false);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            // First Escape closes the list, a second one clears the query: the
            // query is worth keeping while  looking at the canvas underneath.
            if (showList) setOpen(false);
            else if (query) onQueryChange('');
            else inputRef.current?.blur();
        }
        // Everything else — including Space and `e` — stays with the input.
        event.stopPropagation();
    }

    return (
        <div className="search-box">
            <div className="search-input-row">
                <span className="search-icon" aria-hidden="true">⌕</span>
                <input
                    ref={inputRef}
                    className="search-input"
                    type="text"
                    value={query}
                    placeholder="Search  (name, path, export, tag)"
                    title="Plain text searches every field. Prefixes: name: path: sym: tag:"
                    spellCheck={false}
                    onChange={e => { onQueryChange(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onKeyDown}
                />
                {query ? (
                    <button
                        className="search-clear"
                        title="Clear search (Esc)"
                        onClick={() => { onQueryChange(''); inputRef.current?.focus(); }}
                    >
                        ×
                    </button>
                ) : null}
                <button
                    className={`search-filter-toggle ${filterOn ? 'search-filter-toggle--active' : ''}`}
                    title="Dim every node that does not match"
                    onClick={onToggleFilter}
                >
                    Filter
                </button>
            </div>

            {showList ? (
                <div className="search-results" ref={listRef}>
                    {hits.length === 0 ? (
                        <div className="search-empty">No matches</div>
                    ) : (
                        <>
                            {hits.map((hit, i) => (
                                <button
                                    key={hit.id}
                                    className={`search-hit ${i === active ? 'search-hit--active' : ''}`}
                                    // `mousedown` fires before the input's blur, so the
                                    // click is not lost to the list unmounting.
                                    onMouseDown={e => { e.preventDefault(); onPick(hit); setOpen(false); }}
                                    onMouseEnter={() => setActive(i)}
                                >
                                    <span className="search-hit-kind">{hit.kind === 'folder' ? '▣' : '◧'}</span>
                                    <span className="search-hit-label">{hit.label}</span>
                                    {hit.detail ? <span className="search-hit-detail">{hit.detail}</span> : null}
                                    <span className="search-hit-field">{FIELD_LABEL[hit.field]}</span>
                                </button>
                            ))}
                            {totalMatches > hits.length ? (
                                <div className="search-more">+{totalMatches - hits.length} more</div>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
});
