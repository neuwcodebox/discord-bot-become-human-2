export function chooseSplit(text: string, softLimit: number): number {
  const candidates = ["\n\n", "\n", ". ", " "];
  for (const sep of candidates) {
    const index = text.lastIndexOf(sep, softLimit);
    if (index > 0) return index + sep.length;
  }
  return softLimit;
}

export function splitText(text: string, softLimit: number, hardLimit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > hardLimit) {
    const splitAt = chooseSplit(remaining, softLimit);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
