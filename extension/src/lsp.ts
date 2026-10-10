import * as vscode from 'vscode';

export async function getReferences(uri: vscode.Uri, position: vscode.Position) {
    const locs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, position
    );
    return (locs || []).map(l => ({
        uri: l.uri.toString(),
        range: { start: l.range.start, end: l.range.end }
    }));
}

/** Both shapes the definition provider may return. */
export type DefinitionResult = vscode.Location | vscode.LocationLink[] | undefined;

export async function getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<DefinitionResult> {
    return vscode.commands.executeCommand<DefinitionResult>('vscode.executeDefinitionProvider', uri, position);
}

export type FlatSymbol = { name: string; kind: vscode.SymbolKind; range: vscode.Range };

export async function getDocumentSymbols(uri: vscode.Uri): Promise<FlatSymbol[]> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider', uri
        );
        if (!symbols || !Array.isArray(symbols)) return [];
        const out: FlatSymbol[] = [];
        const visit = (items: vscode.DocumentSymbol[]) => {
            for (const s of items) {
                out.push({ name: s.name, kind: s.kind, range: s.selectionRange || s.range });
                if (s.children && s.children.length) visit(s.children);
            }
        };
        visit(symbols);
        return out;
    } catch {
        return [];
    }
}