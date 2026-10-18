const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = function extractArchive(archive, destination, { stripComponents = 0, members = [] } = {}) {
  // Git Bash may put GNU tar first on PATH. Windows' libarchive tar also
  // supports the Wasmtime zip, and does not treat drive letters as hosts.
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const directory = path.dirname(archive);
  const args = ["-xf", path.basename(archive), "-C", path.relative(directory, destination) || "."];
  if (stripComponents) args.push(`--strip-components=${stripComponents}`);
  args.push(...members);
  execFileSync(tar, args, { cwd: directory, stdio: "inherit", windowsHide: true });
};
