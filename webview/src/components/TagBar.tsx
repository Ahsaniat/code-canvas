import { useState, useRef } from 'react';
import { useMetaStore } from '../store/metaStore';

interface Props {
  filePath: string;
}

// Simple hash → one of ~12 distinct hues for visual variety
function tagColor(tag: string): string {
  const hue = (tag.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
  return `hsl(${hue}, 55%, 40%)`;
}

export function TagBar({ filePath }: Props) {
  const { getFileMeta, addTag, removeTag } = useMetaStore();
  const tags = getFileMeta(filePath).tags ?? [];
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commitAdd() {
    const trimmed = input.trim().toLowerCase().replace(/\s+/g, '-');
    if (trimmed) addTag(filePath, trimmed);
    setInput('');
    setAdding(false);
  }

  function startAdd() {
    setAdding(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  if (tags.length === 0 && !adding) {
    return (
      <div className="tag-bar" onClick={(e) => e.stopPropagation()}>
        <button className="tag-add-btn" onClick={startAdd}>+ tag</button>
      </div>
    );
  }

  return (
    <div className="tag-bar" onClick={(e) => e.stopPropagation()}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="tag-chip"
          style={{ backgroundColor: tagColor(tag) }}
        >
          {tag}
          <button
            className="tag-chip-remove"
            onClick={(e) => { e.stopPropagation(); removeTag(filePath, tag); }}
          >
            ×
          </button>
        </span>
      ))}

      {adding ? (
        <input
          ref={inputRef}
          className="tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={commitAdd}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAdd();
            if (e.key === 'Escape') { setInput(''); setAdding(false); }
          }}
          placeholder="tag-name"
          maxLength={30}
        />
      ) : (
        <button className="tag-add-btn" onClick={startAdd}>+ tag</button>
      )}
    </div>
  );
}
