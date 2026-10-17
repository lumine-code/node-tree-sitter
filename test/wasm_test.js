const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const Parser = require("..");
const Web = require("web-tree-sitter");
const bytes = (name) => fs.readFileSync(path.join(__dirname, "fixtures", `${name}.wasm`));
let javascript;
before(async () => {
  javascript = await Parser.loadLanguage("javascript", bytes("javascript"));
  await Web.Parser.init();
});

test("background snapshots include immutable syntax changes computed against the edited input", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const before = await parser.parse("x;", { revision: 1 });
    const after = await parser.parse("[1];", {
      previous: before,
      revision: 2,
      edits: [{ startIndex: 0, oldEndIndex: 1, newText: "[1]" }],
    });
    const edited = before.copy();
    edited.edit({
      startIndex: 0,
      oldEndIndex: 1,
      newEndIndex: 3,
      startPosition: { row: 0, column: 0 },
      oldEndPosition: { row: 0, column: 1 },
      newEndPosition: { row: 0, column: 3 },
    });
    assert.deepEqual(after.changedRanges, edited.getChangedRanges(after));
    assert.ok(after.changedRanges.length > 0);
    assert.ok(Object.isFrozen(after.changedRanges));
    assert.ok(after.changedRanges.every((range) => Object.isFrozen(range) && Object.isFrozen(range.startPosition)));
    assert.deepEqual(before.changedRanges, []);
    assert.equal(before.rootNode.text, "x;");
  } finally {
    parser.close();
  }
});

test("unchanged portable grammars produce the same trees as web-tree-sitter", async () => {
  const sources = {
    javascript: 'const café = "🦉";\r\nfunction f(x) { return `${x + 1}`; }',
    python: 'def café(x):\r\n    """🦉"""\r\n    return f"value: {x + 1}"\r\n',
    html: "<main><script>const x = 1;</script><style>a { color: red }</style></main>",
    json: '{"emoji":"🦉","values":[1,true,null]}',
  };
  for (const [name, source] of Object.entries(sources)) {
    const language = await Parser.loadLanguage(name, bytes(name));
    const parser = new Parser.BackgroundParser(language);
    const web = new Web.Parser();
    const webLanguage = await Web.Language.load(bytes(name));
    web.setLanguage(webLanguage);
    const expected = web.parse(source);
    const actual = await parser.parse(source, { revision: 7 });
    assert.equal(actual.rootNode.toString(), expected.rootNode.toString(), name);
    assert.equal(actual.rootNode.text, source);
    assert.equal(actual.revision, 7);
    assert.equal(actual.rootNode.hasError, false);
    expected.delete();
    web.delete();
    parser.close();
  }
});

test("native queries on a Wasm language match web captures, including UTF-16 positions", async () => {
  const source = 'const café = "🦉";\r\nconst value = café;';
  const parser = new Parser.BackgroundParser(javascript);
  const tree = await parser.parse(source);
  const query = new Parser.Query(javascript, "(identifier) @name");
  const native = query
    .captures(tree.rootNode)
    .map((c) => [c.name, c.node.text, c.node.startIndex, c.node.startPosition]);
  const language = await Web.Language.load(bytes("javascript"));
  const web = new Web.Parser();
  web.setLanguage(language);
  const webTree = web.parse(source);
  const webQuery = new Web.Query(language, "(identifier) @name");
  assert.deepEqual(
    native,
    webQuery.captures(webTree.rootNode).map((c) => [c.name, c.node.text, c.node.startIndex, c.node.startPosition]),
  );
  webQuery.delete();
  webTree.delete();
  web.delete();
  parser.close();
});

test("incremental parsing preserves old nodes and their original text", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const first = await parser.parse("const x = 1;", { revision: 1 });
  const oldNode = first.rootNode;
  const second = await parser.parse("const longer = 1;", {
    previous: first,
    edits: [{ startIndex: 6, oldEndIndex: 7, newText: "longer" }],
    revision: 2,
  });
  assert.equal(oldNode.text, "const x = 1;");
  assert.equal(oldNode.endIndex, 12);
  assert.equal(second.rootNode.text, "const longer = 1;");
  assert.equal(second.rootNode.hasError, false);
  assert.throws(() => first.edit({}), /immutable/);
  parser.close();
});

test("sequential multiline edits handle CRLF and surrogate pairs", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const old = await parser.parse('let x = "a";\r\nx;');
  const edits = [
    { startIndex: 9, oldEndIndex: 10, newText: "🦉" },
    { startIndex: 0, oldEndIndex: 0, newText: "// head\n" },
  ];
  const text = '// head\nlet x = "🦉";\r\nx;';
  const actual = await parser.parse(text, { previous: old, edits });
  const fresh = await parser.parse(text);
  assert.equal(actual.rootNode.toString(), fresh.rootNode.toString());
  assert.equal(old.rootNode.text, 'let x = "a";\r\nx;');
  parser.close();
});

