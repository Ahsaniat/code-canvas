import { BaseEdge, EdgeProps, getSmoothStepPath } from 'reactflow';
import type { EdgeRelationship } from '../model/graphModel';

export interface CircuitEdgeData {
    /** Pre-computed SVG path. Routing NEVER happens in this render body. */
    d?: string;
    relationships: EdgeRelationship[];
    aggregated: boolean;
}

/**
 * Thin white "wire" edge.
 *
 * The geometry is computed in a memo upstream (see edges/route.ts) and delivered
 * through `data.d`. This component only paints it. If a route is missing — the
 * very first frame after a projection change — it degrades to React Flow's own
 * orthogonal smoothstep path so an edge is never invisible.
 */
export function CircuitEdge(props: EdgeProps<CircuitEdgeData>) {
    const { id, data, style, markerEnd, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
    let path = data?.d;
    if (!path) {
        [path] = getSmoothStepPath({
            sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8,
        });
    }
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={22} />;
}

// Defined ONCE at module scope -> stable identity forever, exactly like nodeTypes.
export const edgeTypes = { circuit: CircuitEdge } as const;
