const LOCAL_PATH = /(^|[\s:=([{"'])((?:[A-Za-z]:\\|\/)(?!\/)[^\s"'`,;)]+)/g;

export function publicErrorText(value) {
  return String(value ?? "").replace(LOCAL_PATH, (_match, prefix) => `${prefix}[服务器本地路径]`);
}

export function sanitizePublicResponse(value, field = "") {
  if (typeof value === "string") return new Set(["error", "message", "analysisError", "analysis_error", "stderr", "stack"]).has(field) ? publicErrorText(value) : value;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicResponse(item, field));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (["path", "dir"].includes(key)) continue;
    output[key] = sanitizePublicResponse(item, key);
  }
  return output;
}
