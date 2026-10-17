const { spawnSync } = require("node:child_process");
const { globSync } = require("node:fs");
const env = { ...process.env };
delete env.CI;
const result = spawnSync(process.execPath, ["--test", ...globSync("test/**/*test.js")], { stdio: "inherit", env });
process.exitCode = result.status ?? 1;
