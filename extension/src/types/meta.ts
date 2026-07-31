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
}

export interface MetaFile {
  version: 1;
  files: Record<string, FileMeta>;  // key = absolute path of the file or folder
}
