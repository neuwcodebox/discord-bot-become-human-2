export async function summarizeText(input: {
  text: string;
  maxChars?: number;
}): Promise<{ summary: string }> {
  const maxChars = input.maxChars ?? 1200;
  const normalized = input.text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return { summary: normalized };
  return { summary: `${normalized.slice(0, maxChars - 1)}…` };
}
