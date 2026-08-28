import type { VaultKnowledgeIndex, NoteItem } from "./vault-indexer";

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "before", "being", "between", "but", "can", "content",
  "could", "does", "each", "from", "have", "into", "more", "note", "only", "other", "should", "that", "the",
  "their", "then", "there", "these", "this", "through", "using", "when", "where", "which", "with", "would",
]);

function searchTerms(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9][a-z0-9_.+-]{2,}/g) ?? [])
      .filter((term) => !SEARCH_STOP_WORDS.has(term))
      .map((term) => term.replace(/(?:ing|ed|es|s)$/i, ""))
      .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term)),
  );
}

export interface RankedVaultNote {
  note: NoteItem;
  score: number;
  matchedTerms: number;
  titleMatches: number;
}

function normalizeVaultPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export function isPathInFolder(path: string, folder: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedFolder = normalizeVaultPath(folder);
  return normalizedFolder === ""
    || normalizedPath === normalizedFolder
    || normalizedPath.startsWith(`${normalizedFolder}/`);
}

export function resolveFolderWithinScope(
  requestedFolder: string | undefined,
  scopeFolder: string | undefined,
  maxRelativeDepth: number = 2,
): string {
  const requested = normalizeVaultPath(requestedFolder ?? "");
  const safeDepth = Math.max(0, maxRelativeDepth);

  if (scopeFolder === undefined) {
    return requested.split("/").filter(Boolean).slice(0, safeDepth).join("/");
  }

  const scope = normalizeVaultPath(scopeFolder);
  if (!scope) {
    return requested.split("/").filter(Boolean).slice(0, safeDepth).join("/");
  }
  if (!isPathInFolder(requested, scope)) return scope;

  const relativeFolder = requested === scope ? "" : requested.slice(scope.length + 1);
  const limitedRelativeFolder = relativeFolder.split("/").filter(Boolean).slice(0, safeDepth).join("/");
  return limitedRelativeFolder ? `${scope}/${limitedRelativeFolder}` : scope;
}

export interface AtomicPlacementRequest {
  action: "create_new_note" | "append_to_note";
  targetNotePath?: string;
  targetFolder?: string;
  topicFolder?: string;
}

export type AtomicPlacementTarget =
  | { action: "append_to_note"; targetNotePath: string; targetFolder: string }
  | { action: "create_new_note"; targetFolder: string };

export function resolveAtomicPlacementTarget(
  request: AtomicPlacementRequest,
  folderScope?: string,
): AtomicPlacementTarget {
  const requestedFolder = normalizeVaultPath(request.targetFolder ?? "");
  const normalizedScope = folderScope === undefined ? undefined : normalizeVaultPath(folderScope);
  const rawTopicFolder = normalizeVaultPath(request.topicFolder ?? "");
  const topicFolder = normalizedScope && isPathInFolder(rawTopicFolder, normalizedScope)
    ? rawTopicFolder.slice(normalizedScope.length).replace(/^\/+/, "")
    : rawTopicFolder;
  const limitedTopicFolder = topicFolder.split("/").filter(Boolean).slice(0, 2).join("/");
  const requestedFolderIsAlreadyScoped = normalizedScope === undefined
    || isPathInFolder(requestedFolder, normalizedScope);
  const requestedFolderIsScopeRoot = request.action === "create_new_note"
    && normalizedScope !== undefined
    && requestedFolder === normalizedScope;
  let anchoredNewFolder = request.targetFolder;
  if (request.action === "create_new_note" && (!requestedFolder || requestedFolderIsScopeRoot)) {
    const requiredSubfolder = limitedTopicFolder || "Atomic Notes";
    anchoredNewFolder = normalizedScope ? `${normalizedScope}/${requiredSubfolder}` : requiredSubfolder;
  } else if (request.action === "create_new_note" && normalizedScope && !requestedFolderIsAlreadyScoped) {
    anchoredNewFolder = `${normalizedScope}/${requestedFolder}`;
  }
  const targetFolder = resolveFolderWithinScope(anchoredNewFolder, folderScope);
  const canAppend = request.action === "append_to_note"
    && !!request.targetNotePath
    && (folderScope === undefined || isPathInFolder(request.targetNotePath, folderScope));

  return canAppend
    ? { action: "append_to_note", targetNotePath: request.targetNotePath!, targetFolder }
    : { action: "create_new_note", targetFolder };
}

export function rankVaultContext(
  index: VaultKnowledgeIndex,
  query: string,
  folderScope?: string,
): RankedVaultNote[] {
  const queryTerms = searchTerms(query);
  const notes: NoteItem[] = [];
  const visit = (node: VaultKnowledgeIndex["tree"]) => {
    notes.push(...node.notes.filter((note) => folderScope === undefined || isPathInFolder(note.path, folderScope)));
    node.subfolders.forEach(visit);
  };
  visit(index.tree);

  return notes.map((note) => {
    const titleTerms = searchTerms(`${note.title} ${note.path}`);
    const topicTerms = searchTerms(`${note.tags.join(" ")} ${(note.topics ?? []).join(" ")}`);
    const aboutTerms = searchTerms(note.about);
    const titleMatches = [...titleTerms].filter((term) => queryTerms.has(term)).length;
    const topicMatches = [...topicTerms].filter((term) => queryTerms.has(term)).length;
    const aboutMatches = [...aboutTerms].filter((term) => queryTerms.has(term)).length;
    const matchedTerms = new Set(
      [...titleTerms, ...topicTerms, ...aboutTerms].filter((term) => queryTerms.has(term)),
    ).size;
    return {
      note,
      score: titleMatches * 6 + topicMatches * 3 + aboutMatches,
      matchedTerms,
      titleMatches,
    };
  }).sort((a, b) => b.score - a.score || b.titleMatches - a.titleMatches || b.note.mtime - a.note.mtime);
}

export function selectStrongRelatedNote(
  index: VaultKnowledgeIndex,
  query: string,
  folderScope?: string,
): NoteItem | null {
  const [best, second] = rankVaultContext(index, query, folderScope);
  if (!best) return null;

  const hasStrongTitleMatch = best.titleMatches >= 2 && best.score >= 14;
  const hasBroadMatch = best.titleMatches >= 1 && best.matchedTerms >= 4 && best.score >= 12;
  const hasClearLead = !second || best.score >= second.score + 2;
  return (hasStrongTitleMatch || (hasBroadMatch && hasClearLead)) ? best.note : null;
}

export function parseExcludedFolders(value: string): string[] {
  return value.split(/[\n,]/).map((part) => part.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
}

export function isExcludedPath(path: string, excluded: string[]): boolean {
  return excluded.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

export function estimateRemoteRequests(images: number, notes: number, diagrams: number): number {
  return Math.max(0, images) + 1 + Math.min(Math.max(0, notes), Math.max(0, diagrams));
}

export function selectVaultContext(
  index: VaultKnowledgeIndex,
  query: string,
  limit: number,
  folderScope?: string,
): NoteItem[] {
  return rankVaultContext(index, query, folderScope).slice(0, Math.max(0, limit)).map(({ note }) => note);
}
