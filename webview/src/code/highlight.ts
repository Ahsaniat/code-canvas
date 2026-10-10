import hljs from 'highlight.js/lib/core';
import ts from 'highlight.js/lib/languages/typescript';
import js from 'highlight.js/lib/languages/javascript';
import py from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import plaintext from 'highlight.js/lib/languages/plaintext';
import * as log from '../log';

hljs.registerLanguage('typescript', ts);
hljs.registerLanguage('javascript', js);
// Increase the maximum length before Highlight.js bails out to plaintext so large Python files still get properly highlighted.
hljs.configure({ maxHighlightLength: 500_000 } as any);
hljs.registerLanguage('python', py);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('plaintext', plaintext);

/** Languages the indexer knows about; `other` falls back to plaintext. */
export type Lang = 'ts' | 'js' | 'py' | 'go' | 'rs' | 'java' | 'cs' | 'other';

// A mapping object is slightly cleaner than a long ternary chain.
const languageMap: Record<Lang, string> = {
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    other: 'plaintext'
};

export function highlight(code: string, lang: Lang) {
    const mapped = languageMap[lang] || 'plaintext';

    // 1. First, check if the language is explicitly supported.
    if (hljs.getLanguage(mapped)) {
        try {
            // 2. Attempt to highlight with the specified language.
            return hljs.highlight(code, { language: mapped, ignoreIllegals: true }).value;
        } catch (e) {
            // This catch block will run if highlighting fails catastrophically.
            log.error(`highlighting failed for language "${mapped}"`, e);
        }
    }

    // 3. If specific highlighting fails, fallback to auto-detection.
    // This is safer than the original implementation's catch-all.
    try {
        return hljs.highlightAuto(code).value;
    } catch (e) {
        log.error('auto-highlighting failed', e);
        // 4. As a last resort, return the code escaped to prevent breaking HTML.
        return code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}