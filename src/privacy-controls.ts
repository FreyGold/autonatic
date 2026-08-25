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

export function rankVaultContext(index: VaultKnowledgeIndex, query: string): RankedVaultNote[] {
  const queryTerms = searchTerms(query);
  const notes: NoteItem[] = [];
  const visit = (node: VaultKnowledgeIndex["tree"]) => {
    notes.push(...node.notes);
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

export function selectStrongRelatedNote(index: VaultKnowledgeIndex, query: string): NoteItem | null {
  const [best, second] = rankVaultContext(index, query);
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

export function selectVaultContext(index: VaultKnowledgeIndex, query: string, limit: number): NoteItem[] {
  return rankVaultContext(index, query).slice(0, Math.max(0, limit)).map(({ note }) => note);
}
