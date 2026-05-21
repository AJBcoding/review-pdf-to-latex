// Splitter gutters for the three-pane layout + the right-drawer row split.
//
// Three gutters:
//   #gutterLeft  — between left drawer and middle pane (col resize)
//   #gutterRight — between middle pane and right drawer (col resize)
//   #gutterRdSplit — between rd-comments and rd-claude (row resize)
//
// Widths are persisted via the existing AppStateFile.layout_widths
// (added with this feature). The caller wires onChange → scheduleAppStateSave.

export interface LayoutWidths {
  /** Left drawer width in px. Clamped [180, 480]. */
  col_left?: number;
  /** Right drawer width in px. Clamped [320, 720]. */
  col_right?: number;
  /** rd-comments flex-basis in px. Clamped [120, container - 280]. */
  rd_comments_h?: number;
}

interface SplitterOpts {
  layout: HTMLElement;
  rightDrawer: HTMLElement;
  onChange(widths: LayoutWidths): void;
}

const COL_LEFT_MIN = 180;
const COL_LEFT_MAX = 480;
const COL_RIGHT_MIN = 320;
const COL_RIGHT_MAX = 720;
const RD_COMMENTS_MIN = 120;
const RD_CLAUDE_MIN = 280;

export function bootSplitters(opts: SplitterOpts): void {
  const gutterLeft = document.getElementById('gutterLeft');
  const gutterRight = document.getElementById('gutterRight');
  const gutterRdSplit = document.getElementById('gutterRdSplit');

  if (gutterLeft) {
    wireDrag(gutterLeft, (deltaX, startVal) => {
      const next = clamp(startVal + deltaX, COL_LEFT_MIN, COL_LEFT_MAX);
      opts.layout.style.setProperty('--col-left', `${next}px`);
      return next;
    }, () => readPx(opts.layout, '--col-left', 240),
       (val) => opts.onChange({ col_left: val }));
  }

  if (gutterRight) {
    wireDrag(gutterRight, (deltaX, startVal) => {
      // Dragging right gutter LEFT widens the right drawer (drag direction
      // is inverted relative to col-right). deltaX is signed pointer delta.
      const next = clamp(startVal - deltaX, COL_RIGHT_MIN, COL_RIGHT_MAX);
      opts.layout.style.setProperty('--col-right', `${next}px`);
      return next;
    }, () => readPx(opts.layout, '--col-right', 440),
       (val) => opts.onChange({ col_right: val }));
  }

  if (gutterRdSplit) {
    wireDrag(gutterRdSplit, (deltaY, startVal) => {
      const totalH = opts.rightDrawer.clientHeight;
      const max = Math.max(RD_COMMENTS_MIN, totalH - RD_CLAUDE_MIN);
      const next = clamp(startVal + deltaY, RD_COMMENTS_MIN, max);
      opts.rightDrawer.style.setProperty('--rd-comments-h', `${next}px`);
      return next;
    }, () => readPx(opts.rightDrawer, '--rd-comments-h', opts.rightDrawer.clientHeight / 2),
       (val) => opts.onChange({ rd_comments_h: val }), 'y');
  }
}

/** Apply saved widths on boot. Called by the renderer after restoring AppStateFile. */
export function applyLayoutWidths(
  layout: HTMLElement,
  rightDrawer: HTMLElement,
  widths: LayoutWidths,
): void {
  if (typeof widths.col_left === 'number') {
    layout.style.setProperty('--col-left', `${clamp(widths.col_left, COL_LEFT_MIN, COL_LEFT_MAX)}px`);
  }
  if (typeof widths.col_right === 'number') {
    layout.style.setProperty('--col-right', `${clamp(widths.col_right, COL_RIGHT_MIN, COL_RIGHT_MAX)}px`);
  }
  if (typeof widths.rd_comments_h === 'number' && widths.rd_comments_h > 0) {
    rightDrawer.style.setProperty('--rd-comments-h', `${widths.rd_comments_h}px`);
  }
}

function wireDrag(
  gutter: HTMLElement,
  update: (delta: number, startVal: number) => number,
  readStart: () => number,
  commit: (finalVal: number) => void,
  axis: 'x' | 'y' = 'x',
): void {
  let startCoord = 0;
  let startVal = 0;
  let lastVal = 0;
  let active = false;

  const onMove = (e: PointerEvent) => {
    if (!active) return;
    const cur = axis === 'x' ? e.clientX : e.clientY;
    lastVal = update(cur - startCoord, startVal);
  };
  const onUp = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    gutter.classList.remove('is-dragging');
    try { gutter.releasePointerCapture(e.pointerId); } catch { /* may already be lost */ }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    commit(lastVal);
  };

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    active = true;
    startCoord = axis === 'x' ? e.clientX : e.clientY;
    startVal = readStart();
    lastVal = startVal;
    gutter.classList.add('is-dragging');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* not all gutters support it */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function readPx(el: HTMLElement, varName: string, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
