import { create } from 'zustand';
import { AutoDescriptions, FileMeta, MetaFile } from '../types/meta';

// Utility: acquire the VS Code API (already available in the webview)
const vscode = (window as any).vscode || ((window as any).acquireVsCodeApi ? (window as any).acquireVsCodeApi() : undefined);
if (vscode && !(window as any).vscode) {
  (window as any).vscode = vscode;
}

function postToExtension(msg: object) {
  vscode?.postMessage(msg);
}

interface MetaStore {
  files: Record<string, FileMeta>;
  activeTagFilters: string[];
  tagFilterMode: 'OR' | 'AND';

  hydrate: (meta: MetaFile) => void;
  applyAutoDescriptions: (entries: AutoDescriptions) => void;
  /** Patch one file's meta and persist it to the extension host. */
  patchFileMeta: (filePath: string, patch: Partial<FileMeta>) => void;

  setDescription: (filePath: string, description: string) => void;
  setDescriptionExpanded: (filePath: string, expanded: boolean) => void;
  setCollapsed: (filePath: string, collapsed: boolean) => void;
  addTag: (filePath: string, tag: string) => void;
  removeTag: (filePath: string, tag: string) => void;

  toggleTagFilter: (tag: string) => void;
  setTagFilterMode: (mode: 'OR' | 'AND') => void;
  clearTagFilters: () => void;
}

export const useMetaStore = create<MetaStore>((set, get) => ({
  files: {},
  activeTagFilters: [],
  tagFilterMode: 'OR',

  hydrate: (meta) => set({ files: meta.files ?? {} }),

  /**
   * Merge generated descriptions in.
   *
   * `description` (the manual one) is deliberately absent from the patch, so a
   * regeneration can never clobber what the user wrote. Entries whose text is
   * unchanged are skipped so this does not invalidate node subscriptions.
   */
  applyAutoDescriptions: (entries) => set((state) => {
    let changed = false;
    const files = { ...state.files };
    for (const [key, value] of Object.entries(entries ?? {})) {
      const current = files[key];
      if (current?.autoDescription === value.autoDescription) continue;
      files[key] = { ...(current ?? {}), autoDescription: value.autoDescription, autoDescriptionKind: value.kind };
      changed = true;
    }
    return changed ? { files } : {};
  }),

  // Patch and persist. The host message is sent after `set`, not inside the
  // updater, so a double-invoked updater can never double-post.
  patchFileMeta(filePath, patch) {
    const updated = { ...get().files[filePath], ...patch };
    set((state) => ({ files: { ...state.files, [filePath]: updated } }));
    postToExtension({ type: 'updateFileMeta', filePath, meta: updated });
  },

  setDescription: (filePath, description) =>
    get().patchFileMeta(filePath, { description }),

  setDescriptionExpanded: (filePath, descriptionExpanded) =>
    get().patchFileMeta(filePath, { descriptionExpanded }),

  setCollapsed: (filePath, collapsed) =>
    get().patchFileMeta(filePath, { collapsed }),

  addTag: (filePath, tag) => {
    const current = get().files[filePath]?.tags ?? [];
    if (!current.includes(tag)) {
      get().patchFileMeta(filePath, { tags: [...current, tag] });
    }
  },

  removeTag: (filePath, tag) => {
    const current = get().files[filePath]?.tags ?? [];
    get().patchFileMeta(filePath, { tags: current.filter((t) => t !== tag) });
  },

  toggleTagFilter: (tag) =>
    set((state) => ({
      activeTagFilters: state.activeTagFilters.includes(tag)
        ? state.activeTagFilters.filter((t) => t !== tag)
        : [...state.activeTagFilters, tag],
    })),

  setTagFilterMode: (tagFilterMode) => set({ tagFilterMode }),
  clearTagFilters: () => set({ activeTagFilters: [] }),
}));
