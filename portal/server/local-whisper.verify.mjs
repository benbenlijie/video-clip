import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhisperSrt, getWhisperConfig, transcribeWithWhisper, runWithWhisperSlot } from "./local-whisper.mjs";

assert.equal(parseWhisperSrt("1\n00:00:00,120 --> 00:00:01,450\n繁琐的剪辑工具\n\n2\n00:00:01,500 --> 00:00:02,000\n交给 AI\n")[0].startMs, 120);
assert.deepEqual(parseWhisperSrt("1\n00:00:00,120 --> 00:00:01,450\n繁琐的剪辑工具\n\n2\n00:00:01,500 --> 00:00:02,000\n交给 AI\n").map(({ endMs, text }) => ({ endMs, text })), [
  { endMs: 1450, text: "繁琐的剪辑工具" },
  { endMs: 2000, text: "交给 AI" },
]);

const missing = getWhisperConfig({ WAYNE_WHISPER_CLI_PATH: "/missing/whisper-cli", WAYNE_WHISPER_MODEL_PATH: "/missing/model.bin" });
assert.equal(missing.available, false, "missing CLI/model must take the manual-review path");
assert.equal(getWhisperConfig({ WAYNE_WHISPER_THREADS: "0" }).available, false, "invalid thread counts must disable the local pass");

let active = 0;
let maximum = 0;
await Promise.all(Array.from({ length: 3 }, () => runWithWhisperSlot(async () => {
  active += 1;
  maximum = Math.max(maximum, active);
  await new Promise((resolve) => setTimeout(resolve, 15));
  active -= 1;
})));
assert.equal(maximum, 1, "only one CPU Whisper process may run at a time");

const root = await mkdtemp(join(tmpdir(), "wayne-local-whisper-"));
try {
  const cli = join(root, "fake whisper cli.mjs");
  const model = join(root, "small model.bin");
  const audio = join(root, "audio.wav");
  const argsPath = join(root, "args.json");
  await Promise.all([
    writeFile(model, "fixture model"),
    writeFile(audio, "fixture wav"),
    writeFile(cli, `#!/usr/bin/env node\nimport { writeFile } from 'node:fs/promises';\nconst args = process.argv.slice(2);\nawait writeFile(${JSON.stringify(argsPath)}, JSON.stringify(args));\nconst out = args[args.indexOf('-of') + 1];\nawait writeFile(out + '.srt', '1\\n00:00:00,100 --> 00:00:01,200\\n把繁琐的剪辑工具交给 AI\\n');\n`),
  ]);
  const { chmod } = await import("node:fs/promises");
  await chmod(cli, 0o755);
  const result = await transcribeWithWhisper({ audioPath: audio, config: { cliPath: cli, modelPath: model, threads: 8, timeoutMs: 5000, available: true } });
  const args = JSON.parse(await readFile(argsPath, "utf8"));
  assert.ok(args.includes("-ng"), "the command must explicitly disable GPU use");
  assert.equal(args[args.indexOf("-t") + 1], "8");
  assert.equal(result.provider, "whisper.cpp");
  assert.equal(result.model, "small_q5_1");
  assert.equal(result.segments[0].text, "把繁琐的剪辑工具交给 AI");
  assert.equal(result.segments[0].startMs, 100);
  const failedCli = join(root, "failed.mjs");
  await writeFile(failedCli, "#!/usr/bin/env node\nprocess.exit(7);\n");
  await chmod(failedCli, 0o755);
  await assert.rejects(transcribeWithWhisper({ audioPath: audio, config: { cliPath: failedCli, modelPath: model, threads: 8, timeoutMs: 5000, available: true } }), /Whisper.*7|退出 7/);

  const slowCli = join(root, "slow.mjs");
  await writeFile(slowCli, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 500);\n");
  await chmod(slowCli, 0o755);
  await assert.rejects(transcribeWithWhisper({ audioPath: audio, config: { cliPath: slowCli, modelPath: model, threads: 8, timeoutMs: 30, available: true } }), /超时|timeout/i);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("local-whisper.verify: config, SRT normalization, CPU command, bounded process and concurrency passed");
