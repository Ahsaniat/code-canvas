export interface FileMeta {
  description?: string;
  tags?: string[];
  collapsed?: boolean;
  descriptionExpanded?: boolean;
}

export interface MetaFile {
  version: 1;
  files: Record<string, FileMeta>;  // key = relative path from workspace root
}
