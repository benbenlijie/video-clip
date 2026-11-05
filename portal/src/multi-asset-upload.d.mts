export type UploadChunkHash = { offset: number; length: number; sha256: string };
export type UploadAsset = {
  id: string;
  filename: string;
  status: string;
  bytes?: number;
  expectedBytes?: number;
  chunkHashes?: UploadChunkHash[];
  upload?: { totalBytes: number; receivedBytes: number; chunkHashes?: UploadChunkHash[] };
};
export const MULTI_ASSET_CHUNK_SIZE: number;
export function hashFileChunks(file: Blob, chunkSize?: number): Promise<UploadChunkHash[]>;
export function findMatchingMultiAsset<T extends UploadAsset>(assets: readonly T[], file: Blob & { name: string }, fileChunks: readonly UploadChunkHash[]): { asset: T | undefined; incompleteConflict: boolean };
