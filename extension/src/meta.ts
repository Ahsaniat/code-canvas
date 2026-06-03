import * as vscode from 'vscode';
import * as path from 'path';
import { MetaFile, FileMeta } from './types/meta';

const META_PATH = '.code-canvas/meta.json';

function metaUri(root: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, META_PATH));
}

export async function readMeta(root: string): Promise<MetaFile> {
  try {
    const raw = await vscode.workspace.fs.readFile(metaUri(root));
    return JSON.parse(Buffer.from(raw).toString('utf8')) as MetaFile;
  } catch {
    return { version: 1, files: {} };
  }
}

export async function writeMeta(root: string, data: MetaFile): Promise<void> {
  const uri = metaUri(root);
  // ensure directory exists
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(uri, content);
}

export async function updateFileMeta(
  root: string,
  filePath: string,
  patch: Partial<FileMeta>
): Promise<MetaFile> {
  const meta = await readMeta(root);
  meta.files[filePath] = { ...meta.files[filePath], ...patch };
  await writeMeta(root, meta);
  return meta;
}
