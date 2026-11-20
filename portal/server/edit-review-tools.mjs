import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  EDIT_REVIEW_DIMENSION_IDS,
  analyzeVideoEdit,
  compareVideoEdits,
  createContactSheet,
  cropFrameRegion,
  persistAnalysis,
  persistComparison,
  renderFrame,
  writeReviewReport,
} from "./edit-review.mjs";
import { workspacePath } from "./workspace-path.mjs";

const dimensionIdSchema = z.enum([...EDIT_REVIEW_DIMENSION_IDS]);
const analysisOptions = {
  sceneThreshold: z.number().min(0.05).max(0.9).default(0.24).describe("FFmpeg scene score threshold; lower detects more candidate cuts."),
  silenceDb: z.number().min(-80).max(0).default(-35).describe("Silence detector threshold in dB."),
  silenceMinSeconds: z.number().min(0.1).max(5).default(0.35).describe("Minimum silence duration in seconds."),
  motionSampleFps: z.number().min(0.5).max(10).default(3).describe("Low-resolution motion sampling rate."),
};
const evidenceSchema = z.object({
  video: z.string().min(1),
  timeSeconds: z.number().min(0).optional(),
  note: z.string().min(1),
}).strict();
const dimensionReviewSchema = z.object({
  id: dimensionIdSchema,
  score: z.number().min(0).max(4),
  note: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
}).strict();
const hardDefectSchema = z.object({
  video: z.string().min(1),
  timeSeconds: z.number().min(0).optional(),
  severity: z.enum(["critical", "major", "minor"]),
  code: z.string().min(1),
  note: z.string().min(1),
}).strict();
const videoReviewSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  analysisPath: z.string().min(1).optional(),
  dimensions: z.array(dimensionReviewSchema).min(6).max(6),
  hardDefects: z.array(hardDefectSchema).default([]),
  strengths: z.array(z.string().min(1)).default([]),
  weaknesses: z.array(z.string().min(1)).default([]),
}).strict();
const reviewSchema = z.object({
  contract: z.literal("talking-head-edit-review.v1"),
  mode: z.enum(["single", "pairwise"]),
  summary: z.string().min(1),
  winner: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  videos: z.array(videoReviewSchema).min(1).max(2),
  limitations: z.array(z.string().min(1)).default([]),
}).strict();

function toRelative(root, target) {
  return relative(root, target).replaceAll("\\", "/");
}

function imageContent(imagePath, mimeType = "image/jpeg") {
  return fs.readFile(imagePath).then((data) => ({ type: "image", mimeType, data: data.toString("base64") }));
}

