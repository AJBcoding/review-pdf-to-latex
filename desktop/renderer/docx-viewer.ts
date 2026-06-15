import mammoth from 'mammoth';
import type { ViewerLoadContext } from '@shared/file-viewer';
import {
  IframeDocViewer,
  type IframeDocViewerOptions,
} from './iframe-doc-viewer';

export type DocxViewerOptions = IframeDocViewerOptions;

/** Renders a `.docx` via mammoth in the sandboxed iframe. Its only job over the
 *  {@link IframeDocViewer} base is the bytes→HTML strategy: run mammoth and wrap
 *  the result in a styled document shell. */
export class DocxViewer extends IframeDocViewer {
  protected async bytesToHtml(
    bytes: Uint8Array,
    _ctx?: ViewerLoadContext,
  ): Promise<string> {
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      { styleMap: ['u => em'] },
    );

    if (result.messages.length > 0) {
      console.warn('[docx-viewer] mammoth warnings:', result.messages);
    }

    return `
      <!DOCTYPE html>
      <html><head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            max-width: 720px;
            margin: 24px auto;
            padding: 0 16px;
            line-height: 1.6;
            color: #e6e6e6;
            background: #222;
          }
          img { max-width: 100%; }
          table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          th, td { border: 1px solid #444; padding: 6px 10px; text-align: left; }
          th { background: rgba(255,255,255,0.04); }
          blockquote { border-left: 3px solid #4a9eff; padding-left: 1em; color: #888; margin: 1em 0; }
          pre { background: #111; padding: 12px; border-radius: 6px; overflow-x: auto; }
          code { font-family: "SF Mono", monospace; font-size: 0.9em; }
        </style>
      </head><body>${result.value}</body></html>
    `;
  }
}
