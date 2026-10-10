/**
 * Porcelain v1 parsing for the Git CLI fallback.
 *
 * Kept free of the `vscode` import so it is directly testable and runnable
 * outside the extension host.
 */

/**
 * Turn `git status --porcelain` output into changed file paths.
 *
 * Rename/copy entries look like `R  old -> new` (and `C  old -> new`); the
 * new path is the one that can match an indexed file. Slicing at column 3
 * alone would return the literal string `old -> new`.
 */
export function parsePorcelain(stdout: string): string[] {
    const out: string[] = [];
    for (const line of (stdout || '').split('\n')) {
        if (!line.trim()) continue;
        const rest = line.slice(3);
        const arrow = rest.indexOf(' -> ');
        out.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
    }
    return Array.from(new Set(out));
}
