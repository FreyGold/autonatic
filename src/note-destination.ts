import { normalizeGeneratedNoteMarkdown, resolveGeneratedNoteFolder } from "./generated-markdown";

export const GENERATED_NOTES_FALLBACK_FOLDER = "Autonatic";

function normalizeFolder(value: string | undefined): string {
  const segments = (value ?? "").trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")
    || /[<>:"|?*\u0000-\u001f]/u.test(segment))) {
    throw new Error("The target folder contains an unsafe path segment.");
  }
  return segments.join("/");
}

/** Generated Markdown notes must always have a real folder below the vault root. */
export function ensureNonRootNoteFolder(
  requestedFolder: string | undefined,
  configuredFallback: string | undefined = GENERATED_NOTES_FALLBACK_FOLDER,
): string {
  const requested = normalizeFolder(requestedFolder);
  if (requested) return requested;
  const fallback = normalizeFolder(configuredFallback);
  return fallback || GENERATED_NOTES_FALLBACK_FOLDER;
}

/** Resolve model tags and user choices once so review and final placement agree. */
export function resolveNewNoteFolder(
  markdown: string,
  requestedFolder: string | undefined,
  configuredFallback: string | undefined,
  allowGeneratedFolder: boolean,
): string {
  const requested = normalizeFolder(requestedFolder);
  const resolved = allowGeneratedFolder
    ? resolveGeneratedNoteFolder(markdown, requested)
    : requested;
  return ensureNonRootNoteFolder(resolved, configuredFallback);
}

export function deriveSafeNoteTitle(markdown: string, requestedTitle?: string): string {
  const normalized = normalizeGeneratedNoteMarkdown(markdown);
  let title = requestedTitle?.trim();
  if (!title) {
    const yamlTitleMatch = normalized.match(/^title:\s*["']?([^"'\n\r]+)["']?/m);
    const headingMatch = normalized.match(/^#\s+(.+)$/m);
    title = yamlTitleMatch?.[1]?.trim() || headingMatch?.[1]?.trim();
  }
  if (!title) {
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
    title = `AI Note ${dateStr}`;
  }
  const safeTitle = title.replace(/(?:\.md)+$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (safeTitle) return safeTitle;
  const dateStr = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
  return `AI Note ${dateStr}`;
}
