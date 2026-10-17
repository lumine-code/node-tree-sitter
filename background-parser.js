const MAX_INDEX = Math.floor(0xffffffff / 2);
const { TextEdits, advanceText, prepareOrdered } = require("./text-edits");

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
  const normalized = [];
  let length = previous.input.length;
  for (const edit of edits) {
    const { startIndex, oldEndIndex, newText } = edit;
    index(startIndex, "startIndex", length);
    index(oldEndIndex, "oldEndIndex", length);
    if (oldEndIndex < startIndex || typeof newText !== "string") {
      throw new TypeError("An edit requires ordered indices and string newText");
    }
    length += newText.length - (oldEndIndex - startIndex);
    index(length, "edited text length");
    normalized.push({ startIndex, oldEndIndex, newText });
  }
  let prepared = prepareOrdered(previous.input, normalized);
  if (!prepared) {
    const source = new TextEdits(previous.input);
    const changes = normalized.map((edit) => source.replace(edit.startIndex, edit.oldEndIndex, edit.newText));
    prepared = { changes, text: source.getText() };
  }
  if (prepared.text !== text) throw new Error("edits do not transform the previous snapshot into the requested text");
  const copy = previous.copy();
  for (const change of prepared.changes) copy.edit(change);
  return copy;
}

function validateRanges(ranges, text) {
  if (ranges === undefined) return;
  if (!Array.isArray(ranges)) throw new TypeError("includedRanges must be an array");
  let offset = 0,
    position = { row: 0, column: 0 };
  let previousEnd = 0;
  const normalized = [];
  for (const range of ranges) {
    const { startIndex, endIndex, startPosition, endPosition } = range;
    index(startIndex, "range.startIndex", text.length);
    index(endIndex, "range.endIndex", text.length);
    if (startIndex < previousEnd || endIndex < startIndex) {
      throw new RangeError("includedRanges must be ordered and non-overlapping");
    }
    const copy = { startIndex, endIndex };
    for (const endpoint of ["start", "end"]) {
      const next = copy[`${endpoint}Index`];
      const actual = advanceText(text, offset, next, position);
      offset = next;
      position = actual;
      const supplied = endpoint === "start" ? startPosition : endPosition;
      if (actual.row !== supplied?.row || actual.column !== supplied?.column) {
        throw new RangeError("Range positions must match UTF-16 indices in the snapshot");
      }
      copy[`${endpoint}Position`] = actual;
    }
    previousEnd = endIndex;
    normalized.push(copy);
  }
  return normalized;
}

module.exports = (NativeParser, published = () => {}, initialize = () => {}) => {
  const snapshots = new WeakSet();
  return class BackgroundParser {
    #native;
    #language;
    #busy = false;
    #closed = false;
    #cancelled = false;
    constructor(language) {
      this.#native = new NativeParser(language);
      initialize(language);
      this.#language = language;
    }
    async parse(text, options = {}) {
      if (this.#closed) throw new Error("Parser is closed");
      if (this.#busy) throw new Error("Parser already has an active parse");
      this.#busy = true;
      this.#cancelled = false;
      let signal;
      let listening = false;
      const cancel = () => this.#native.cancel();
      try {
        const { previous = null, edits = [], includedRanges, revision = 0 } = options;
        signal = options.signal;
        if (typeof text !== "string") throw new TypeError("Background parsing requires a string snapshot");
        index(text.length, "text length");
        index(revision, "revision", Number.MAX_SAFE_INTEGER);
        if (!Array.isArray(edits)) throw new TypeError("edits must be an array");
        if (
          signal != null &&
          ["throwIfAborted", "addEventListener", "removeEventListener"].some(
            (name) => typeof signal[name] !== "function",
          )
        ) {
          throw new TypeError("signal must be an AbortSignal");
        }
        signal?.throwIfAborted();
        const ranges = validateRanges(includedRanges, text);
        if (previous !== null && !snapshots.has(previous))
          throw new TypeError("previous must be an immutable background snapshot");
        const oldTree = preparePrevious(previous, edits, text, this.#language);
        listening = signal != null;
        signal?.addEventListener("abort", cancel, { once: true });
        signal?.throwIfAborted();
        if (this.#cancelled) {
          const error = new Error("Parsing was cancelled");
          error.name = "AbortError";
          throw error;
        }
        const tree = await this.#native.parse(text, oldTree, ranges);
        signal?.throwIfAborted();
        Object.defineProperties(tree, {
          changedRanges: {
            value: Object.freeze(
              tree.changedRanges.map((range) =>
                Object.freeze({
                  ...range,
                  startPosition: Object.freeze(range.startPosition),
                  endPosition: Object.freeze(range.endPosition),
                }),
              ),
            ),
            writable: false,
            configurable: false,
            enumerable: true,
          },
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
        snapshots.add(tree);
        published(tree);
        return tree;
      } finally {
        this.#busy = false;
        if (listening) signal.removeEventListener("abort", cancel);
      }
    }
    cancel() {
      if (this.#busy) this.#cancelled = true;
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
};
