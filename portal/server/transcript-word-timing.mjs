const IGNORED_CHARACTERS = /[\s，。！？、；：,.!?;:"'“”‘’（）()【】\[\]《》]/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeTranscriptText(value) {
  return String(value || "").normalize("NFKC").replace(IGNORED_CHARACTERS, "");
}

function graphemes(value) {
  const text = normalizeTranscriptText(value);
  return [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
}

function align(oldText, newText) {
  const rows = oldText.length + 1;
  const columns = newText.length + 1;
  if (rows * columns > 4_004_001) return null;
  const costs = new Uint16Array(rows * columns);
  for (let row = 0; row < rows; row += 1) costs[row * columns] = row;
  for (let column = 0; column < columns; column += 1) costs[column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = costs[(row - 1) * columns + column - 1] + (oldText[row - 1] === newText[column - 1] ? 0 : 1);
      costs[row * columns + column] = Math.min(
        substitution,
        costs[(row - 1) * columns + column] + 1,
        costs[row * columns + column - 1] + 1,
      );
    }
  }
  const operations = [];
  let row = oldText.length;
  let column = newText.length;
  while (row || column) {
    const current = costs[row * columns + column];
    if (row && column && oldText[row - 1] === newText[column - 1] && current === costs[(row - 1) * columns + column - 1]) {
      operations.push({ type: "equal", oldIndex: row - 1, newIndex: column - 1 });
      row -= 1; column -= 1;
    } else if (row && column && current === costs[(row - 1) * columns + column - 1] + 1) {
      operations.push({ type: "replace", oldIndex: row - 1, newIndex: column - 1 });
      row -= 1; column -= 1;
    } else if (row && current === costs[(row - 1) * columns + column] + 1) {
      operations.push({ type: "delete", oldIndex: row - 1 });
      row -= 1;
    } else {
      operations.push({ type: "insert", oldIndex: row, newIndex: column - 1 });
      column -= 1;
    }
  }
  return operations.reverse();
}

function distribute(indices, startMs, endMs, target) {
  if (!indices.length || endMs - startMs < indices.length) return false;
  const duration = endMs - startMs;
  indices.forEach((index, offset) => {
    target[index] = {
      startMs: startMs + duration * offset / indices.length,
      endMs: startMs + duration * (offset + 1) / indices.length,
    };
  });
  return true;
}

export function remapWordTimings({ previousText, nextText, words, startMs, endMs }) {
  if (!Array.isArray(words) || !words.length) return null;
  const segmentStart = Number(startMs);
  const segmentEnd = Number(endMs);
  if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) return null;
  const oldText = graphemes(previousText);
  const newText = graphemes(nextText);
  if (!oldText.length || !newText.length) return null;

  const oldUnits = [];
  for (const [wordIndex, word] of words.entries()) {
    if (!word || typeof word !== "object" || Array.isArray(word)) return null;
    const wordStart = Number(word.startMs);
    const wordEnd = Number(word.endMs);
    const chars = graphemes(word.text);
    if (!chars.length || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordStart < segmentStart || wordEnd > segmentEnd || wordEnd <= wordStart || wordEnd - wordStart < chars.length) return null;
    if (oldUnits.length && wordStart < oldUnits.at(-1).endMs) return null;
    chars.forEach((text, index) => {
      const duration = wordEnd - wordStart;
      oldUnits.push({
        text,
        startMs: wordStart + duration * index / chars.length,
        endMs: wordStart + duration * (index + 1) / chars.length,
        wordIndex,
        wordStart,
        wordEnd,
      });
    });
  }
  if (oldUnits.length !== oldText.length || oldUnits.some((unit, index) => unit.text !== oldText[index])) return null;

  const operations = align(oldText, newText);
  if (!operations) return null;
  const timings = new Array(newText.length);
  for (const operation of operations) {
    if (operation.type === "equal") timings[operation.newIndex] = { startMs: oldUnits[operation.oldIndex].startMs, endMs: oldUnits[operation.oldIndex].endMs };
  }

  const insertedByWord = new Map();
  for (const [index, operation] of operations.entries()) {
    if (operation.type !== "insert") continue;
    const left = [...operations.slice(0, index)].reverse().find((item) => Number.isInteger(item.oldIndex));
    const right = operations.slice(index + 1).find((item) => Number.isInteger(item.oldIndex));
    const neighbor = left ? oldUnits[left.oldIndex] : right ? oldUnits[right.oldIndex] : null;
    if (!neighbor) return null;
    const indices = insertedByWord.get(neighbor.wordIndex) || [];
    indices.push(operation.newIndex);
    insertedByWord.set(neighbor.wordIndex, indices);
  }

  const newIndicesByWord = new Map();
  for (const operation of operations) {
    if (operation.type === "insert" || !Number.isInteger(operation.oldIndex) || !Number.isInteger(operation.newIndex)) continue;
    const wordIndex = oldUnits[operation.oldIndex].wordIndex;
    const indices = newIndicesByWord.get(wordIndex) || [];
    indices.push(operation.newIndex);
    newIndicesByWord.set(wordIndex, indices);
  }
  let block = [];
  const flushBlock = () => {
    const oldIndices = block.filter((operation) => operation.type !== "insert").map((operation) => operation.oldIndex);
    const newIndices = block.filter((operation) => Number.isInteger(operation.newIndex)).map((operation) => operation.newIndex);
    if (oldIndices.length && newIndices.length) {
      const start = Math.min(...oldIndices.map((index) => oldUnits[index].startMs));
      const end = Math.max(...oldIndices.map((index) => oldUnits[index].endMs));
      if (!distribute(newIndices, start, end, timings)) return false;
    }
    block = [];
    return true;
  };
  for (const operation of operations) {
    if (operation.type === "equal") {
      if (!flushBlock()) return null;
    } else block.push(operation);
  }
  if (!flushBlock() || timings.some((timing) => !timing)) return null;
  for (const [wordIndex, insertedIndices] of insertedByWord) {
    const indices = [...new Set([...(newIndicesByWord.get(wordIndex) || []), ...insertedIndices])].sort((a, b) => a - b);
    if (indices.at(-1) - indices[0] + 1 !== indices.length) return null;
    const sourceWord = words[wordIndex];
    if (!distribute(indices, Number(sourceWord.startMs), Number(sourceWord.endMs), timings)) return null;
  }
  for (let index = 0; index < timings.length; index += 1) {
    const timing = timings[index];
    if (timing.startMs < segmentStart || timing.endMs > segmentEnd || timing.endMs <= timing.startMs || (index > 0 && timing.startMs < timings[index - 1].endMs - 0.01)) return null;
  }
  return newText.map((text, index) => ({ ...timings[index], text }));
}
