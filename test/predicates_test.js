const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("..");
const Web = require("web-tree-sitter");
const { prepareOrdered } = require("../text-edits");
let language, webLanguage;
before(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm"));
  language = await P.loadLanguage("javascript", bytes);
  await Web.Parser.init();
  webLanguage = await Web.Language.load(bytes);
});
const makeParser = () => new P().setLanguage(language);
const point = (text, index) => {
  const lines = text.slice(0, index).split("\n");
  return { row: lines.length - 1, column: lines.at(-1).length };
};
const captureValues = (values) =>
  values.map((c) => [c.name, c.node.startIndex, c.node.endIndex, c.node.text, c.setProperties]);

test("capture metadata and result pattern indices agree with web", () => {
  const source = "(array (number)* @number) @owner\n(identifier) @identifier";
  const query = new P.Query(language, source),
    web = new Web.Query(webLanguage, source);
  try {
    assert.equal(query.patternCount(), web.patternCount());
    assert.deepEqual(query.captureNames, web.captureNames);
    assert.deepEqual(query.captureQuantifiers, web.captureQuantifiers);
    assert.ok(Object.isFrozen(query.captureNames));
    assert.ok(Object.isFrozen(query.captureQuantifiers));
    assert.ok(query.captureQuantifiers.every(Object.isFrozen));
    const root = makeParser().parse("[1,2]; value;").rootNode;
    const parser = new Web.Parser();
    parser.setLanguage(webLanguage);
    const tree = parser.parse("[1,2]; value;");
    try {
      assert.deepEqual(
        query.captures(root).map((c) => c.patternIndex),
        web.captures(tree.rootNode).map((c) => c.patternIndex),
      );
    } finally {
      tree.delete();
      parser.delete();
    }
    assert.ok(query.matches(root).every((m) => m.pattern === m.patternIndex));
  } finally {
    web.delete();
  }
});

test("low query match limits remain independent of earlier executions", () => {
  const tree = makeParser().parse("[1];");
  const query = new P.Query(language, "(array (number)* @n)\n(number) @plain");
  for (const method of ["captures", "matches"]) {
    const limited = query[method](tree.rootNode, { matchLimit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(query.didExceedMatchLimit(), true);
    assert.equal(query[method](tree.rootNode).length, 2);
    assert.equal(query.didExceedMatchLimit(), false);
    assert.deepEqual(query[method](tree.rootNode, { matchLimit: 1 }), limited);
    assert.equal(query.didExceedMatchLimit(), true);
    assert.equal(query.matchLimit, 1);
  }
});

test("query results agree with web across optional captures, disabling and bounded searches", () => {
  const native = makeParser();
  const web = new Web.Parser();
  web.setLanguage(webLanguage);
  const predicates = [
    '#eq? @n "1"',
    '#not-eq? @n "1"',
    '#any-eq? @n "1"',
    '#any-not-eq? @n "1"',
    '#match? @n "^[12]$"',
    '#not-match? @n "^1$"',
    '#any-match? @n "^1$"',
    '#any-not-match? @n "^1$"',
    '#any-of? @n "1" "2"',
    '#not-any-of? @n "1" "2"',
    "#eq? @n @n",
    "#any-not-eq? @n @n",
  ];
  try {
    for (const text of ["[];", "[1];", "[1,2,1];", "[3,2]; [1,1];"]) {
      const tree = native.parse(text),
        webTree = web.parse(text);
      try {
        for (const predicate of predicates) {
          const source = `((array (number)* @n) (${predicate}) (#set! role "number"))\n(number) @plain`;
          const q = new P.Query(language, source),
            wq = new Web.Query(webLanguage, source);
          try {
            for (const mode of ["normal", "disable-pattern", "disable-capture"]) {
              if (mode === "disable-pattern") {
                q.disablePattern(1);
                wq.disablePattern(1);
              }
              if (mode === "disable-capture") {
                q.disableCapture("n");
                wq.disableCapture("n");
              }
              for (const options of [
                {},
                // web-tree-sitter 0.27.1 passes numeric bounds as bytes. Point
                // bounds provide the same UTF-16 region in both backends.
                { startPosition: { row: 0, column: 1 }, endPosition: { row: 0, column: text.length - 1 } },
                { maxStartDepth: 0 },
                { matchLimit: 16 },
              ]) {
                const label = `${text}: ${predicate}: ${mode}: ${JSON.stringify(options)}`;
                assert.deepEqual(
                  captureValues(q.captures(tree.rootNode, options)),
                  captureValues(wq.captures(webTree.rootNode, options)),
                  label,
                );
                const normalize = (values) =>
                  values.map((m) => [m.pattern ?? m.patternIndex, captureValues(m.captures), m.setProperties]);
                assert.deepEqual(
                  normalize(q.matches(tree.rootNode, options)),
                  normalize(wq.matches(webTree.rootNode, options)),
                  label,
                );
              }
            }
          } finally {
            wq.delete();
          }
        }
      } finally {
        webTree.delete();
      }
    }
  } finally {
    web.delete();
  }
});

test("Wasm node type names remain data and cannot execute host JavaScript", async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm"));
  const original = Buffer.from("generator_function_declaration");
  const replacement = "a{static{globalThis.X=1}}//".padEnd(original.length, " ");
  const offset = bytes.indexOf(original);
  assert.ok(offset >= 0);
  bytes.write(replacement, offset, original.length, "utf8");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "X");
  delete globalThis.X;
  try {
    const grammar = await P.loadLanguage("javascript", bytes);
    // The generic Wasm path has no node-types metadata. Exercise the supported
    // descriptor path that generates specialized subclasses from that data.
    const descriptor = { ...grammar, nodeTypeInfo: [{ type: replacement, named: true, fields: {} }] };
    delete descriptor.nodeSubclasses;
    const parser = new P().setLanguage(descriptor);
    assert.equal(globalThis.X, undefined);
    assert.ok(
      descriptor.nodeSubclasses.some(
        (type) => type && Object.getOwnPropertyDescriptor(type.prototype, "type")?.value === replacement,
      ),
    );
    assert.equal(parser.parse("function* sample() { yield 1; }").rootNode.hasError, false);
  } finally {
    delete globalThis.X;
    if (previous) Object.defineProperty(globalThis, "X", previous);
  }
});

