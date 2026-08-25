import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import { extractSmartDecision } from "../src/vault-indexer";
import { HistoryManager, revertFileSnapshots } from "../src/history-manager";
import { NemotronModal } from "../src/modal";
import { createMirroredExcalidrawDrawing } from "../src/excalidraw-generator";
import { estimateRemoteRequests, isExcludedPath, parseExcludedFolders, selectVaultContext } from "../src/privacy-controls";
import { DiagramEngine } from "../src/diagram-engine";
import { buildUserPrompt } from "../src/prompts";

test("diagram engine selects a flowchart and repairs invalid model output", async () => {
  const engine = new DiagramEngine({
    synthesize: async () => ({
      title: "Release process",
      type: "flowchart",
      nodes: [
        { id: "build", title: "Build", details: ["Compile the project"], kind: "process" },
        { id: "build", title: "Publish", details: ["Upload the release"], kind: "result" },
      ],
      edges: [
        { from: "build", to: "missing", label: "then" },
        { from: "build", to: "build", label: "invalid loop" },
      ],
    }),
  });

  const result = await engine.generate(
    { title: "Release", content: "First build the project. Then publish the release." },
    { type: "auto", detail: "balanced", direction: "right", theme: "dark", maxNodes: 12 }
  );

  assert.equal(result.spec.type, "flowchart");
  assert.equal(new Set(result.spec.nodes.map((node) => node.id)).size, 2);
  assert.equal(result.spec.edges.length, 0);
  assert.match(result.excalidrawJson, /"type": "excalidraw"/);
});

test("comparison diagrams render visible group headings", async () => {
  const engine = new DiagramEngine({ synthesize: async () => ({
    type: "comparison",
    title: "Storage choices",
    groups: [{ id: "sql", title: "Relational option" }, { id: "doc", title: "Document option" }],
    nodes: [
      { id: "tables", title: "Tables", groupId: "sql", kind: "data" },
      { id: "documents", title: "Documents", groupId: "doc", kind: "data" },
    ],
    edges: [],
  }) });
  const result = await engine.generate({ title: "Storage", content: "Compare tables versus documents." }, { type: "comparison" });
  const scene = JSON.parse(result.excalidrawJson);
  const text = scene.elements.filter((element: { type: string }) => element.type === "text").map((element: { text: string }) => element.text);
  assert.ok(text.includes("Relational option"));
  assert.ok(text.includes("Document option"));
});

test("diagram takeaways remain visible on the canvas", async () => {
  const engine = new DiagramEngine({ synthesize: async () => ({
    type: "mind-map", title: "Caching", nodes: [{ id: "cache", title: "Cache" }, { id: "ttl", title: "Expiry" }],
    edges: [{ from: "cache", to: "ttl" }], takeaways: ["Expire stale entries before reuse"],
  }) });
  const result = await engine.generate({ title: "Caching", content: "Cache entries expire." }, { type: "mind-map" });
  assert.match(result.excalidrawJson, /Expire stale entries before reuse/);
});

test("balanced diagrams stay sparse enough to scan", async () => {
  const nodes = Array.from({ length: 16 }, (_, index) => ({
    id: `node-${index}`,
    title: `Processing stage ${index}`,
    details: ["First long implementation detail", "Second long implementation detail", "Third long implementation detail"],
    kind: "process",
  }));
  const engine = new DiagramEngine({ synthesize: async () => ({
    type: "flowchart", title: "Dense process", nodes,
    edges: nodes.slice(1).flatMap((node, index) => [
      { from: nodes[index].id, to: node.id },
      ...(index > 0 ? [{ from: nodes[index - 1].id, to: node.id }] : []),
    ]),
  }) });
  const result = await engine.generate({ title: "Dense", content: "First process, then continue." }, { detail: "balanced", maxNodes: 20 });
  assert.ok(result.spec.nodes.length <= 10);
  assert.ok(result.spec.nodes.every((node) => node.details.length <= 1));
  assert.ok(result.spec.edges.length <= 12);
});

