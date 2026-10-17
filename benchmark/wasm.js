const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const lines = Number(process.env.BENCH_LINES || 10000);
const samples = Number(process.env.BENCH_SAMPLES || 10);
const warmups = 2;
const source = Array.from({ length: lines }, (_, i) => `const value${i} = ${i} + 1;`).join("\n");
const bytes = fs.readFileSync(path.join(__dirname, "../test/fixtures/javascript.wasm"));
const mode = process.argv[2];
const stats = (values) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
    samples: values,
  };
};
async function run() {
  if (!mode) {
    const results = [];
    for (const backend of ["web", "native-sync", "native-background"]) {
      const env = { ...process.env };
      delete env.CI;
      const child = spawnSync(process.execPath, ["--expose-gc", __filename, backend], { encoding: "utf8", env });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      results.push(JSON.parse(child.stdout));
    }
    if (new Set(results.map((result) => result.checksum)).size !== 1) throw new Error("Backend syntax trees disagree");
    console.log(JSON.stringify({ runtime: process.versions, lines, samples, warmups, results }, null, 2));
    return;
  }
  const loadStart = performance.now();
  let parser, language;
  if (mode === "web") {
    const Web = require("web-tree-sitter");
    await Web.Parser.init();
    language = await Web.Language.load(bytes);
    parser = new Web.Parser();
    parser.setLanguage(language);
  } else {
    const Native = require("..");
    language = await Native.loadLanguage("javascript", bytes);
    parser = mode === "native-background" ? new Native.BackgroundParser(language) : new Native().setLanguage(language);
  }
  const loadMs = performance.now() - loadStart;
  const totals = [],
    submissions = [],
    incremental = [],
    stalls = [];

  let checksum;
  let firstParseMs;
  try {
    for (let i = 0; i < samples + warmups; i++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      global.gc?.();
      let lastTick = performance.now();
      const heartbeat = setInterval(() => {
        const now = performance.now();
        stalls.push(now - lastTick);
        lastTick = now;
      }, 2);
      const start = performance.now();
      const pending = parser.parse(source);
      const submitted = performance.now();
      const tree = await pending;
      const duration = performance.now() - start;
      if (i === 0) firstParseMs = duration;
      await new Promise((resolve) => setTimeout(resolve, 4));
      clearInterval(heartbeat);
      const text = source.replace("= 0 +", "= 9 +");
      const offset = source.indexOf("= 0") + 2;
      const editStart = performance.now();
      let updated;
      if (mode === "native-background") {
        updated = await parser.parse(text, {
          previous: tree,
          edits: [{ startIndex: offset, oldEndIndex: offset + 1, newText: "9" }],
        });
      } else {
        tree.edit({
          startIndex: offset,
          oldEndIndex: offset + 1,
          newEndIndex: offset + 1,
          startPosition: { row: 0, column: offset },
          oldEndPosition: { row: 0, column: offset + 1 },
          newEndPosition: { row: 0, column: offset + 1 },
        });
        updated = parser.parse(text, tree);
      }
      const editMs = performance.now() - editStart;
      if (i >= warmups) {
        totals.push(duration);
        submissions.push(submitted - start);
        incremental.push(editMs);
      }
      if (updated.rootNode.hasError) throw new Error("Invalid benchmark tree");
      if (i === 0) checksum = crypto.createHash("sha256").update(updated.rootNode.toString()).digest("hex");
      tree.delete?.();
      updated.delete?.();
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  } finally {
    parser.close?.();
    parser.delete?.();
  }
  global.gc?.();
  console.log(
    JSON.stringify({
      mode,
      loadMs,
      firstParseMs,
      initial: stats(totals),
      submission: stats(submissions),
      incremental: stats(incremental),
      heartbeatMaxMs: Math.max(...stalls),
      memory: process.memoryUsage(),
      checksum,
    }),
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
