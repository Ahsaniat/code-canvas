export interface FileMeta {
  /** User-authored description. ALWAYS wins over `autoDescription`. */
  description?: string;
  /** Heuristically generated description; never overwrites the manual one. */
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
  files: Record<string, FileMeta>;
}

/** Payload of the `autoDescriptions` message from the extension host. */
export type AutoDescriptions = Record<string, { autoDescription: string; kind: 'file' | 'folder' }>;
