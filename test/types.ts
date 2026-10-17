/// <reference path="../tree-sitter.d.ts" />
import Parser = require("@lumine-code/node-tree-sitter");
async function exercise(bytes: Buffer) {
  const language = await Parser.loadLanguage("javascript", bytes);
  const parser = new Parser.BackgroundParser(language);
  const before = await parser.parse("x;", { revision: 1 });
  const after: Parser.Snapshot = await parser.parse("y;", {
    previous: before,
    edits: [{ startIndex: 0, oldEndIndex: 1, newText: "y" }],
    signal: new AbortController().signal,
    revision: 2,
  });
  const copy: Parser.Tree = after.copy();
  new Parser.Query(language, "(identifier) @name").captures(copy.rootNode);
  parser.close();
}
void exercise;
