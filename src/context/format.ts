export function block(tag: string, content: string): string | undefined {
  const trimmed = content.trim();
  return trimmed ? `<${tag}>\n${trimmed}\n</${tag}>` : undefined;
}

export function sections(...blocks: Array<string | undefined>): string {
  return blocks.filter((block): block is string => block !== undefined).join("\n\n");
}
