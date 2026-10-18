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
  const synchronous: Parser.Snapshot = parser.parseSync("z;", {
    previous: after,
    edits: [{ startIndex: 0, oldEndIndex: 1, newText: "z" }],
    revision: 3,
  });
  void synchronous;
  const bounded: Parser.Snapshot | null = parser.tryParseSync("small;", { timeoutMicros: 1000 });
  void bounded;
  const reused: Parser.Snapshot | null = Parser.BackgroundParser.reuseSnapshot(after, "y;", {
    revision: 3,
    edits: Object.freeze([]),
    includedRanges: Object.freeze([]),
  });
  void reused;
  copy.input = "updated;";
  const captures = new Parser.Query(language, "(identifier) @name").captures(copy.rootNode);
  const property: string | null | undefined = captures[0]?.setProperties?.role;
  const cursor = copy.walk();
  const child: number | null = cursor.gotoFirstChildForIndex(0);
  const positionChild: number | null = cursor.gotoFirstChildForPosition({ row: 0, column: 0 });
  const field: string | undefined = cursor.currentFieldName;
  const fieldId: number | undefined = cursor.currentFieldId;
  const edited: Parser.Range | undefined = copy.getEditedRange();
  const sync = new Parser().setLanguage(language).setTimeoutMicros(0).reset().setLogger(null);
  const currentLanguage: Parser.Language | null = sync.getLanguage();
  const logger: Parser.Logger | null = sync.getLogger();
  // @ts-expect-error A cursor search returns an index or null, not a boolean.
  const booleanChild: boolean = cursor.gotoFirstChildForIndex(0);
  // @ts-expect-error Snapshots own immutable input.
  after.input = "changed";
  // @ts-expect-error Background previous trees must be snapshots, not mutable copies.
  await parser.parse("updated;", { previous: copy });
  // @ts-expect-error setLanguage requires a descriptor.
  sync.setLanguage();
  // @ts-expect-error A string is not a logger.
  sync.setLogger("debug");
  void [property, child, positionChild, field, fieldId, edited, currentLanguage, logger, booleanChild];
  parser.close();
}
void exercise;
