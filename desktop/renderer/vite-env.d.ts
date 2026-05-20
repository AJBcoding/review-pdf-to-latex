/// <reference types="vite/client" />

// pdfjs-dist 5.x ships the viewer-component bundle at web/pdf_viewer.mjs but
// doesn't include a matching .d.ts in that subpath (types live under types/web/).
// Re-export the builder classes we actually use so the TextLayerBuilder port
// in pdf-viewer.ts gets real types.
declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  export { TextLayerBuilder } from 'pdfjs-dist/types/web/text_layer_builder';
  export { StructTreeLayerBuilder } from 'pdfjs-dist/types/web/struct_tree_layer_builder';
  // Note: TextAccessibilityManager is defined in pdf_viewer.mjs but NOT in
  // its public export list (the runtime `export { ... }` statement at the
  // bottom of pdf_viewer.mjs), so we can't import it.
}
