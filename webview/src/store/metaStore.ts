import { create } from 'zustand';
import { FileMeta, MetaFile } from '../types/meta';

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
  getFileMeta: (filePath: string) => FileMeta;

  setDescription: (filePath: string, description: string) => void;
  setDescriptionExpanded: (filePath: string, expanded: boolean) => void;
  setCollapsed: (filePath: string, collapsed: boolean) => void;
  addTag: (filePath: string, tag: string) => void;
  removeTag: (filePath: string, tag: string) => void;

  toggleTagFilter: (tag: string) => void;
  setTagFilterMode: (mode: 'OR' | 'AND') => void;
  clearTagFilters: () => void;
  getAllTags: () => string[];
}

export const useMetaStore = create<MetaStore>((set, get) => ({
  files: {},
  activeTagFilters: [],
  tagFilterMode: 'OR',

  hydrate: (meta) => set({ files: meta.files ?? {} }),

  getFileMeta: (filePath) => get().files[filePath] ?? {},

  // Internal helper: patch and persist
  _patch(filePath: string, patch: Partial<FileMeta>) {
    set((state) => {
      const updated = { ...state.files[filePath], ...patch };
      const files = { ...state.files, [filePath]: updated };
      postToExtension({ type: 'updateFileMeta', filePath, meta: updated });
      return { files };
    });
  },

  setDescription: (filePath, description) =>
    (get() as any)._patch(filePath, { description }),

  setDescriptionExpanded: (filePath, descriptionExpanded) =>
    (get() as any)._patch(filePath, { descriptionExpanded }),

  setCollapsed: (filePath, collapsed) =>
    (get() as any)._patch(filePath, { collapsed }),

  addTag: (filePath, tag) => {
    const current = get().files[filePath]?.tags ?? [];
    if (!current.includes(tag)) {
      (get() as any)._patch(filePath, { tags: [...current, tag] });
    }
  },

  removeTag: (filePath, tag) => {
    const current = get().files[filePath]?.tags ?? [];
    (get() as any)._patch(filePath, { tags: current.filter((t) => t !== tag) });
  },

  toggleTagFilter: (tag) =>
    set((state) => ({
      activeTagFilters: state.activeTagFilters.includes(tag)
        ? state.activeTagFilters.filter((t) => t !== tag)
        : [...state.activeTagFilters, tag],
    })),

  setTagFilterMode: (tagFilterMode) => set({ tagFilterMode }),
  clearTagFilters: () => set({ activeTagFilters: [] }),

  getAllTags: () => {
    const all = new Set<string>();
    Object.values(get().files).forEach((f) => f.tags?.forEach((t) => all.add(t)));
    return Array.from(all).sort();
  },
}));
