import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { parsePorcelain } from './porcelain';

export async function getChangedFiles(): Promise<string[]> {
    // Prefer the Git extension API: it knows every open repository.
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt) {
        try {
            const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
            const files = new Set<string>();
            for (const repo of api.repositories) {
                for (const change of [
                    ...repo.state.workingTreeChanges,
                    ...repo.state.mergeChanges,
                    ...repo.state.indexChanges,
                ]) {
                    files.add(change.uri.fsPath);
                }
            }
            return Array.from(files);
        } catch {
            // Fall through to the CLI.
        }
    }
    return gitStatusFallback();
}

/**
 * Fallback: parse `git status --porcelain` asynchronously.
 *
 * This used to be a blocking spawnSync in the extension host. The porcelain
 * parsing lives in `porcelain.ts` so it can be tested without `vscode`.
 */
function gitStatusFallback(): Promise<string[]> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return Promise.resolve([]);
    return new Promise((resolve) => {
        execFile('git', ['status', '--porcelain'], { cwd }, (err, stdout) => {
            resolve(err ? [] : parsePorcelain(stdout));
        });
    });
}

export function watchGitState(onChange: () => void): vscode.Disposable {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return new vscode.Disposable(() => { });

    // P2-6: the Git API activates asynchronously, so collect the real disposers
    // as they become available and expose a Disposable that actually tears them
    // down (the previous implementation discarded them and returned a no-op).
    const disposables: vscode.Disposable[] = [];
    const watched = new Set<unknown>();
    let disposed = false;

    const attach = (repo: any): void => {
        if (!repo || watched.has(repo)) return;
        watched.add(repo);
        const sub = repo.state.onDidChange(onChange);
        if (disposed) sub.dispose();
        else disposables.push(sub);
    };

    (async () => {
        try {
            const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
            const subs: vscode.Disposable[] = [
                api.onDidOpenRepository((repo: any) => attach(repo)),
                api.onDidChangeState(onChange),
            ];
            if (disposed) subs.forEach(d => d.dispose());
            else disposables.push(...subs);
            // Watch every repository, not just the first.
            for (const repo of api.repositories) attach(repo);
        } catch {
            // Git extension unavailable/failed to activate — nothing to watch.
        }
    })();

    return new vscode.Disposable(() => {
        disposed = true;
        disposables.forEach(d => d.dispose());
        disposables.length = 0;
        watched.clear();
    });
}
