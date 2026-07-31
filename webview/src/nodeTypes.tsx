import React, { createContext, useContext, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals } from 'reactflow';
import CodeCard, { CodeCardHandle } from './code/CodeCard';
import { DescriptionPanel } from './components/DescriptionPanel';
import { TagBar } from './components/TagBar';
import { useMetaStore } from './store/metaStore';
import { firstSentence } from './text';

// ---------------------------------------------------------------------------
// Canvas context
//
// P0-2: `nodeTypes` MUST have a stable identity for the lifetime of the app,
// otherwise React Flow remounts every node (and re-runs highlight.js) on each
// render. All dynamic state the node components need is delivered through this
// context instead of a closure captured inside `nodeTypes`.
// ---------------------------------------------------------------------------

export interface FolderNodeData {
    label: string;
    path?: string;
    fileCount: number;
    inDegree: number;
    outDegree: number;
    expandable: boolean;
    expanded: boolean;
    dim?: boolean;
}

export interface CanvasContextValue {
    zoomOk: boolean;
    wrap: boolean;
    codeCacheRef: React.MutableRefObject<Record<string, string>>;
    codeRefs: React.MutableRefObject<Record<string, React.RefObject<CodeCardHandle>>>;
    onTokenClick: (payload: { path: string; line: number; character: number; token: string }) => void;
    onOpenFile: (path: string) => void;
    onToggleFolder: (id: string) => void;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

function useCanvas(): CanvasContextValue {
    const ctx = useContext(CanvasContext);
    if (!ctx) throw new Error('CanvasContext provider missing');
    return ctx;
}

function computePlaceholderFontPx(label: string, widthPx: number | undefined): number {
    const width = Math.max(120, (widthPx ?? 480) * 0.9);
    const chars = Math.max(1, (label || '').length);
    return Math.min(96, Math.max(18, Math.floor(width / (chars * 0.55))));
}

/**
 * The description shown on a node: the user's own text always wins, the
 * generated one is the fallback.
 */
function useEffectiveDescription(path: string | undefined): { text: string; auto: boolean } {
    const meta = useMetaStore(s => (path ? s.files[path] : undefined));
    if (meta?.description) return { text: meta.description, auto: false };
    if (meta?.autoDescription) return { text: meta.autoDescription, auto: true };
    return { text: '', auto: false };
}

/** Shared expand/collapse affordance. `nodrag` keeps React Flow from panning. */
function ExpandButton({ id, expanded, onToggle }: { id: string; expanded: boolean; onToggle: (id: string) => void }) {
    return (
        <button
            className="folder-chevron nodrag nopan"
            title={expanded ? 'Collapse folder' : 'Expand folder'}
            aria-expanded={expanded}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onToggle(id); }}
        >
            {expanded ? '▾' : '▸'}
        </button>
    );
}

// ---------------------------------------------------------------------------
// File node
// ---------------------------------------------------------------------------

