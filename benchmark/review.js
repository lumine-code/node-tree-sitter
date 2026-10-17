// Compare a frozen build and the working build in fresh A-B-B-A processes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const samples = Number(process.env.BENCH_SAMPLES || 7);
const warmups = 2;
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: values,
  };
};
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function main() {
  if (process.argv[2] !== "--child") {
    const baseline = process.argv[2];
    if (!baseline) throw new Error("Usage: node benchmark/review.js <frozen-package-directory>");
    const roots = { baseline: path.resolve(baseline), candidate: path.resolve(__dirname, "..") };
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
        encoding: "utf8",
        env,
        timeout: 120000,
      });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout || child.error?.message);
      runs.push({ label, ...JSON.parse(child.stdout) });
    }
    if (new Set(runs.map((run) => run.checksum)).size !== 1) throw new Error("Baseline and candidate results differ");
    const comparison = {};
    for (const metric of Object.keys(runs[0].metrics)) {
      comparison[metric] = {};
      for (const label of Object.keys(roots)) {
        comparison[metric][label] = summary(
          runs.filter((run) => run.label === label).map((run) => run.metrics[metric].medianMs),
        );
      }
    }
    console.log(
      JSON.stringify(
        {
          date: "2026-10-17",
          runtime: process.versions,
          platform: process.platform,
          arch: process.arch,
          samples,
          warmups,
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
  const parser = new P.BackgroundParser(language),
    sync = new P().setLanguage(language);
  const text = "const x = 0;\n".repeat(20000),
    previous = await parser.parse(text);
  const edits = Array.from({ length: 128 }, (_, i) => ({
    startIndex: text.length - 3 - i * 13,
    oldEndIndex: text.length - 2 - i * 13,
    newText: "9",
  }));
  let updated = text;
  for (const edit of edits)
    updated = updated.slice(0, edit.startIndex) + edit.newText + updated.slice(edit.oldEndIndex);
  const ranges = Array.from({ length: 512 }, (_, i) => ({
    startIndex: i * 39,
    endIndex: i * 39 + 12,
    startPosition: { row: i * 3, column: 0 },
    endPosition: { row: i * 3, column: 12 },
  }));
  const capturesTree = sync.parse("[" + Array(512).fill("1").join(",") + "];");
  const query = new P.Query(language, '(array (number) @n ("," (number) @n)*)');
  const filtered = new P.Query(language, '((array (number) @n ("," (number) @n)*) (#eq? @n "1"))');
  const simpleTree = sync.parse(text),
    simple = new P.Query(language, "(identifier) @name");
  const metrics = {},
    check = [];
  async function measure(name, operation, submitOnly = false) {
    const times = [];
    let value;
    for (let i = 0; i < samples + warmups; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc?.();
      const start = performance.now(),
        pending = operation(),
        submitted = performance.now();
      value = await pending;
      const elapsed = performance.now() - start;
      if (i >= warmups) times.push(submitOnly ? submitted - start : elapsed);
    }
    metrics[name] = summary(times);
    return value;
  }
  await measure("construct32Parsers", () => {
    const instances = Array.from({ length: 32 }, () => new P.BackgroundParser(language));
    for (const instance of instances) instance.close();
  });
  const batch = await measure("batch128Submission", () => parser.parse(updated, { previous, edits }), true);
  check.push(batch.rootNode.toString(), previous.rootNode.text);
  const ranged = await measure("ranges512Submission", () => parser.parse(text, { includedRanges: ranges }), true);
  check.push(ranged.rootNode.toString());
  const eof = await measure(
    "singleEditAtEndSubmission",
    () =>
      parser.parse(text + "x;", {
        previous,
        edits: [{ startIndex: text.length, oldEndIndex: text.length, newText: "x;" }],
      }),
    true,
  );
  check.push(eof.rootNode.toString());
  for (const [name, q, tree] of [
    ["quantified512Captures", query, capturesTree],
    ["quantified512WithPredicate", filtered, capturesTree],
    ["simple20000Captures", simple, simpleTree],
  ]) {
    const captures = await measure(name, () => q.captures(tree.rootNode));
    check.push(captures.map((c) => [c.name, c.node.startIndex, c.node.endIndex, c.node.text]));
  }
  parser.close();
  console.log(
    JSON.stringify({
      metrics,
      checksum: digest(JSON.stringify(check)),
      binary: digest(fs.readFileSync(path.join(root, "build/Release/tree_sitter_runtime_binding.node"))),
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
