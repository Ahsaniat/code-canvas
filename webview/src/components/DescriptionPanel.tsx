import { useState, useRef } from 'react';
import { useMetaStore } from '../store/metaStore';

interface Props {
  filePath: string;
}

export function DescriptionPanel({ filePath }: Props) {
  const { getFileMeta, setDescription, setDescriptionExpanded } = useMetaStore();
  const meta = getFileMeta(filePath);
  const expanded = meta.descriptionExpanded ?? false;
  const description = meta.description ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function toggleExpand() {
    setDescriptionExpanded(filePath, !expanded);
  }

  function startEdit() {
    setDraft(description);
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function commitEdit() {
    setDescription(filePath, draft.trim());
    setEditing(false);
  }

  return (
    <div className="description-panel">
      {/* Toggle row — always visible */}
      <div className="description-toggle" onClick={toggleExpand}>
        <span className="description-toggle-arrow">{expanded ? '▼' : '▶'}</span>
        <span className="description-toggle-label">File Description</span>
      </div>

      {/* Content — visible only when expanded */}
      {expanded && (
        <div className="description-body">
          {editing ? (
            <textarea
              ref={textareaRef}
              className="description-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey) commitEdit();
                if (e.key === 'Escape') setEditing(false);
              }}
              placeholder="Describe this file: purpose, algorithms, methods used…"
              rows={4}
            />
          ) : (
            <p
              className={`description-text ${!description ? 'description-placeholder' : ''}`}
              onClick={startEdit}
              title="Click to edit"
            >
              {description || 'Add a description for this file…'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
