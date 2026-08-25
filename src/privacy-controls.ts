import type { VaultKnowledgeIndex, NoteItem } from "./vault-indexer";

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
  const terms = new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}/g) ?? []);
  const notes: NoteItem[] = [];
  const visit = (node: VaultKnowledgeIndex["tree"]) => {
    notes.push(...node.notes);
    node.subfolders.forEach(visit);
  };
  visit(index.tree);
  return notes.map((note) => {
    const text = `${note.title} ${note.path} ${note.about} ${(note.topics ?? []).join(" ")}`.toLowerCase();
    return { note, score: [...terms].reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime).slice(0, Math.max(0, limit)).map(({ note }) => note);
}
