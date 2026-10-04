import { App, FileSystemAdapter, requestUrl, TFile } from "obsidian";
import type { NemotronPluginSettings } from "./settings";
import { isExcludedPath, isPathInFolder, parseExcludedFolders } from "./privacy-controls";
import { getEmbeddingConfig } from "./providers";

export interface SearchChunk {
  id: string;
  path: string;
  heading: string;
  text: string;
  vector: number[];
}

interface IndexedDocument { path: string; mtime: number; size: number; chunks: number; }
export interface AskIndexStatus { notes: number; chunks: number; busy: boolean; message: string; }
export interface AskSearchResult { sources: SearchChunk[]; }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local search storage failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Local search storage failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Local search storage was interrupted."));
  });
}

function dbName(app: App): string {
  const adapter = app.vault.adapter;
  const location = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : app.vault.getName();
  let hash = 2166136261;
  for (const char of location) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `autonatic-ask-notes-${(hash >>> 0).toString(16)}`;
}

function openDatabase(app: App): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Local search storage is unavailable in this Obsidian window."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(app), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("documents", { keyPath: "path" });
      const chunks = db.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("path", "path");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local search storage."));
    request.onblocked = () => reject(new Error("Close other Obsidian windows using this vault, then retry."));
  });
}

export function chunkMarkdown(path: string, markdown: string): Omit<SearchChunk, "vector">[] {
  const chunks: Omit<SearchChunk, "vector">[] = [];
  let heading = "";
  let section = "";
  const flush = () => {
    const body = section.trim();
    if (!body) return;
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + 1500, body.length);
      if (end < body.length) {
        const boundary = Math.max(body.lastIndexOf("\n", end), body.lastIndexOf(" ", end));
        if (boundary > start + 750) end = boundary;
      }
      const text = body.slice(start, end).trim();
      if (text) chunks.push({ id: `${path}\u0000${chunks.length}`, path, heading, text });
      if (end >= body.length) break;
      start = Math.max(start + 1, end - 180);
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      section = "";
    } else {
      section += `${line}\n`;
    }
  }
  flush();
  return chunks;
}

export function isAskNoteEligible(path: string, included: readonly string[], excluded: readonly string[]): boolean {
  return path.toLowerCase().endsWith(".md")
    && !path.split("/").some((part) => part.startsWith("."))
    && included.some((folder) => isPathInFolder(path, folder))
    && !isExcludedPath(path, [...excluded]);
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "about", "for", "how", "in", "is", "of", "the", "to", "what", "with",
  "i", "my", "me", "please", "can", "could", "would", "do", "does", "it", "this", "that",
]);

function tokens(text: string): string[] {
  // Split camelCase identifiers, but retain their complete spelling as well.
  const words = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set([...words(text), ...words(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))])];
}

function termForms(term: string): string[] {
  const forms = [term];
  // Whole-token inflections only: REPL must never match replace or replay.
  if (/^[a-z]+$/.test(term)) {
    if (term.length > 4 && term.endsWith("ies")) forms.push(term.slice(0, -3) + "y");
    else if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) forms.push(term.slice(0, -1));
    if (term.length > 5 && term.endsWith("ing")) forms.push(term.slice(0, -3), term.slice(0, -3) + "e");
    if (term.length > 4 && term.endsWith("ed")) forms.push(term.slice(0, -2), term.slice(0, -1));
  }
  return forms;
}

function tokenSet(text: string): Set<string> {
  return new Set(tokens(text).flatMap(termForms));
}

function searchTerms(query: string): string[] {
  const subject = query.replace(/^\s*(?:how\s+(?:do\s+i\s+|can\s+i\s+|to\s+))(?:make|build|create|implement|use)\s+/i, "");
  return tokens(subject).filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term));
}

function matchesTerm(text: Set<string>, term: string): boolean {
  return termForms(term).some((form) => text.has(form));
}

function hasStrongSearchMatch(sources: readonly SearchChunk[], question: string): boolean {
  // Only explicit identifier/term lookups take the offline shortcut. Word
  // overlap in a natural-language question is not evidence that it is answered.
  const lookup = question.trim();
  if (!/^[\p{L}\p{N}_.$:-]+$/u.test(lookup)) return false;
  const terms = searchTerms(lookup);
  return terms.length > 0 && sources.some((source) => {
    const text = tokenSet(`${source.path} ${source.heading} ${source.text}`);
    return terms.every((term) => matchesTerm(text, term));
  });
}

