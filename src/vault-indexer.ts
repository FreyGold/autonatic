import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { NemotronPluginSettings } from "./settings";
import { isExcludedPath, parseExcludedFolders } from "./privacy-controls";
import { streamChatCompletion } from "./api";
import { getGenerationApiKey, getGenerationConfig } from "./providers";
import { promptDataBlock, PROMPT_DATA_GUIDELINES, REASONING_EXPLANATION_GUIDELINES, STE_INSPIRED_WRITING_GUIDELINES } from "./prompts";
import { isRecord, stringArray, stringValue } from "./type-guards";

export interface NoteItem {
  title: string;
  path: string;
  mtime: number;
  tags: string[];
  topics?: string[];
  about: string;
}

export interface FolderNode {
  name: string;
  path: string;
  about: string;
  topics?: string[];
  notes: NoteItem[];
  subfolders: FolderNode[];
}

export interface VaultKnowledgeIndex {
  version: number;
  lastUpdated: number;
  vaultName: string;
  totalNotes: number;
  totalFolders: number;
  tree: FolderNode;
}

export interface SmartPlacementDecision {
  action: "create_new_note" | "append_to_note";
  targetFolder?: string;
  targetNotePath?: string;
  title?: string;
  reason: string;
}

export interface AtomicNoteItem {
  action: "create_new_note" | "append_to_note";
  targetFolder?: string;
  topicFolder?: string;
  folderStrategy?: "root" | "existing_subfolder" | "new_subfolder";
  targetNotePath?: string;
  title: string;
  reason: string;
  content: string;
}

export const VAULT_INDEX_FILENAME = "vault-index.json";
export const LEGACY_VAULT_INDEX_FILENAME = ".nemotron-vault-index.json";

export function vaultIndexPath(app: App): string {
  return normalizePath(`${app.vault.configDir}/plugins/autonatic/${VAULT_INDEX_FILENAME}`);
}

export async function migrateVaultIndexStorage(app: App): Promise<void> {
  const adapter = app.vault.adapter;
  const target = vaultIndexPath(app);
  const hasLegacyIndex = await adapter.exists(LEGACY_VAULT_INDEX_FILENAME);
  if (await adapter.exists(target)) {
    if (hasLegacyIndex) await adapter.remove(LEGACY_VAULT_INDEX_FILENAME);
    return;
  }
  if (!hasLegacyIndex) return;
  const raw = await adapter.read(LEGACY_VAULT_INDEX_FILENAME);
  await adapter.write(target, raw);
  await adapter.remove(LEGACY_VAULT_INDEX_FILENAME);
}

/**
 * Extracts a structural outline & metadata from a note file
 */
