const MAX_INDEX = Math.floor(0xffffffff / 2);

function index(value, name, maximum = MAX_INDEX) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
}

function position(text, offset) {
  let row = 0;
  let start = 0;
  for (let next = text.indexOf("\n"); next >= 0 && next < offset; next = text.indexOf("\n", next + 1)) {
    row++;
    start = next + 1;
  }
  return { row, column: offset - start };
}

function preparePrevious(previous, edits, text, language) {
  if (!previous) {
    if (edits.length) throw new TypeError("edits require a previous snapshot");
    return null;
  }
  if (previous.language !== language || typeof previous.input !== "string") {
    throw new TypeError("previous must be a string snapshot from the same language");
  }
  const copy = previous.copy();
  let source = previous.input;
  for (const edit of edits) {
    index(edit.startIndex, "startIndex", source.length);
    index(edit.oldEndIndex, "oldEndIndex", source.length);
    if (edit.oldEndIndex < edit.startIndex || typeof edit.newText !== "string") {
      throw new TypeError("An edit requires ordered indices and string newText");
    }
    const updated = source.slice(0, edit.startIndex) + edit.newText + source.slice(edit.oldEndIndex);
    index(updated.length, "edited text length");
    const newEndIndex = edit.startIndex + edit.newText.length;
    copy.edit({
      startIndex: edit.startIndex,
      oldEndIndex: edit.oldEndIndex,
      newEndIndex,
      startPosition: position(source, edit.startIndex),
      oldEndPosition: position(source, edit.oldEndIndex),
      newEndPosition: position(updated, newEndIndex),
    });
    source = updated;
  }
  if (source !== text) throw new Error("edits do not transform the previous snapshot into the requested text");
  return copy;
}

function validateRanges(ranges, text) {
  if (ranges === undefined) return;
  if (!Array.isArray(ranges)) throw new TypeError("includedRanges must be an array");
  let previousEnd = 0;
  for (const range of ranges) {
    index(range.startIndex, "range.startIndex", text.length);
    index(range.endIndex, "range.endIndex", text.length);
    if (range.startIndex < previousEnd || range.endIndex < range.startIndex) {
      throw new RangeError("includedRanges must be ordered and non-overlapping");
    }
    for (const endpoint of ["start", "end"]) {
      const actual = position(text, range[`${endpoint}Index`]);
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
