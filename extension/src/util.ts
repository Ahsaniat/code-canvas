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
 * as exported by the TARGET module; `alias` is the local name in the SOURCE
 * module when the two differ.
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
    source: string;
    target: string;
    kind: 'import' | 'call' | 'ref';
    sourceLine?: number;
    targetLine?: number;
    links?: EdgeLink[];
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Auto-generated (never user-authored) descriptions keyed by absolute path. */
export type AutoDescriptions = Record<string, { autoDescription: string; kind: 'file' | 'folder' }>;

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
