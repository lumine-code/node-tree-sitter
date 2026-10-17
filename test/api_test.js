const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Parser = require("..");
let language;
before(async () => {
  language = await Parser.loadLanguage("javascript", fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm")));
});
const parse = (text) => new Parser().setLanguage(language).parse(text);

test("query syntax errors at byte zero throw a useful error", () => {
  assert.throws(
    () => new Parser.Query(language, "!"),
    (error) => error.offset === 0 && error.kind > 0,
  );
  assert.equal(new Parser.Query(language, "(identifier) @id").captures(parse("a;").rootNode).length, 1);
});

test("numeric query ranges use UTF-16 indices consistently", () => {
  const tree = parse("a; b; c;");
  const query = new Parser.Query(language, "(identifier) @id");
  assert.deepEqual(
    query.captures(tree.rootNode, { startIndex: 6, endIndex: 8 }).map((c) => c.node.text),
    ["c"],
  );
  assert.deepEqual(
    query.matches(tree.rootNode, { startIndex: 6, endIndex: 8 }).map((m) => m.captures[0].node.text),
    ["c"],
  );
});

test("both query operations invoke cancellation callbacks", () => {
  const tree = parse("value;\n".repeat(10000));
  const query = new Parser.Query(language, "(identifier) @id");
  for (const method of ["matches", "captures"]) {
    let calls = 0;
    const result = query[method](tree.rootNode, {
      progressCallback() {
        calls++;
        return true;
      },
    });
    assert.ok(calls > 0, method);
    assert.ok(result.length < 10000, method);
  }
});

test("nested queries do not replace the outer cursor or its match limit", () => {
  const tree = parse("value;\n".repeat(10000));
  const tiny = parse("tiny;");
  const outer = new Parser.Query(language, "(identifier) @id");
  const inner = new Parser.Query(language, "(identifier) @id");
  let calls = 0;
  const captures = outer.captures(tree.rootNode, {
    matchLimit: 37,
    progressCallback() {
      calls++;
      assert.equal(inner.captures(tiny.rootNode, { matchLimit: 2 }).length, 1);
      return false;
    },
  });
  assert.ok(calls > 0);
  assert.equal(captures.length, 10000);
  assert.equal(outer.matchLimit, 37);
  assert.equal(inner.matchLimit, 2);
});

test("callback exceptions leave queries and parsers usable", () => {
  const parser = new Parser().setLanguage(language);
  const text = "value;\n".repeat(10000);
  assert.throws(
    () =>
      parser.parse(() => {
        throw new Error("input failed");
      }),
    /input failed/,
  );
  assert.throws(
    () =>
      parser.parse(text, null, {
        progressCallback() {
          throw new Error("parse failed");
        },
      }),
    /parse failed/,
  );
  const tree = parser.parse(text);
  const query = new Parser.Query(language, "(identifier) @id");
  assert.throws(
    () =>
      query.captures(tree.rootNode, {
        progressCallback() {
          throw new Error("query failed");
        },
      }),
    /query failed/,
  );
  assert.equal(query.captures(parse("x;").rootNode).length, 1);
});

test("parser and query re-entry fail safely", () => {
  const parser = new Parser().setLanguage(language);
  assert.throws(() => parser.parse(() => parser.parse("nested;")), /re-enter/);
  const tree = parser.parse("value;\n".repeat(10000));
  const query = new Parser.Query(language, "(identifier) @id");
  assert.throws(
    () =>
      query.matches(tree.rootNode, {
        progressCallback() {
          query.matches(tree.rootNode);
        },
      }),
    /re-enter/,
  );
  assert.equal(parser.parse("ok;").rootNode.hasError, false);
});

test("cursor reset and resetTo adopt the new tree and text owner", () => {
  const first = parse("first;");
  const second = parse("second;");
  const cursor = first.walk();
  const secondNode = second.rootNode.firstNamedChild.firstNamedChild;
  void first.rootNode.endPosition; // Disturb the shared node marshaling buffer.
  cursor.reset(secondNode);
  assert.equal(cursor.currentNode.text, "second");
  assert.equal(cursor.currentNode.tree, second);
  const firstCursor = first.walk();
  firstCursor.gotoFirstChild();
  cursor.resetTo(firstCursor);
  assert.equal(cursor.currentNode.text, "first;");
  assert.equal(cursor.currentNode.tree, first);
  assert.throws(() => cursor.resetTo(Object.create(Parser.TreeCursor.prototype)), /TreeCursor/);
});

test("uninitialized native trees and cursors cannot be constructed", () => {
  assert.throws(() => new Parser.Tree(), /created/);
  assert.throws(() => new Parser.TreeCursor(), /created/);
});

test("syntax nodes cannot be constructed, cloned or proxied into native operations", () => {
  const tree = parse("call(value);");
  const root = tree.rootNode;
  assert.throws(() => new Parser.SyntaxNode(tree), /created/);
  assert.throws(() => new root.constructor(tree), /created/);
  const query = new Parser.Query(language, "(identifier) @name");
  const cursor = tree.walk();
  let accessed = false;
  const impostors = [
    { ...root },
    Object.assign(Object.create(Object.getPrototypeOf(root)), root),
    new Proxy(root, {}),
    {
      get tree() {
        accessed = true;
        throw new Error("unexpected getter");
      },
    },
  ];
  const type = Object.getOwnPropertyDescriptor(Parser.SyntaxNode.prototype, "type").get;
  for (const fake of impostors) {
    assert.throws(() => query.captures(fake), /syntax node/i);
    assert.throws(() => query.matches(fake), /syntax node/i);
    assert.throws(() => type.call(fake), /syntax node/i);
    assert.throws(() => cursor.reset(fake), /syntax node/i);
    assert.throws(() => root.childWithDescendant(fake), /syntax node/i);
  }
  assert.equal(accessed, false);
  assert.equal(query.captures(root).length, 2);
  cursor.reset(root);
  assert.equal(cursor.nodeType, "program");
});

test("failed predicate initialization leaves later queries usable", () => {
  const root = parse("value;").rootNode;
  for (let i = 0; i < 500; i++) {
    assert.throws(
      () => new Parser.Query(language, "((identifier) @id (#unsupported? @id))"),
      /Unknown query predicate/,
    );
    assert.throws(() => new Parser.Query(language, '((identifier) @id (#match? @id "["))'), SyntaxError);
  }
  const original = Parser.Query.prototype._init;
  let escaped;
  try {
    Parser.Query.prototype._init = function () {
      escaped = this;
      throw new Error("initialization failed");
    };
    assert.throws(() => new Parser.Query(language, "(identifier) @id"), /initialization failed/);
    assert.throws(() => escaped.disablePattern(0), Error);
  } finally {
    Parser.Query.prototype._init = original;
  }
  assert.equal(new Parser.Query(language, "(identifier) @id").captures(root)[0].node.text, "value");
});

test("large capture batches preserve node identity and distinct capture metadata", () => {
  const root = parse("const value = 1;\n".repeat(4000)).rootNode;
  const query = new Parser.Query(language, '(identifier) @first @second\n((identifier) @third (#set! role "name"))');
  const captures = query.captures(root);
  assert.equal(captures.length, 12000);
  const grouped = new Map();
  for (const capture of captures) {
    const index = capture.node.startIndex;
    const previous = grouped.get(index);
    if (previous) assert.equal(capture.node, previous);
    else grouped.set(index, capture.node);
    assert.equal(capture.setProperties?.role, capture.name === "third" ? "name" : undefined);
  }
  assert.equal(grouped.size, 4000);
  assert.equal(new Set(captures).size, captures.length);
  assert.equal(root.descendantsOfType("identifier")[0], captures[0].node);
});

test("invalid callback buffer sizes reject before native parsing", () => {
  const parser = new Parser().setLanguage(language);
  for (const bufferSize of [0, 1, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => parser.parse("x;", null, { bufferSize }), /bufferSize/);
  }
  assert.equal(parser.parse("x;").rootNode.hasError, false);
});

test("background parser exposes lifecycle state and explicit resource management", async () => {
  const parser = new Parser.BackgroundParser(language);
  assert.equal(parser.closed, false);
  assert.equal(parser.busy, false);
  const promise = parser.parse("x;");
  assert.equal(parser.busy, true);
  await promise;
  assert.equal(parser.busy, false);
  parser[Symbol.dispose]();
  assert.equal(parser.closed, true);
  await assert.rejects(parser.parse("x;"), /closed/);
});
