import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED_TOOLS = ["begin_edit_session", "review_edit_session"];

function localEndpoint(value) {
  const url = new URL(value || "http://127.0.0.1:5199/api/external-mcp/mcp");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("OpenChatCut MCP 连接仅允许本机 HTTP 地址");
  }
  return url;
}

async function withOpenChatCutClient({ url = process.env.OPENCHATCUT_MCP_URL, token = process.env.OPENCHATCUT_MCP_TOKEN, timeoutMs = 4000 } = {}, action) {
  const endpoint = localEndpoint(url);
  const bearer = token?.trim() || (await fs.readFile(join(homedir(), ".openchatcut", "mcp-token"), "utf8")).trim();
  const abort = AbortSignal.timeout(timeoutMs);
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers, signal: abort } });
  const client = new Client({ name: "wayne-openchatcut-sidecar", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await action(client, endpoint);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export async function probeOpenChatCut(options = {}) {
  return withOpenChatCutClient(options, async (client, endpoint) => {
    const result = await client.listTools();
    const tools = (result.tools || []).map((tool) => String(tool.name));
    const missingTools = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    return { status: missingTools.length ? "incompatible" : "ready", endpoint: endpoint.origin, server: client.getServerVersion?.() || null, toolCount: tools.length, missingTools };
  });
}

export function normalizeOpenChatCutProjects(result) {
  if (result?.isError) {
    const message = result.structuredContent?.message || result.content?.find((item) => item.type === "text")?.text;
    throw new Error(message || "OpenChatCut MCP 工具调用失败");
  }
  let projects = result?.structuredContent?.result ?? result?.structuredContent;
  if (!Array.isArray(projects)) {
    const text = result?.content?.find((item) => item.type === "text")?.text;
    try { projects = JSON.parse(text || "null"); } catch { projects = null; }
    if (!Array.isArray(projects)) projects = projects?.result;
  }
  if (!Array.isArray(projects)) throw new Error("OpenChatCut 项目列表格式无效");
  return projects.flatMap((project) => {
    const id = typeof project?.id === "string" ? project.id.trim() : "";
    if (!id || id.length > 128) return [];
    const name = typeof project.name === "string" ? project.name.trim().slice(0, 160) : "";
    const updatedAt = project.updatedAt == null ? null : Number(project.updatedAt);
    return [{ id, name: name || "未命名工程", updatedAt: Number.isFinite(updatedAt) ? updatedAt : null }];
  });
}

export async function listOpenChatCutProjects(options = {}) {
  return withOpenChatCutClient(options, async (client) => {
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    return normalizeOpenChatCutProjects(result);
  });
}
