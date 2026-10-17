// Git dependency archives omit submodules. Provision the exact upstream source
// explicitly before a source build; this is never an install lifecycle hook.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const revision = "10eb5ac119eec9cb4267a8e035066473983f5f3a";
const checksum = "71bbc0a7a98013b519b104e281e6ad98524a438c8c822a095e6f27de05d15562";

async function main() {
  const root = path.resolve(__dirname, "..");
  const destination = path.join(root, "vendor", "tree-sitter");
  if (fs.existsSync(path.join(destination, "lib", "src", "lib.c"))) return;
  if (fs.existsSync(path.join(destination, "lib")))
    throw new Error("Incomplete Tree-sitter source; refusing to overwrite it");
  const cache = path.join(root, ".deps");
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `tree-sitter-${revision}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const response = await fetch(`https://github.com/tree-sitter/tree-sitter/archive/${revision}.tar.gz`);
    if (!response.ok) throw new Error(`Tree-sitter source download failed: ${response.status}`);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !== checksum) {
    throw new Error("Tree-sitter source archive checksum mismatch");
  }
  const staging = fs.mkdtempSync(path.join(cache, "tree-sitter-source-"));
  execFileSync(
    "tar",
    [
      "-xf",
      archive,
      "-C",
      staging,
      "--strip-components=1",
      `tree-sitter-${revision}/lib/include`,
      `tree-sitter-${revision}/lib/src`,
    ],
    { stdio: "inherit" },
  );
  fs.mkdirSync(destination, { recursive: true });
  // Both absolute paths are children of this package; no existing source is moved.
  if (!staging.startsWith(cache + path.sep) || !destination.startsWith(root + path.sep))
    throw new Error("Invalid runtime staging path");
  fs.renameSync(path.join(staging, "lib"), path.join(destination, "lib"));
  fs.rmdirSync(staging);
  console.log(`Tree-sitter runtime: ${revision}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
