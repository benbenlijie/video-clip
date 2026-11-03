import assert from "node:assert/strict";
import { normalizeOpenChatCutProjects, probeOpenChatCut } from "./openchatcut-sidecar.mjs";

await assert.rejects(probeOpenChatCut({ url: "https://example.com/mcp", token: "unused" }), /仅允许本机 HTTP 地址/);
await assert.rejects(probeOpenChatCut({ url: "file:///tmp/mcp", token: "unused" }), /Invalid URL|仅允许本机 HTTP 地址/);
assert.deepEqual(normalizeOpenChatCutProjects({
  structuredContent: { result: [{ id: "test-id", name: "Wayne Integration", updatedAt: 1793580071973, editorUrl: "http://127.0.0.1:5199/#/editor/test-id", description: "/private/path" }] },
}), [{ id: "test-id", name: "Wayne Integration", updatedAt: 1793580071973 }]);
assert.deepEqual(normalizeOpenChatCutProjects({
  content: [{ type: "text", text: JSON.stringify({ result: [{ id: "project-2", name: "Example project" }] }) }],
}), [{ id: "project-2", name: "Example project", updatedAt: null }]);
assert.throws(() => normalizeOpenChatCutProjects({ structuredContent: { result: "invalid" } }), /项目列表格式无效/);
console.log("openchatcut-sidecar.verify: MCP targets are restricted to loopback HTTP");
