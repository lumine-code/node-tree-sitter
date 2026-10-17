const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("..");
const { TextEdits, prepareOrdered } = require("../text-edits");
let language;
before(async () => {
  language = await P.loadLanguage("javascript", fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm")));
});
const point = (text, index) => {
  const lines = text.slice(0, index).split("\n");
  return { row: lines.length - 1, column: lines.at(-1).length };
};

test("query strings preserve embedded NUL and property keys are ordinary data", () => {
  const root = new P().setLanguage(language).parse("a;").rootNode;
  for (const method of ["matches", "captures"]) {
    for (const predicate of ["eq?", "match?"]) {
      const query = new P.Query(language, `((identifier) @id (#${predicate} @id "a\0b"))`);
      assert.deepEqual(query[method](root), []);
    }
    const query = new P.Query(
      language,
      '((identifier) @id (#set! "__proto__" "v\0tail") (#is? "__proto__") (#is-not? "constructor" "no"))',
    );
    const [result] = query[method](root);
    assert.equal(Object.getPrototypeOf(result.setProperties), Object.prototype);
    assert.ok(Object.hasOwn(result.setProperties, "__proto__"));
    assert.equal(result.setProperties.__proto__, "v\0tail");
    assert.equal(result.assertedProperties.__proto__, null);
    assert.equal(result.refutedProperties.constructor, "no");
  }
});

test("background parsing initializes a fresh native grammar descriptor", async () => {
  const native = require("tree-sitter-javascript");
  const descriptor = { language: native.language, nodeTypeInfo: native.nodeTypeInfo };
  const parser = new P.BackgroundParser(descriptor);
  try {
    const tree = await parser.parse("const value = 1;");
    assert.equal(tree.rootNode.type, "program");
    assert.equal(tree.rootNode.firstNamedChild.firstNamedChild.nameNode.text, "value");
  } finally {
    parser.close();
  }
});

test("snapshot copies read their own text and cannot masquerade as immutable revisions", async () => {
  const parser = new P.BackgroundParser(language);
  const other = new P.BackgroundParser(language);
  try {
    const snapshot = await parser.parse("old;");
    const copy = snapshot.copy();
    copy.input = "new;";
    assert.equal(copy.rootNode.text, "new;");
    assert.equal(snapshot.rootNode.text, "old;");
    for (const previous of [copy, new P().setLanguage(language).parse("old;"), {}, false]) {
      await assert.rejects(parser.parse("old;", { previous }), /immutable background snapshot/);
    }
    assert.equal((await other.parse("old;", { previous: snapshot })).rootNode.text, "old;");
  } finally {
    parser.close();
    other.close();
  }
});

test("query point getters cannot overwrite the node being queried", () => {
  const tree = new P().setLanguage(language).parse("a; b;");
  const root = tree.rootNode;
  const last = root.lastNamedChild.firstNamedChild;
  const query = new P.Query(language, "(identifier) @id");
  for (const method of ["matches", "captures"]) {
    const startPosition = {
      get row() {
        assert.equal(last.type, "identifier");
        return 0;
      },
      column: 0,
    };
    const result = query[method](root, { startPosition });
    const captures = method === "matches" ? result.flatMap((m) => m.captures) : result;
    assert.deepEqual(
      captures.map((c) => c.node.text),
      ["a", "b"],
    );
  }
});

test("background option reads reserve the request and normalize ranges once", async () => {
  const parser = new P.BackgroundParser(language);
  let nested,
    reads = 0;
  try {
    const tree = await parser.parse("a;", {
      get includedRanges() {
        assert.equal(parser.busy, true);
        nested = assert.rejects(parser.parse("b;"), /active parse/);
        return [
          {
            get startIndex() {
              reads++;
              return 0;
            },
            endIndex: 2,
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 0, column: 2 },
          },
        ];
      },
    });
    await nested;
    assert.equal(reads, 1);
    assert.equal(tree.rootNode.text, "a;");
    assert.equal(parser.busy, false);
    await assert.rejects(parser.parse("a;", { signal: {} }), /AbortSignal/);
    assert.equal(parser.busy, false);
    await assert.rejects(
      parser.parse("a;", {
        get revision() {
          parser.cancel();
          return 0;
        },
      }),
      { name: "AbortError" },
    );
    assert.equal((await parser.parse("b;")).rootNode.text, "b;");
    await assert.rejects(
      parser.parse("a;", {
        get revision() {
          parser.close();
          return 0;
        },
      }),
      /closed/,
    );
    assert.equal(parser.busy, false);
  } finally {
    parser.close();
  }
});

test("native submission survives closing, cancelling and re-entry from range getters", async () => {
  const { BackgroundParser } = require("node-gyp-build")(path.join(__dirname, ".."));
  for (const action of ["close", "cancel", "reenter", "throw"]) {
    const parser = new BackgroundParser(language);
    let calls = 0;
    const ranges = [
      {
        get startPosition() {
          calls++;
          if (action === "close") parser.close();
          if (action === "cancel") parser.cancel();
          if (action === "reenter") assert.throws(() => parser.parse("b;"), /active parse/);
          if (action === "throw") throw new Error("range getter failed");
          return { row: 0, column: 0 };
        },
        endPosition: { row: 0, column: 2 },
        startIndex: 0,
        endIndex: 2,
      },
    ];
    try {
      if (action === "reenter") await parser.parse("a;", null, ranges);
      else
        assert.throws(
          () => parser.parse("a;", null, ranges),
          action === "close" ? /closed/ : action === "cancel" ? /cancelled/ : /range getter failed/,
        );
      assert.equal(calls, 1);
      if (action !== "close") await parser.parse("a;");
    } finally {
      parser.close();
    }
  }
});

