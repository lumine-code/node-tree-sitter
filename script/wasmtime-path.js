const fs = require("node:fs");
const path = require("node:path");
const root =
  process.env.WASMTIME_ROOT || fs.readFileSync(path.join(__dirname, "../.deps/wasmtime-root.txt"), "utf8").trim();
const part = process.argv[2];
if (part === "library") {
  console.log(path.join(root, "lib", process.platform === "win32" ? "wasmtime.lib" : "libwasmtime.a"));
} else {
  console.log(path.join(root, part || ""));
}
