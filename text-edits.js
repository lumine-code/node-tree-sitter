// Temporary pieces avoid rebuilding and scanning the full document per edit.
// This is independent of the eventual native buffer integration.
class Source {
  constructor(text) {
    this.text = text;
    this.starts = [0];
    for (let next = text.indexOf("\n"); next !== -1; next = text.indexOf("\n", next + 1)) {
      this.starts.push(next + 1);
    }
  }
  position(offset) {
    let low = 0,
      high = this.starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { row: low, column: offset - this.starts[low] };
  }
  piece(start, end) {
    const from = this.position(start),
      to = this.position(end);
    return { source: this, start, end, rows: to.row - from.row, column: to.row === from.row ? end - start : to.column };
  }
}

function advance(point, rows, column) {
  return { row: point.row + rows, column: rows ? column : point.column + column };
}

function advanceText(text, start, end, point = { row: 0, column: 0 }) {
  let row = point.row,
    last = -1;
  for (let next = text.indexOf("\n", start); next !== -1 && next < end; next = text.indexOf("\n", next + 1)) {
    row++;
    last = next;
  }
  return { row, column: last < 0 ? point.column + end - start : end - last - 1 };
}

class TextEdits {
  constructor(text) {
    const source = new Source(text);
    this.pieces = text.length ? [source.piece(0, text.length)] : [];
    this.length = text.length;
  }
  locate(offset) {
    let point = { row: 0, column: 0 };
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      const length = piece.end - piece.start;
      if (offset < length) {
        const prefix = piece.source.piece(piece.start, piece.start + offset);
        return { i, offset, point: advance(point, prefix.rows, prefix.column) };
      }
      offset -= length;
      point = advance(point, piece.rows, piece.column);
    }
    return { i: this.pieces.length, offset: 0, point };
  }
  replace(startIndex, oldEndIndex, newText) {
    const from = this.locate(startIndex),
      to = this.locate(oldEndIndex);
    const inserted = new Source(newText).piece(0, newText.length);
    const replacement = [];
    if (from.offset) {
      const piece = this.pieces[from.i];
      replacement.push(piece.source.piece(piece.start, piece.start + from.offset));
    }
    if (newText.length) replacement.push(inserted);
    if (to.i < this.pieces.length) {
      const piece = this.pieces[to.i];
      replacement.push(piece.source.piece(piece.start + to.offset, piece.end));
    }
    this.pieces.splice(from.i, to.i - from.i + (to.i < this.pieces.length ? 1 : 0), ...replacement);
    this.length += newText.length - (oldEndIndex - startIndex);
    return {
      startIndex,
      oldEndIndex,
      newEndIndex: startIndex + newText.length,
      startPosition: from.point,
      oldEndPosition: to.point,
      newEndPosition: advance(from.point, inserted.rows, inserted.column),
    };
  }
  getText() {
    return this.pieces.map((piece) => piece.source.text.slice(piece.start, piece.end)).join("");
  }
}

function prepareOrdered(text, edits) {
  const descending = edits.every((edit, i) => !i || edit.oldEndIndex <= edits[i - 1].startIndex);
  const ascending =
    !descending &&
    edits.every((edit, i) => !i || edit.startIndex >= edits[i - 1].startIndex + edits[i - 1].newText.length);
  if (!descending && !ascending) return null;
  const changes = new Array(edits.length),
    chunks = [];
  let sourceOffset = 0,
    delta = 0,
    position = { row: 0, column: 0 };
  for (let n = 0; n < edits.length; n++) {
    const i = descending ? edits.length - n - 1 : n;
    const edit = edits[i];
    const originalStart = edit.startIndex - (descending ? 0 : delta);
    const originalEnd = edit.oldEndIndex - (descending ? 0 : delta);
    const startPosition = advanceText(text, sourceOffset, originalStart, position);
    const oldEndPosition = advanceText(text, originalStart, originalEnd, startPosition);
    const newEndPosition = advanceText(edit.newText, 0, edit.newText.length, startPosition);
    changes[i] = {
      startIndex: edit.startIndex,
      oldEndIndex: edit.oldEndIndex,
      newEndIndex: edit.startIndex + edit.newText.length,
      startPosition,
      oldEndPosition,
      newEndPosition,
    };
    chunks.push(text.slice(sourceOffset, originalStart), edit.newText);
    sourceOffset = originalEnd;
    position = descending ? oldEndPosition : newEndPosition;
    delta += edit.newText.length - (edit.oldEndIndex - edit.startIndex);
  }
  chunks.push(text.slice(sourceOffset));
  return { changes, text: chunks.join("") };
}

module.exports = { TextEdits, advanceText, prepareOrdered };
