import { StrictMode, createElement, useState, useCallback, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileViewer } from '@shared/file-viewer';
import type { AnchorKind } from '@shared/types';

export interface MarkdownViewerOptions {
  container: HTMLElement;
  onWikilinkClick?: (target: string) => void;
}

export class MarkdownViewer implements FileViewer {
  private opts: MarkdownViewerOptions;
  private root: Root | null = null;
  private stage: HTMLElement;
  private markdownText = '';
  private dark = false;

  constructor(opts: MarkdownViewerOptions) {
    this.opts = opts;
    this.stage = document.createElement('div');
    this.stage.className = 'md-viewer-stage';
    opts.container.appendChild(this.stage);
    this.root = createRoot(this.stage);
  }

  get totalPages(): number { return 1; }
  get currentPage(): number { return 1; }
  get anchorKind(): AnchorKind { return 'md-fuzzy-snippet'; }

  async loadBytes(bytes: Uint8Array): Promise<void> {
    this.markdownText = new TextDecoder('utf-8').decode(bytes);
    this.render();
  }

  async nextPage(): Promise<void> { /* .md is a single scrollable page */ }
  async prevPage(): Promise<void> { /* .md is a single scrollable page */ }
  async fitPage(): Promise<void> { /* no-op for markdown */ }
  async fitWidth(): Promise<void> { /* no-op for markdown */ }

  setDarkMode(enabled: boolean): void {
    this.dark = enabled;
    this.stage.classList.toggle('md-dark', enabled);
  }

  isDarkMode(): boolean { return this.dark; }

  dispose(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.stage.remove();
  }

  private render(): void {
    if (!this.root) return;
    this.root.render(
      createElement(StrictMode, null,
        createElement(MarkdownPreview, {
          text: this.markdownText,
          onWikilinkClick: this.opts.onWikilinkClick ?? null,
        })
      )
    );
  }
}

interface FrontmatterBlock {
  raw: string;
  fields: Array<{ key: string; value: string }>;
}

function parseFrontmatter(text: string): { frontmatter: FrontmatterBlock | null; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: null, body: text };

  const raw = match[1];
  const fields: Array<{ key: string; value: string }> = [];
  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w[\w\s-]*?):\s*(.*)$/);
    if (kv) fields.push({ key: kv[1].trim(), value: kv[2].trim() });
  }

  return {
    frontmatter: { raw, fields },
    body: text.slice(match[0].length),
  };
}

function resolveWikilinks(text: string): string {
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, display?: string) => {
      const label = display ?? target;
      return `[${label}](wikilink:${encodeURIComponent(target)})`;
    }
  );
}

interface MarkdownPreviewProps {
  text: string;
  onWikilinkClick: ((target: string) => void) | null;
}

function MarkdownPreview({ text, onWikilinkClick }: MarkdownPreviewProps) {
  const { frontmatter, body } = useMemo(() => parseFrontmatter(text), [text]);
  const processedBody = useMemo(() => resolveWikilinks(body), [body]);
  const [fmCollapsed, setFmCollapsed] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (href.startsWith('wikilink:')) {
      e.preventDefault();
      const target = decodeURIComponent(href.slice('wikilink:'.length));
      onWikilinkClick?.(target);
    }
  }, [onWikilinkClick]);

  return createElement('div', { className: 'md-preview', onClick: handleClick },
    frontmatter && createElement(FrontmatterCard, {
      frontmatter,
      collapsed: fmCollapsed,
      onToggle: () => setFmCollapsed((c) => !c),
    }),
    createElement(ReactMarkdown as any, {
      remarkPlugins: [remarkGfm],
      children: processedBody,
    }),
  );
}

interface FrontmatterCardProps {
  frontmatter: FrontmatterBlock;
  collapsed: boolean;
  onToggle: () => void;
}

function FrontmatterCard({ frontmatter, collapsed, onToggle }: FrontmatterCardProps) {
  return createElement('div', { className: `md-frontmatter ${collapsed ? 'is-collapsed' : ''}` },
    createElement('button', {
      className: 'md-frontmatter-toggle',
      onClick: onToggle,
      'aria-expanded': !collapsed,
    }, collapsed ? '▸ Frontmatter' : '▾ Frontmatter'),
    !collapsed && createElement('table', { className: 'md-frontmatter-table' },
      createElement('tbody', null,
        ...frontmatter.fields.map((f) =>
          createElement('tr', { key: f.key },
            createElement('td', { className: 'md-fm-key' }, f.key),
            createElement('td', { className: 'md-fm-value' }, f.value),
          )
        ),
      ),
    ),
  );
}
