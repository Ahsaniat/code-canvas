export type Box = { w: number; h: number };
export type Pt = { x: number; y: number };

/**
 * Everything an engine needs to place the DIRECT children of one container.
 *
 * `sizeOf` is the single source of truth for geometry: for a nested container it
 * already returns that container's FINAL size, because containers are laid out
 * deepest-first. An engine must never cause a size to be revised afterwards —
 * that is precisely what made enlarged containers stack on top of each other.
 */
export interface EngineContext {
    childIds: string[];
    sizeOf: (id: string) => Box;
    /** Edges strictly between two of `childIds`, deduped, no self-loops. */
    edges: Array<[string, string]>;
    /**
     * Total connections of a child, counting links that leave the container.
     * A file whose only import points outside its folder is NOT an orphan.
     */
    degreeOf: (id: string) => number;
}

/** Returns child positions normalized so the minimum x and y are both 0. */
export type Engine = (ctx: EngineContext) => Map<string, Pt> | Promise<Map<string, Pt>>;

/** Normalize a raw position map so the minimum x and y become 0. */
export function normalize(pos: Map<string, Pt>): Map<string, Pt> {
    let minX = Infinity;
    let minY = Infinity;
    for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    const out = new Map<string, Pt>();
    for (const [id, p] of pos) out.set(id, { x: p.x - minX, y: p.y - minY });
    return out;
}
