/**
 * Host <-> webview protocol types.
 *
 * These shapes cross the postMessage boundary in both directions, so they live
 * in one place: `extension/src/types/meta.ts` and `webview/src/types/meta.ts`
 * re-export from here instead of drifting apart.
 */

export interface FileMeta {
  /** User-authored description. ALWAYS wins over `autoDescription`. */
  description?: string;
  /**
   * Heuristically generated description (doc comment / export summary). Stored
   * in a separate field so regeneration can never clobber the manual one.
   */
  autoDescription?: string;
  autoDescriptionKind?: 'file' | 'folder';
  tags?: string[];
  collapsed?: boolean;
  descriptionExpanded?: boolean;
  /** User-set node size (NodeResizer). Overrides the content-derived size. */
  width?: number;
  height?: number;
}

export interface MetaFile {
  version: 1;
  /** key = absolute path of the file or folder */
  files: Record<string, FileMeta>;
}

/** Payload of the `autoDescriptions` message from the extension host. */
export type AutoDescriptions = Record<string, { autoDescription: string; kind: 'file' | 'folder' }>;
