// Explicit, checksum-verified provisioning; never run from the install hook.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const version = "48.0.1"; // Matches the pinned Tree-sitter runtime's Wasmtime dependency.
const targets = {
  "win32-x64": ["x86_64-windows", "40bd84d36dfaa1e0a9658fbb16377952a116469cc2ebe61c1ca6e4ad07104989"],
  "win32-arm64": ["aarch64-windows", "d80fda8877a80c7e47970fcfaabac65eb0fa5c99f93e17c8ea2996e4f819952b"],
  "linux-x64": ["x86_64-linux", "67683d04b416a8b91f0e607e7b4c22bd32f18f947c10b5372eb8c277ae3b883a"],
  "linux-arm64": ["aarch64-linux", "1c521a9be661644541158b360df8f7c7ec5bc2d88d23ff4dbbc12f639247c266"],
  "darwin-x64": ["x86_64-macos", "a5d92170718d41e4bd08173049019f0cedb318d0156365a52667d4a35ea3ca69"],
  "darwin-arm64": ["aarch64-macos", "9e3c636ed487a41026ff76388c5fa6f3a48ea0968408d033ed4b5e8082c20d69"],
};
async function main() {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error("No pinned Wasmtime archive for this platform; set WASMTIME_ROOT to a source build.");
  const directory = path.resolve(__dirname, "../.deps");
  fs.mkdirSync(directory, { recursive: true });
  const name = `wasmtime-v${version}-${target[0]}-c-api`;
  const archive = path.join(directory, name + (process.platform === "win32" ? ".zip" : ".tar.xz"));
  if (!fs.existsSync(archive)) {
    const response = await fetch(
      `https://github.com/bytecodealliance/wasmtime/releases/download/v${version}/${path.basename(archive)}`,
    );
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !== target[1]) {
    throw new Error("Wasmtime archive checksum mismatch");
  }
  execFileSync("tar", ["-xf", archive, "-C", directory], { stdio: "inherit" });
  fs.writeFileSync(path.join(directory, "wasmtime-root.txt"), path.join(directory, name));
  console.log(`Wasmtime ${version}: ${path.join(directory, name)}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