test("field traversal preserves repeated fields, absent fields and native identities", () => {
  const native = require("tree-sitter-python");
  const parser = new P().setLanguage(native);
  const node = parser.parse("if a:\n  b\nelif c:\n  d\nelif e:\n  f\nelse:\n  g\n").rootNode.firstNamedChild;
  const expected = node.childrenForFieldName("alternative");
  assert.equal(expected.length, 3);
  const cursor = node.walk();
  cursor.gotoFirstChild();
  let fieldId;
  do {
    if (cursor.currentFieldName === "alternative") {
      fieldId = cursor.currentFieldId;
      break;
    }
  } while (cursor.gotoNextSibling());
  assert.ok(fieldId > 0);
  for (let i = 0; i < 2000; i++) {
    assert.deepEqual(node.childrenForFieldId(fieldId), expected);
    assert.deepEqual(node.childrenForFieldName("alternative"), expected);
  }
  assert.deepEqual(expected[0].firstNamedChild.childrenForFieldId(fieldId), []);
  assert.deepEqual(node.childrenForFieldName("missing_field"), []);
  assert.deepEqual(node.childrenForFieldId(0), []);
});

test("node indices, field IDs and query offsets reject truncating conversions", () => {
  const parser = new P().setLanguage(language);
  const node = parser.parse("let x = 1;").rootNode;
  for (const method of [
    "child",
    "namedChild",
    "fieldNameForChild",
    "fieldNameForNamedChild",
    "childForFieldId",
    "childrenForFieldId",
  ]) {
    for (const value of [-1, 0.5, NaN, Infinity, 2 ** 32]) assert.throws(() => node[method](value), RangeError, method);
  }
  assert.throws(() => node.childForFieldId(65536), RangeError);
  assert.throws(() => node.childrenForFieldId(65536), RangeError);
  const query = new P.Query(language, "(identifier) @id");
  for (const value of [-1, 0.5, NaN, Infinity, 2 ** 32])
    assert.throws(() => query.isPatternGuaranteedAtStep(value), RangeError);
  for (const value of [false, 0, "tree"]) assert.throws(() => parser.parse("a;", value), TypeError);
  assert.throws(() => parser.parse("a;", null, { bufferSize: "32" }), TypeError);
  assert.equal(parser.parse("a;").rootNode.text, "a;");
});

test("a throwing logger error handler propagates safely and the parser recovers", () => {
  const parser = new P().setLanguage(language);
  const previous = console.error;
  const failure = new Error("logging failed");
  try {
    console.error = () => {
      throw failure;
    };
    parser.setLogger(() => {
      throw new Error("logger failed");
    });
    assert.throws(
      () => parser.parse("let value = 1;"),
      (error) => error === failure,
    );
  } finally {
    console.error = previous;
    parser.setLogger(null);
  }
  assert.equal(parser.parse("ok;").rootNode.text, "ok;");
});

test("deterministic edit fuzzing agrees with string reconstruction and fresh parses", async () => {
  let state = 0x19780;
  const random = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const replacements = ["", "x", "\n", "\r\n", "🦉", "a;\n", "\0"];
  const parser = new P.BackgroundParser(language);
  try {
    for (let run = 0; run < 400; run++) {
      const original = 'let café = "🦉";\r\ncall(café);\n';
      let text = original;
      const edits = [],
        changes = [];
      const pieces = new TextEdits(text);
      for (let i = 0; i < 8; i++) {
        const startIndex = random(text.length + 1);
        const oldEndIndex = startIndex + random(text.length - startIndex + 1);
        const newText = replacements[random(replacements.length)];
        const change = {
          startIndex,
          oldEndIndex,
          newEndIndex: startIndex + newText.length,
          startPosition: point(text, startIndex),
          oldEndPosition: point(text, oldEndIndex),
          newEndPosition: point(text.slice(0, startIndex) + newText, startIndex + newText.length),
        };
        edits.push({ startIndex, oldEndIndex, newText });
        changes.push(change);
        assert.deepEqual(pieces.replace(startIndex, oldEndIndex, newText), change, `run ${run}, edit ${i}`);
        text = text.slice(0, startIndex) + newText + text.slice(oldEndIndex);
        assert.equal(pieces.getText(), text);
      }
      const ordered = prepareOrdered(original, edits);
      if (ordered) {
        assert.equal(ordered.text, text);
        assert.deepEqual(ordered.changes, changes);
      }
      if (run < 80) {
        const previous = await parser.parse(original);
        const actual = await parser.parse(text, { previous, edits });
        const fresh = await parser.parse(text);
        assert.equal(actual.rootNode.toString(), fresh.rootNode.toString(), `run ${run}`);
        assert.deepEqual(actual.rootNode.startPosition, fresh.rootNode.startPosition);
        assert.deepEqual(actual.rootNode.endPosition, fresh.rootNode.endPosition);
        assert.equal(actual.rootNode.text, fresh.rootNode.text);
        assert.equal(actual.input, text);
      }
    }
  } finally {
    parser.close();
  }
});
