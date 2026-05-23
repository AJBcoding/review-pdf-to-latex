import type { AnchorKind } from './types';

export interface FileViewerPageInfo {
  page: number;
  totalPages: number;
}

export interface FileViewer {
  readonly totalPages: number;
  readonly currentPage: number;
  readonly anchorKind: AnchorKind;

  loadBytes(bytes: Uint8Array): Promise<void>;
  nextPage(): Promise<void>;
  prevPage(): Promise<void>;
  fitPage(): Promise<void>;
  fitWidth(): Promise<void>;
  setDarkMode(enabled: boolean): void;
  isDarkMode(): boolean;
  dispose(): void;
}
