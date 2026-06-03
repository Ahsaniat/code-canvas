import { useMetaStore } from '../store/metaStore';

export function TagFilterToolbar() {
  const { getAllTags, activeTagFilters, tagFilterMode, toggleTagFilter, setTagFilterMode, clearTagFilters } =
    useMetaStore();
  const tags = getAllTags();

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
