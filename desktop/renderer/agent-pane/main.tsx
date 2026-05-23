// Agent-pane entry — Project 4 / M-int-1.
//
// Replaces agent-viewer's standalone `createRoot(#root)` bootstrap with an
// explicit mount function that takes the host element. Lets pdf/latex's
// plain-TS renderer (renderer/index.ts) decide whether and where to mount
// the React agent pane based on the feature flag.
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/**
 * Mount the agent-viewer React app into the given host element.
 * Returns a dispose callback that unmounts the React tree.
 */
export function mountAgentPane(host: HTMLElement): () => void {
  let root: Root | null = createRoot(host);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return () => {
    if (root) {
      root.unmount();
      root = null;
    }
  };
}