test("node cache separates shifted views regardless of lookup order", () => {
  for (const shiftedFirst of [false, true]) {
    const tree = makeParser().parse("call(x);");
    const shifted = shiftedFirst ? tree.rootNodeWithOffset(10, { row: 2, column: 3 }) : null;
    const root = tree.rootNode,
      view = shifted || tree.rootNodeWithOffset(10, { row: 2, column: 3 });
    assert.notEqual(root, view);
    assert.equal(root.startIndex, 0);
    assert.equal(view.startIndex, 10);
    assert.deepEqual(view.startPosition, { row: 2, column: 3 });
    assert.equal(tree.rootNode, root);
    assert.equal(tree.rootNodeWithOffset(10, { row: 2, column: 3 }), view);
    assert.notEqual(root.firstNamedChild, view.firstNamedChild);
    assert.equal(view.firstNamedChild.startIndex, 10);
    const query = new P.Query(language, "(identifier) @id");
    assert.deepEqual(
      query.captures(view).map((c) => c.node.startIndex),
      [10, 15],
    );
    assert.deepEqual(
      query.captures(root).map((c) => c.node.startIndex),
      [0, 5],
    );
  }
});

test("node-cache mutation helpers are not exposed on public trees", () => {
  const tree = makeParser().parse("x;"),
    root = tree.rootNode;
  assert.equal(tree._cacheNode, undefined);
  assert.equal(tree._cacheNodes, undefined);
  assert.equal(Object.hasOwn(P.Tree.prototype, "_cacheNode"), false);
  assert.equal(Object.hasOwn(P.Tree.prototype, "_cacheNodes"), false);
  assert.equal(tree.rootNode, root);
});

test(
  "shifted cache entries survive edits and independent finalization",
  { skip: typeof global.gc !== "function" },
  async () => {
    const tree = makeParser().parse("x;"),
      root = tree.rootNode;
    let middle = tree.rootNodeWithOffset(10, { row: 1, column: 0 });
    const last = tree.rootNodeWithOffset(20, { row: 2, column: 0 }),
      weak = new WeakRef(middle);
    middle = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setImmediate(r));
      global.gc();
      if (!weak.deref()) break;
    }
    assert.equal(weak.deref(), undefined);
    assert.equal(tree.rootNode, root);
    assert.equal(tree.rootNodeWithOffset(20, { row: 2, column: 0 }), last);
    tree.edit({
      startIndex: 2,
      oldEndIndex: 2,
      newEndIndex: 3,
      startPosition: { row: 0, column: 2 },
      oldEndPosition: { row: 0, column: 2 },
      newEndPosition: { row: 0, column: 3 },
    });
    assert.equal(root.startIndex, 0);
    assert.equal(last.startIndex, 21);
    assert.equal(tree.rootNodeWithOffset(10, { row: 1, column: 0 }).startIndex, 10);
  },
);

test("queries and synchronous parsers reject trees from another language", async () => {
  const json = await P.loadLanguage("json", fs.readFileSync(path.join(__dirname, "fixtures/json.wasm")));
  const foreign = new P().setLanguage(json).parse("{}");
  const query = new P.Query(language, "(identifier) @id"),
    parser = makeParser();
  assert.throws(() => query.captures(foreign.rootNode), /same language/);
  assert.throws(() => query.matches(foreign.rootNode), /same language/);
  assert.throws(() => parser.parse("x;", foreign), /different language/);
  assert.throws(() => foreign.getChangedRanges(parser.parse("x;")), /same language/);
  assert.equal(parser.parse("x;").rootNode.hasError, false);
});

