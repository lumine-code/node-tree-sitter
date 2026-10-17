const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const samples = Number(process.env.BENCH_SAMPLES || 7),
  warmups = 2;
const caseFilter = process.env.BENCH_CASE;
if (
  caseFilter &&
  !["ascending5000", "descending5000", "predicate512", "snapshotPredicate512", "simple20000", "cursorWalk"].includes(
    caseFilter,
  )
) {
  throw new Error("Unknown BENCH_CASE");
}
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const statistics = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples,
  };
};
async function main() {
  if (process.argv[2] !== "--child") {
    if (!process.argv[2]) throw new Error("Usage: node benchmark/predicates.js <frozen-package-directory>");
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
      const child = spawnSync(process.execPath, ["--expose-gc", __filename, "--child", roots[label]], {
        encoding: "utf8",
        env,
        timeout: 180000,
      });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout || String(child.error));
      runs.push({ label, ...JSON.parse(child.stdout) });
    }
    if (new Set(runs.map((r) => r.checksum)).size !== 1) throw new Error("Baseline and candidate outputs differ");
    const comparison = {};
    for (const metric of Object.keys(runs[0].metrics)) {
      comparison[metric] = {};
      for (const label of Object.keys(roots))
        comparison[metric][label] = statistics(
          runs.filter((r) => r.label === label).map((r) => r.metrics[metric].medianMs),
        );
    }
    console.log(
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          runtime: process.versions,
          platform: process.platform,
          arch: process.arch,
          samples,
          warmups,
          order: "ABBAABBA",
          caseFilter: caseFilter || null,
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
  const lang = await P.loadLanguage(
    "javascript",
    fs.readFileSync(path.join(__dirname, "../test/fixtures/javascript.wasm")),
  );
  const parser = new P.BackgroundParser(lang),
    sync = new P().setLanguage(lang);
  const source = "const x = 0;\n".repeat(6000),
    previous = await parser.parse(source);
  const edits = Array.from({ length: 5000 }, (_, i) => ({
    startIndex: i * 13 + 10,
    oldEndIndex: i * 13 + 11,
    newText: "9",
  }));
  const updated = "const x = 9;\n".repeat(5000) + "const x = 0;\n".repeat(1000);
  const queryText = "[" + Array(512).fill("1").join(",") + "];",
    queryTree = sync.parse(queryText);
  const backgroundTree = await parser.parse(queryText);
  const filtered = new P.Query(lang, '((array (number) @n ("," (number) @n)*) (#eq? @n "1"))');
  const simple = new P.Query(lang, "(identifier) @name"),
    simpleTree = sync.parse("const x = 0;\n".repeat(20000));
  const metrics = {},
    checks = [];
  async function measure(name, operation, submission = false) {
    // Keep correctness checks for every workload, but isolate timing when
    // investigating a noisy result from the complete mixed-workload run.
    if (caseFilter && caseFilter !== name) return operation();
    const values = [];
    let result;
    for (let i = 0; i < samples + warmups; i++) {
      await new Promise((r) => setImmediate(r));
      global.gc?.();
      const start = performance.now(),
        pending = operation(),
        submitted = performance.now();
      result = await pending;
      if (i >= warmups) values.push(submission ? submitted - start : performance.now() - start);
    }
    metrics[name] = statistics(values);
    return result;
  }
  for (const [name, list] of [
    ["ascending5000", edits],
    ["descending5000", [...edits].reverse()],
  ]) {
    const tree = await measure(name, () => parser.parse(updated, { previous, edits: list }), true);
    checks.push(tree.rootNode.toString(), tree.rootNode.text);
  }
  for (const [name, q, tree] of [
    ["predicate512", filtered, queryTree],
    ["snapshotPredicate512", filtered, backgroundTree],
    ["simple20000", simple, simpleTree],
  ]) {
    const captures = await measure(name, () => q.captures(tree.rootNode));
    checks.push(captures.map((c) => [c.name, c.node.startIndex, c.node.endIndex, c.node.text]));
  }
  checks.push(
    await measure("cursorWalk", () => {
      const cursor = simpleTree.walk();
      let count = 0;
      do {
        count += cursor.currentNode.childCount;
      } while (
        cursor.gotoFirstChild() ||
        cursor.gotoNextSibling() ||
        (() => {
          while (cursor.gotoParent()) if (cursor.gotoNextSibling()) return true;
          return false;
        })()
      );
      return count;
    }),
  );
  parser.close();
  global.gc?.();
  console.log(
    JSON.stringify({
      metrics,
      checksum: hash(JSON.stringify(checks)),
      binary: hash(fs.readFileSync(path.join(root, "build/Release/tree_sitter_runtime_binding.node"))),
      memory: process.memoryUsage(),
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
