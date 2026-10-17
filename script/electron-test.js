const { spawnSync } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.CI;
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.ELECTRON_EXECUTABLE || require("electron");
const result = spawnSync(executable, ["--no-sandbox", path.join(__dirname, "electron-smoke.js")], {
  env,
  stdio: "inherit",
  timeout: 60000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
