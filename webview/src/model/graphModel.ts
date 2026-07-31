/**
 * Collapse-first graph model.
 *
 * The extension hands over the FULL file tree. Rendering that tree as nested
 * React Flow groups is what produced both the stacked-container bug and the lag,
 * so the tree is kept here as plain data and only a *projection* of it — derived
 * from the set of expanded folders — is ever handed to React Flow.
 *
 * Invariants:
 *  - The real file->file import edges live here and are never given to React Flow.
 *  - A collapsed folder is an ordinary leaf node, not a container.
 *  - Every projected edge carries the underlying file pairs + symbols, so the
 *    hover tooltip works identically at folder level and at file level.
 */

export type RawNodeType = 'file' | 'group';

export interface RawNode {
    id: string;
    label: string;
    type: RawNodeType;
    path?: string;
    lang?: string;
    parentId?: string;
}

export interface RawEdgeLink {
    symbolName?: string;
    alias?: string;
    kind?: string;
    sourceLine?: number;
    targetLine: number;
}

export interface RawEdge {
    id: string;
    source: string;
    target: string;
    sourceLine?: number;
    targetLine?: number;
    links?: RawEdgeLink[];
}

export interface ModelNode {
    id: string;
    label: string;
    kind: 'file' | 'folder';
    path?: string;
    lang?: string;
    parentId?: string;
    childIds: string[];
    /** Number of file descendants (a folder's own weight in the tree). */
    fileCount: number;
}

export interface GraphModel {
    nodes: Map<string, ModelNode>;
    /** Ids rendered at the canvas root — the workspace root folder is elided. */
    displayRoots: string[];
    edges: RawEdge[];
    /** Every folder id, deepest first: handy for "expand all up to depth N". */
    folderIds: string[];
}

const EMPTY_MODEL: GraphModel = { nodes: new Map(), displayRoots: [], edges: [], folderIds: [] };

/**
 * Build the model. Folders with a single folder child are NOT collapsed away —
 * that would make the expand affordance lie about the tree.
 */
export function buildModel(rawNodes: RawNode[], rawEdges: RawEdge[]): GraphModel {
    if (!rawNodes?.length) return EMPTY_MODEL;

    const nodes = new Map<string, ModelNode>();
    for (const n of rawNodes) {
        nodes.set(n.id, {
            id: n.id,
            label: n.label,
            kind: n.type === 'group' ? 'folder' : 'file',
            path: n.path,
            lang: n.lang,
            parentId: n.parentId,
            childIds: [],
            fileCount: 0,
        });
    }

    const roots: string[] = [];
    for (const n of nodes.values()) {
        const parent = n.parentId ? nodes.get(n.parentId) : undefined;
        if (parent) parent.childIds.push(n.id);
        else roots.push(n.id);
    }

    // Folders before files, then alphabetically: a stable, readable child order.
    for (const n of nodes.values()) {
        n.childIds.sort((a, b) => {
            const na = nodes.get(a)!;
            const nb = nodes.get(b)!;
            if (na.kind !== nb.kind) return na.kind === 'folder' ? -1 : 1;
            return na.label.localeCompare(nb.label);
        });
    }

    // Descendant file counts, computed iteratively so a pathological tree depth
    // cannot blow the stack.
    for (const id of postOrder(nodes, roots)) {
        const n = nodes.get(id)!;
        n.fileCount = n.kind === 'file' ? 1 : 0;
        for (const c of n.childIds) n.fileCount += nodes.get(c)!.fileCount;
    }

    // The workspace root folder is a wrapper, not a thing the user wants to
    // click. Elide it so the default view is "top-level folders, all collapsed".
    let displayRoots = roots;
    if (roots.length === 1) {
        const only = nodes.get(roots[0])!;
        if (only.kind === 'folder' && only.childIds.length > 0) displayRoots = only.childIds;
    }

    const folderIds = postOrder(nodes, displayRoots).filter(id => nodes.get(id)!.kind === 'folder');

    return { nodes, displayRoots, edges: rawEdges ?? [], folderIds };
}