export function rankSearchChunks(chunks: readonly SearchChunk[], query: string, vector: readonly number[], limit = 6): SearchChunk[] {
  if (limit <= 0) return [];
  const terms = searchTerms(query);
  const queryNorm = Math.hypot(...vector);
  const validQuery = vector.length > 0 && Number.isFinite(queryNorm) && queryNorm > 0;
  const prepared = chunks.map((chunk) => ({
    chunk,
    title: tokenSet(chunk.path.split("/").pop()?.replace(/\.md$/i, "") ?? ""),
    heading: tokenSet(chunk.heading),
    body: tokenSet(chunk.text),
  }));
  // Count note frequency, not chunk frequency, so long notes do not distort IDF.
  const noteCount = new Set(chunks.map((chunk) => chunk.path)).size;
  const weights = terms.map((term) => {
    const notes = new Set(prepared.filter((item) =>
      matchesTerm(item.title, term) || matchesTerm(item.heading, term) || matchesTerm(item.body, term))
      .map((item) => item.chunk.path));
    return Math.log(1 + (noteCount + 1) / (notes.size + 1));
  });
  const scored = prepared.map(({ chunk, title, heading, body }) => {
    const lexical = terms.reduce((score, term, i) => score + weights[i] *
      (matchesTerm(title, term) ? 4 : matchesTerm(heading, term) ? 3 : matchesTerm(body, term) ? 1 : 0), 0);
    let semantic = -Infinity;
    if (validQuery && chunk.vector.length === vector.length && chunk.vector.every(Number.isFinite)) {
      const norm = Math.hypot(...chunk.vector);
      if (norm > 0 && Number.isFinite(norm)) {
        semantic = chunk.vector.reduce((dot, value, i) => dot + value * vector[i], 0) / (queryNorm * norm);
      }
    }
    return { chunk, lexical, semantic, fused: 0 };
  });
  const candidateLimit = Math.max(30, limit * 5);
  const lexical = scored.filter((item) => item.lexical > 0)
    .sort((a, b) => b.lexical - a.lexical || b.semantic - a.semantic).slice(0, candidateLimit);
  // A conservative noise guard, not a calibrated probability of relevance.
  // Keep lexical evidence independently, even when embeddings disagree.
  const semantic = scored.filter((item) => item.semantic >= 0.35)
    .sort((a, b) => b.semantic - a.semantic).slice(0, candidateLimit);
  // Weighted reciprocal-rank fusion replaces reserved keyword-first slots.
  lexical.forEach((item, i) => { item.fused += 2 / (60 + i + 1); });
  semantic.forEach((item, i) => { item.fused += 1 / (60 + i + 1); });
  const candidates = [...new Set([...lexical, ...semantic])]
    .sort((a, b) => b.fused - a.fused || b.lexical - a.lexical || b.semantic - a.semantic);
  const selected: SearchChunk[] = [];
  const perNote = new Map<string, number>();
  for (const item of candidates) {
    if (selected.length >= limit) break;
    if ((perNote.get(item.chunk.path) ?? 0) >= 2) continue;
    selected.push(item.chunk);
    perNote.set(item.chunk.path, (perNote.get(item.chunk.path) ?? 0) + 1);
  }
  return selected;
}

export class AskNotesSearch {
  private dbPromise?: Promise<IDBDatabase>;
  private running: Promise<void> | null = null;
  private rerun = false;
  private forceRebuild = false;
  private disposed = false;
  private message = "Not indexed";
  private listeners = new Set<(message: string) => void>();

  constructor(private app: App, private settings: () => NemotronPluginSettings) {
  }

