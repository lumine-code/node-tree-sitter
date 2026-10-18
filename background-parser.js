const MAX_INDEX = Math.floor(0xffffffff / 2);
const { TextEdits, advanceText, prepareOrdered } = require("./text-edits");

function index(value, name, maximum = MAX_INDEX) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
}

const editPlans = new WeakMap();

function rememberPlan(edits, source, text, changes) {
  if (!Object.isFrozen(edits)) return;
  for (let i = 0; i < edits.length; i++) {
    const edit = Object.getOwnPropertyDescriptor(edits, i)?.value;
    if (!edit || !Object.isFrozen(edit)) return;
    if (
      ["startIndex", "oldEndIndex", "newText"].some(
        (key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(edit, key) ?? {}, "value"),
      )
    )
      return;
  }
  editPlans.set(edits, { source, text, changes });
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
  const plan = editPlans.get(edits);
  if (plan?.source === previous.input && plan.text === text) {
    const copy = previous.copy();
    for (const change of plan.changes) copy.edit(change);
    return copy;
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
    const change = {
      startIndex,
      oldEndIndex,
      newEndIndex: startIndex + newText.length,
      startPosition,
      oldEndPosition: advanceText(source, startIndex, oldEndIndex, startPosition),
      newEndPosition: advanceText(newText, 0, newText.length, startPosition),
    };
    copy.edit(change);
    rememberPlan(edits, source, text, [change]);
    return copy;
  }
  const normalized = [];
  let length = previous.input.length;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
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
  rememberPlan(edits, previous.input, text, prepared.changes);
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

module.exports = (NativeParser, published = () => {}, initialize = () => {}, freeze = () => {}, createSynchronousParser) => {
  const snapshots = new WeakSet();
  function publishSnapshot(tree, text, language, revision) {
    freeze(tree);
    Object.defineProperties(tree, {
      changedRanges: {
        value: Object.freeze(
          (tree.changedRanges ?? []).map((range) =>
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
      input: { value: text, writable: false, configurable: false },
      language: { value: language, writable: false, configurable: false },
      revision: { value: revision, enumerable: true },
      getText: { value: (node) => text.slice(node.startIndex, node.endIndex), writable: false, configurable: false },
      edit: {
        value: () => {
          throw new TypeError("Cannot edit an immutable parse snapshot; use copy()");
        },
      },
    });
    snapshots.add(tree);
    published(tree);
  }
  return class BackgroundParser {
    static reuseSnapshot(previous, text, { edits = [], includedRanges, revision = 0 } = {}) {
      if (!snapshots.has(previous)) throw new TypeError("previous must be an immutable background snapshot");
      if (typeof text !== "string") throw new TypeError("Expected a string snapshot");
      index(text.length, "text length");
      index(revision, "revision", Number.MAX_SAFE_INTEGER);
      if (!Array.isArray(edits)) throw new TypeError("edits must be an array");
      const ranges = validateRanges(includedRanges, text);
      if (!ranges?.length) return null;
      const oldRanges = previous.getIncludedRanges();
      if (oldRanges.length !== ranges.length) return null;
      const rowShift = ranges[0].startPosition.row - oldRanges[0].startPosition.row;
      for (let i = 0; i < ranges.length; i++) {
        const before = oldRanges[i],
          after = ranges[i];
        if (
          before.endIndex > previous.input.length ||
          after.startPosition.row - before.startPosition.row !== rowShift ||
          after.endPosition.row - before.endPosition.row !== rowShift ||
          before.startPosition.column !== after.startPosition.column ||
          before.endPosition.column !== after.endPosition.column ||
          previous.input.slice(before.startIndex, before.endIndex) !== text.slice(after.startIndex, after.endIndex)
        )
          return null;
        // Lexer initialization treats a BOM at byte zero specially, and a
        // UTF-16 boundary must not make lookahead depend on excluded text.
        const first = previous.input.charCodeAt(before.startIndex);
        const last = previous.input.charCodeAt(before.endIndex - 1);
        if ((first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff)) return null;
        if (first === 0xfeff && (before.startIndex === 0) !== (after.startIndex === 0)) return null;
      }
      let tree = preparePrevious(previous, edits, text, previous.language);
      if (tree === previous) tree = previous.copy();
      const shifted = tree.getIncludedRanges();
      for (let i = 0; i < ranges.length; i++) {
        const actual = shifted[i],
          expected = ranges[i];
        if (
          actual.startIndex !== expected.startIndex ||
          actual.endIndex !== expected.endIndex ||
          actual.startPosition.row !== expected.startPosition.row ||
          actual.startPosition.column !== expected.startPosition.column ||
          actual.endPosition.row !== expected.endPosition.row ||
          actual.endPosition.column !== expected.endPosition.column
        )
          return null;
      }
      publishSnapshot(tree, text, previous.language, revision);
      return tree;
    }
    #native;
    #synchronous;
    #language;
    #busy = false;
    #closed = false;
    #cancelled = false;
    constructor(language) {
      this.#native = new NativeParser(language);
      initialize(language);
      this.#language = language;
    }
    parseSync(text, options = {}) {
      return this.#parseSynchronous(text, options, false);
    }
    tryParseSync(text, options = {}) {
      return this.#parseSynchronous(text, options, true);
    }
    setLogger(logger) {
      if (this.#closed) throw new Error("Parser is closed");
      if (this.#busy) throw new Error("Parser already has an active parse");
      if (!this.#synchronous && (logger == null || logger === false)) return this;
      this.#synchronous ??= createSynchronousParser(this.#language);
      this.#synchronous.setLogger(logger);
      return this;
    }
    getLogger() {
      return this.#synchronous?.getLogger() ?? null;
    }
    #parseSynchronous(text, options, bounded) {
      if (this.#closed) throw new Error("Parser is closed");
      if (this.#busy) throw new Error("Parser already has an active parse");
      this.#busy = true;
      this.#cancelled = false;
      let parser;
      try {
        const { previous = null, edits = [], includedRanges, revision = 0 } = options;
        const timeoutMicros = bounded ? options.timeoutMicros ?? 5000 : 0;
        index(timeoutMicros, "timeoutMicros", Number.MAX_SAFE_INTEGER);
        if (typeof text !== "string") throw new TypeError("Snapshot parsing requires a string");
        index(text.length, "text length");
        index(revision, "revision", Number.MAX_SAFE_INTEGER);
        if (!Array.isArray(edits)) throw new TypeError("edits must be an array");
        const ranges = validateRanges(includedRanges, text);
        if (previous !== null && !snapshots.has(previous))
          throw new TypeError("previous must be an immutable snapshot");
        const oldTree = preparePrevious(previous, edits, text, this.#language);
        if (this.#cancelled || this.#closed) {
          const error = new Error("Parsing was cancelled");
          error.name = "AbortError";
          throw error;
        }
        parser = this.#synchronous ??= createSynchronousParser(this.#language);
        parser.setTimeoutMicros(timeoutMicros);
        const tree = parser.parse(text, oldTree, { includedRanges: ranges });
        if (this.#cancelled || this.#closed) {
          parser.reset();
          const error = new Error("Parsing was cancelled");
          error.name = "AbortError";
          throw error;
        }
        if (!tree) {
          parser.reset();
          if (bounded) return null;
          throw new Error("Synchronous snapshot parsing did not complete");
        }
        tree.changedRanges = oldTree ? oldTree.getChangedRanges(tree) : [];
        publishSnapshot(tree, text, this.#language, revision);
        return tree;
      } finally {
        parser?.setTimeoutMicros(0);
        this.#busy = false;
      }
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
        publishSnapshot(tree, text, this.#language, revision);
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
      this.#synchronous = null;
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
