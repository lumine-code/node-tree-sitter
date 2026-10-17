const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const samples = 15,
  warmups = 2,
  lines = 20000;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
async function main() {
  if (process.argv[2] !== "--child") {
    if (!process.argv[2]) throw new Error("Usage: node benchmark/cold-captures.js <frozen-package-directory>");
    const roots = { baseline: path.resolve(process.argv[2]), candidate: path.resolve(__dirname, "..") },
      runs = [];
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
      const result = spawnSync(process.execPath, ["--expose-gc", __filename, "--child", roots[label]], {
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
      runs.push({ label, ...JSON.parse(result.stdout) });
    }
    if (new Set(runs.map((r) => r.checksum)).size !== 1) throw new Error("Capture checksums differ");
    const comparison = {};
    for (const label of Object.keys(roots))
      comparison[label] = {
        medianMs: median(runs.filter((r) => r.label === label).map((r) => median(r.samplesMs))),
      };
    console.log(
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          runtime: process.versions,
          samples,
          warmups,
          lines,
          order: "ABBAABBA",
          comparison,
          runs,
        },
        null,
        2,
      ),
    );
    return;
  }
  const root = process.argv[3],
    P = require(root);
  const language = await P.loadLanguage(
    "javascript",
    fs.readFileSync(path.join(__dirname, "../test/fixtures/javascript.wasm")),
  );
  const tree = new P().setLanguage(language).parse("const x = 0;\n".repeat(lines));
  const query = new P.Query(language, "(identifier) @first @second");
  const samplesMs = [];
  let captures = null,
    checksum = 0;
  for (let i = 0; i < warmups + samples; i++) {
    // Drop the prior output before GC, unlike the warm-cache control. Fresh
    // wrappers must be materialized and repeated native IDs deduplicated.
    captures = null;
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    const start = performance.now();
    captures = query.captures(tree.rootNode);
    const elapsed = performance.now() - start;
    if (captures.length !== lines * 2) throw new Error("Wrong capture count");
    for (let n = 0; n < captures.length; n += 2) {
      if (captures[n].node !== captures[n + 1].node || captures[n] === captures[n + 1])
        throw new Error("Wrong capture identity");
    }
    checksum += captures.length + captures[0].node.startIndex + captures.at(-1).node.endIndex;
    if (i >= warmups) samplesMs.push(elapsed);
  }
  const binarySha256 = createHash("sha256")
    .update(fs.readFileSync(path.join(root, "build/Release/tree_sitter_runtime_binding.node")))
    .digest("hex");
  console.log(JSON.stringify({ binarySha256, samplesMs, checksum }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