export async function extractNoteStructure(
  app: App,
  file: TFile
): Promise<{ title: string; tags: string[]; headings: string[]; summary: string; rawExcerpt: string }> {
  let title = file.basename;
  const tags: string[] = [];
  const headings: string[] = [];
  let summary = "";
  let rawExcerpt = "";

  const cache = app.metadataCache.getFileCache(file);
  if (cache?.frontmatter) {
    const fm = cache.frontmatter;
    if (fm.title && typeof fm.title === "string") title = fm.title.trim();
    if (fm.summary && typeof fm.summary === "string") summary = fm.summary.trim();
    if (Array.isArray(fm.tags)) {
      fm.tags.forEach((t: unknown) => {
        if (typeof t === "string") tags.push(t);
      });
    } else if (typeof fm.tags === "string") {
      fm.tags.split(",").forEach((t: string) => tags.push(t.trim()));
    }
  }

  if (cache?.headings) {
    for (const h of cache.headings) {
      if (h.heading) headings.push(h.heading);
    }
  }

  try {
    const content = await app.vault.read(file);
    const bodyWithoutYaml = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
    rawExcerpt = bodyWithoutYaml.slice(0, 800).replace(/[*_#`[\]]/g, " ").replace(/\s+/g, " ").trim();

    if (!summary) {
      const calloutMatch = content.match(/>\s*\[!(?:summary|info|abstract|note)\][^\n\r]*\r?\n((?:>[^\n\r]*\r?\n?)+)/i);
      if (calloutMatch) {
        summary = calloutMatch[1]
          .split("\n")
          .map((l) => l.replace(/^>\s*/, "").replace(/\*\*/g, "").trim())
          .filter((l) => l.length > 0)
          .join(" ");
      }
    }
  } catch {
    // A temporarily unreadable note still contributes its cached metadata.
  }

  return { title, tags, headings, summary, rawExcerpt };
}

/**
 * Helper to call Nemotron API for semantic batch analysis
 */
async function callNemotronJson(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string
): Promise<unknown> {
  const config = getGenerationConfig(settings);
  const response = await streamChatCompletion({ ...settings, apiKey: config.apiKey, baseUrl: config.baseUrl,
    model: config.model, temperature: 0.2, maxTokens: 3000 },
  systemPrompt, userPrompt);
  const content = response.content;
  const jsonMatch = content.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/) || [null, content];
  return JSON.parse((jsonMatch[1] || content).trim()) as unknown;
}

/**
 * Loads the existing index from the plugin data directory.
 */
export async function loadVaultIndex(app: App): Promise<VaultKnowledgeIndex | null> {
  try {
    const adapter = app.vault.adapter;
    const currentPath = vaultIndexPath(app);
    const path = await adapter.exists(currentPath)
      ? currentPath
      : await adapter.exists(LEGACY_VAULT_INDEX_FILENAME)
      ? LEGACY_VAULT_INDEX_FILENAME
      : "";
    if (path) {
      const raw = await adapter.read(path);
      return JSON.parse(raw) as VaultKnowledgeIndex;
    }
  } catch (err) {
    console.warn("Failed to load vault index:", err);
  }
  return null;
}

/**
 * Deep AI Knowledge Tree Indexer:
 * Builds a clean, true hierarchical JSON tree of folders and notes.
 * Every note is stored directly inside its containing folder node.
 */
export async function buildOrUpdateVaultIndex(
  app: App,
  settings?: NemotronPluginSettings,
  onProgress?: (current: number, total: number, statusText: string) => void
): Promise<VaultKnowledgeIndex> {
  const adapter = app.vault.adapter;
  const existingIndex = await loadVaultIndex(app);

  // Collect previous note cache for fast incremental updates
  const existingNotesMap = new Map<string, NoteItem>();
  if (existingIndex?.tree) {
    const collectExisting = (node: FolderNode) => {
      if (Array.isArray(node.notes)) {
        for (const n of node.notes) {
          existingNotesMap.set(n.path, n);
        }
      }
      if (Array.isArray(node.subfolders)) {
        for (const sub of node.subfolders) {
          collectExisting(sub);
        }
      }
    };
    collectExisting(existingIndex.tree);
  }

  const now = Date.now();
  const excluded = parseExcludedFolders(settings?.excludedFolders ?? "");
  const mdFiles = app.vault.getMarkdownFiles().filter((f) => !f.name.startsWith(".") && !isExcludedPath(f.path, excluded));
  const totalFiles = mdFiles.length;

  const analyzedNotesMap = new Map<string, NoteItem>();
  const notesToAnalyzeWithAI: { file: TFile; structure: Awaited<ReturnType<typeof extractNoteStructure>> }[] = [];

  // Phase 1: Structural Extraction
  if (onProgress) onProgress(0, totalFiles, `Reading note structures (0/${totalFiles})...`);

  for (let i = 0; i < totalFiles; i++) {
    const file = mdFiles[i];
    const cached = existingNotesMap.get(file.path);

    if (cached && cached.mtime === file.stat.mtime && cached.about && cached.about.length > 20) {
      analyzedNotesMap.set(file.path, cached);
      continue;
    }

    const structure = await extractNoteStructure(app, file);

    let about = structure.summary;
    if (!about && structure.headings.length > 0) {
      about = `Covers ${structure.headings.slice(0, 4).join(", ")}. ${structure.rawExcerpt.slice(0, 100)}`;
    } else if (!about) {
      about = structure.rawExcerpt.slice(0, 160) || `Topic note covering ${file.basename}`;
    }

    const noteItem: NoteItem = {
      title: structure.title,
      path: file.path,
      mtime: file.stat.mtime,
      tags: structure.tags,
      about,
    };

    analyzedNotesMap.set(file.path, noteItem);
    notesToAnalyzeWithAI.push({ file, structure });

    if (onProgress && (i % 20 === 0 || i === totalFiles - 1)) {
      onProgress(i + 1, totalFiles, `Reading note structures (${i + 1}/${totalFiles})...`);
    }

    if (i % 40 === 0) {
      await new Promise((r) => window.setTimeout(r, 0));
    }
  }

  // Phase 2: Deep AI Semantic Analysis (if API key available)
  if (settings?.allowRemoteVaultIndexing && getGenerationApiKey(settings) && notesToAnalyzeWithAI.length > 0) {
    const BATCH_SIZE = 6;
    const totalAiBatches = Math.ceil(notesToAnalyzeWithAI.length / BATCH_SIZE);

    for (let b = 0; b < totalAiBatches; b++) {
      const batch = notesToAnalyzeWithAI.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      if (onProgress) {
        onProgress(
          b + 1,
          totalAiBatches,
          `AI Semantic Analysis: Batch ${b + 1}/${totalAiBatches} (${batch.length} notes)...`
        );
      }

      const promptPayload = batch.map((item) => ({
        path: item.file.path,
        title: item.structure.title,
        folder: item.file.parent?.path || "Root",
        headings: item.structure.headings.slice(0, 5),
        excerpt: item.structure.rawExcerpt.slice(0, 300),
      }));

      const systemPrompt = `Summarize the supplied note metadata from an Obsidian vault.
Use only the provided title, headings, and excerpt. Do not invent a note's contents, examples, or scope. Describe partial evidence without implying that the complete note was read.
For EACH note, return a JSON array containing:
- "path": exact note path
- "about": concise, 1-2 sentence semantic summary of what this note discusses, its technical scope, and core knowledge
- "topics": array of 2-5 core concept tags/topics (e.g. ["error-handling", "control-flow", "go"])

Output ONLY a JSON array of objects.

${PROMPT_DATA_GUIDELINES}

${STE_INSPIRED_WRITING_GUIDELINES}

${REASONING_EXPLANATION_GUIDELINES}`;

      try {
        const responseData = await callNemotronJson(
          settings,
          systemPrompt,
          promptDataBlock("note-metadata", JSON.stringify(promptPayload))
        );

        if (Array.isArray(responseData)) {
          for (const resItem of responseData) {
            if (isRecord(resItem) && typeof resItem.path === "string" && analyzedNotesMap.has(resItem.path)) {
              const noteObj = analyzedNotesMap.get(resItem.path)!;
              if (typeof resItem.about === "string") noteObj.about = resItem.about.trim();
              const topics = stringArray(resItem.topics);
              if (topics.length) noteObj.topics = topics;
            }
          }
        }
      } catch (err) {
        console.warn("AI Semantic batch analysis warning:", err);
      }

      await new Promise((r) => window.setTimeout(r, 100));
    }
  }

  // Phase 3: Discover all folders & Build True Recursive Tree
  if (onProgress) onProgress(totalFiles, totalFiles, "Building hierarchical folder & note tree...");

  const allFoldersMap = new Map<string, TFolder>();
  const collectFolders = (folder: TFolder) => {
    if (folder.name.startsWith(".")) return;
    const path = folder.path === "/" ? "" : folder.path;
    allFoldersMap.set(path, folder);
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        collectFolders(child);
      }
    }
  };

  const rootFolder = app.vault.getRoot();
  collectFolders(rootFolder);

  let totalFolderCount = 0;

  const buildTree = (folderPath: string): FolderNode => {
    totalFolderCount++;
    const isRoot = folderPath === "";
    const folderName = isRoot ? "Vault Root" : folderPath.split("/").pop() || folderPath;

    // Get direct notes located in this folder
    const folderNotes: NoteItem[] = [];
    const collectedTopics = new Set<string>();

    for (const [filePath, noteItem] of analyzedNotesMap.entries()) {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const noteFolder = file.parent ? (file.parent.path === "/" ? "" : file.parent.path) : "";
        if (noteFolder === folderPath) {
          folderNotes.push(noteItem);
          if (noteItem.topics) {
            noteItem.topics.forEach((t) => collectedTopics.add(t));
          }
        }
      }
    }

    folderNotes.sort((a, b) => a.title.localeCompare(b.title));

    // Get direct subfolders
    const subfolderNodes: FolderNode[] = [];
    for (const [subPath, subObj] of allFoldersMap.entries()) {
      if (subPath === folderPath) continue;
      const parentPath = subObj.parent ? (subObj.parent.path === "/" ? "" : subObj.parent.path) : "";
      if (parentPath === folderPath) {
        subfolderNodes.push(buildTree(subPath));
      }
    }

    subfolderNodes.sort((a, b) => a.name.localeCompare(b.name));

    // Collect subfolder topics as well
    for (const sub of subfolderNodes) {
      if (sub.topics) {
        sub.topics.forEach((t) => collectedTopics.add(t));
      }
    }

    // Generate folder "about" summary
    let folderAbout = "";
    if (isRoot) {
      folderAbout = "Top-level vault directory containing root notes and domain categories.";
    } else {
      const topicList = Array.from(collectedTopics);
      const noteTitles = folderNotes.map((n) => n.title).slice(0, 5);

      if (topicList.length > 0) {
        folderAbout = `Dedicated to ${folderName}. Topics: ${topicList.slice(0, 6).join(", ")}. Notes: ${noteTitles.join(", ")}.`;
      } else if (noteTitles.length > 0) {
        folderAbout = `Dedicated to ${folderName}. Notes: ${noteTitles.join(", ")}.`;
      } else {
        folderAbout = `Folder dedicated to ${folderName} documentation and notes.`;
      }
    }

    const topicsArr = Array.from(collectedTopics);

    return {
      name: folderName,
      path: folderPath,
      about: folderAbout,
      topics: topicsArr,
      notes: folderNotes,
      subfolders: subfolderNodes,
    };
  };

  const tree = buildTree("");

  const fullIndex: VaultKnowledgeIndex = {
    version: 2,
    lastUpdated: now,
    vaultName: app.vault.getName(),
    totalNotes: analyzedNotesMap.size,
    totalFolders: totalFolderCount,
    tree,
  };

  // Phase 4: Save inside the plugin data directory, never at vault root.
  try {
    const jsonStr = JSON.stringify(fullIndex, null, 2);
    await adapter.write(vaultIndexPath(app), jsonStr);
    if (await adapter.exists(LEGACY_VAULT_INDEX_FILENAME)) {
      await adapter.remove(LEGACY_VAULT_INDEX_FILENAME);
    }
  } catch (err) {
    console.error("Failed to write the Autonatic vault index:", err);
  }

  return fullIndex;
}

