const { spawnSync } = require("node:child_process");
const { globSync } = require("node:fs");
const env = { ...process.env };
env.NODE_TREE_SITTER_TEST_STDERR = "1";
delete env.CI;
// Native timeout assertions measure short wall-clock intervals. Do not run
// their process alongside the CPU-heavy stress suites in this same test run.
const result = spawnSync(process.execPath, ["--expose-gc", "--test", "--test-concurrency=1", ...globSync("test/**/*test.js")], { stdio: "inherit", env });
process.exitCode = result.status ?? 1;
