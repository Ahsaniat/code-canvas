// The protocol shapes live in `shared/protocol.ts`; re-exported so existing
// imports keep working and the host/webview copies cannot drift.
export type { FileMeta, MetaFile } from '../../../shared/protocol';