test("included ranges retain document coordinates and reset between requests", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const text = "<script>let x = 1;</script>";
  const tree = await parser.parse(text, {
    includedRanges: [
      { startIndex: 8, endIndex: 18, startPosition: { row: 0, column: 8 }, endPosition: { row: 0, column: 18 } },
    ],
  });
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.startIndex, 8);
  assert.equal((await parser.parse("let y = 2;")).rootNode.startIndex, 0);
  parser.close();
});

test("invalid modules and export names reject without poisoning later loads", async () => {
  await assert.rejects(Parser.loadLanguage("bad", Buffer.from("not wasm")));
  await assert.rejects(Parser.loadLanguage("missing_export", bytes("json")));
  const language = await Parser.loadLanguage("json", bytes("json"));
  const parser = new Parser.BackgroundParser(language);
  assert.equal((await parser.parse("{}")).rootNode.hasError, false);
  parser.close();
});

test("bad edits, coordinates and cross-language snapshots reject", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const first = await parser.parse("x;");
  await assert.rejects(parser.parse("y;", { previous: first }), /do not transform/);
  await assert.rejects(
    parser.parse("x;", { previous: first, edits: [{ startIndex: -1, oldEndIndex: 1, newText: "x" }] }),
    /startIndex/,
  );
  await assert.rejects(
    parser.parse("x;", {
      includedRanges: [
        { startIndex: 0, endIndex: 2, startPosition: { row: 1, column: 0 }, endPosition: { row: 0, column: 2 } },
      ],
    }),
    /positions/,
  );
  const json = new Parser.BackgroundParser(await Parser.loadLanguage("json", bytes("json")));
  await assert.rejects(json.parse("x;", { previous: first }), /same language/);
  parser.close();
  json.close();
});

test("cancellation discards partial work and the parser can be reused", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const controller = new AbortController();
  const pending = parser.parse("let x = 1;\n".repeat(100000), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await parser.parse("let y = 2;")).rootNode.hasError, false);
  parser.close();
});

test("close cancels pending work and rejects future requests", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const pending = parser.parse("let x = 1;\n".repeat(100000));
  parser.close();
  parser.close();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(parser.parse("x;"), /closed/);
});

test("closed parsers release their store without invalidating delivered snapshots", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const tree = await parser.parse("const keep = 1;");
  parser.close();
  parser.close();
  assert.equal(tree.rootNode.text, "const keep = 1;");
  assert.deepEqual(
    new Parser.Query(javascript, "(identifier) @name").captures(tree.rootNode).map((c) => c.node.text),
    ["keep"],
  );
  await assert.rejects(parser.parse("x;"), /closed/);
});

test("a language load owns its bytes before asynchronous compilation", async () => {
  const input = bytes("json");
  const pending = Parser.loadLanguage("json", input);
  input.fill(0);
  const parser = new Parser.BackgroundParser(await pending);
  assert.equal((await parser.parse("{}")).rootNode.hasError, false);
  parser.close();
});

test("one parser rejects concurrent requests while separate parsers are independent", async () => {
  const a = new Parser.BackgroundParser(javascript),
    b = new Parser.BackgroundParser(javascript);
  const pending = a.parse("x;".repeat(10000));
  await assert.rejects(a.parse("y;"), /active parse/);
  const other = b.parse("const b = true;");
  assert.equal((await pending).rootNode.hasError, false);
  assert.equal((await other).rootNode.hasError, false);
  a.close();
  b.close();
});

test("the event loop advances during a large background parse", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await parser.parse("const value = [1, 2, 3];\n".repeat(100000));
    assert.ok(ticks > 0, "parsing must allow timers to run");
  } finally {
    clearInterval(timer);
    parser.close();
  }
});

test("terminating a worker during native parsing does not crash or hang", { timeout: 30000 }, async () => {
  const worker = new Worker(
    `
    const {parentPort, workerData} = require('node:worker_threads');
    const Parser = require(workerData.root);
    const fs = require('node:fs');
    (async () => {
      const language = await Parser.loadLanguage('javascript', fs.readFileSync(workerData.wasm));
      const parser = new Parser.BackgroundParser(language);
      parser.parse('let x = 1;\\n'.repeat(1000000)).catch(() => {});
      parentPort.postMessage('started');
    })();
  `,
    {
      eval: true,
      workerData: { root: path.resolve(__dirname, ".."), wasm: path.join(__dirname, "fixtures/javascript.wasm") },
    },
  );
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.equal(await worker.terminate(), 1);
});
