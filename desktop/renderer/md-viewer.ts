import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  keymap,
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxTree, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import type { FileViewer } from '@shared/file-viewer';
import type { AnchorKind } from '@shared/types';
import type { MdAnchor } from '@shared/md/anchors';

export interface MdSelection {
  from: number;
  to: number;
  text: string;
}

export interface MarkdownViewerOptions {
  container: HTMLElement;
  onWikilinkClick?: (target: string) => void;
  onContentChange?: (content: string) => void;
  onSelection?: (sel: MdSelection | null) => void;
  onBlur?: () => void;
}

// ─── Tracked anchor state ─────────────────────────────────────────────────

interface TrackedAnchor {
  commentId: string;
  from: number;
  to: number;
  orphaned: boolean;
}

const setAnchors = StateEffect.define<TrackedAnchor[]>();

const anchorField = StateField.define<TrackedAnchor[]>({
  create() { return []; },
  update(anchors, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAnchors)) return effect.value;
    }
    if (!tr.docChanged) return anchors;
    return anchors.map((a) => {
      if (a.orphaned) return a;
      const from = tr.changes.mapPos(a.from, 1);
      const to = tr.changes.mapPos(a.to, -1);
      if (from >= to) return { ...a, from: -1, to: -1, orphaned: true };
      return { ...a, from, to };
    });
  },
});

const anchorHighlight = Decoration.mark({ class: 'cm-md-anchor-highlight' });

const anchorDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.some((t) =>
        t.effects.some((e) => e.is(setAnchors))
      )) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const anchors = view.state.field(anchorField);
      const ranges = anchors
        .filter((a) => !a.orphaned && a.from >= 0 && a.to > a.from && a.to <= view.state.doc.length)
        .map((a) => anchorHighlight.range(a.from, a.to));
      ranges.sort((a, b) => a.from - b.from);
      return Decoration.set(ranges);
    }
  },
  { decorations: (v) => v.decorations },
);

// ─── MarkdownViewer ───────────────────────────────────────────────────────

export class MarkdownViewer implements FileViewer {
  private opts: MarkdownViewerOptions;
  private stage: HTMLElement;
  private fmCard: HTMLElement;
  private editorHost: HTMLElement;
  private editorView: EditorView | null = null;
  private dark = false;
  private bodyOffset = 0;
  private fmPrefix = '';

  constructor(opts: MarkdownViewerOptions) {
    this.opts = opts;

    this.stage = document.createElement('div');
    this.stage.className = 'md-viewer-stage';

    this.fmCard = document.createElement('div');
    this.fmCard.className = 'md-frontmatter-host';
    this.stage.appendChild(this.fmCard);

    this.editorHost = document.createElement('div');
    this.editorHost.className = 'md-editor-host';
    this.stage.appendChild(this.editorHost);

    opts.container.appendChild(this.stage);
  }

  get totalPages(): number { return 1; }
  get currentPage(): number { return 1; }
  get anchorKind(): AnchorKind { return 'text-quote'; }

  async loadBytes(bytes: Uint8Array): Promise<void> {
    const text = new TextDecoder('utf-8').decode(bytes);
    const { frontmatter, body, bodyOffset } = parseFrontmatter(text);
    this.bodyOffset = bodyOffset;
    this.fmPrefix = text.slice(0, bodyOffset);
    this.renderFrontmatter(frontmatter);
    this.mountEditor(body);
  }

  async nextPage(): Promise<void> {}
  async prevPage(): Promise<void> {}
  async fitPage(): Promise<void> {}
  async fitWidth(): Promise<void> {}

  setDarkMode(enabled: boolean): void {
    this.dark = enabled;
    this.stage.classList.toggle('md-dark', enabled);
  }

  isDarkMode(): boolean { return this.dark; }

  dispose(): void {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    this.stage.remove();
  }

  getContent(): string {
    return this.fmPrefix + (this.editorView?.state.doc.toString() ?? '');
  }

  getSelection(): MdSelection | null {
    if (!this.editorView) return null;
    const sel = this.editorView.state.selection.main;
    if (sel.from === sel.to) return null;
    return {
      from: sel.from,
      to: sel.to,
      text: this.editorView.state.sliceDoc(sel.from, sel.to),
    };
  }

  setTrackedAnchors(anchors: TrackedAnchor[]): void {
    if (!this.editorView) return;
    this.editorView.dispatch({ effects: setAnchors.of(anchors) });
  }

