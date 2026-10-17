const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Parser = require("..");
const Web = require("web-tree-sitter");
const { TextEdits } = require("../text-edits");
let language, webLanguage;
before(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "fixtures/javascript.wasm"));
  language = await Parser.loadLanguage("javascript", bytes);
  await Web.Parser.init();
  webLanguage = await Web.Language.load(bytes);
});

function point(text, offset) {
  const prefix = text.slice(0, offset).split("\n");
  return { row: prefix.length - 1, column: prefix.at(-1).length };
}

test("piece preparation matches sequential string edits and coordinates", () => {
  let seed = 1234567;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let run = 0; run < 40; run++) {
    let text = run % 2 ? "" : "a\r\n🦉\nlast";
    const pieces = new TextEdits(text);
    for (let i = 0; i < 80; i++) {
      const start = random(text.length + 1),
        end = start + random(text.length - start + 1);
      const replacement = ["", "x", "\n", "\r\n", "🦉", "a\nb", "\r"][random(7)];
      const updated = text.slice(0, start) + replacement + text.slice(end);
      const edit = pieces.replace(start, end, replacement);
      assert.deepEqual(edit, {
        startIndex: start,
        oldEndIndex: end,
        newEndIndex: start + replacement.length,
        startPosition: point(text, start),
        oldEndPosition: point(text, end),
        newEndPosition: point(updated, start + replacement.length),
      });
      assert.equal(pieces.getText(), updated);
      assert.equal(pieces.length, updated.length);
      text = updated;
    }
  }
});

test("large batched edits preserve the snapshot and agree with a fresh parse", async () => {
  const parser = new Parser.BackgroundParser(language);
  const text = "const x = 0;\n".repeat(1000);
  const before = await parser.parse(text);
  const edits = Array.from({ length: 128 }, (_, i) => ({
    startIndex: text.length - 3 - i * 13,
    oldEndIndex: text.length - 2 - i * 13,
    newText: "9",
  }));
  let updated = text;
  for (const edit of edits)
    updated = updated.slice(0, edit.startIndex) + edit.newText + updated.slice(edit.oldEndIndex);
  const after = await parser.parse(updated, { previous: before, edits });
  const fresh = await parser.parse(updated);
  assert.equal(after.rootNode.toString(), fresh.rootNode.toString());
  assert.equal(before.rootNode.text, text);
  parser.close();
});

test("many included ranges validate against one coherent text version", async () => {
  const parser = new Parser.BackgroundParser(language);
  const text = "x;\r\n".repeat(1000);
  const ranges = Array.from({ length: 500 }, (_, i) => ({
    startIndex: i * 8,
    endIndex: i * 8 + 2,
    startPosition: { row: i * 2, column: 0 },
    endPosition: { row: i * 2, column: 2 },
  }));
  const tree = await parser.parse(text, { includedRanges: ranges });
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.namedChildCount, 500);
  parser.close();
});

test("a new parser can reuse another parser's snapshot before lazy initialization", async () => {
  const first = new Parser.BackgroundParser(language);
  const snapshot = await first.parse("const x = 1;");
  first.close();
  const second = new Parser.BackgroundParser(language);
  const result = await second.parse("const y = 1;", {
    previous: snapshot,
    edits: [{ startIndex: 6, oldEndIndex: 7, newText: "y" }],
  });
  assert.equal(result.rootNode.text, "const y = 1;");
  assert.equal(result.rootNode.hasError, false);
  assert.equal(snapshot.rootNode.text, "const x = 1;");
  second.close();
});

test("quantified captures retain order, duplicates, properties and text predicates", () => {
  const parser = new Parser().setLanguage(language),
    web = new Web.Parser();
  web.setLanguage(webLanguage);
  const text = "[" + Array(128).fill("1").join(",") + "];";
  const tree = parser.parse(text),
    webTree = web.parse(text);
  for (const suffix of ["", '(#set! color "number")', '(#eq? @n "1")', '(#eq? @n "2")']) {
    const source = `((array (number) @n ("," (number) @n)*) ${suffix})`;
    const query = new Parser.Query(language, source),
      webQuery = new Web.Query(webLanguage, source);
    const simplify = (captures) =>
      captures.map((c) => [c.name, c.node.startIndex, c.node.endIndex, c.node.text, c.setProperties?.color]);
    assert.deepEqual(simplify(query.captures(tree.rootNode)), simplify(webQuery.captures(webTree.rootNode)), source);
    webQuery.delete();
  }
  webTree.delete();
  web.delete();
});

test("invalid pattern indices reject instead of reaching a native assertion", () => {
  const query = new Parser.Query(language, "(identifier) @name");
  for (const method of [
    "startIndexForPattern",
    "endIndexForPattern",
    "isPatternRooted",
    "isPatternNonLocal",
    "disablePattern",
  ]) {
    for (const index of [-1, 1, 500, 1.5, NaN, Infinity, 2 ** 32])
      assert.throws(() => query[method](index), RangeError, `${method}(${index})`);
  }
  assert.equal(query.startIndexForPattern(0), 0);
});

const noopEdit = {
  startIndex: 0,
  oldEndIndex: 0,
  newEndIndex: 0,
  startPosition: { row: 0, column: 0 },
  oldEndPosition: { row: 0, column: 0 },
  newEndPosition: { row: 0, column: 0 },
};
test("queries reject edits to a tree used by an active native cursor", () => {
  const parser = new Parser().setLanguage(language),
    tree = parser.parse("value;\n".repeat(10000));
  const query = new Parser.Query(language, "(identifier) @name");
  assert.throws(
    () =>
      query.captures(tree.rootNode, {
        progressCallback() {
          tree.edit(noopEdit);
          return false;
        },
      }),
    /reading/,
  );
  assert.doesNotThrow(() => tree.edit(noopEdit));
  assert.equal(query.captures(tree.rootNode).length, 10000);
});

test("incremental parser callbacks cannot mutate the input tree", () => {
  const parser = new Parser().setLanguage(language),
    tree = parser.parse("value;");
  assert.throws(
    () =>
      parser.parse(() => {
        tree.edit(noopEdit);
        return "value;";
      }, tree),
    /reading/,
  );
  assert.doesNotThrow(() => tree.edit(noopEdit));
  assert.equal(parser.parse("value;", tree).rootNode.hasError, false);
});

test(
  "parser and query progress callbacks are collectable after completion",
  { skip: typeof global.gc !== "function" },
  async () => {
    const parser = new Parser().setLanguage(language),
      tree = parser.parse("value;\n".repeat(1000));
    const query = new Parser.Query(language, "(identifier) @name");
    function createReferences() {
      const references = [];
      for (let i = 0; i < 40; i++) {
        const callback = () => false;
        references.push(new WeakRef(callback));
        parser.parse("x;", null, { progressCallback: callback });
        query.captures(tree.rootNode, { progressCallback: callback });
      }
      return references;
    }
    const references = createReferences();
    let remaining;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
      remaining = references.filter((ref) => ref.deref()).length;
      if (!remaining) break;
    }
    assert.equal(remaining, 0);
  },
);
