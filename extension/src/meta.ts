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

/**
 * Serialize every read-modify-write of one workspace's meta file.
 *
 * Two writers already exist — user edits (`updateFileMeta`, debounced) and
 * generated-description caching (`mergeAutoDescriptions`, after every graph
 * publish). Without a queue their read-modify-write cycles interleave and the
 * later write silently rolls the earlier one back, including a user-authored
 * `description`. One promise chain per resolved root makes the cycles atomic
 * with respect to each other in this process.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  // Run the task regardless of whether the previous one settled or failed, so
  // one bad write can never wedge the queue.
  const next = previous.then(task, task);
  writeQueues.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Write the meta file atomically: full content to a sibling temp file, then a
 * rename over the target. A crash mid-write leaves the previous file intact
 * instead of a truncated JSON document.
 */
async function writeMetaUnsafe(root: string, data: MetaFile): Promise<void> {
  const target = metaFsPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = JSON.stringify(data, null, 2);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function updateFileMeta(
  root: string,
  filePath: string,
  patch: Partial<FileMeta>
): Promise<MetaFile> {
  return enqueue(root, async () => {
    const meta = await readMeta(root);
    meta.files[filePath] = { ...(meta.files[filePath] || {}), ...patch };
    await writeMetaUnsafe(root, meta);
    return meta;
  });
}

/**
 * Cache generated descriptions.
 *
 * This writes ONLY `autoDescription`/`autoDescriptionKind`. A user-authored
 * `description` is never read, never compared, and never written here, so
 * regeneration cannot destroy manual work. The write is skipped entirely when
 * nothing changed, so opening the panel does not churn `.code-canvas/meta.json`.
 * Read and write happen inside one queued critical section (see `enqueue`).
 */
export async function mergeAutoDescriptions(
  root: string,
  entries: AutoDescriptions
): Promise<MetaFile> {
  return enqueue(root, async () => {
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
    if (changed) await writeMetaUnsafe(root, meta);
    return meta;
  });
}
