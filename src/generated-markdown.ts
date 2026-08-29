export function normalizeGeneratedNoteMarkdown(markdown: string): string {
  return markdown.replace(
    /^```(?:yaml|yml)\s*\r?\n(---\r?\n[\s\S]*?\r?\n---)\s*\r?\n```\s*(?:\r?\n)?/i,
    "$1\n",
  );
}
