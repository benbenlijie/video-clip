export const MULTI_ASSET_CHUNK_SIZE = 8 * 1024 * 1024;

export async function hashFileChunks(file, chunkSize = MULTI_ASSET_CHUNK_SIZE) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前浏览器无法安全校验素材续传，请使用支持 HTTPS 的浏览器");
  const chunks = [];
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(file.size, offset + chunkSize);
    const digest = await subtle.digest("SHA-256", await file.slice(offset, end).arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    chunks.push({ offset, length: end - offset, sha256 });
  }
  return chunks;
}

function sameChunks(left = [], right = []) {
  return left.length === right.length && left.every((chunk, index) => chunk.offset === right[index].offset
    && chunk.length === right[index].length
    && chunk.sha256 === right[index].sha256);
}

function matchesAcknowledgedPrefix(asset, fileChunks, fileSize) {
  const receivedBytes = Number(asset.upload?.receivedBytes || 0);
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > fileSize) return false;
  if (receivedBytes === 0) return true;
  const expectedPrefix = fileChunks.filter((chunk) => chunk.offset + chunk.length <= receivedBytes);
  if (!expectedPrefix.length || expectedPrefix.at(-1).offset + expectedPrefix.at(-1).length !== receivedBytes) return false;
  return sameChunks(asset.upload?.chunkHashes || [], expectedPrefix);
}

export function findMatchingMultiAsset(assets, file, fileChunks) {
  const sameNameAndSize = (asset, size) => asset.filename === file.name
    && Number(asset.bytes ?? asset.expectedBytes ?? asset.upload?.totalBytes ?? 0) === size;
  const ready = assets.find((asset) => asset.status === "ready"
    && sameNameAndSize(asset, file.size)
    && sameChunks(asset.chunkHashes || [], fileChunks));
  if (ready) return { asset: ready, incompleteConflict: false };

  const incomplete = assets.filter((asset) => asset.status === "uploading"
    && asset.filename === file.name
    && Number(asset.upload?.totalBytes || asset.expectedBytes || 0) === file.size);
  const resumable = incomplete.find((asset) => matchesAcknowledgedPrefix(asset, fileChunks, file.size));
  return { asset: resumable, incompleteConflict: incomplete.length > 0 && !resumable };
}
