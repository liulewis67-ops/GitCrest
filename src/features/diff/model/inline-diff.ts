const WORD_TOKENS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_LCS_CELLS = 300_000;

export interface InlineDiffSegment {
  text: string;
  changed: boolean;
}

/** Highlights changed words/punctuation while preserving whitespace and original text. */
export function splitInlineDiff(text: string, counterpart: string | null): InlineDiffSegment[] {
  if (counterpart === null) return text ? [{ text, changed: true }] : [];
  const tokens = text.match(WORD_TOKENS) ?? [];
  const counterpartTokens = counterpart.match(WORD_TOKENS) ?? [];
  const isMatched = tokens.map(() => false);
  const cellCount = (tokens.length + 1) * (counterpartTokens.length + 1);

  if (cellCount <= MAX_LCS_CELLS) {
    const width = counterpartTokens.length + 1;
    const lcs = new Uint32Array(cellCount);
    for (let left = tokens.length - 1; left >= 0; left -= 1) {
      for (let right = counterpartTokens.length - 1; right >= 0; right -= 1) {
        const cell = left * width + right;
        lcs[cell] = tokens[left] === counterpartTokens[right]
          ? lcs[(left + 1) * width + right + 1] + 1
          : Math.max(lcs[(left + 1) * width + right], lcs[left * width + right + 1]);
      }
    }
    let left = 0;
    let right = 0;
    while (left < tokens.length && right < counterpartTokens.length) {
      if (tokens[left] === counterpartTokens[right]) {
        isMatched[left] = true;
        left += 1;
        right += 1;
      } else if (lcs[(left + 1) * width + right] >= lcs[left * width + right + 1]) {
        left += 1;
      } else {
        right += 1;
      }
    }
  } else {
    // Keep large or pathological lines responsive with a linear common-edge fallback.
    let prefix = 0;
    while (prefix < tokens.length && prefix < counterpartTokens.length && tokens[prefix] === counterpartTokens[prefix]) {
      isMatched[prefix] = true;
      prefix += 1;
    }
    let suffix = 0;
    while (suffix < tokens.length - prefix && suffix < counterpartTokens.length - prefix
      && tokens[tokens.length - suffix - 1] === counterpartTokens[counterpartTokens.length - suffix - 1]) {
      isMatched[tokens.length - suffix - 1] = true;
      suffix += 1;
    }
  }

  const segments: InlineDiffSegment[] = [];
  tokens.forEach((token, index) => {
    const changed = !isMatched[index];
    const last = segments[segments.length - 1];
    if (last?.changed === changed) last.text += token;
    else segments.push({ text: token, changed });
  });
  return segments;
}