test("diagram cards use readable text at normal zoom", async () => {
  const engine = new DiagramEngine();
  const result = await engine.generate({ title: "Parser", content: "First read input. Then validate data. Finally return a result." }, { type: "flowchart" });
  const scene = JSON.parse(result.excalidrawJson);
  const cardText = scene.elements.filter((element: { id: string; type: string }) => element.type === "text" && element.id.endsWith("-text") && !element.id.startsWith("diagram-"));
  assert.ok(cardText.length >= 2);
  assert.ok(cardText.every((element: { fontSize: number }) => element.fontSize >= 16));
});

test("flowcharts use a wide desktop layout by default", async () => {
  const ids = ["start", "read", "buffer", "parse", "validate", "error", "done"];
  const model = {
    type: "flowchart",
    title: "Request parser",
    nodes: ids.map((id) => ({ id, title: id, kind: id === "done" ? "result" : "process" })),
    edges: ids.slice(1).map((id, index) => ({ from: ids[index], to: id })),
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate(
    { title: "Request parser", content: "First read. Then parse. Finally return." },
    { type: "flowchart" },
  );
  const scene = JSON.parse(result.excalidrawJson);
  const cards = scene.elements.filter((element: { id: string }) => ids.includes(element.id));
  const width = Math.max(...cards.map((card: { x: number; width: number }) => card.x + card.width)) - Math.min(...cards.map((card: { x: number }) => card.x));
  const height = Math.max(...cards.map((card: { y: number; height: number }) => card.y + card.height)) - Math.min(...cards.map((card: { y: number }) => card.y));
  assert.ok(width > height * 2, `expected a wide layout, got ${width} by ${height}`);
});

test("parallel diagram cards never overlap", async () => {
  const model = {
    type: "architecture", title: "System",
    nodes: ["gateway", "worker", "database", "cache"].map((id) => ({ id, title: id, kind: "process" })),
    edges: [{ from: "gateway", to: "database" }, { from: "worker", to: "cache" }],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate({ title: "System", content: "gateway worker database cache" }, { type: "architecture", direction: "down" });
  const scene = JSON.parse(result.excalidrawJson);
  const cards = scene.elements.filter((element: { id: string }) => model.nodes.some((node) => node.id === element.id));
  for (let first = 0; first < cards.length; first++) {
    for (let second = first + 1; second < cards.length; second++) {
      const a = cards[first], b = cards[second];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `${a.id} overlaps ${b.id}`);
    }
  }
});

test("architecture group titles never stack on each other", async () => {
  const model = {
    type: "architecture",
    title: "Network stack",
    groups: [
      { id: "application", title: "Application Layer" },
      { id: "transport", title: "Transport Layer" },
    ],
    nodes: [
      { id: "http", title: "HTTP Semantics", groupId: "application", kind: "process" },
      { id: "kernel", title: "Kernel TCP Stack", groupId: "transport", kind: "process" },
      { id: "tcp", title: "TCP Reliable Stream", groupId: "transport", kind: "process" },
      { id: "proxy", title: "Application Proxy", groupId: "application", kind: "process" },
    ],
    edges: [
      { from: "http", to: "tcp" },
      { from: "kernel", to: "proxy" },
    ],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate(
    { title: "Network stack", content: "HTTP and TCP cross application and transport boundaries." },
    { type: "architecture", direction: "right" },
  );
  const scene = JSON.parse(result.excalidrawJson);
  const titles = scene.elements.filter((element: { id: string }) => /^group-.*-title$/.test(element.id));
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  assert.equal(titles.length, 2);
  assert.equal(overlaps(titles[0], titles[1]), false, "architecture group titles overlap");
});

test("crossing architecture edges use separate label positions", async () => {
  const model = {
    type: "architecture",
    title: "Network stack",
    groups: [{ id: "left", title: "Left Layer" }, { id: "right", title: "Right Layer" }],
    nodes: [
      { id: "left-top", title: "Left Top", groupId: "left", kind: "process" },
      { id: "left-bottom", title: "Left Bottom", groupId: "left", kind: "process" },
      { id: "right-top", title: "Right Top", groupId: "right", kind: "process" },
      { id: "right-bottom", title: "Right Bottom", groupId: "right", kind: "process" },
    ],
    edges: [
      { from: "left-top", to: "right-bottom", label: "encapsulated in" },
      { from: "left-bottom", to: "right-top", label: "implemented by" },
    ],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate(
    { title: "Network stack", content: "Two layers with crossing connections." },
    { type: "architecture", direction: "right" },
  );
  const scene = JSON.parse(result.excalidrawJson);
  const labels = scene.elements.filter((element: { id: string }) => element.id.startsWith("edge-") && element.id.endsWith("-label"));
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  assert.equal(labels.length, 2);
  assert.equal(overlaps(labels[0], labels[1]), false, "architecture edge labels overlap");
});

test("layered diagrams reorder cards to prevent avoidable arrow crossings", async () => {
  const model = {
    type: "flowchart", title: "Parallel work",
    nodes: ["start-a", "start-b", "finish-b", "finish-a"].map((id) => ({ id, title: id, kind: "process" })),
    edges: [{ from: "start-a", to: "finish-a" }, { from: "start-b", to: "finish-b" }],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate({ title: "Parallel", content: "First run two tasks, then finish both." }, { type: "flowchart", direction: "down" });
  const scene = JSON.parse(result.excalidrawJson);
  const arrows = scene.elements.filter((element: { type: string }) => element.type === "arrow");
  const absoluteSegments = (arrow: { x: number; y: number; points: [number, number][] }) => arrow.points.slice(1).map((point, index) => ({
    x1: arrow.x + arrow.points[index][0], y1: arrow.y + arrow.points[index][1],
    x2: arrow.x + point[0], y2: arrow.y + point[1],
  }));
  const intersects = (a: any, b: any) => {
    const aVertical = a.x1 === a.x2, bVertical = b.x1 === b.x2;
    if (aVertical && bVertical) return a.x1 === b.x1 && Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2)) < Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
    if (!aVertical && !bVertical) return a.y1 === b.y1 && Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) < Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
    const vertical = aVertical ? a : b, horizontal = aVertical ? b : a;
    return vertical.x1 > Math.min(horizontal.x1, horizontal.x2) && vertical.x1 < Math.max(horizontal.x1, horizontal.x2)
      && horizontal.y1 > Math.min(vertical.y1, vertical.y2) && horizontal.y1 < Math.max(vertical.y1, vertical.y2);
  };
  assert.equal(absoluteSegments(arrows[0]).some((a) => absoluteSegments(arrows[1]).some((b) => intersects(a, b))), false);
});

test("feedback loops do not collapse a flowchart into one row", async () => {
  const ids = ["read", "find", "validate", "shift", "return"];
  const model = {
    type: "flowchart", title: "Parser",
    nodes: ids.map((id) => ({ id, title: id, kind: "process" })),
    edges: [
      { from: "read", to: "find" }, { from: "find", to: "validate" },
      { from: "validate", to: "shift" }, { from: "shift", to: "return" },
      { from: "validate", to: "read", kind: "optional" },
    ],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate({ title: "Parser", content: "Read, validate, repeat, and return." }, { type: "flowchart", direction: "down" });
  const scene = JSON.parse(result.excalidrawJson);
  const yPositions = scene.elements.filter((element: { id: string }) => ids.includes(element.id)).map((element: { y: number }) => element.y);
  assert.ok(new Set(yPositions).size >= 4);
});

test("edge limits keep error paths before optional feedback paths", async () => {
  const model = {
    type: "flowchart", title: "Validation",
    nodes: ["check", "success", "retry", "failure"].map((id) => ({ id, title: id, kind: id === "failure" ? "warning" : "process" })),
    edges: [
      { from: "check", to: "success", kind: "normal" },
      { from: "check", to: "retry", kind: "optional" },
      { from: "check", to: "failure", kind: "error" },
    ],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate({ title: "Validation", content: "Validate, retry, or fail." }, { type: "flowchart" });
  assert.ok(result.spec.edges.some((edge) => edge.to === "failure" && edge.kind === "error"));
  assert.equal(result.spec.edges.some((edge) => edge.to === "retry" && edge.kind === "optional"), false);
});

test("feedback arrows route outside the node column", async () => {
  const ids = ["read", "parse", "validate", "done"];
  const model = {
    type: "flowchart", title: "Loop",
    nodes: ids.map((id) => ({ id, title: id, kind: "process" })),
    edges: [{ from: "read", to: "parse" }, { from: "parse", to: "validate" }, { from: "validate", to: "done" }, { from: "validate", to: "read", kind: "optional" }],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate({ title: "Loop", content: "Read and retry until valid." }, { type: "flowchart", direction: "down" });
  const scene = JSON.parse(result.excalidrawJson);
  const cards = scene.elements.filter((element: { id: string }) => ids.includes(element.id));
  const rightEdge = Math.max(...cards.map((card: { x: number; width: number }) => card.x + card.width));
  const feedback = scene.elements.find((element: { id: string }) => element.id === "edge-validate-read");
  const absoluteX = feedback.points.map((point: [number, number]) => feedback.x + point[0]);
  assert.ok(Math.max(...absoluteX) > rightEdge + 40);
});

test("semantic node colors are consistent", async () => {
  const model = {
    type: "flowchart", title: "Outcome",
    nodes: [{ id: "start", title: "Start", kind: "process" }, { id: "success", title: "Success", kind: "result" }, { id: "failure", title: "Failure", kind: "warning" }],
    edges: [{ from: "start", to: "success" }, { from: "start", to: "failure", kind: "error" }],
  };
  const scene = JSON.parse((await new DiagramEngine({ synthesize: async () => model }).generate({ title: "Outcome", content: "Return success or failure." }, { type: "flowchart" })).excalidrawJson);
  assert.equal(scene.elements.find((element: { id: string }) => element.id === "success").strokeColor, "#10b981");
  assert.equal(scene.elements.find((element: { id: string }) => element.id === "failure").strokeColor, "#ef4444");
});

test("decision text stays inside its diamond", async () => {
  const model = {
    type: "flowchart",
    title: "Buffer loop",
    nodes: [
      { id: "start", title: "Start", kind: "process" },
      { id: "buffer-full", title: "Buffer Full?", details: ["readToIndex >= len(buf)"], kind: "decision" },
      { id: "grow", title: "Grow Buffer", kind: "process" },
    ],
    edges: [
      { from: "start", to: "buffer-full" },
      { from: "buffer-full", to: "grow", label: "Yes" },
    ],
  };
  const result = await new DiagramEngine({ synthesize: async () => model }).generate(
    { title: "Buffer loop", content: "Start. If the buffer is full, grow it." },
    { type: "flowchart", detail: "balanced" },
  );
  const scene = JSON.parse(result.excalidrawJson);
  const diamond = scene.elements.find((element: { id: string }) => element.id === "buffer-full");
  const textElements = scene.elements.filter((element: { id: string }) => element.id.startsWith("buffer-full-") && element.id.endsWith("-text"));
  const centerX = diamond.x + diamond.width / 2;
  const centerY = diamond.y + diamond.height / 2;
  const isInside = (x: number, y: number) =>
    Math.abs(x - centerX) / (diamond.width / 2) + Math.abs(y - centerY) / (diamond.height / 2) <= 1;

  assert.ok(textElements.length === 2);
  for (const textElement of textElements) {
    const corners = [
      [textElement.x, textElement.y],
      [textElement.x + textElement.width, textElement.y],
      [textElement.x, textElement.y + textElement.height],
      [textElement.x + textElement.width, textElement.y + textElement.height],
    ];
    assert.ok(corners.every(([x, y]) => isInside(x, y)), `${textElement.id} exceeds the decision diamond`);
  }
});

test("privacy controls exclude complete folder paths", () => {
  const excluded = parseExcludedFolders("Private, Archive/Old\nPeople");
  assert.equal(isExcludedPath("Private/note.md", excluded), true);
  assert.equal(isExcludedPath("Privateer/note.md", excluded), false);
});

test("vault context is relevant and bounded", () => {
  const note = (title: string, about: string, mtime: number) => ({ title, path: `${title}.md`, about, mtime, tags: [] });
  const index = { tree: { name: "Vault", path: "", about: "", topics: [], notes: [note("Cooking", "bread", 2), note("TypeScript", "compiler types", 1)], subfolders: [] } } as never;
  assert.deepEqual(selectVaultContext(index, "typescript compiler", 1).map((item) => item.title), ["TypeScript"]);
  assert.equal(estimateRemoteRequests(2, 5, 3), 6);
});

class FakeVault {
  readonly files = new Map<string, { file: TFile; content: string }>();
  readonly folders = new Map<string, TFolder>();
  failCreates = false;

  add(path: string, content: string): TFile {
    const file = new TFile(path);
    this.files.set(path, { file, content });
    return file;
  }

  addFolder(path: string): TFolder {
    const folder = new TFolder(path);
    this.folders.set(path, folder);
    return folder;
  }

  getAbstractFileByPath(path: string) {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async read(file: TFile) {
    return this.files.get(file.path)?.content ?? "";
  }

  async modify(file: TFile, content: string) {
    const stored = this.files.get(file.path);
    if (!stored) throw new Error(`Missing file: ${file.path}`);
    stored.content = content;
  }

  async process(file: TFile, change: (content: string) => string) {
    const stored = this.files.get(file.path);
    if (!stored) throw new Error(`Missing file: ${file.path}`);
    stored.content = change(stored.content);
  }

  async create(path: string, content: string) {
    if (this.failCreates) throw new Error("Create failed");
    return this.add(path, content);
  }

  async delete(file: TFile) {
    this.files.delete(file.path);
  }

  async createFolder(path: string) {
    return this.addFolder(path);
  }
}

function fakeApp(vault: FakeVault) {
  return {
    vault,
    fileManager: {
      trashFile: async (file: TFile) => {
        vault.files.delete(file.path);
      },
    },
    workspace: {
      getActiveViewOfType: () => null,
      getLeaf: () => ({ openFile: async () => {} }),
    },
  };
}

test("folder multi-note mode requests new notes only", () => {
  const prompt = buildUserPrompt("HTTP parsing and buffer growth", "multi_note_folder", "concise", undefined, []);
  assert.match(prompt, /Mode: Create Multiple Notes in One Folder/);
  assert.match(prompt, /Action: create_new_note/);
  assert.match(prompt, /save every note in the directory selected by the user/);
  assert.doesNotMatch(prompt, /Action: append_to_note/);
});

test("explicit note folders keep the complete selected path", async () => {
  const vault = new FakeVault();
  const plugin = {
    settings: {
      enableProperties: false,
      enableExcalidrawMindMap: false,
      autoOpenCreatedNote: false,
    },
  };
  const modal = new NemotronModal(fakeApp(vault) as never, plugin as never);
  const result = await (modal as never as {
    createNewNoteFile(content: string, title: string, folder: string, properties: boolean, diagram: boolean, depth: null): Promise<{ snaps: FileSnapshot[] }>;
  }).createNewNoteFile("# Buffer Growth", "Buffer Growth", "Areas/Engineering/HTTP", false, false, null);

  assert.equal(result.snaps[0]?.path, "Areas/Engineering/HTTP/Buffer Growth.md");
});

test("smart placement parses the exact decision format requested by the prompt", () => {
  const response = `--- SMART DECISION ---
Action: append_to_note
Target: "Projects/Alpha.md"
Folder: Projects
Title: Alpha update
Reason: The content extends the existing project note.
--- END DECISION ---

## Status
The project is active.`;

  const result = extractSmartDecision(response);

  assert.deepEqual(result.decision, {
    action: "append_to_note",
    targetNotePath: "Projects/Alpha.md",
    targetFolder: "Projects",
    title: "Alpha update",
    reason: "The content extends the existing project note.",
  });
  assert.equal(result.cleanedContent, "## Status\nThe project is active.");
});

test("undo does not overwrite a file that the user changed later", async () => {
  const vault = new FakeVault();
  const file = vault.add("note.md", "generated content plus user edit");
  const history = new HistoryManager(fakeApp(vault) as never, [{
    id: "1",
    timestamp: 1,
    mode: "append",
    description: "append",
    files: [{
      path: file.path,
      isNewFile: false,
      previousContent: "original content",
      newContent: "generated content",
    }],
    foldersCreated: [],
  }]);

  await assert.rejects(() => history.undo(), /changed after generation/i);
  assert.equal(await vault.read(file), "generated content plus user edit");
});

test("undo does not delete a generated file that the user changed later", async () => {
  const vault = new FakeVault();
  const file = vault.add("generated.md", "generated content plus user edit");
  const history = new HistoryManager(fakeApp(vault) as never, [{
    id: "1",
    timestamp: 1,
    mode: "new_file",
    description: "new file",
    files: [{
      path: file.path,
      isNewFile: true,
      newContent: "generated content",
    }],
    foldersCreated: [],
  }]);

  await assert.rejects(() => history.undo(), /changed after generation/i);
  assert.equal(await vault.read(file), "generated content plus user edit");
});

test("an updated Excalidraw file records and restores its previous content", async () => {
  const vault = new FakeVault();
  vault.addFolder("Excalidrawings");
  const note = vault.add("Architecture.md", "# Architecture\nA small system.");
  const drawing = vault.add("Excalidrawings/Architecture.excalidraw.md", "user drawing");
  const app = fakeApp(vault);

  const originalWarn = console.warn;
  console.warn = () => {};
  let result!: Awaited<ReturnType<typeof createMirroredExcalidrawDrawing>>;
  try {
    result = await createMirroredExcalidrawDrawing(
      app as never,
      {
        baseUrl: "invalid-url",
        apiKey: "test",
        model: "test",
        temperature: 0,
        topP: 1,
        maxTokens: 100,
        enableThinking: false,
      } as never,
      note,
      "# Architecture\nA small system."
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.fileSnapshot.isNewFile, false);
  assert.equal(result.fileSnapshot.previousContent, "user drawing");
  assert.equal(result.fileSnapshot.newContent, await vault.read(drawing));
  assert.match(result.fileSnapshot.newContent, /nemotron-renderer: 6/);

  const history = new HistoryManager(app as never, [{
    id: "drawing",
    timestamp: 1,
    mode: "excalidraw",
    description: "drawing",
    files: [result.fileSnapshot],
    foldersCreated: [],
  }]);
  await history.undo();
  assert.equal(await vault.read(drawing), "user drawing");
});

test("failed auto-split restores the first note", async () => {
  const vault = new FakeVault();
  const original = Array.from({ length: 200 }, () => "word").join(" ");
  const file = vault.add("Long note.md", original);
  vault.failCreates = true;

  const plugin = {
    settings: {
      enableAutoSplitLongNotes: true,
      maxNoteWordCount: 200,
      splitNamingFormat: "part_suffix",
      enableExcalidrawMindMap: false,
      autoOpenCreatedNote: false,
      excalidrawFolder: "Excalidrawings",
    },
  };
  const modal = new NemotronModal(fakeApp(vault) as never, plugin as never);

  await assert.rejects(
    () => (modal as never as { appendToFile(file: TFile, content: string, enableProperties: boolean): Promise<unknown> })
      .appendToFile(file, "one more word", false),
    /Create failed/
  );
  assert.equal(await vault.read(file), original);
});

test("a failed multi-file operation restores every completed change", async () => {
  const vault = new FakeVault();
  const existing = vault.add("existing.md", "second generated append");
  vault.add("new.md", "new generated note");
  const app = fakeApp(vault);

  await revertFileSnapshots(app as never, [
    {
      path: existing.path,
      isNewFile: false,
      previousContent: "original",
      newContent: "first generated append",
    },
    {
      path: existing.path,
      isNewFile: false,
      previousContent: "first generated append",
      newContent: "second generated append",
    },
    {
      path: "new.md",
      isNewFile: true,
      newContent: "new generated note",
    },
  ]);

  assert.equal(await vault.read(existing), "original");
  assert.equal(vault.getAbstractFileByPath("new.md"), null);
});