  getTrackedAnchors(): TrackedAnchor[] {
    if (!this.editorView) return [];
    return this.editorView.state.field(anchorField);
  }

  private mountEditor(text: string): void {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }

    const extensions: Extension[] = [
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      livePreviewPlugin(),
      anchorField,
      anchorDecoPlugin,
      livePreviewBaseTheme,
      EditorView.lineWrapping,
    ];

    if (this.opts.onContentChange) {
      const onChange = this.opts.onContentChange;
      const prefix = this.fmPrefix;
      extensions.push(
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) onChange(prefix + update.state.doc.toString());
        })
      );
    }

    if (this.opts.onSelection) {
      const onSel = this.opts.onSelection;
      extensions.push(
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.selectionSet) {
            const sel = update.state.selection.main;
            if (sel.from === sel.to) {
              onSel(null);
            } else {
              onSel({
                from: sel.from,
                to: sel.to,
                text: update.state.sliceDoc(sel.from, sel.to),
              });
            }
          }
        })
      );
    }

    if (this.opts.onBlur) {
      const onBlur = this.opts.onBlur;
      extensions.push(
        EditorView.domEventHandlers({ blur: () => { onBlur(); } })
      );
    }

    const state = EditorState.create({ doc: text, extensions });
    this.editorView = new EditorView({ state, parent: this.editorHost });
  }

  private renderFrontmatter(fm: FrontmatterBlock | null): void {
    this.fmCard.innerHTML = '';
    if (!fm) { this.fmCard.hidden = true; return; }
    this.fmCard.hidden = false;

    const card = document.createElement('div');
    card.className = 'md-frontmatter';

    const toggle = document.createElement('button');
    toggle.className = 'md-frontmatter-toggle';
    toggle.textContent = '▾ Frontmatter';
    toggle.setAttribute('aria-expanded', 'true');

    const table = document.createElement('table');
    table.className = 'md-frontmatter-table';
    const tbody = document.createElement('tbody');
    for (const f of fm.fields) {
      const tr = document.createElement('tr');
      const tdKey = document.createElement('td');
      tdKey.className = 'md-fm-key';
      tdKey.textContent = f.key;
      const tdVal = document.createElement('td');
      tdVal.className = 'md-fm-value';
      tdVal.textContent = f.value;
      tr.append(tdKey, tdVal);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    toggle.addEventListener('click', () => {
      const collapsed = table.hidden;
      table.hidden = !collapsed;
      toggle.textContent = collapsed ? '▾ Frontmatter' : '▸ Frontmatter';
      toggle.setAttribute('aria-expanded', String(collapsed));
      card.classList.toggle('is-collapsed', !collapsed);
    });

    card.append(toggle, table);
    this.fmCard.appendChild(card);
  }
}

// ─── Frontmatter parsing ──────────────────────────────────────────────────

interface FrontmatterBlock {
  raw: string;
  fields: Array<{ key: string; value: string }>;
}

export function parseFrontmatter(text: string): {
  frontmatter: FrontmatterBlock | null;
  body: string;
  bodyOffset: number;
} {
  // Use [ \t]* instead of \s* so a newline on the opening --- line never
  // accidentally absorbs the first content line.
  const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/);
  if (!match) return { frontmatter: null, body: text, bodyOffset: 0 };

  const raw = match[1];
  const fields: Array<{ key: string; value: string }> = [];
  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w[\w\s-]*?):\s*(.*)$/);
    if (kv) fields.push({ key: kv[1].trim(), value: kv[2].trim() });
  }

  // Reject blocks with no key-value pairs — these are horizontal-rule pairs
  // (---...---) in plain Markdown, not YAML frontmatter.
  if (fields.length === 0) return { frontmatter: null, body: text, bodyOffset: 0 };

  return {
    frontmatter: { raw, fields },
    body: text.slice(match[0].length),
    bodyOffset: match[0].length,
  };
}

// ─── CM6 live-preview decorations ─────────────────────────────────────────

const MARK_NAMES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'LinkMark',
  'URL',
  'CodeMark',
  'QuoteMark',
]);

const HEADING_NODES: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
};

const hideMark = Decoration.mark({ class: 'cm-md-hidden' });

