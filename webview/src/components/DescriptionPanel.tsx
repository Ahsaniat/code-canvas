import { useState, useRef } from 'react';
import { useMetaStore } from '../store/metaStore';
import { firstSentence } from '../text';

interface Props {
  filePath: string;
}

/**
 * Description editor.
 *
 * Descriptions are generated automatically by the extension host (doc comment
 * or export summary) and shown here as a dimmed fallback. Typing replaces them
 * with a manual description, which is stored in a separate field and always
 * wins from then on — regeneration cannot overwrite it.
 */
export function DescriptionPanel({ filePath }: Props) {
  // P1-2: subscribe only to this file's meta + the two actions used here.
  const fileMeta = useMetaStore((s) => s.files[filePath]);
  const setDescription = useMetaStore((s) => s.setDescription);
  const setDescriptionExpanded = useMetaStore((s) => s.setDescriptionExpanded);
  const expanded = fileMeta?.descriptionExpanded ?? false;
  const description = fileMeta?.description ?? '';
  const autoDescription = fileMeta?.autoDescription ?? '';
  const showingAuto = !description && !!autoDescription;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const full = description || autoDescription;
  // Collapsed shows the first sentence only. Descriptions are written so that
  // sentence stands alone as the summary, with the enumerated imports and graph
  // detail after it — the panel would otherwise dominate the node.
  const summary = firstSentence(full);
  const hasMore = !!full && summary.length < full.length;

  function toggleExpand() {
    setDescriptionExpanded(filePath, !expanded);
  }

  function startEdit() {
    // Seed the editor with the generated text so refining it is one keystroke
    // away, but never persist it until the user actually commits.
    setDraft(description || autoDescription);
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
        {showingAuto ? <span className="description-auto-badge" title="Generated from this file's doc comment or exports">auto</span> : null}
      </div>

      {/* Collapsed: the one-line summary, so the panel is useful without opening. */}
      {!expanded && full ? (
        <p
          className={`description-summary ${showingAuto ? 'description-auto' : ''}`}
          onClick={toggleExpand}
        >
          {summary}{hasMore ? <span className="description-more"> more…</span> : null}
        </p>
      ) : null}

      {/* Content — visible only when expanded */}
      {expanded && (
        <div className="description-body">
          {editing ? (
            <textarea
              ref={textareaRef}
              className="description-textarea nodrag nopan"
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
              className={`description-text ${!description && !autoDescription ? 'description-placeholder' : ''} ${showingAuto ? 'description-auto' : ''}`}
              onClick={startEdit}
              title="Click to edit"
            >
              {full || 'Add a description for this file…'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
