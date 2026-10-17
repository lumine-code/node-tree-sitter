const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Parser = require("..");
let language;
before(async () => {
  language = await Parser.loadLanguage("javascript", fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm")));
});
const parser = () => new Parser().setLanguage(language);
const emptyEdit = {
  startIndex: 0,
  oldEndIndex: 0,
  newEndIndex: 0,
  startPosition: { row: 0, column: 0 },
  oldEndPosition: { row: 0, column: 0 },
  newEndPosition: { row: 0, column: 0 },
};

test("callback text reads stop at empty or missing input without inventing text", () => {
  for (const end of ["", null, undefined]) {
    let mode = "parse",
      calls = 0;
    const tree = parser().parse((index) => {
      if (mode === "parse") return "alpha;".slice(index);
      assert.ok(++calls < 5, "text reads must make progress");
      return mode === "partial" && index === 0 ? "al" : end;
    });
    mode = "empty";
    assert.equal(tree.rootNode.text, "");
    mode = "partial";
    calls = 0;
    assert.equal(tree.rootNode.text, "al");
  }
});

test("callback node text reads pass correct positions for each chunk", () => {
  const text = 'const x = "🦉";\r\nconst y = x;';
  const expected = (index) => {
    const lines = text.slice(0, index).split("\n");
    return { row: lines.length - 1, column: lines.at(-1).length };
  };
  const tree = parser().parse((index, position) => {
    assert.deepEqual(position, expected(index));
    return text.slice(index, index + 2);
  });
  assert.equal(tree.rootNode.text, text);
  const cursor = tree.walk();
  assert.equal(cursor.nodeText, text);
});

test("cursors detect tree edits and can recover with reset", () => {
  const tree = parser().parse("x;"),
    cursor = tree.walk();
  tree.edit({ ...emptyEdit, newEndIndex: 1, newEndPosition: { row: 0, column: 1 } });
  for (const read of [
    () => cursor.currentNode,
    () => cursor.startPosition,
    () => cursor.endIndex,
    () => cursor.nodeType,
    () => cursor.nodeText,
    () => cursor.gotoFirstChild(),
  ]) {
    assert.throws(read, /Tree changed/);
  }
  cursor.reset(tree.rootNode);
  assert.equal(cursor.nodeType, "program");
  assert.equal(cursor.endIndex, 3);
});

test("cursor resetTo rejects stale sources while allowing a stale destination", () => {
  const first = parser().parse("a;"),
    second = parser().parse("b;");
  const a = first.walk(),
    b = second.walk();
  first.edit(emptyEdit);
  assert.throws(() => b.resetTo(a), /Tree changed/);
  a.resetTo(b);
  assert.equal(a.nodeText, "b;");
  assert.equal(a.tree, second);
  assert.equal(Reflect.set(a, "tree", first), false);
  assert.equal(a.tree, second);
});

test(
  "cursor ownership retains its tree and releases the previous owner after reset",
  { skip: typeof global.gc !== "function" },
  async () => {
    const make = () => {
      const tree = parser().parse("first;");
      return { cursor: tree.walk(), ref: new WeakRef(tree) };
    };
    const { cursor, ref } = make();
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    assert.ok(ref.deref());
    const second = parser().parse("second;");
    cursor.reset(second.rootNode);
    let retained;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
      retained = ref.deref() !== undefined;
      if (!retained) break;
    }
    assert.equal(retained, false);
    assert.equal(cursor.nodeText, "second;");
  },
);

test("descendant indices are validated against the cursor subtree root", () => {
  const root = parser().parse("call(a, b); tail;").rootNode.firstNamedChild;
  const cursor = root.walk(),
    count = root.descendantCount;
  for (const value of [-1, NaN, Infinity, 1.5, 2 ** 32, count])
    assert.throws(() => cursor.gotoDescendant(value), RangeError);
  cursor.gotoDescendant(count - 1);
  assert.equal(cursor.currentDescendantIndex, count - 1);
  cursor.gotoDescendant(0);
  assert.equal(cursor.nodeType, root.type);
  cursor.reset(root.firstNamedChild);
  assert.throws(() => cursor.gotoDescendant(count - 1), RangeError);
});

