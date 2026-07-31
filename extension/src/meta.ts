import * as path from 'path';
import * as fs from 'fs/promises';
import { MetaFile, FileMeta } from './types/meta';
import type { AutoDescriptions } from './util';

const META_PATH = '.code-canvas/meta.json';

function metaFsPath(root: string): string {
  return path.join(root, META_PATH);
}

export async function readMeta(root: string): Promise<MetaFile> {
  try {
    const raw = await fs.readFile(metaFsPath(root), 'utf8');
    return JSON.parse(raw) as MetaFile;
  } catch {
    return { version: 1, files: {} };
  }
}

export async function writeMeta(root: string, data: MetaFile): Promise<void> {
  const p = metaFsPath(root);
  // ensure directory exists
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
  } catch (e) {
    // Ignore error if directory already exists
  }
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(p, content, 'utf8');
}

export async function updateFileMeta(
  root: string,
  filePath: string,
  patch: Partial<FileMeta>
): Promise<MetaFile> {
  const meta = await readMeta(root);
  meta.files[filePath] = { ...(meta.files[filePath] || {}), ...patch };
  await writeMeta(root, meta);
  return meta;
}

/**
 * Cache generated descriptions.
 *
 * This writes ONLY `autoDescription`/`autoDescriptionKind`. A user-authored
 * `description` is never read, never compared, and never written here, so
 * regeneration cannot destroy manual work. The write is skipped entirely when
 * nothing changed, so opening the panel does not churn `.code-canvas/meta.json`.
 */
export async function mergeAutoDescriptions(
  root: string,
  entries: AutoDescriptions
): Promise<MetaFile> {
  const meta = await readMeta(root);
  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    const current = meta.files[key];
    if (current?.autoDescription === value.autoDescription
      && current?.autoDescriptionKind === value.kind) continue;
    meta.files[key] = {
      ...(current || {}),
      autoDescription: value.autoDescription,
      autoDescriptionKind: value.kind,
    };
    changed = true;
  }
  if (changed) await writeMeta(root, meta);
  return meta;
}
