const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const iterations = 40000,
  samples = 5,
  warmups = 10000;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
async function main() {
  if (process.argv[2] !== "--child") {
    if (!process.argv[2]) throw new Error("Usage: node benchmark/fields.js <frozen-package-directory>");
    const roots = { baseline: path.resolve(process.argv[2]), candidate: path.resolve(__dirname, "..") };
    const runs = [];
    for (const label of [
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]) {
      const env = { ...process.env, NODE_TREE_SITTER_TEST_STDERR: "1" };
      delete env.CI;
      const child = spawnSync(process.execPath, ["--expose-gc", __filename, "--child", roots[label]], {
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout || String(child.error));
      runs.push({ label, ...JSON.parse(child.stdout) });
    }
    if (new Set(runs.map((r) => r.checksum)).size !== 1) throw new Error("Field results differ between variants");
    const comparison = {};
    for (const label of Object.keys(roots)) {
      const selected = runs.filter((r) => r.label === label);
      comparison[label] = {
        medianBatchMs: median(selected.map((r) => median(r.samplesMs))),
        medianRssGrowthBytes: median(selected.map((r) => r.memory.at(-1).rss - r.memory[0].rss)),
      };
    }
    console.log(
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          runtime: process.versions,
          order: "ABBAABBA",
          iterations,
          samples,
          warmups,
          comparison,
          runs,
        },
        null,
        2,
      ),
    );
    return;
  }
  const root = process.argv[3];
  const P = require(root);
  const language = await P.loadLanguage(
    "python",
    fs.readFileSync(path.join(__dirname, "../test/fixtures/python.wasm")),
  );
  const parser = new P().setLanguage(language);
  const node = parser.parse("if a:\n  b\nelif c:\n  d\nelif e:\n  f\nelse:\n  g\n").rootNode.firstNamedChild;
  const expected = node.childrenForFieldName("alternative");
  const cursor = node.walk();
  cursor.gotoFirstChild();
  let fieldId;
  do {
    if (cursor.currentFieldName === "alternative") {
      fieldId = cursor.currentFieldId;
      break;
    }
  } while (cursor.gotoNextSibling());
  if (!fieldId || expected.length !== 3) throw new Error("Unexpected grammar shape");
  const loop = (count) => {
    let checksum = 0;
    for (let i = 0; i < count; i++) {
      for (const result of [node.childrenForFieldName("alternative"), node.childrenForFieldId(fieldId)]) {
        if (result.length !== 3 || result.some((n, index) => n !== expected[index]))
          throw new Error("Field identities changed");
        checksum += result.length;
      }
    }
    return checksum;
  };
  loop(warmups);
  global.gc();
  const memory = [process.memoryUsage()],
    samplesMs = [];
  let checksum = 0;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    checksum += loop(iterations);
    samplesMs.push(performance.now() - start);
    global.gc();
    memory.push(process.memoryUsage());
  }
  const binarySha256 = createHash("sha256")
    .update(fs.readFileSync(path.join(root, "build/Release/tree_sitter_runtime_binding.node")))
    .digest("hex");
  console.log(JSON.stringify({ binarySha256, samplesMs, memory, checksum }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
