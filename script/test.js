const { spawnSync } = require("node:child_process");
const { globSync } = require("node:fs");
const env = { ...process.env };
env.NODE_TREE_SITTER_TEST_STDERR = "1";
delete env.CI;
const result = spawnSync(process.execPath, ["--expose-gc", "--test", ...globSync("test/**/*test.js")], { stdio: "inherit", env });
process.exitCode = result.status ?? 1;