test("cached predicate contexts agree with web results for interleaved and quantified captures", async () => {
  const text = "[" + Array.from({ length: 64 }, (_, i) => (i % 3 ? "1" : "2")).join(",") + "];";
  const parser = makeParser(),
    tree = parser.parse(text),
    web = new Web.Parser();
  web.setLanguage(webLanguage);
  const webTree = web.parse(text),
    background = new P.BackgroundParser(language),
    snapshot = await background.parse(text);
  for (const predicate of [
    '(#eq? @n "1")',
    '(#any-eq? @n "1")',
    '(#not-eq? @n "3")',
    '(#match? @n "^[12]$")',
    '(#any-not-match? @n "^1$")',
    '(#any-of? @n "1" "2")',
  ]) {
    const source = `((array (number) @n ("," (number) @n)*) ${predicate} (#set! color "number"))\n(number) @single`;
    const q = new P.Query(language, source),
      wq = new Web.Query(webLanguage, source);
    const expected = captureValues(wq.captures(webTree.rootNode));
    for (const root of [tree.rootNode, snapshot.rootNode]) {
      const actual = q.captures(root);
      assert.deepEqual(captureValues(actual), expected, source);
      assert.equal(new Set(actual).size, actual.length, "each emitted capture must own its result object");
    }
    wq.delete();
  }
  background.close();
  webTree.delete();
  web.delete();
});

test("custom text readers are not treated as immutable predicate input", () => {
  const text = "[" + Array(32).fill("1").join(",") + "];";
  const tree = makeParser().parse(text),
    query = new P.Query(language, '((array (number) @n ("," (number) @n)*) (#eq? @n "1"))');
  let reads = 0;
  tree.getText = (node) => {
    reads++;
    return text.slice(node.startIndex, node.endIndex);
  };
  const result = query.captures(tree.rootNode);
  assert.ok(reads > result.length * 8, "each capture must re-evaluate live text predicates");
  assert.ok(result.length > 0);
  const getterTree = makeParser().parse(text);
  reads = 0;
  Object.defineProperty(getterTree, "input", {
    get() {
      reads++;
      return text;
    },
  });
  const getterResult = query.captures(getterTree.rootNode);
  assert.ok(reads > getterResult.length * 8, "input accessors must be evaluated for every predicate context");
  const accessorTree = makeParser().parse(text),
    originalReader = accessorTree.getText;
  reads = 0;
  Object.defineProperty(accessorTree, "getText", {
    get() {
      reads++;
      return originalReader;
    },
  });
  const accessorResult = query.captures(accessorTree.rootNode);
  assert.ok(reads > accessorResult.length * 8, "text-reader accessors must remain live");
});

test("ordered edit fast paths match sequential strings and every intermediate point", () => {
  const original = "abc\r\ndef🦉\nghi\n";
  const groups = [
    [
      { startIndex: 13, oldEndIndex: 14, newText: "X\n" },
      { startIndex: 5, oldEndIndex: 8, newText: "Q" },
      { startIndex: 0, oldEndIndex: 0, newText: "\n" },
    ],
    [
      { startIndex: 0, oldEndIndex: 1, newText: "AA\n" },
      { startIndex: 7, oldEndIndex: 10, newText: "Z" },
      { startIndex: 13, oldEndIndex: 13, newText: "!" },
    ],
    [
      { startIndex: 0, oldEndIndex: 0, newText: "a" },
      { startIndex: 0, oldEndIndex: 0, newText: "b" },
    ],
    [
      { startIndex: 0, oldEndIndex: 0, newText: "a" },
      { startIndex: 1, oldEndIndex: 1, newText: "b" },
    ],
  ];
  for (const edits of groups) {
    let text = original;
    const expected = [];
    for (const e of edits) {
      const updated = text.slice(0, e.startIndex) + e.newText + text.slice(e.oldEndIndex);
      expected.push({
        startIndex: e.startIndex,
        oldEndIndex: e.oldEndIndex,
        newEndIndex: e.startIndex + e.newText.length,
        startPosition: point(text, e.startIndex),
        oldEndPosition: point(text, e.oldEndIndex),
        newEndPosition: point(updated, e.startIndex + e.newText.length),
      });
      text = updated;
    }
    assert.deepEqual(prepareOrdered(original, edits), { text, changes: expected });
  }
  assert.equal(
    prepareOrdered(original, [
      { startIndex: 0, oldEndIndex: 0, newText: "abc" },
      { startIndex: 1, oldEndIndex: 2, newText: "X" },
    ]),
    null,
  );
});

test("thousands of ordered edits agree with a fresh parse and preserve prior snapshots", async () => {
  const parser = new P.BackgroundParser(language),
    text = "const x = 0;\n".repeat(6000),
    previous = await parser.parse(text);
  for (const descending of [false, true]) {
    const edits = Array.from({ length: 5000 }, (_, i) => ({
      startIndex: i * 13 + 10,
      oldEndIndex: i * 13 + 11,
      newText: "9",
    }));
    if (descending) edits.reverse();
    const updated = "const x = 9;\n".repeat(5000) + "const x = 0;\n".repeat(1000);
    const actual = await parser.parse(updated, { previous, edits }),
      fresh = await parser.parse(updated);
    assert.equal(actual.rootNode.toString(), fresh.rootNode.toString());
    assert.equal(previous.rootNode.text, text);
  }
  parser.close();
});