export async function startEditReviewTools(workDir, auditPath) {
  const root = await fs.realpath(workDir);
  const audit = async (entry) => {
    if (!auditPath) return;
    await fs.mkdir(dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const server = new McpServer({ name: "talking-head-edit-review", version: "1.0.0" });

  const registerText = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const payload = await handler(args || {});
        await audit({ tool: name, ok: true, ...(payload?.analysisPath ? { analysisPath: payload.analysisPath } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        await audit({ tool: name, ok: false, error: error.message });
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    });
  };

  registerText(
    "analyze_edit",
    "Measure one talking-head video's editing form with ffprobe/FFmpeg: source facts, scene-cut candidates, shot rhythm, low-resolution motion, silence/loudness, black/freeze candidates and review timestamps. It never scores captions, B-roll, composition or speaker/content quality; inspect returned frames and use the talking-head-edit-review skill for those judgments.",
    {
      video: z.string().min(1).describe("Workspace-relative video path."),
      ...analysisOptions,
    },
    async ({ video, ...options }) => {
      const target = await workspacePath(root, video);
      const analysis = await analyzeVideoEdit(target, { ...options, displayPath: video });
      const analysisPath = await persistAnalysis(root, analysis);
      return { ...analysis, analysisPath };
    },
  );

  registerText(
    "compare_edits",
    "Run analyze_edit for two workspace videos and return factual metric deltas plus evidence timestamps. Use extract_contact_sheet and view_frame before assigning any score. Content, speaker charisma and factual correctness are out of scope.",
    {
      videoA: z.string().min(1).describe("Workspace-relative path to video A."),
      videoB: z.string().min(1).describe("Workspace-relative path to video B."),
      labelA: z.string().max(40).default("A"),
      labelB: z.string().max(40).default("B"),
      ...analysisOptions,
    },
    async ({ videoA, videoB, labelA, labelB, ...options }) => {
      const targetA = await workspacePath(root, videoA);
      const targetB = await workspacePath(root, videoB);
      const comparison = await compareVideoEdits(targetA, targetB, {
        ...options,
        labelA,
        labelB,
        displayPathA: videoA,
        displayPathB: videoB,
      });
      const analysisPaths = {
        [labelA]: await persistAnalysis(root, comparison.videos[0].analysis),
        [labelB]: await persistAnalysis(root, comparison.videos[1].analysis),
      };
      comparison.videos[0].analysis.analysisPath = analysisPaths[labelA];
      comparison.videos[1].analysis.analysisPath = analysisPaths[labelB];
      const comparisonPath = await persistComparison(root, comparison);
      return { ...comparison, analysisPaths, comparisonPath };
    },
  );

  server.registerTool(
    "extract_contact_sheet",
    {
      description:
        "Extract a 4-12 frame chronological contact sheet from one workspace video and return it as an image. Use it to inspect shot organization, B-roll, captions, graphics, composition and continuity. Times are approximate uniform samples; use view_frame for exact evidence timestamps.",
      inputSchema: {
        video: z.string().min(1).describe("Workspace-relative video path."),
        count: z.number().int().min(4).max(12).default(9),
      },
    },
    async ({ video, count }) => {
      try {
        const target = await workspacePath(root, video);
        const outputDirectory = await workspacePath(root, ".edit-review/frames", { existing: false });
        const outputPath = join(outputDirectory, `${randomUUID().slice(0, 8)}-contact.jpg`);
        const sheet = await createContactSheet(target, { count, outPath: outputPath });
        await audit({ tool: "extract_contact_sheet", ok: true, video, count, path: toRelative(root, outputPath) });
        return {
          content: [
            { type: "text", text: JSON.stringify({ ...sheet, path: toRelative(root, outputPath) }) },
            await imageContent(outputPath),
          ],
        };
      } catch (error) {
        await audit({ tool: "extract_contact_sheet", ok: false, error: error.message });
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  );

  server.registerTool(
    "view_frame",
    {
      description:
        "Return one exact frame from a workspace video for visual evidence. Use this around cut candidates, B-roll boundaries, caption/graphic events, black/freeze candidates and continuity problems. Always cite the returned timestamp in the review.",
      inputSchema: {
        video: z.string().min(1).describe("Workspace-relative video path."),
        timeSeconds: z.number().min(0).describe("Exact timestamp in seconds."),
      },
    },
    async ({ video, timeSeconds }) => {
      try {
        const target = await workspacePath(root, video);
        const outputDirectory = await workspacePath(root, ".edit-review/frames", { existing: false });
        const outputPath = join(outputDirectory, `${randomUUID().slice(0, 8)}-${String(timeSeconds).replaceAll(".", "_")}.jpg`);
        await renderFrame(target, timeSeconds, outputPath);
        await audit({ tool: "view_frame", ok: true, video, timeSeconds, path: toRelative(root, outputPath) });
        return {
          content: [
            { type: "text", text: `${video} at ${Number(timeSeconds).toFixed(3)}s` },
            await imageContent(outputPath),
          ],
        };
      } catch (error) {
        await audit({ tool: "view_frame", ok: false, error: error.message });
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  );

  server.registerTool(
    "view_frame_region",
    {
      description:
        "Return one exact frame region, cropped and upscaled from the original video resolution. Use normalized x/y/width/height for typography detail: title band, identity card, caption band, logo or small graphics. The returned crop is suitable for comparing font skeleton, weight, letter spacing, stroke thickness, shadow, panel color/opacity and padding.",
      inputSchema: {
        video: z.string().min(1).describe("Workspace-relative video path."),
        timeSeconds: z.number().min(0).describe("Exact timestamp in seconds."),
        region: z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().min(0.01).max(1),
          height: z.number().min(0.01).max(1),
        }).strict().describe("Normalized crop region; x+width and y+height must not exceed 1."),
        scale: z.number().min(1).max(4).default(2).describe("Upscale factor using Lanczos."),
      },
    },
    async ({ video, timeSeconds, region, scale }) => {
      try {
        const target = await workspacePath(root, video);
        const outputDirectory = await workspacePath(root, ".edit-review/regions", { existing: false });
        const outputPath = join(
          outputDirectory,
          `${randomUUID().slice(0, 8)}-${String(timeSeconds).replaceAll(".", "_")}-${Math.round(region.x * 1000)}-${Math.round(region.y * 1000)}.png`,
        );
        const result = await cropFrameRegion(target, { timeSeconds, region, scale, outPath: outputPath });
        await audit({ tool: "view_frame_region", ok: true, video, timeSeconds, region, scale, path: toRelative(root, outputPath) });
        return {
          content: [
            { type: "text", text: JSON.stringify({ ...result, path: toRelative(root, outputPath) }) },
            await imageContent(outputPath, "image/png"),
          ],
        };
      } catch (error) {
        await audit({ tool: "view_frame_region", ok: false, error: error.message });
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  );

  registerText(
    "write_review_report",
    "Persist the final skill-authored talking-head edit review as versioned JSON and Markdown. Scores must be 0-4 and every dimension needs time-coded evidence. The tool computes weighted scores and hard-defect penalties; it does not invent missing judgments.",
    { review: reviewSchema },
    async ({ review }) => writeReviewReport(root, review),
  );

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workDir = process.argv[2] || process.cwd();
  const auditPath = process.argv[3] || join(workDir, ".edit-review", "audit.jsonl");
  await fs.mkdir(workDir, { recursive: true });
  const server = await startEditReviewTools(workDir, auditPath);
  await server.connect(new StdioServerTransport());
}
