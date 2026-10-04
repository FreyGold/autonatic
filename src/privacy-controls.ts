import type { VaultKnowledgeIndex, NoteItem } from "./vault-indexer";

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "before", "being", "between", "but", "can", "content",
  "could", "does", "each", "from", "have", "into", "more", "note", "only", "other", "should", "that", "the",
  "their", "then", "there", "these", "this", "through", "using", "when", "where", "which", "with", "would",
]);

function searchTerms(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.+-]{2,}/gu) ?? [])
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
  folderStrategy?: "root" | "existing_subfolder" | "new_subfolder";
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
  const requestedFolderIsAlreadyScoped = normalizedScope === undefined
    || isPathInFolder(requestedFolder, normalizedScope);
  let anchoredNewFolder = request.targetFolder;
  if (request.action === "create_new_note" && normalizedScope && requestedFolder && !requestedFolderIsAlreadyScoped) {
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

export function resolveAtomicPlacementPlan(
  requests: readonly AtomicPlacementRequest[],
  folderScope?: string,
  existingFolders: readonly string[] = [],
): AtomicPlacementTarget[] {
  const scopeRoot = folderScope === undefined ? "" : normalizeVaultPath(folderScope);
  const existingFolderSet = new Set(
    existingFolders
      .map(normalizeVaultPath)
      .filter((folder) => folderScope === undefined || isPathInFolder(folder, scopeRoot)),
  );
  const candidates = requests.map((request) => {
    const target = resolveAtomicPlacementTarget(request, folderScope);
    if (target.action === "append_to_note" || folderScope !== undefined) return target;

    const requestedFolder = normalizeVaultPath(request.targetFolder ?? "");
    const deepestExistingAncestor = [...existingFolderSet]
      .filter((folder) => folder && isPathInFolder(requestedFolder, folder))
      .sort((left, right) => right.split("/").length - left.split("/").length)[0];
    if (!deepestExistingAncestor) return target;

    return {
      action: "create_new_note" as const,
      targetFolder: resolveFolderWithinScope(requestedFolder, deepestExistingAncestor),
    };
  });

  return candidates.map((target, index) => {
    if (target.action === "append_to_note") return target;

    const strategy = requests[index].folderStrategy;
    const candidateFolder = target.targetFolder;
    const rootTarget: AtomicPlacementTarget = { action: "create_new_note", targetFolder: scopeRoot };
    if (strategy === "root" || !candidateFolder || candidateFolder === scopeRoot) return rootTarget;
    if (existingFolderSet.has(candidateFolder)) return target;
    // A missing destination can be created even if the model labeled it existing.
    return target;
  });
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

/**
 * Search long sources in bounded pieces so repeated early subjects cannot crowd
 * every other subject out of the context sent for automatic placement.
 */
export function sourceRetrievalQueries(source: string, maxQueries = 64): string[] {
  const paragraphs = source.replace(/\r\n?/g, "\n").split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  const queries: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) queries.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    // Imported chat transcripts mark each turn with a numbered You heading.
    // Keep its question and answer together, while giving the next turn its own query.
    if (/^##\s+\d+\.\s+You\s*$/i.test(paragraph)
      || /^(?:user|you|human):/i.test(paragraph)
      || (/^#{1,3}\s+\S/.test(paragraph) && !/^##\s+\d+\.\s+(?:Gemini|ChatGPT|Claude)\s*$/i.test(paragraph))) flush();
    if (paragraph.length > 1500) {
      flush();
      for (let start = 0; start < paragraph.length; start += 1400) {
        queries.push(paragraph.slice(start, start + 1500));
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > 1500) flush();
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  flush();

  const count = Math.max(1, Math.floor(maxQueries));
  if (queries.length <= count) return queries;
  if (count === 1) return [queries[Math.floor((queries.length - 1) / 2)]];
  return Array.from({ length: count }, (_, index) =>
    queries[Math.round(index * (queries.length - 1) / (count - 1))]);
}

export function selectVaultContextByTopic(
  index: VaultKnowledgeIndex,
  source: string,
  limit: number,
  folderScope?: string,
): NoteItem[] {
  const maxNotes = Math.max(0, Math.floor(limit));
  if (!maxNotes) return [];
  const queries = sourceRetrievalQueries(source);
  if (!queries.length) return [];

  const ranked = queries.map((query) =>
    rankVaultContext(index, query, folderScope).filter(({ score }) => score > 0).slice(0, 4));
  const selected: NoteItem[] = [];
  const seen = new Set<string>();
  // One candidate per source piece first; only then add alternatives. This
  // preserves coverage when a long conversation returns to one topic often.
  for (let rank = 0; rank < 4 && selected.length < maxNotes; rank++) {
    for (const candidates of ranked) {
      const candidate = candidates[rank]?.note;
      if (!candidate || seen.has(candidate.path)) continue;
      selected.push(candidate);
      seen.add(candidate.path);
      if (selected.length >= maxNotes) break;
    }
  }
  return selected;
}