function postOrder(nodes: Map<string, ModelNode>, roots: string[]): string[] {
    const out: string[] = [];
    const stack: Array<{ id: string; visited: boolean }> = roots.map(id => ({ id, visited: false }));
    const seen = new Set<string>();
    while (stack.length) {
        const frame = stack.pop()!;
        if (frame.visited) { out.push(frame.id); continue; }
        if (seen.has(frame.id)) continue;
        seen.add(frame.id);
        stack.push({ id: frame.id, visited: true });
        for (const c of nodes.get(frame.id)?.childIds ?? []) stack.push({ id: c, visited: false });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type ProjectedNodeKind = 'file' | 'folder' | 'group';

export interface ProjectedNode {
    id: string;
    /** 'group' = expanded folder (a React Flow container); 'folder' = collapsed. */
    kind: ProjectedNodeKind;
    label: string;
    path?: string;
    lang?: string;
    parentId?: string;
    fileCount: number;
    inDegree: number;
    outDegree: number;
    expandable: boolean;
}

/** One underlying file->file relationship behind a (possibly aggregated) edge. */
export interface EdgeRelationship {
    sourcePath: string;
    targetPath: string;
    sourceLabel: string;
    targetLabel: string;
    symbols: string[];
    sourceLine?: number;
    targetLine?: number;
}

export interface ProjectedEdge {
    id: string;
    source: string;
    target: string;
    /** Underlying file pairs, deduped. Drives the hover tooltip. */
    relationships: EdgeRelationship[];
    /** True when both endpoints are files (a single, concrete import). */
    direct: boolean;
    sourceLine?: number;
    targetLine?: number;
}

export interface Projection {
    nodes: ProjectedNode[];
    edges: ProjectedEdge[];
    /** Paths of the file nodes currently on the canvas — drives code fetching. */
    visibleFilePaths: string[];
}

const EMPTY_PROJECTION: Projection = { nodes: [], edges: [], visibleFilePaths: [] };

/**
 * Derive the React-Flow-visible graph.
 *
 * Every file is mapped UP to its nearest visible ancestor; self-loops are
 * dropped and the remainder deduped. A collapsed folder therefore shows the
 * union of its descendants' external edges (requirement 4), and expanding it
 * re-anchors those edges onto the specific child (requirement 5).
 *
 * The returned array is already parents-before-children (React Flow v11
 * requires it): the walk is breadth-first over the visible tree.
 */
export function projectGraph(
    model: GraphModel,
    expanded: ReadonlySet<string>,
    hidden: ReadonlySet<string> = new Set()
): Projection {
    if (!model.nodes.size) return EMPTY_PROJECTION;

    const visible: ProjectedNode[] = [];
    const visibleFilePaths: string[] = [];
    // fileId (or folder id) -> the visible node that represents it on canvas.
    const representative = new Map<string, string>();

    type Frame = { id: string; parentId?: string };
    const queue: Frame[] = model.displayRoots.map(id => ({ id, parentId: undefined }));

    while (queue.length) {
        const { id, parentId } = queue.shift()!;
        if (hidden.has(id)) continue;
        const node = model.nodes.get(id);
        if (!node) continue;

        if (node.kind === 'file') {
            representative.set(id, id);
            visible.push(makeProjectedNode(node, 'file', parentId));
            if (node.path) visibleFilePaths.push(node.path);
            continue;
        }

        const isExpanded = expanded.has(id) && node.childIds.length > 0;
        if (!isExpanded) {
            // Collapsed: an ordinary leaf that stands in for every descendant.
            representative.set(id, id);
            for (const descendant of descendantsOf(model, id)) representative.set(descendant, id);
            visible.push(makeProjectedNode(node, 'folder', parentId));
            continue;
        }

        representative.set(id, id);
        visible.push(makeProjectedNode(node, 'group', parentId));
        for (const c of node.childIds) queue.push({ id: c, parentId: id });
    }

    const edges = projectEdges(model, representative, visible);

    // In/out degree badges come straight from the projected edge set.
    const byId = new Map(visible.map(n => [n.id, n] as const));
    for (const e of edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (s) s.outDegree += e.relationships.length || 1;
        if (t) t.inDegree += e.relationships.length || 1;
    }

    return { nodes: visible, edges, visibleFilePaths };
}

const canExpand = (model: GraphModel, id: string): boolean => {
    const n = model.nodes.get(id);
    return !!n && n.kind === 'folder' && n.childIds.length > 0;
};

/**
 * Pick the opening view.
 *
 * Collapsing everything sounds like the safe default and is in fact the worst
 * one: at the coarsest level almost every import is INTERNAL to a top-level
 * folder, so every edge projects to a self-loop and is dropped. A monorepo whose
 * roots are `extension/` and `webview/` opens as two boxes, no edges, both
 * classified orphans — which is nothing anyone can read.
 *
 * So expand level by level until the canvas is actually informative: enough
 * nodes to be worth looking at AND at least one edge that survives projection.
 * The edge condition is the important half — a view with no edges is not a
 * graph, and it is worth overshooting the node target to escape one.
 */
export function initialExpansion(
    model: GraphModel,
    targetNodes = 24,
    hardCap = 80,
    maxDepth = 6
): Set<string> {
    const expanded = new Set<string>();
    if (!model.nodes.size) return expanded;

    let frontier = model.displayRoots.filter(id => canExpand(model, id));

    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
        const projection = projectGraph(model, expanded);
        if (projection.edges.length > 0 && projection.nodes.length >= targetNodes) break;

        const cost = frontier.reduce((sum, id) => sum + (model.nodes.get(id)?.childIds.length ?? 0), 0);
        // Only let the node cap stop us once the view already shows edges.
        if (projection.edges.length > 0 && projection.nodes.length + cost > hardCap) break;

        const next: string[] = [];
        for (const id of frontier) {
            expanded.add(id);
            for (const child of model.nodes.get(id)?.childIds ?? []) {
                if (canExpand(model, child)) next.push(child);
            }
        }
        frontier = next;
    }

    return expanded;
}

function makeProjectedNode(node: ModelNode, kind: ProjectedNodeKind, parentId?: string): ProjectedNode {
    return {
        id: node.id,
        kind,
        label: node.label,
        path: node.path,
        lang: node.lang,
        parentId,
        fileCount: node.fileCount,
        inDegree: 0,
        outDegree: 0,
        expandable: node.kind === 'folder' && node.childIds.length > 0,
    };
}

function descendantsOf(model: GraphModel, rootId: string): string[] {
    const out: string[] = [];
    const stack = [...(model.nodes.get(rootId)?.childIds ?? [])];
    let guard = 0;
    while (stack.length && guard++ < 200000) {
        const id = stack.pop()!;
        out.push(id);
        const n = model.nodes.get(id);
        if (n) for (const c of n.childIds) stack.push(c);
    }
    return out;
}

function projectEdges(
    model: GraphModel,
    representative: Map<string, string>,
    visible: ProjectedNode[]
): ProjectedEdge[] {
    const visibleIds = new Set(visible.map(n => n.id));
    const kinds = new Map(visible.map(n => [n.id, n.kind] as const));
    const byKey = new Map<string, ProjectedEdge>();
    const seenPairs = new Map<string, Set<string>>();

    for (const e of model.edges) {
        const a = representative.get(e.source);
        const b = representative.get(e.target);
        if (!a || !b || a === b) continue;              // dropped or self-loop
        if (!visibleIds.has(a) || !visibleIds.has(b)) continue;

        const key = `${a} ${b}`;
        let projected = byKey.get(key);
        if (!projected) {
            projected = {
                id: `pe_${a}__${b}`,
                source: a,
                target: b,
                relationships: [],
                direct: kinds.get(a) === 'file' && kinds.get(b) === 'file',
            };
            byKey.set(key, projected);
            seenPairs.set(key, new Set());
        }

        const srcNode = model.nodes.get(e.source);
        const tgtNode = model.nodes.get(e.target);
        const pairKey = `${e.source} ${e.target}`;
        const pairs = seenPairs.get(key)!;
        if (pairs.has(pairKey)) continue;
        pairs.add(pairKey);

        projected.relationships.push({
            sourcePath: srcNode?.path ?? e.source,
            targetPath: tgtNode?.path ?? e.target,
            sourceLabel: srcNode?.label ?? e.source,
            targetLabel: tgtNode?.label ?? e.target,
            symbols: symbolsOf(e),
            sourceLine: e.sourceLine,
            targetLine: e.targetLine,
        });
    }

    // A direct file->file edge keeps its line anchors so clicking it can still
    // scroll both code cards to the import site.
    for (const projected of byKey.values()) {
        if (projected.direct && projected.relationships.length === 1) {
            projected.sourceLine = projected.relationships[0].sourceLine;
            projected.targetLine = projected.relationships[0].targetLine;
        }
    }

    return Array.from(byKey.values());
}

function symbolsOf(e: RawEdge): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const link of e.links ?? []) {
        const name = link.symbolName
            ?? (link.kind === 'default' ? 'default' : undefined)
            ?? (link.kind === 'namespace' || link.kind === 'module' ? '* (namespace)' : undefined)
            ?? (link.kind === 'side-effect' ? '(side effect)' : undefined)
            ?? (link.kind === 'dynamic' ? '(dynamic import)' : undefined);
        if (!name) continue;
        const label = link.alias && link.alias !== name ? `${name} as ${link.alias}` : name;
        if (seen.has(label)) continue;
        seen.add(label);
        out.push(label);
    }
    return out;
}

/**
 * Expanding a nested folder only makes sense when every ancestor is expanded
 * too, so toggling one on pulls its whole ancestor chain with it.
 */
export function expandWithAncestors(model: GraphModel, expanded: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(expanded);
    let cur: string | undefined = id;
    let guard = 0;
    const displayRootSet = new Set(model.displayRoots);
    while (cur && guard++ < 10000) {
        next.add(cur);
        if (displayRootSet.has(cur)) break;
        cur = model.nodes.get(cur)?.parentId;
    }
    return next;
}

/** Collapsing a folder also collapses everything beneath it. */
export function collapseWithDescendants(model: GraphModel, expanded: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(expanded);
    next.delete(id);
    for (const d of descendantsOf(model, id)) next.delete(d);
    return next;
}
