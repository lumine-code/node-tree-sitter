const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    const root = path.resolve(__dirname, "..");
    const run = async () => {
      await window.loadURL("about:blank");
      return window.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const Parser = require(${JSON.stringify(root)});
      const language = await Parser.loadLanguage('javascript', fs.readFileSync(${JSON.stringify(path.join(root, "test/fixtures/javascript.wasm"))}));
      const parser = new Parser.BackgroundParser(language);
      const first = await parser.parse('const x = 1;', {revision: 1});
      const next = await parser.parse('const y = 1;', {previous: first, edits: [{startIndex: 6, oldEndIndex: 7, newText: 'y'}], revision: 2});
      assert.equal(first.rootNode.text, 'const x = 1;');
      assert.equal(next.rootNode.hasError, false);
      assert.equal(next.revision, 2);
      const pending = parser.parse('let x = 1;\\n'.repeat(100000));
      parser.close();
      await assert.rejects(pending, {name: 'AbortError'});
      return process.versions;
    })()`);
    };
    const versions = await run();
    await run(); // The second navigation unloads the first Node environment.
    console.log(
      JSON.stringify({ electron: versions.electron, node: versions.node, renderer: "passed", reload: "passed" }),
    );
    window.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
