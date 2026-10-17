const MAX_INDEX = Math.floor(0xffffffff / 2);
const { TextEdits, advanceText } = require("./text-edits");

function index(value, name, maximum = MAX_INDEX) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
}

function preparePrevious(previous, edits, text, language) {
  if (!previous) {
    if (edits.length) throw new TypeError("edits require a previous snapshot");
    return null;
  }
  if (previous.language !== language || typeof previous.input !== "string") {
    throw new TypeError("previous must be a string snapshot from the same language");
  }
  if (!edits.length) {
    if (previous.input !== text)
      throw new Error("edits do not transform the previous snapshot into the requested text");
    return previous;
  }
  if (edits.length === 1) {
    const { startIndex, oldEndIndex, newText } = edits[0];
    const source = previous.input;
    index(startIndex, "startIndex", source.length);
    index(oldEndIndex, "oldEndIndex", source.length);
    if (oldEndIndex < startIndex || typeof newText !== "string")
      throw new TypeError("An edit requires ordered indices and string newText");
    index(source.length + newText.length - (oldEndIndex - startIndex), "edited text length");
    if (source.slice(0, startIndex) + newText + source.slice(oldEndIndex) !== text) {
      throw new Error("edits do not transform the previous snapshot into the requested text");
    }
    const startPosition = advanceText(source, 0, startIndex);
    const copy = previous.copy();
    copy.edit({
      startIndex,
      oldEndIndex,
      newEndIndex: startIndex + newText.length,
      startPosition,
      oldEndPosition: advanceText(source, startIndex, oldEndIndex, startPosition),
      newEndPosition: advanceText(newText, 0, newText.length, startPosition),
    });
    return copy;
  }
  const source = new TextEdits(previous.input);
  const changes = [];
  for (const edit of edits) {
    index(edit.startIndex, "startIndex", source.length);
    index(edit.oldEndIndex, "oldEndIndex", source.length);
    if (edit.oldEndIndex < edit.startIndex || typeof edit.newText !== "string") {
      throw new TypeError("An edit requires ordered indices and string newText");
    }
    index(source.length + edit.newText.length - (edit.oldEndIndex - edit.startIndex), "edited text length");
    changes.push(source.replace(edit.startIndex, edit.oldEndIndex, edit.newText));
  }
  if (source.getText() !== text)
    throw new Error("edits do not transform the previous snapshot into the requested text");
  const copy = previous.copy();
  for (const change of changes) copy.edit(change);
  return copy;
}

function validateRanges(ranges, text) {
  if (ranges === undefined) return;
  if (!Array.isArray(ranges)) throw new TypeError("includedRanges must be an array");
  let offset = 0,
    position = { row: 0, column: 0 };
  let previousEnd = 0;
  for (const range of ranges) {
    index(range.startIndex, "range.startIndex", text.length);
    index(range.endIndex, "range.endIndex", text.length);
    if (range.startIndex < previousEnd || range.endIndex < range.startIndex) {
      throw new RangeError("includedRanges must be ordered and non-overlapping");
    }
    for (const endpoint of ["start", "end"]) {
      const next = range[`${endpoint}Index`];
      const actual = advanceText(text, offset, next, position);
      offset = next;
      position = actual;
      const supplied = range[`${endpoint}Position`];
      if (actual.row !== supplied?.row || actual.column !== supplied?.column) {
        throw new RangeError("Range positions must match UTF-16 indices in the snapshot");
      }
    }
    previousEnd = range.endIndex;
  }
}

module.exports = (NativeParser) =>
  class BackgroundParser {
    #native;
    #language;
    #busy = false;
    #closed = false;
    constructor(language) {
      this.#native = new NativeParser(language);
      this.#language = language;
    }
    async parse(text, { previous = null, edits = [], includedRanges, signal, revision = 0 } = {}) {
      if (this.#closed) throw new Error("Parser is closed");
      if (this.#busy) throw new Error("Parser already has an active parse");
      if (typeof text !== "string") throw new TypeError("Background parsing requires a string snapshot");
      index(text.length, "text length");
      index(revision, "revision", Number.MAX_SAFE_INTEGER);
      if (!Array.isArray(edits)) throw new TypeError("edits must be an array");
      if (
        signal != null &&
        ["throwIfAborted", "addEventListener", "removeEventListener"].some((name) => typeof signal[name] !== "function")
      ) {
        throw new TypeError("signal must be an AbortSignal");
      }
      signal?.throwIfAborted();
      validateRanges(includedRanges, text);
      const oldTree = preparePrevious(previous, edits, text, this.#language);
      const cancel = () => this.#native.cancel();
      this.#busy = true;
      try {
        signal?.addEventListener("abort", cancel, { once: true });
        const tree = await this.#native.parse(text, oldTree, includedRanges);
        signal?.throwIfAborted();
        Object.defineProperties(tree, {
          input: { value: text },
          language: { value: this.#language },
          revision: { value: revision, enumerable: true },
          getText: { value: (node) => text.slice(node.startIndex, node.endIndex) },
          edit: {
            value: () => {
              throw new TypeError("Cannot edit an immutable parse snapshot; use copy()");
            },
          },
        });
        return tree;
      } finally {
        this.#busy = false;
        signal?.removeEventListener("abort", cancel);
      }
    }
    cancel() {
      this.#native.cancel();
    }
    close() {
      this.#closed = true;
      this.#native.close();
    }
    get closed() {
      return this.#closed;
    }
    get busy() {
      return this.#busy;
    }
    [Symbol.dispose]() {
      this.close();
    }
  };
