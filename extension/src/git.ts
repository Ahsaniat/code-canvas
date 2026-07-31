import * as vscode from 'vscode';

export async function getChangedFiles(): Promise<string[]> {
    // Prefer Git extension API if available
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt) {
        const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
        const repo = api.repositories[0];
        if (repo) {
            const files = [
                ...repo.state.workingTreeChanges,
                ...repo.state.mergeChanges,
                ...repo.state.indexChanges
            ].map(c => c.uri.fsPath);
            return Array.from(new Set(files));
        }
    }
    // Fallback: simple status parse
    try {
        const cp = await import('child_process');
        const { stdout } = cp.spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
        return stdout.split('\n').filter(Boolean).map(line => line.slice(3)).filter(Boolean);
    } catch { return []; }
}

export function watchGitState(onChange: () => void): vscode.Disposable {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return new vscode.Disposable(() => { });

    // P2-6: the Git API activates asynchronously, so collect the real disposers as
    // they become available and expose a Disposable that actually tears them down
    // (the previous implementation discarded them and returned a no-op).
    const disposables: vscode.Disposable[] = [];
    let disposed = false;

    (async () => {
        try {
            const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
            const subs: vscode.Disposable[] = [];
            const repo = api.repositories[0];
            if (repo) subs.push(repo.state.onDidChange(onChange));
            subs.push(api.onDidOpenRepository(onChange));
            subs.push(api.onDidChangeState(onChange));
            if (disposed) subs.forEach(d => d.dispose());
            else disposables.push(...subs);
        } catch {
            // Git extension unavailable/failed to activate — nothing to watch.
        }
    })();

    return new vscode.Disposable(() => {
        disposed = true;
        disposables.forEach(d => d.dispose());
        disposables.length = 0;
    });
}