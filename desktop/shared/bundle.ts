// Shared bundle utilities — used by both main (writes the bundle) and the
// renderer (drives Cmd+S / Cmd+Return + the "Last bundle" title-bar pip).
//
// Implements §10.4 filename grammar, §10.6 source-version parsing, and the
// L1/L2/L3 engagement-level palette decided in bd rev-pya. One source of
// truth so PDF annotation /C and the right-drawer card CSS can't drift.

import type { EngagementLevel } from './types';

/** §10.6 source-filename parse. Matches `<base>-<major>.<minor>.<ext>`.
 *  Captures `<base>` and `<major>.<minor>` as `source_version`. Returns
 *  `null` for filenames that don't conform (e.g. `report.pdf`,
 *  `report-final.pdf`) — those are treated as having no version. */
export interface ParsedSourceName {
  base: string;
  source_version: string; // e.g. "1.0"
  ext: 'pdf' | 'md' | 'tex';
}

const SOURCE_NAME_RE = /^(.+?)-(\d+)\.(\d+)\.(pdf|md|tex)$/;

export function parseSourceName(filename: string): ParsedSourceName | null {
  const m = SOURCE_NAME_RE.exec(filename);
  if (!m) return null;
  return {
    base: m[1],
    source_version: `${m[2]}.${m[3]}`,
    ext: m[4] as 'pdf' | 'md' | 'tex',
  };
}

/** Build a §10.4 bundle filename:
 *    `YYYY-MM-DD <base>-<source_version> (AJB edits).<ext>`
 *  `ext` is `pdf` or `json` (not the source ext — bundles are always
 *  PDF + JSON pairs, even when the source is .md or .tex; v1 only ships
 *  PDF review so the .md/.tex case is moot here, but the grammar is the
 *  same). Falls back to a no-version filename if the source didn't parse. */
export function buildBundleFilename(opts: {
  parsed: ParsedSourceName | null;
  fallbackBase: string;   // basename of the source if no version match
  date: Date;             // today's date in local TZ; date string is local-day
  ext: 'pdf' | 'json';
}): string {
  const { parsed, fallbackBase, date, ext } = opts;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const datePrefix = `${yyyy}-${mm}-${dd}`;
  if (parsed) {
    return `${datePrefix} ${parsed.base}-${parsed.source_version} (AJB edits).${ext}`;
  }
  // No version match: drop the source extension and use the bare basename.
  // Filename collisions across same-day re-writes are still overwrites by
  // design (§10.4 rule (a)) — yesterday's file is the audit trail.
  const baseNoExt = fallbackBase.replace(/\.[^./\\]+$/, '');
  return `${datePrefix} ${baseNoExt} (AJB edits).${ext}`;
}

/** Bundle ID: `YYYYMMDD-HHmmss` in UTC. Stable, sortable, dense.
 *  Used as the bundle's logical identifier in the JSON sidecar and in
 *  the gt-mail subject (§10.1). Distinct from `submit_id` which is
 *  minted at Submit time by rev-1md.4. */
export function mintBundleId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Engagement-level palette (bd rev-pya).
 *
 *  - `pdfC`: 3 floats in [0,1] for the PDF /C array (annotation color).
 *  - `pdfCA`: opacity for /CA. 0.5 across all levels (Preview/Acrobat
 *    default for Highlight subtype; renders consistently in iOS Quick Look).
 *  - `cssHex`: hex string for CSS — :root variables consume this so the
 *    right-drawer cards stay lockstep with the PDF.
 *
 *  L1 amber, L2 sky-blue, L3 magenta — picked for color-blind safety
 *  (L1/L3 separate cleanly across the red↔green axis) and for matching
 *  the spec's "warm-fix / cool-swap / attention-rethink" semantic. */
export interface PaletteEntry {
  level: EngagementLevel;
  pdfC: [number, number, number];
  pdfCA: number;
  cssHex: string;
}

export const ENGAGEMENT_PALETTE: Readonly<Record<EngagementLevel, PaletteEntry>> = {
  comment: {
    level: 'comment',
    pdfC: [0.961, 0.784, 0.294],
    pdfCA: 0.5,
    cssHex: '#F5C84B',
  },
  redraft: {
    level: 'redraft',
    pdfC: [0.435, 0.694, 1.000],
    pdfCA: 0.5,
    cssHex: '#6FB1FF',
  },
  surface: {
    level: 'surface',
    pdfC: [0.886, 0.435, 0.694],
    pdfCA: 0.5,
    cssHex: '#E26FB1',
  },
};