/**
 * Formats the vault knowledge tree into a clean, true nested hierarchy
 * where every note is clearly listed under its parent folder directory.
 */
export function formatVaultTreeForAI(index: VaultKnowledgeIndex): string {
  const lines: string[] = [];

  const traverse = (node: FolderNode, indent: string = "") => {
    const isRoot = node.path === "";
    const folderDisplay = isRoot ? "📁 [Vault Root]" : `📁 ${node.path}/`;
    const folderAbout = node.about ? ` (About: ${node.about})` : "";
    lines.push(`${indent}${folderDisplay}${folderAbout}`);

    // Direct notes in this folder listed right under it
    if (Array.isArray(node.notes)) {
      for (const note of node.notes) {
        const topicTags = note.topics && note.topics.length > 0 ? ` [Topics: ${note.topics.join(", ")}]` : "";
        lines.push(`${indent}  📄 "${note.title}" (path: "${note.path}") - ${note.about}${topicTags}`);
      }
    }

    // Direct subfolders nested below
    if (Array.isArray(node.subfolders)) {
      for (const sub of node.subfolders) {
        traverse(sub, indent + "  ");
      }
    }
  };

  if (index.tree) {
    traverse(index.tree);
  }
  return lines.join("\n");
}

/**
 * Parses the AI smart placement decision header from the response (Single Note)
 */
