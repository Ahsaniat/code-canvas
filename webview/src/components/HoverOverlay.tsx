import React, { forwardRef, useImperativeHandle, useState } from 'react';
import type { EdgeRelationship } from '../model/graphModel';

/**
 * Floating edge tooltip.
 *
 * Only EDGES get an overlay. A file or folder renders its own description on the
 * node, so a hover banner there just repeated visible text while covering the
 * canvas behind it; a wire has nowhere to put its symbol list, so it still needs
 * one. Living outside the React Flow subtree and driven imperatively through a
 * ref, this re-renders alone — the canvas, nodes and edges are untouched.
 */

export interface EdgeOverlayPayload {
    sourceLabel: string;
    targetLabel: string;
    aggregated: boolean;
    relationships: EdgeRelationship[];
    x: number;
    y: number;
}

export interface HoverOverlayHandle {
    showEdge: (payload: EdgeOverlayPayload | null) => void;
    clear: () => void;
}

const MAX_TOOLTIP_ROWS = 10;
const MAX_SYMBOLS_PER_ROW = 6;

function EdgeTooltip({ payload }: { payload: EdgeOverlayPayload }) {
    const rows = payload.relationships.slice(0, MAX_TOOLTIP_ROWS);
    const hidden = payload.relationships.length - rows.length;
    return (
        <div className="canvas-overlay edge-tooltip" style={{ left: payload.x, top: payload.y }}>
            <div className="canvas-overlay-title">
                {payload.sourceLabel} <span className="edge-tooltip-arrow">→</span> {payload.targetLabel}
            </div>
            {payload.aggregated ? (
                <div className="canvas-overlay-detail">
                    {payload.relationships.length} file relationship{payload.relationships.length === 1 ? '' : 's'}
                </div>
            ) : null}
            <ul className="edge-tooltip-list">
                {rows.map((rel, i) => {
                    const symbols = rel.symbols.slice(0, MAX_SYMBOLS_PER_ROW);
                    const more = rel.symbols.length - symbols.length;
                    return (
                        <li key={`${rel.sourcePath}->${rel.targetPath}-${i}`}>
                            <span className="edge-tooltip-pair">{rel.sourceLabel} → {rel.targetLabel}</span>
                            {symbols.length ? (
                                <span className="edge-tooltip-symbols">
                                    {symbols.join(', ')}{more > 0 ? ` +${more} more` : ''}
                                </span>
                            ) : (
                                <span className="edge-tooltip-symbols edge-tooltip-symbols--empty">whole module</span>
                            )}
                        </li>
                    );
                })}
            </ul>
            {hidden > 0 ? <div className="edge-tooltip-more">+{hidden} more file pair{hidden === 1 ? '' : 's'}</div> : null}
        </div>
    );
}

/**
 * Skip state updates that would paint an identical tooltip.
 *
 * Pointer moves fire many times per second and each builds a fresh payload
 * object, so without this guard an unchanged tooltip re-renders on every event.
 */
function sameEdgePayload(a: EdgeOverlayPayload | null, b: EdgeOverlayPayload | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y
        && a.sourceLabel === b.sourceLabel && a.targetLabel === b.targetLabel
        && a.relationships === b.relationships;
}

export const HoverOverlay = forwardRef<HoverOverlayHandle>(function HoverOverlay(_props, ref) {
    const [edge, setEdge] = useState<EdgeOverlayPayload | null>(null);

    useImperativeHandle(ref, () => ({
        showEdge: (next) => setEdge(prev => (sameEdgePayload(prev, next) ? prev : next)),
        clear: () => setEdge(null),
    }), []);

    return edge ? <EdgeTooltip payload={edge} /> : null;
});
