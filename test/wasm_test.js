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

test("synchronous snapshots publish immediately and interoperate with background snapshots", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const before = await parser.parse('const café = "🦉";\r\n', { revision: 1 });
    const retained = before.rootNode;
    const text = '// header\r\nconst café = "🦉";\r\n';
    const current = parser.parseSync(text, {
      previous: before,
      edits: [{ startIndex: 0, oldEndIndex: 0, newText: '// header\r\n' }],
      revision: 2,
    });
    assert.equal(typeof current.then, "undefined");
    assert.equal(current.revision, 2);
    assert.equal(current.rootNode.text, text);
    assert.equal(current.rootNode.hasError, false);
    assert.equal(retained.text, 'const café = "🦉";\r\n');
    assert.ok(Object.isFrozen(current.changedRanges));
    assert.throws(() => Parser.Tree.prototype.edit.call(current, {
      startIndex: 0, oldEndIndex: 0, newEndIndex: 0,
      startPosition: {row: 0, column: 0},
      oldEndPosition: {row: 0, column: 0},
      newEndPosition: {row: 0, column: 0},
    }), /snapshot/i);
    assert.throws(() => Object.defineProperty(current, "input", { value: "different" }), TypeError);
    const next = await parser.parse(text + "next;", {
      previous: current,
      edits: [{ startIndex: text.length, oldEndIndex: text.length, newText: "next;" }],
      revision: 3,
    });
    assert.equal(next.rootNode.text, text + "next;");
    assert.equal(current.rootNode.text, text);
  } finally {
    parser.close();
  }
});

test("synchronous snapshots validate requests and preserve parser lifecycle after errors", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const before = parser.parseSync("a;", { revision: 1 });
    assert.throws(() => parser.parseSync("b;", { previous: before }), /edits do not transform/);
    assert.equal(parser.busy, false);
    assert.throws(() => parser.parseSync("a;", {
      includedRanges: [{ startIndex: 0, endIndex: 2, startPosition: {row: 0, column: 1}, endPosition: {row: 0, column: 2} }],
    }), /positions must match/);
    const pending = parser.parse("b;");
    assert.throws(() => parser.parseSync("c;"), /active parse/);
    await pending;
    assert.equal(parser.parseSync("d;").rootNode.text, "d;");
    parser.close();
    assert.throws(() => parser.parseSync("e;"), /closed/);
    assert.equal(before.rootNode.text, "a;");
  } finally {
    parser.close();
  }
});

test("bounded initial snapshot parsing resets partial work before another request", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const previous = parser.parseSync("before;", { revision: 1 });
    assert.equal(parser.tryParseSync("const value = 1;\n".repeat(50000), { timeoutMicros: 1 }), null);
    assert.equal(parser.busy, false);
    assert.equal(previous.rootNode.text, "before;");
    const next = parser.parseSync("after;");
    assert.equal(next.rootNode.text, "after;");
    assert.equal(next.rootNode.hasError, false);
    assert.throws(() => parser.tryParseSync("bad;", {timeoutMicros: -1}), RangeError);
    const background = await parser.parse("background;");
    assert.equal(background.rootNode.text, "background;");
  } finally {
    parser.close();
  }
});

test("synchronous snapshot logging respects cancellation, close and retained snapshots", () => {
  const parser = new Parser.BackgroundParser(javascript);
  const before = parser.parseSync("before;");
  let logged = 0;
  parser.setLogger(() => { logged++; });
  assert.equal(typeof parser.getLogger(), "function");
  assert.equal(parser.parseSync("next;").rootNode.text, "next;");
  assert.ok(logged > 0);
  parser.setLogger(() => parser.cancel());
  assert.throws(() => parser.parseSync("cancelled;"), {name: "AbortError"});
  assert.equal(parser.busy, false);
  parser.setLogger(null);
  assert.equal(parser.getLogger(), null);
  assert.equal(parser.parseSync("ready;").rootNode.text, "ready;");
  parser.setLogger(() => parser.close());
  assert.throws(() => parser.parseSync("closed;"), {name: "AbortError"});
  assert.equal(before.rootNode.text, "before;");
  assert.equal(parser.closed, true);
});

test("parse planning uses a private edited tree with accurate text and retains its snapshot", () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const previous = parser.parseSync("before;\r\n");
    const prepared = Parser.BackgroundParser.prepareTree(previous, "longer;\r\n", {
      edits: [{startIndex: 0, oldEndIndex: 6, newText: "longer"}],
    });
    assert.notEqual(prepared, previous);
    assert.equal(prepared.rootNode.text, "longer;\r\n");
    assert.equal(prepared.rootNode.hasChanges, true);
    assert.equal(previous.rootNode.hasChanges, false);
    assert.equal(previous.rootNode.text, "before;\r\n");
    assert.throws(() => parser.parseSync("longer;\r\n", {previous: prepared}), /immutable snapshot/);
    const copy = Parser.BackgroundParser.prepareTree(previous, previous.input);
    assert.notEqual(copy, previous);
    assert.equal(copy.rootNode.text, previous.input);
  } finally {
    parser.close();
  }
});

