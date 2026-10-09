import { useMemo } from 'react';
import { useMetaStore } from '../store/metaStore';

export function TagFilterToolbar() {
  // Selective subscriptions: the toolbar used to subscribe to the whole store
  // without a selector, so every description keystroke re-rendered it.
  const files = useMetaStore((s) => s.files);
  const activeTagFilters = useMetaStore((s) => s.activeTagFilters);
  const tagFilterMode = useMetaStore((s) => s.tagFilterMode);
  const toggleTagFilter = useMetaStore((s) => s.toggleTagFilter);
  const setTagFilterMode = useMetaStore((s) => s.setTagFilterMode);
  const clearTagFilters = useMetaStore((s) => s.clearTagFilters);

  // Derived once per meta change instead of once per render.
  const tags = useMemo(() => {
    const all = new Set<string>();
    for (const f of Object.values(files)) f.tags?.forEach((t) => all.add(t));
    return Array.from(all).sort();
  }, [files]);

  if (tags.length === 0) return null;

  return (
    <div className="tag-filter-toolbar">
      <span className="tag-filter-label">Filter by tag:</span>

      {tags.map((tag) => (
        <button
          key={tag}
          className={`tag-filter-pill ${activeTagFilters.includes(tag) ? 'tag-filter-pill--active' : ''}`}
          onClick={() => toggleTagFilter(tag)}
        >
          {tag}
        </button>
      ))}

      {activeTagFilters.length > 0 && (
        <>
          <button
            className="tag-filter-mode"
            title="Toggle AND/OR matching"
            onClick={() => setTagFilterMode(tagFilterMode === 'OR' ? 'AND' : 'OR')}
          >
            {tagFilterMode}
          </button>
          <button className="tag-filter-clear" onClick={clearTagFilters}>
            ✕ clear
          </button>
        </>
      )}
    </div>
  );
}