test("lookahead states reject truncation and forged instances", () => {
  const lookahead = new Parser.LookaheadIterator(language, 0);
  for (const value of [-1, NaN, Infinity, 1.5, 65536, 2 ** 32]) {
    assert.throws(() => new Parser.LookaheadIterator(language, value), RangeError);
    assert.throws(() => lookahead.resetState(value), RangeError);
    assert.throws(() => lookahead.reset(language, value), RangeError);
  }
  const getter = Object.getOwnPropertyDescriptor(Parser.LookaheadIterator.prototype, "currentType").get;
  assert.throws(() => getter.call(Object.create(Parser.LookaheadIterator.prototype)), Error);
  assert.equal(lookahead.resetState(0), true);
});

test("malformed included ranges cannot silently reuse the previous range set", () => {
  const p = parser();
  const valid = {
    startIndex: 0,
    endIndex: 2,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 2 },
  };
  assert.equal(p.parse("a;b;", null, { includedRanges: [valid] }).rootNode.namedChildCount, 1);
  for (const includedRanges of [
    [{ ...valid, startIndex: 3 }],
    [null],
    {},
    [{ ...valid, startIndex: -1 }],
    [{ ...valid, endPosition: { row: 0, column: NaN } }],
  ]) {
    assert.throws(() => p.parse("a;b;", null, { includedRanges }));
  }
  assert.equal(p.parse("a;b;").rootNode.namedChildCount, 2);
});

test("invalid edit values reject without changing the tree or cursor generation", () => {
  const tree = parser().parse("x;"),
    cursor = tree.walk();
  for (const value of [-1, 1.5, NaN, Infinity, 2 ** 32]) {
    assert.throws(() => tree.edit({ ...emptyEdit, startIndex: value }), RangeError);
    assert.throws(() => tree.edit({ ...emptyEdit, startPosition: { row: value, column: 0 } }), RangeError);
  }
  assert.throws(() => tree.edit({ ...emptyEdit, startIndex: 1 }), RangeError);
  assert.equal(cursor.nodeText, "x;");
});

test("positive infinity remains an unbounded position, but NaN is rejected", () => {
  const cursor = parser().parse("x;").walk();
  assert.equal(cursor.gotoFirstChildForPosition({ row: Infinity, column: Infinity }), null);
  assert.throws(() => cursor.gotoFirstChildForPosition({ row: NaN, column: 0 }), RangeError);
});

test("query and timeout options reject wrapping and non-number values", () => {
  const p = parser(),
    tree = p.parse("a; b;");
  const query = new Parser.Query(language, "(identifier) @name");
  for (const value of [-1, NaN, Infinity, 1.5, 2 ** 32, "3"]) {
    assert.throws(() => p.setTimeoutMicros(value));
    for (const method of ["captures", "matches"]) {
      assert.throws(() => query[method](tree.rootNode, { startIndex: value }));
      assert.throws(() => query[method](tree.rootNode, { matchLimit: value }));
      assert.throws(() => query[method](tree.rootNode, { timeoutMicros: value }));
    }
  }
  assert.throws(() => p.parse("a;", null, { progressCallback: 42 }), /progressCallback/);
  assert.throws(() => query.captures(tree.rootNode, { progressCallback: 42 }), /progressCallback/);
  assert.equal(query.captures(tree.rootNode).length, 2);
});

test("invalid finite query ranges reject instead of becoming whole-document queries", () => {
  const tree = parser().parse("a; b;"),
    query = new Parser.Query(language, "(identifier) @name");
  for (const method of ["matches", "captures"]) {
    assert.throws(() => query[method](tree.rootNode, { startIndex: 5, endIndex: 3 }), RangeError);
    assert.throws(
      () => query[method](tree.rootNode, { startPosition: { row: 2, column: 0 }, endPosition: { row: 1, column: 0 } }),
      RangeError,
    );
    assert.equal(query[method](tree.rootNode).length, 2);
  }
});