test("unchanged included text can advance immutably across outside edits", async () => {
  const point = (text, index) => {
    const lines = text.slice(0, index).split("\n");
    return { row: lines.length - 1, column: lines.at(-1).length };
  };
  const range = (text, startIndex, endIndex) => ({
    startIndex,
    endIndex,
    startPosition: point(text, startIndex),
    endPosition: point(text, endIndex),
  });
  for (const [name, body] of Object.entries({
    javascript: "value;",
    python: "value = 1",
    json: '{"x":1}',
    html: "<b>x</b>",
  })) {
    const language = await Parser.loadLanguage(name, bytes(name));
    const parser = new Parser.BackgroundParser(language);
    try {
      const text = "excluded\n" + body + "\ntrailer";
      const before = await parser.parse(text, { revision: 1, includedRanges: [range(text, 9, 9 + body.length)] });
      const oldNode = before.rootNode;
      const updated = "\n" + text + "!";
      const edits = Object.freeze([
        Object.freeze({ startIndex: 0, oldEndIndex: 0, newText: "\n" }),
        Object.freeze({ startIndex: text.length + 1, oldEndIndex: text.length + 1, newText: "!" }),
      ]);
      const includedRanges = [range(updated, 10, 10 + body.length)];
      const reused = Parser.BackgroundParser.reuseSnapshot(before, updated, { edits, includedRanges, revision: 2 });
      assert.ok(reused, name);
      const fresh = await parser.parse(updated, { includedRanges });
      assert.equal(reused.rootNode.toString(), fresh.rootNode.toString(), name);
      assert.deepEqual(reused.rootNode.startPosition, fresh.rootNode.startPosition);
      assert.deepEqual(reused.rootNode.endPosition, fresh.rootNode.endPosition);
      assert.equal(reused.rootNode.text, fresh.rootNode.text);
      assert.equal(reused.input, updated);
      assert.equal(reused.revision, 2);
      assert.deepEqual(reused.changedRanges, []);
      assert.equal(Reflect.set(reused, "input", "wrong"), false);
      assert.equal(
        Reflect.set(reused, "getText", () => "wrong"),
        false,
      );
      assert.throws(() => reused.edit({}), /immutable/);
      assert.throws(
        () =>
          Parser.Tree.prototype.edit.call(reused, {
            startIndex: 0,
            oldEndIndex: 0,
            newEndIndex: 0,
            startPosition: { row: 0, column: 0 },
            oldEndPosition: { row: 0, column: 0 },
            newEndPosition: { row: 0, column: 0 },
          }),
        /immutable/,
      );
      assert.equal(oldNode.text, body);
      assert.equal(oldNode.startPosition.row, 1);
      assert.equal((await parser.parse(updated, { previous: reused, includedRanges })).rootNode.text, body);
      const columnsChanged = " " + text;
      assert.equal(
        Parser.BackgroundParser.reuseSnapshot(before, columnsChanged, {
          edits: [{ startIndex: 0, oldEndIndex: 0, newText: " " }],
          includedRanges: [range(columnsChanged, 10, 10 + body.length)],
        }) === null,
        false,
      ); // Prefix on an excluded earlier line leaves columns unchanged.
      const bodyShifted = text.slice(0, 9) + " " + text.slice(9);
      assert.equal(
        Parser.BackgroundParser.reuseSnapshot(before, bodyShifted, {
          edits: [{ startIndex: 9, oldEndIndex: 9, newText: " " }],
          includedRanges: [range(bodyShifted, 10, 10 + body.length)],
        }),
        null,
      );
    } finally {
      parser.close();
    }
  }
});

test("shared frozen edit lists stay tied to their source text and do not cache accessors", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  try {
    const edits = Object.freeze([Object.freeze({ startIndex: 0, oldEndIndex: 5, newText: "beta;" })]);
    for (const source of ["alpha", "a\nbcd"]) {
      const previous = await parser.parse(source);
      const result = await parser.parse("beta;", { previous, edits });
      assert.deepEqual(result.rootNode.endPosition, { row: 0, column: 5 });
    }
    const previous = await parser.parse("alpha");
    let newText = "beta;";
    const dynamic = Object.freeze([
      Object.freeze({
        startIndex: 0,
        oldEndIndex: 5,
        get newText() {
          return newText;
        },
      }),
    ]);
    await parser.parse("beta;", { previous, edits: dynamic });
    newText = "other";
    await assert.rejects(parser.parse("beta;", { previous, edits: dynamic }), /do not transform/);
  } finally {
    parser.close();
  }
});

test("snapshot reuse rejects changed line topology and decoder-sensitive boundaries", async () => {
  const parser = new Parser.BackgroundParser(javascript);
  const ranges = [
    { startIndex: 0, endIndex: 2, startPosition: { row: 0, column: 0 }, endPosition: { row: 0, column: 2 } },
    { startIndex: 4, endIndex: 6, startPosition: { row: 0, column: 4 }, endPosition: { row: 0, column: 6 } },
  ];
  try {
    const previous = await parser.parse("a;  b;", { includedRanges: ranges });
    assert.equal(
      Parser.BackgroundParser.reuseSnapshot(previous, "a;\n    b;", {
        edits: [{ startIndex: 2, oldEndIndex: 4, newText: "\n    " }],
        includedRanges: [
          ranges[0],
          { startIndex: 7, endIndex: 9, startPosition: { row: 1, column: 4 }, endPosition: { row: 1, column: 6 } },
        ],
      }),
      null,
    );
    for (const text of ["\ufeffa;", "\ud800", "\udc00"]) {
      const included = [
        {
          startIndex: 0,
          endIndex: text.length,
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: text.length },
        },
      ];
      const old = await parser.parse(text, { includedRanges: included });
      assert.equal(
        Parser.BackgroundParser.reuseSnapshot(old, "\n" + text, {
          edits: [{ startIndex: 0, oldEndIndex: 0, newText: "\n" }],
          includedRanges: [
            {
              startIndex: 1,
              endIndex: text.length + 1,
              startPosition: { row: 1, column: 0 },
              endPosition: { row: 1, column: text.length },
            },
          ],
        }),
        null,
      );
    }
  } finally {
    parser.close();
  }
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
