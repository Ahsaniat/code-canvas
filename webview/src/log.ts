/**
 * Scoped diagnostics for the webview.
 *
 * Every message carries a single product prefix so canvas output can be
 * filtered out of the webview devtools console, and there is one place to
 * add levels or silence diagnostics later.
 */
const PREFIX = '[code-canvas]';

export function warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
}