const headingDecos: Record<string, Decoration> = {};
for (const [node, cls] of Object.entries(HEADING_NODES)) {
  headingDecos[node] = Decoration.line({ class: cls });
}
const emphDeco = Decoration.mark({ class: 'cm-md-em' });
const strongDeco = Decoration.mark({ class: 'cm-md-strong' });
const strikeDeco = Decoration.mark({ class: 'cm-md-strike' });
const linkDeco = Decoration.mark({ class: 'cm-md-link' });
const codeDeco = Decoration.mark({ class: 'cm-md-code' });
const blockquoteDeco = Decoration.line({ class: 'cm-md-blockquote' });

function buildDecorations(view: EditorView): DecorationSet {
  const builder: Array<{ from: number; to: number; deco: Decoration }> = [];
  const lineDecos: Array<{ pos: number; deco: Decoration }> = [];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const tree = syntaxTree(view.state);

  tree.iterate({
    enter(node) {
      const nodeStartLine = view.state.doc.lineAt(node.from).number;
      const nodeEndLine = view.state.doc.lineAt(node.to).number;
      const cursorOnNode = cursorLine >= nodeStartLine && cursorLine <= nodeEndLine;

      if (node.name in HEADING_NODES) {
        for (let l = nodeStartLine; l <= nodeEndLine; l++) {
          const line = view.state.doc.line(l);
          lineDecos.push({ pos: line.from, deco: headingDecos[node.name] });
        }
      }

      if (node.name === 'Emphasis' && !cursorOnNode) {
        builder.push({ from: node.from, to: node.to, deco: emphDeco });
      }
      if (node.name === 'StrongEmphasis' && !cursorOnNode) {
        builder.push({ from: node.from, to: node.to, deco: strongDeco });
      }
      if (node.name === 'Strikethrough' && !cursorOnNode) {
        builder.push({ from: node.from, to: node.to, deco: strikeDeco });
      }
      if (node.name === 'Link' && !cursorOnNode) {
        builder.push({ from: node.from, to: node.to, deco: linkDeco });
      }
      if (node.name === 'InlineCode' && !cursorOnNode) {
        builder.push({ from: node.from, to: node.to, deco: codeDeco });
      }
      if (node.name === 'Blockquote') {
        for (let l = nodeStartLine; l <= nodeEndLine; l++) {
          const line = view.state.doc.line(l);
          lineDecos.push({ pos: line.from, deco: blockquoteDeco });
        }
      }

      if (MARK_NAMES.has(node.name) && !cursorOnNode) {
        if (node.name === 'CodeMark') {
          let parent = node.node.parent;
          while (parent) {
            if (parent.name === 'FencedCode') return;
            parent = parent.parent;
          }
        }
        builder.push({ from: node.from, to: node.to, deco: hideMark });
      }
    },
  });

  const allRanges = [
    ...builder.map((b) => b.deco.range(b.from, b.to)),
    ...lineDecos.map((l) => l.deco.range(l.pos)),
  ];
  allRanges.sort((a, b) => a.from - b.from);

  return Decoration.set(allRanges);
}

function livePreviewPlugin(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ─── CM6 theme ────────────────────────────────────────────────────────────

const livePreviewBaseTheme = EditorView.baseTheme({
  '&': {
    fontSize: '15px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  '.cm-content': {
    maxWidth: '720px',
    margin: '0 auto',
    padding: '0 8px',
    lineHeight: '1.65',
    caretColor: '#4a9eff',
  },
  '.cm-cursor': { borderLeftColor: '#4a9eff' },
  '.cm-selectionBackground': { background: '#264f78 !important' },
  '&.cm-focused .cm-selectionBackground': { background: '#264f78 !important' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.cm-line': { padding: '0' },

  '.cm-md-hidden': { display: 'none' },
  '.cm-md-h1': { fontSize: '1.8em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-md-h2': { fontSize: '1.4em', fontWeight: '600', lineHeight: '1.35' },
  '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontWeight: '600' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-strike': { textDecoration: 'line-through', color: '#888' },
  '.cm-md-link': { color: '#4a9eff', textDecoration: 'none' },
  '.cm-md-code': {
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
    fontSize: '0.88em',
    background: 'rgba(255,255,255,0.07)',
    padding: '0.15em 0.35em',
    borderRadius: '3px',
  },
  '.cm-md-blockquote': {
    borderLeft: '3px solid #4a9eff',
    paddingLeft: '1em',
    color: '#888',
  },
  '.cm-md-anchor-highlight': {
    background: 'rgba(245, 200, 75, 0.15)',
    borderBottom: '2px solid rgba(245, 200, 75, 0.5)',
  },
});
