import { App, TFile, normalizePath } from "obsidian";
import type { NemotronPluginSettings } from "./settings";
import type { FileSnapshot } from "./history-manager";
import { streamChatCompletion, StreamCallbacks } from "./api";
import { DiagramEngine, DiagramOptions, DiagramSynthesisRequest } from "./diagram-engine";

export const DIAGRAM_RENDERER_VERSION = 5;

function createDiagramEngine(settings: NemotronPluginSettings, callbacks?: StreamCallbacks): DiagramEngine {
  return new DiagramEngine({
    synthesize: async (request: DiagramSynthesisRequest, signal?: AbortSignal) => {
      callbacks?.onStatus?.(`Designing a clear ${request.type.replace(/-/g, " ")}...`);
      const systemPrompt = `You turn a source note into a sparse visual diagram.
Return JSON only. Do not use Markdown fences.
Requested type: "${request.type}".
Maximum nodes: ${request.maxNodes}.

Schema:
{
  "type": "mind-map|flowchart|architecture|timeline|decision-tree|comparison",
  "title": "short title",
  "subtitle": "optional purpose",
  "groups": [{"id":"stable-id","title":"group title"}],
  "nodes": [{
    "id":"unique-stable-id",
    "title":"2 to 5 words",
    "details":["one short fact"],
    "kind":"concept|process|decision|data|warning|result",
    "importance":1,
    "groupId":"optional-group-id",
    "sourceHeading":"optional exact source heading"
  }],
  "edges": [{"from":"node-id","to":"node-id","label":"1 to 3 words","kind":"normal|error|optional"}],
  "takeaways":["short conclusion"]
}

Rules:
- Explain the structure. Do not copy the complete note.
- Use 6 to 10 nodes unless the source is very small.
- Use one detail per node. Omit details that repeat the title.
- Do not include code blocks or function bodies.
- Give each node no more than two incoming and two outgoing edges.
- Use exact node IDs for edge endpoints.
- Use decisions only for real conditions.
- A mind map has one root and short branches.
- A timeline follows chronological order.
- A comparison uses two or more groups.
- A flowchart has a clear start and result. Each decision has labeled outcome branches.
- Arrange a flowchart for a wide desktop canvas. Keep the main path concise.
- Avoid generic labels such as Core Idea, Processing Pipeline, or Key Details.`;
      const userPrompt = `Title: ${request.title}\n\nSource note:\n${request.content.slice(0, 9000)}`;
      const result = await streamChatCompletion(settings, systemPrompt, userPrompt, callbacks, signal);
      const match = result.content.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/);
      return JSON.parse((match?.[1] ?? result.content).trim());
    },
  });
}

async function ensureFolder(app: App, target: string): Promise<string[]> {
  const created: string[] = [];
  let current = "";
  for (const segment of target.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    const path = normalizePath(current);
    if (!app.vault.getAbstractFileByPath(path)) {
      await app.vault.createFolder(path);
      created.push(path);
    }
  }
  return created;
}

function drawingContent(json: string, sourceNotePath?: string, sourceTitle?: string): string {
  const linkedNote = sourceNotePath
    ? `> [!info] Source note\n> [[${sourceNotePath}|${sourceTitle || sourceNotePath}]]\n\n`
    : "";
  return `---
excalidraw-plugin: parsed
nemotron-renderer: ${DIAGRAM_RENDERER_VERSION}
tags: [ea/drawing, excalidraw, diagram]
---
==Decompressed Markdown File==
${linkedNote}# Drawing
\`\`\`json
${json}
\`\`\`
%%
# Text Elements
%%
`;
}

export async function createMirroredExcalidrawDrawing(
  app: App,
  settings: NemotronPluginSettings,
  noteFile: TFile,
  noteContent: string,
  rootExcalidrawFolder = "Excalidrawings",
  callbacks?: StreamCallbacks,
  signal?: AbortSignal,
  diagramOptions?: Partial<DiagramOptions>
): Promise<{ drawingPath: string; drawingFile: TFile; foldersCreated: string[]; fileSnapshot: FileSnapshot }> {
  const noteDirectory = noteFile.parent?.path === "/" ? "" : noteFile.parent?.path || "";
  const targetDirectory = normalizePath(noteDirectory ? `${rootExcalidrawFolder}/${noteDirectory}` : rootExcalidrawFolder);
  const foldersCreated = await ensureFolder(app, targetDirectory);
  const result = await createDiagramEngine(settings, callbacks).generate(
    { title: noteFile.basename, content: noteContent, sourceNotePath: noteFile.path },
    diagramOptions,
    signal
  );
  const content = drawingContent(result.excalidrawJson, noteFile.path, noteFile.basename);
  const drawingPath = normalizePath(`${targetDirectory}/${noteFile.basename}.excalidraw.md`);
  const existing = app.vault.getAbstractFileByPath(drawingPath);
  let drawingFile: TFile;
  let fileSnapshot: FileSnapshot;
  if (existing instanceof TFile) {
    const previousContent = await app.vault.read(existing);
    await app.vault.modify(existing, content);
    drawingFile = existing;
    fileSnapshot = { path: drawingPath, isNewFile: false, previousContent, newContent: content };
  } else {
    drawingFile = await app.vault.create(drawingPath, content);
    fileSnapshot = { path: drawingPath, isNewFile: true, newContent: content };
  }
  return { drawingPath, drawingFile, foldersCreated, fileSnapshot };
}

export async function createStandaloneRichExcalidrawDrawing(
  app: App,
  settings: NemotronPluginSettings,
  title: string,
  content: string,
  targetFolder = "Excalidrawings",
  sourceNotePath?: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal,
  diagramOptions?: Partial<DiagramOptions>
): Promise<{ drawingPath: string; drawingFile: TFile; foldersCreated: string[]; fileSnapshot: FileSnapshot }> {
  const cleanFolder = normalizePath(targetFolder || "Excalidrawings");
  const foldersCreated = await ensureFolder(app, cleanFolder);
  const result = await createDiagramEngine(settings, callbacks).generate(
    { title, content, sourceNotePath },
    diagramOptions,
    signal
  );
  const fileContent = drawingContent(result.excalidrawJson, sourceNotePath);
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "Excalidraw Diagram";
  let drawingPath = normalizePath(`${cleanFolder}/${safeTitle}.excalidraw.md`);
  let counter = 1;
  while (app.vault.getAbstractFileByPath(drawingPath)) {
    drawingPath = normalizePath(`${cleanFolder}/${safeTitle} (${counter++}).excalidraw.md`);
  }
  const drawingFile = await app.vault.create(drawingPath, fileContent);
  return {
    drawingPath,
    drawingFile,
    foldersCreated,
    fileSnapshot: { path: drawingPath, isNewFile: true, newContent: fileContent },
  };
}