  private async db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDatabase(this.app).catch((error) => {
      this.dbPromise = undefined;
      throw error;
    });
    return this.dbPromise;
  }

  subscribe(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private report(message: string): void {
    this.message = message;
    for (const listener of this.listeners) listener(message);
  }

  private eligibleFiles(): TFile[] {
    const settings = this.settings();
    const excluded = parseExcludedFolders(settings.excludedFolders);
    return this.app.vault.getMarkdownFiles().filter((file) =>
      isAskNoteEligible(file.path, settings.askNotesFolders, excluded));
  }

  private async embed(texts: string[], inputType: "passage" | "query"): Promise<number[][]> {
    const settings = this.settings();
    const config = getEmbeddingConfig(settings);
    if (!config.apiKey.trim()) throw new Error(`Add the ${config.provider} API key in settings first.`);
    if (!config.embeddingModel.trim()) throw new Error(`Fetch and select an embedding model for ${config.provider} in settings first.`);
    const storedProvider = settings.providers?.[config.provider];
    if (storedProvider && !storedProvider.availableEmbeddingModels.includes(config.embeddingModel)) {
      throw new Error(`Fetch ${config.provider} models in settings and select an available embedding model first.`);
    }
    const isGemini = config.provider === "gemini";
    const response = await requestUrl({
      url: isGemini
        ? `${config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(config.embeddingModel)}:batchEmbedContents`
        : `${config.baseUrl.replace(/\/+$/, "")}/embeddings`,
      method: "POST",
      headers: { "Content-Type": "application/json", ...(isGemini
        ? { "x-goog-api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` }) },
      body: JSON.stringify(isGemini
        ? { requests: texts.map((text) => ({ model: `models/${config.embeddingModel}`, content: { parts: [{ text }] }, taskType: inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" })) }
        : { model: config.embeddingModel, input: texts,
          ...(config.provider === "nvidia" ? { input_type: inputType, truncate: "NONE" } : {}), encoding_format: "float" }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${config.provider} embeddings failed (${response.status}): ${response.text}`);
    }
    const responseData = response.json as {
      embeddings?: Array<{ values: number[] }>;
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const items = isGemini
      ? responseData.embeddings?.map((item, index) => ({ embedding: item.values, index }))
      : responseData.data;
    if (!Array.isArray(items) || items.length !== texts.length) throw new Error(`${config.provider} returned incomplete embeddings.`);
    const vectors = items.sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((item: { embedding: number[] }) => item.embedding);
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || vectors.some((v: unknown) => !Array.isArray(v)
      || (v as number[]).length !== dimensions || !(v as number[]).every(Number.isFinite))) {
      throw new Error(`${config.provider} returned invalid embeddings.`);
    }
    return vectors;
  }

  async status(): Promise<AskIndexStatus> {
    const db = await this.db();
    const tx = db.transaction(["documents", "chunks"], "readonly");
    const [notes, chunks] = await Promise.all([
      requestResult(tx.objectStore("documents").count()),
      requestResult(tx.objectStore("chunks").count()),
    ]);
    return { notes, chunks, busy: !!this.running, message: this.message };
  }

  async clear(): Promise<void> {
    if (this.running) await this.running.catch(() => {});
    const db = await this.db();
    const tx = db.transaction(["documents", "chunks"], "readwrite");
    tx.objectStore("documents").clear();
    tx.objectStore("chunks").clear();
    await transactionDone(tx);
    this.report("Not indexed");
  }

  async rebuild(onProgress?: (message: string) => void): Promise<void> {
    if (this.running) await this.running.catch(() => {});
    this.forceRebuild = true;
    await this.sync(onProgress);
  }

  sync(onProgress?: (message: string) => void): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.syncOnce(onProgress);
      } while (this.rerun && !this.disposed);
    })().catch((error) => {
      this.report(error instanceof Error ? error.message : "Indexing failed");
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async syncOnce(onProgress?: (message: string) => void): Promise<void> {
    const settings = this.settings();
    if (!settings.askNotesEnabled || settings.askNotesPaused || !settings.askNotesFolders.length || this.disposed) return;
    const db = await this.db();
    const files = this.eligibleFiles();
    const eligible = new Set(files.map((file) => file.path));
    const existing = await requestResult(db.transaction("documents", "readonly").objectStore("documents").getAll()) as IndexedDocument[];
    for (const doc of existing) if (!eligible.has(doc.path)) await this.removeDocument(doc);
    const known = new Map(existing.map((doc) => [doc.path, doc]));
    for (let i = 0; i < files.length; i++) {
      if (!this.settings().askNotesEnabled || this.settings().askNotesPaused || this.disposed) return;
      const file = files[i];
      const old = known.get(file.path);
      if (!this.forceRebuild && old?.mtime === file.stat.mtime && old.size === file.stat.size) continue;
      const indexedMtime = file.stat.mtime;
      const indexedSize = file.stat.size;
      this.report(`Indexing ${i + 1} of ${files.length}: ${file.basename}`);
      onProgress?.(this.message);
      const content = await this.app.vault.read(file);
      const chunks = chunkMarkdown(file.path, content);
      const vectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += 8) {
        if (!this.settings().askNotesEnabled || this.settings().askNotesPaused || this.disposed) return;
        vectors.push(...await this.embed(chunks.slice(offset, offset + 8).map((chunk) =>
          `${file.basename}${chunk.heading ? ` — ${chunk.heading}` : ""}\n${chunk.text}`), "passage"));
      }
      // A note changed while requests were in flight; the next sync will index its new version.
      const current = this.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile) || current.stat.mtime !== indexedMtime || current.stat.size !== indexedSize
        || !isAskNoteEligible(file.path, this.settings().askNotesFolders, parseExcludedFolders(this.settings().excludedFolders))) {
        this.rerun = true;
        continue;
      }
      const tx = db.transaction(["documents", "chunks"], "readwrite");
      const chunkStore = tx.objectStore("chunks");
      for (let j = 0; j < (old?.chunks ?? 0); j++) chunkStore.delete(`${file.path}\u0000${j}`);
      chunks.forEach((chunk, j) => chunkStore.put({ ...chunk, vector: vectors[j] }));
      tx.objectStore("documents").put({ path: file.path, mtime: indexedMtime, size: indexedSize, chunks: chunks.length });
      await transactionDone(tx);
    }
    this.report(`Ready: ${files.length} notes`);
    this.forceRebuild = false;
    onProgress?.(this.message);
  }

  private async removeDocument(document: IndexedDocument): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["documents", "chunks"], "readwrite");
    const store = tx.objectStore("chunks");
    for (let i = 0; i < document.chunks; i++) store.delete(`${document.path}\u0000${i}`);
    tx.objectStore("documents").delete(document.path);
    await transactionDone(tx);
  }

  async ask(question: string, onStatus?: (message: string) => void, signal?: AbortSignal, onMatches?: (sources: SearchChunk[]) => void): Promise<AskSearchResult> {
    const settings = this.settings();
    if (!settings.askNotesEnabled || !settings.askNotesFolders.length) throw new Error("Choose folders and enable Ask Notes in settings first.");
    if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    if (!question.trim()) return { sources: [] };
    const db = await this.db();
    const [all, documents] = await Promise.all([
      requestResult(db.transaction("chunks", "readonly").objectStore("chunks").getAll()) as Promise<SearchChunk[]>,
      requestResult(db.transaction("documents", "readonly").objectStore("documents").getAll()) as Promise<IndexedDocument[]>,
    ]);
    const currentDocs = new Map(documents.map((doc) => [doc.path, doc]));
    const excluded = parseExcludedFolders(settings.excludedFolders);
    const chunks = all.filter((chunk) => {
      const file = this.app.vault.getAbstractFileByPath(chunk.path);
      const indexed = currentDocs.get(chunk.path);
      return isAskNoteEligible(chunk.path, settings.askNotesFolders, excluded)
        && file instanceof TFile && indexed?.mtime === file.stat.mtime && indexed?.size === file.stat.size;
    });
    if (!chunks.length) throw new Error("No indexed notes yet. Build the Ask Notes index in settings.");
    if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    const sourcesCurrent = (sources: SearchChunk[]) => this.settings().askNotesEnabled && sources.every((source) => {
      const file = this.app.vault.getAbstractFileByPath(source.path);
      const indexed = currentDocs.get(source.path);
      return isAskNoteEligible(source.path, this.settings().askNotesFolders, parseExcludedFolders(this.settings().excludedFolders))
        && file instanceof TFile && indexed?.mtime === file.stat.mtime && indexed?.size === file.stat.size;
    });
    const localSources = rankSearchChunks(chunks, question, []);
    if (!sourcesCurrent(localSources)) throw new Error("Search access or source notes changed. Try again.");
    onMatches?.(localSources);
    if (hasStrongSearchMatch(localSources, question) || !getEmbeddingConfig(this.settings()).apiKey.trim()) {
      return { sources: localSources };
    }

    onStatus?.(localSources.length ? "Showing text matches. Finding related passages…" : "Finding related passages…");
    let queryVector: number[];
    try {
      [queryVector] = await this.embed([question], "query");
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      if (!sourcesCurrent(localSources)) throw new Error("Search access or source notes changed. Try again.");
      if (localSources.length) {
        onStatus?.("Semantic search is unavailable. Showing text matches.");
        return { sources: localSources };
      }
      throw error;
    }
    if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    const sources = rankSearchChunks(chunks, question, queryVector);
    if (!sourcesCurrent(sources)) throw new Error("Search access or source notes changed. Try again.");
    return { sources };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    if (this.dbPromise) void this.dbPromise.then((db) => db.close()).catch(() => {});
  }
}
