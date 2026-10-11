import * as vscode from 'vscode';
import * as fs from 'fs';

export type GraphNode = {
    id: string;
    label: string;
    path?: string;
    lang?: 'ts' | 'js' | 'tsx' | 'jsx' | 'py' | 'other';
    type: 'file' | 'group';
    // React Flow v11.11 preferred field (was `parentNode`). See P2-4.
    parentId?: string;
    /**
     * Top-level exported symbol names, on file nodes only.
     *
     * These are already extracted for the auto-descriptions, so shipping them
     * costs one extra array per file and lets the webview answer "which file
     * exports `foo`?" without a round trip — the canvas is collapse-first, so
     * search must be able to reach files that are not currently rendered.
     */
    symbols?: string[];
};

/** How a binding crossed the module boundary. Drives the edge hover tooltip. */
export type ImportKind =
    | 'named'
    | 'default'
    | 'namespace'
    | 'side-effect'
    | 'reexport'
    | 'dynamic'
    | 'require'
    | 'module';

/**
 * One imported/exported binding behind an import edge. `symbolName` is the name
 * as provided by the SOURCE module; `alias` is the local name in the TARGET
 * module when the two differ. `sourceLine`/`targetLine` are lines in the source
 * and target files respectively (the definition and the import statement).
 */
export type EdgeLink = {
    symbolName?: string;
    alias?: string;
    kind?: ImportKind;
    sourceLine?: number;
    targetLine: number;
};

export type GraphEdge = {
    id: string;
    /** File that PROVIDES the symbols (the imported module). */
    source: string;
    /** File that CONSUMES them (the importing module). */
    target: string;
    /** Line in the source file: the symbol definition. */
    sourceLine?: number;
    /** Line in the target file: the import statement. */
    targetLine?: number;
    links?: EdgeLink[];
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

// Auto-generated descriptions keyed by absolute path live in the shared
// protocol module (re-exported here for existing importers).
export type { AutoDescriptions } from '../../shared/protocol';

/**
 * Load the built webview HTML and rewrite asset URLs for the VS Code webview.
 * Handles both "/assets/..." and "./assets/...".
 */
export function htmlForWebview(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const index = vscode.Uri.joinPath(media, 'index.html');
    let html = fs.readFileSync(index.fsPath, 'utf8');

    const fix = (p: string) =>
        panel.webview
            .asWebviewUri(vscode.Uri.joinPath(media, p))
            .toString();

    html = html
        // rewrite src/href="./assets/..." and "/assets/..."
        .replace(/((?:src|href)=["'])\.?\/assets\//g, (_m, p1) => `${p1}${fix('assets/')}`)
        .replace(/__CSP__/g, panel.webview.cspSource);

    return html;
}