function FileCanvasNode(p: NodeProps) {
    const ctx = useCanvas();
    const data = p.data as { label: string; path: string; lang: any; dim?: boolean; width?: number };
    const path = data.path;
    const content = ctx.codeCacheRef.current[path] ?? path;

    // P1-2: selective store subscriptions — this node re-renders only when ITS
    // own meta changes, not on every unrelated store update.
    const fileMeta = useMetaStore(s => s.files[path]);
    const setCollapsed = useMetaStore(s => s.setCollapsed);
    const collapsed = fileMeta?.collapsed ?? false;
    const descriptionExpanded = fileMeta?.descriptionExpanded ?? false;

    if (!ctx.codeRefs.current[p.id]) ctx.codeRefs.current[p.id] = React.createRef();

    const updateNodeInternals = useUpdateNodeInternals();
    useEffect(() => {
        updateNodeInternals(p.id);
    }, [collapsed, descriptionExpanded, p.id, updateNodeInternals]);

    const placeholderSize = computePlaceholderFontPx(data.label, data.width);

    return (
        <div className={`file-node ${collapsed ? 'code-card--collapsed' : ''}`} style={{ opacity: data.dim ? 0.25 : 1 }}>
            <div className="file-node-header label-fixed code-card-header" onDoubleClick={() => ctx.onOpenFile(path)}>
                <span className="code-card-filename">{data.label}</span>
                <button
                    className="code-card-collapse-btn nodrag nopan"
                    title={collapsed ? 'Expand node' : 'Collapse node'}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setCollapsed(path, !collapsed); }}
                >
                    {collapsed ? '+' : '−'}
                </button>
            </div>

            <DescriptionPanel filePath={path} />
            <TagBar filePath={path} />

            {!collapsed && (ctx.zoomOk ? (
                <CodeCard
                    ref={ctx.codeRefs.current[p.id]}
                    key={path}
                    file={path}
                    lang={data.lang}
                    content={content}
                    onTokenClick={ctx.onTokenClick}
                    wrap={ctx.wrap}
                />
            ) : (
                <div className="node-placeholder-body" data-label={data.label}>
                    <div className="node-placeholder-title" style={{ fontSize: placeholderSize }}>{data.label}</div>
                    <div style={{ opacity: 0.75 }}>Zoom in to view code</div>
                </div>
            ))}

            <Handle type="source" position={Position.Right} />
            <Handle type="target" position={Position.Left} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Collapsed folder — an ORDINARY node, deliberately not a React Flow group.
// This is what keeps the default view free of nested containers.
// ---------------------------------------------------------------------------

function FolderCanvasNode(p: NodeProps<FolderNodeData>) {
    const ctx = useCanvas();
    const data = p.data;
    const description = useEffectiveDescription(data.path);

    return (
        <div className="folder-node" style={{ opacity: data.dim ? 0.3 : 1 }}>
            <div className="folder-node-header label-fixed">
                {data.expandable ? <ExpandButton id={p.id} expanded={false} onToggle={ctx.onToggleFolder} /> : <span className="folder-chevron folder-chevron--empty" />}
                <span className="folder-node-name">{data.label}</span>
            </div>
            {/* No `title` attribute on the description: a native tooltip trails
                the cursor and ignores any JS timer, which is what made the old
                banner follow the mouse and never leave. Only the first sentence
                is shown here — the rest is detail, not a node label. */}
            <div className="folder-node-body">
                <div className="folder-node-badges">
                    <span className="folder-badge" title="Files in this folder (recursive)">{data.fileCount} file{data.fileCount === 1 ? '' : 's'}</span>
                    <span className="folder-badge folder-badge--in" title="Incoming imports from outside this folder">in {data.inDegree}</span>
                    <span className="folder-badge folder-badge--out" title="Outgoing imports to outside this folder">out {data.outDegree}</span>
                </div>
                {description.text ? (
                    <div className={`folder-node-description ${description.auto ? 'is-auto' : ''}`}>
                        {firstSentence(description.text)}
                    </div>
                ) : null}
            </div>

            <Handle type="source" position={Position.Right} />
            <Handle type="target" position={Position.Left} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Expanded folder — the React Flow container. Its size comes from the layout
// pass (see layout.ts) and is never revised afterwards.
// ---------------------------------------------------------------------------

function GroupCanvasNode(p: NodeProps<FolderNodeData>) {
    const ctx = useCanvas();
    const data = p.data;

    return (
        <div className="group-node" data-selected={p.selected ? 'true' : 'false'}>
            <div className="group-label label-fixed">
                <ExpandButton id={p.id} expanded onToggle={ctx.onToggleFolder} />
                <span className="group-label-name">{data.label}</span>
                <span className="folder-badge folder-badge--in">in {data.inDegree}</span>
                <span className="folder-badge folder-badge--out">out {data.outDegree}</span>
            </div>
            <Handle type="source" position={Position.Right} />
            <Handle type="target" position={Position.Left} />
        </div>
    );
}

// Defined ONCE at module scope → stable identity forever.
export const nodeTypes = { file: FileCanvasNode, folder: FolderCanvasNode, group: GroupCanvasNode } as const;
