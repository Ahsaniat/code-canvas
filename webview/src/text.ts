/**
 * Text helpers shared by the node bodies and the description panel.
 */

/**
 * Text up to and including the first sentence-ending full stop.
 *
 * Descriptions are written so the first sentence stands alone as the summary and
 * everything after it is detail, which is what lets a collapsed panel show one
 * useful line instead of a wall of enumerated imports.
 *
 * Guards the obvious false positives — a decimal, an ellipsis, or a dotted name
 * like `util.ts` — so "Imports: 1. `x` from util.ts" is never cut at the
 * enumerator or the file extension.
 */
export function firstSentence(text: string): string {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    // A full stop only ends a sentence when whitespace or the end follows it,
    // which already rules out `util.ts` and `3.14`.
    const match = flat.match(/^.*?[.!?](?=\s|$)/);
    if (!match) return flat;
    const candidate = match[0];
    // "Imports: 1." is an enumerator, not the end of a sentence.
    if (/(?:^|\s)\d+\.$/.test(candidate)) return flat;
    // An ellipsis is a continuation, not a terminator.
    if (/\.\.\.$|…$/.test(candidate)) return flat;
    return candidate;
}
