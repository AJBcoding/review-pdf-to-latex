import type { ViewerLoadContext } from '@shared/file-viewer';
import {
  IframeDocViewer,
  type IframeDocViewerOptions,
} from './iframe-doc-viewer';

// Re-exported so existing importers (and the comment→anchor projection) keep
// resolving from the HTML viewer module after the X11 union.
export {
  htmlAnchorsFromComments,
  type HtmlAnchor,
} from './iframe-doc-viewer';

export interface HtmlViewerOptions extends IframeDocViewerOptions {
  /** Base directory for resolving relative resource URLs. Optional now that
   *  X7 threads the document path through `loadBytes(bytes, ctx)`; the ctx
   *  path wins when both are present. */
  basePath?: string;
}

/** Renders an `.html` file verbatim in the sandboxed iframe. Its only job over
 *  the {@link IframeDocViewer} base is the bytes→HTML strategy: decode UTF-8 and
 *  inject a `<base href>` so relative resources resolve against the doc's dir. */
export class HtmlViewer extends IframeDocViewer {
  private readonly basePath?: string;

  constructor(opts: HtmlViewerOptions) {
    super(opts);
    this.basePath = opts.basePath;
  }

  protected bytesToHtml(bytes: Uint8Array, ctx?: ViewerLoadContext): string {
    const htmlContent = new TextDecoder('utf-8').decode(bytes);
    const base = ctx?.path ?? this.basePath ?? '';
    const baseDir = base.replace(/[^/\\]*$/, '');
    const baseTag = `<base href="file://${baseDir}">`;
    const injected = htmlContent.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
    return injected.includes('<head')
      ? injected
      : `<head>${baseTag}</head>${htmlContent}`;
  }
}
