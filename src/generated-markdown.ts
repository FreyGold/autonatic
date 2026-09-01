export function normalizeGeneratedNoteMarkdown(markdown: string): string {
  return markdown.replace(
    /^```(?:yaml|yml)\s*\r?\n(---\r?\n[\s\S]*?\r?\n---)\s*\r?\n```\s*(?:\r?\n)?/i,
    "$1\n",
  );
}

function normalizeGeneratedFolderPath(value: string): string {
  const segments = value.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return "";
  return segments.join("/");
}

function readFrontmatterTags(markdown: string): string[] {
  const normalized = normalizeGeneratedNoteMarkdown(markdown);
  const frontmatterMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) return [];

  const lines = frontmatterMatch[1].split(/\r?\n/);
  const tags: string[] = [];
  const tagLineIndex = lines.findIndex((line) => /^tags:\s*/i.test(line));
  if (tagLineIndex < 0) return tags;

  const inlineValue = lines[tagLineIndex].replace(/^tags:\s*/i, "").trim();
  if (inlineValue) {
    const values = inlineValue.startsWith("[") && inlineValue.endsWith("]")
      ? inlineValue.slice(1, -1).split(",")
      : [inlineValue];
    tags.push(...values.map((value) => value.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));
  }

  for (const line of lines.slice(tagLineIndex + 1)) {
    const listItem = line.match(/^\s+-\s+(.+?)\s*$/);
    if (listItem) {
      tags.push(listItem[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (/^\S/.test(line)) break;
  }
  return tags;
}

export function extractGeneratedNoteFolder(markdown: string): string {
  for (const tag of readFrontmatterTags(markdown)) {
    if (!/^#?notes\//i.test(tag)) continue;
    const folder = normalizeGeneratedFolderPath(tag.replace(/^#?notes\//i, ""));
    if (folder) return folder;
  }
  return "";
}

export function resolveGeneratedNoteFolder(markdown: string, requestedFolder?: string): string {
  const requested = normalizeGeneratedFolderPath(requestedFolder ?? "");
  const tagged = extractGeneratedNoteFolder(markdown);
  if (!tagged) return requested;
  if (!requested) return tagged;

  const requestedParts = requested.split("/");
  const taggedParts = tagged.split("/");
  const tagStartsInRequestedFolder = requestedParts.every(
    (part, index) => taggedParts[index]?.toLocaleLowerCase() === part.toLocaleLowerCase(),
  );
  if (tagStartsInRequestedFolder && taggedParts.length > requestedParts.length) {
    return [...requestedParts, ...taggedParts.slice(requestedParts.length)].join("/");
  }
  return requested;
}
