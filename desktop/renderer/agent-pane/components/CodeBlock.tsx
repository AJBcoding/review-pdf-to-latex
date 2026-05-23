// Shiki-highlighted code block for react-markdown. Lazy-creates a single
// shared highlighter so the Shiki bundle (themes + grammars) is only
// fetched the first time an assistant message includes a fenced block.
//
// T3 uses @pierre/diffs (their Shiki wrapper with a per-render LRU cache)
// — we don't need that until code-block render perf shows up as a
// problem, which it won't at our scale.

import { useEffect, useState } from "react";
import type { Highlighter } from "shiki";

const THEME = "github-dark";

// Pre-loaded languages. Add as needed — anything not in this list falls
// back to a plain text render rather than throwing.
const LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "shell",
  "json",
  "yaml",
  "toml",
  "css",
  "html",
  "markdown",
  "go",
  "rust",
  "java",
  "ruby",
  "sql",
  "diff",
];

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import("shiki");
      return shiki.createHighlighter({
        themes: [THEME],
        langs: LANGS,
      });
    })();
  }
  return highlighterPromise;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fallbackHtml(code: string, lang: string): string {
  // Plain pre+code when Shiki isn't ready or the lang isn't loaded.
  return `<pre class="shiki shiki--fallback" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code)}</code></pre>`;
}

interface Props {
  code: string;
  lang: string;
}

export function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string>(() => fallbackHtml(code, lang));

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        const supported = h.getLoadedLanguages().includes(lang);
        try {
          const rendered = h.codeToHtml(code, {
            lang: supported ? lang : "text",
            theme: THEME,
          });
          setHtml(rendered);
        } catch (err) {
          console.error("[code-block] highlight failed:", err);
          setHtml(fallbackHtml(code, lang));
        }
      })
      .catch((err) => {
        console.error("[code-block] highlighter init failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="codeblock">
      {lang && <div className="codeblock__lang">{lang}</div>}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