export function extractSmartDecision(content: string): {
  decision: SmartPlacementDecision | null;
  cleanedContent: string;
} {
  const toDecision = (value: unknown): SmartPlacementDecision | null => {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.action !== "create_new_note" && candidate.action !== "append_to_note") return null;
    if (typeof candidate.reason !== "string" || !candidate.reason.trim()) return null;

    const readOptionalString = (key: string): string | undefined => {
      const field = candidate[key];
      return typeof field === "string" && field.trim() ? field.trim() : undefined;
    };

    const decision: SmartPlacementDecision = {
      action: candidate.action,
      reason: candidate.reason.trim(),
      targetFolder: readOptionalString("targetFolder"),
      targetNotePath: readOptionalString("targetNotePath"),
      title: readOptionalString("title"),
    };

    if (decision.action === "append_to_note" && !decision.targetNotePath) return null;
    return decision;
  };

  const match = content.match(/```(?:smart-decision|json:smart-decision)\s*\r?\n([\s\S]*?)\r?\n```/);
  if (match) {
    try {
      const decisionObj = toDecision(JSON.parse(match[1]));
      if (!decisionObj) throw new Error("Invalid smart decision fields.");
      const cleaned = content.replace(/```(?:smart-decision|json:smart-decision)\s*\r?\n[\s\S]*?\r?\n```\s*/, "").trim();
      return { decision: decisionObj, cleanedContent: cleaned };
    } catch (e) {
      console.warn("Failed to parse smart decision block:", e);
    }
  }

  // Support responses from versions that requested a plain-text decision block.
  const legacyMatch = content.match(/---\s*SMART DECISION\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*END DECISION\s*---/i);
  if (legacyMatch) {
    const fields = new Map<string, string>();
    for (const line of legacyMatch[1].split(/\r?\n/)) {
      const fieldMatch = line.match(/^\s*(Action|Target|Folder|Title|Reason):\s*(.*?)\s*$/i);
      if (fieldMatch) {
        fields.set(fieldMatch[1].toLowerCase(), fieldMatch[2].replace(/^["']|["']$/g, "").trim());
      }
    }

    const decisionObj = toDecision({
      action: fields.get("action"),
      targetNotePath: fields.get("target"),
      targetFolder: fields.get("folder"),
      title: fields.get("title"),
      reason: fields.get("reason"),
    });
    if (decisionObj) {
      return {
        decision: decisionObj,
        cleanedContent: content.replace(legacyMatch[0], "").trim(),
      };
    }
  }

  const rawJsonMatch = content.match(/\{\s*"action":\s*"(create_new_note|append_to_note)"[\s\S]*?"reason":\s*"[^"]+"\s*\}/);
  if (rawJsonMatch) {
    try {
      const decisionObj = toDecision(JSON.parse(rawJsonMatch[0]));
      if (!decisionObj) throw new Error("Invalid smart decision fields.");
      const cleaned = content.replace(rawJsonMatch[0], "").trim();
      return { decision: decisionObj, cleanedContent: cleaned };
    } catch {
      // The fallback parser below handles malformed embedded JSON.
    }
  }

  return { decision: null, cleanedContent: content };
}

/**
 * Bulletproof Multi-Note Atomic Decomposition Parser
 * Supports both Delimiter-based blocks (zero JSON escape errors) and JSON plans.
 */
export function extractAtomicDecompositionPlan(rawContent: string): AtomicNoteItem[] {
  const results: AtomicNoteItem[] = [];

  // 1. Primary: Delimiter-Based Block Parsing (=== ATOMIC NOTE === ... === END NOTE ===)
  const blockRegex = /===\s*(?:START\s+)?ATOMIC NOTE(?:\s+\d+)?\s*===([\s\S]*?)(?:===\s*END (?:ATOMIC )?NOTE(?:\s+\d+)?\s*===|$)/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(rawContent)) !== null) {
    const blockBody = blockMatch[1].trim();
    if (!blockBody) continue;

    const actionMatch = blockBody.match(/Action:\s*(append_to_note|create_new_note)/i);
    const targetPathMatch = blockBody.match(/(?:TargetNotePath|Target Note|Target):\s*([^\n\r]+)/i);
    const folderMatch = blockBody.match(/(?:TargetFolder|Folder):\s*([^\n\r]+)/i);
    const topicFolderMatch = blockBody.match(/(?:TopicFolder|Topic):\s*([^\n\r]+)/i);
    const folderStrategyMatch = blockBody.match(/Placement:\s*(root|existing_subfolder|new_subfolder)/i);
    const titleMatch = blockBody.match(/Title:\s*([^\n\r]+)/i);
    const reasonMatch = blockBody.match(/Reason:\s*([^\n\r]+)/i);

    const contentSplitMatch = blockBody.match(
      /^(?:---+\s*CONTENT\b[^\r\n]*|Content:\s*)\r?\n([\s\S]*)$/im,
    );
    const content = contentSplitMatch ? contentSplitMatch[1].trim() : blockBody;

    const action = actionMatch ? (actionMatch[1].toLowerCase() as "create_new_note" | "append_to_note") : (targetPathMatch ? "append_to_note" : "create_new_note");
    const targetNotePath = targetPathMatch ? targetPathMatch[1].trim().replace(/^["']|["']$/g, "") : undefined;
    const targetFolder = folderMatch ? folderMatch[1].trim().replace(/^["']|["']$/g, "") : "";
    let title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : "";

    if (!title && targetNotePath) {
      title = targetNotePath.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
    }

    results.push({
      action,
      targetFolder: normalizeFolderPath(targetFolder),
      topicFolder: normalizeFolderPath(topicFolderMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || ""),
      folderStrategy: folderStrategyMatch?.[1]?.toLowerCase() as AtomicNoteItem["folderStrategy"],
      targetNotePath,
      title: title || "Synthesized Note",
      reason: reasonMatch ? reasonMatch[1].trim() : "Decomposed topic piece",
      content,
    });
  }

  if (results.length > 0) {
    return results;
  }

  // 2. Secondary: JSON Array / ```atomic-plan Parser with relaxed control char sanitization
  const planMatch = rawContent.match(/```(?:atomic-plan|json:atomic-plan|json)\s*\r?\n([\s\S]*?)\r?\n```/) || [null, rawContent];
  const candidateJson = planMatch[1] ? planMatch[1].trim() : rawContent.trim();

  const arrayStart = candidateJson.indexOf("[");
  const arrayEnd = candidateJson.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    const rawArrayStr = candidateJson.slice(arrayStart, arrayEnd + 1);
    try {
      const items = JSON.parse(rawArrayStr) as unknown;
      if (Array.isArray(items) && items.length > 0) {
        return items.filter(isRecord).map((it) => {
          const strategy = it.folderStrategy ?? it.placement;
          const folderStrategy = strategy === "root" || strategy === "existing_subfolder" || strategy === "new_subfolder"
            ? strategy : undefined;
          return {
            action: it.action === "append_to_note" ? "append_to_note" : "create_new_note",
            targetFolder: normalizeFolderPath(stringValue(it.targetFolder)),
            topicFolder: normalizeFolderPath(stringValue(it.topicFolder ?? it.topic)),
            folderStrategy,
            targetNotePath: typeof it.targetNotePath === "string" ? it.targetNotePath : undefined,
            title: stringValue(it.title, "Synthesized Note"),
            reason: stringValue(it.reason),
            content: stringValue(it.content),
          };
        });
      }
    } catch {
      const objRegex = /\{\s*"action"\s*:\s*"(append_to_note|create_new_note)"[\s\S]*?"content"\s*:\s*"([\s\S]*?)"\s*\}/g;
      let objMatch: RegExpExecArray | null;
      while ((objMatch = objRegex.exec(rawArrayStr)) !== null) {
        try {
          const action = objMatch[1] as "append_to_note" | "create_new_note";
          const fullObjStr = objMatch[0];
          const targetNoteMatch = fullObjStr.match(/"targetNotePath"\s*:\s*"([^"]+)"/);
          const targetFolderMatch = fullObjStr.match(/"targetFolder"\s*:\s*"([^"]+)"/);
          const topicFolderMatch = fullObjStr.match(/"(?:topicFolder|topic)"\s*:\s*"([^"]+)"/i);
          const folderStrategyMatch = fullObjStr.match(/"(?:folderStrategy|placement)"\s*:\s*"(root|existing_subfolder|new_subfolder)"/i);
          const titleMatch = fullObjStr.match(/"title"\s*:\s*"([^"]+)"/);
          const reasonMatch = fullObjStr.match(/"reason"\s*:\s*"([^"]+)"/);

          let unescapedContent = objMatch[2]
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");

          results.push({
            action,
            targetFolder: normalizeFolderPath(targetFolderMatch ? targetFolderMatch[1] : ""),
            topicFolder: normalizeFolderPath(topicFolderMatch ? topicFolderMatch[1] : ""),
            folderStrategy: folderStrategyMatch?.[1]?.toLowerCase() as AtomicNoteItem["folderStrategy"],
            targetNotePath: targetNoteMatch ? targetNoteMatch[1] : undefined,
            title: titleMatch ? titleMatch[1] : "Synthesized Note",
            reason: reasonMatch ? reasonMatch[1] : "",
            content: unescapedContent,
          });
        } catch {
          // Ignore one malformed object and continue scanning the remaining plan.
        }
      }
      if (results.length > 0) return results;
    }
  }

  // 3. Fallback: Single smart decision note
  const { decision, cleanedContent } = extractSmartDecision(rawContent);
  if (decision) {
    return [
      {
        action: decision.action,
        targetFolder: decision.targetFolder,
        targetNotePath: decision.targetNotePath,
        title: decision.title || "Synthesized Note",
        reason: decision.reason,
        content: cleanedContent,
      },
    ];
  }

  return [
    {
      action: "create_new_note",
      title: "Synthesized Note",
      reason: "Direct creation",
      content: rawContent,
    },
  ];
}

/**
 * Normalizes folder path to ensure max depth of 2 (e.g. "Cat1/Cat2")
 */
export function enforceMaxDepthFolder(folderPath?: string, maxDepth: number = 2): string {
  const cleaned = normalizeFolderPath(folderPath);
  const segments = cleaned.split("/").filter((s) => s.trim().length > 0);
  const capped = segments.slice(0, maxDepth);
  return capped.join("/");
}

function normalizeFolderPath(folderPath?: string): string {
  if (!folderPath) return "";
  const cleaned = normalizePath(folderPath).replace(/^\/+|\/+$/g, "");
  return !cleaned || cleaned === "." || cleaned === "/" ? "" : cleaned;
}
