const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const extractArchive = require("../script/extract-archive");

for (const zip of process.platform === "win32" ? [false, true] : [false]) {
  test(`extracts ${zip ? "zip" : "tar"} archives under a scoped path with spaces`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "@scope archive "));
    t.after(() => {
      assert.equal(path.dirname(root), os.tmpdir());
      fs.rmSync(root, { recursive: true, force: true });
    });
    const source = path.join(root, "release");
    const destination = path.join(root, "extracted source");
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, "header.h"), "verified source\n");
    fs.writeFileSync(path.join(source, "unused.h"), "excluded\n");
    const archive = path.join(root, zip ? "release.zip" : "release.tar");
    const tar =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || process.env.WINDIR, "System32", "tar.exe")
        : "tar";
    execFileSync(tar, ["-cf", path.basename(archive), ...(zip ? ["--format=zip"] : []), "release"], {
      cwd: root,
      windowsHide: true,
    });
    if (process.platform === "win32") {
      // Exercise the Git Bash environment used by package CI.
      const gitBin = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin");
      execFileSync(
        process.execPath,
        [
          "-e",
          `require(process.argv[1])(process.argv[2], process.argv[3], {
        stripComponents: 1, members: ["release/header.h"]
      });`,
          require.resolve("../script/extract-archive"),
          archive,
          destination,
        ],
        {
          env: { ...process.env, PATH: gitBin + path.delimiter + process.env.PATH },
          windowsHide: true,
        },
      );
    } else {
      extractArchive(archive, destination, { stripComponents: 1, members: ["release/header.h"] });
    }
    assert.equal(fs.readFileSync(path.join(destination, "header.h"), "utf8"), "verified source\n");
    assert.equal(fs.existsSync(path.join(destination, "unused.h")), false);
  });
}
