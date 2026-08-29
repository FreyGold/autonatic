import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import { extractAtomicDecompositionPlan, extractSmartDecision } from "../src/vault-indexer";
import { HistoryManager, revertFileSnapshots } from "../src/history-manager";
import { NemotronModal } from "../src/modal";
import { createMirroredExcalidrawDrawing } from "../src/excalidraw-generator";
import {
  estimateRemoteRequests,
  isExcludedPath,
  isPathInFolder,
  parseExcludedFolders,
  resolveAtomicPlacementPlan,
  resolveAtomicPlacementTarget,
  resolveFolderWithinScope,
  selectStrongRelatedNote,
  selectVaultContext,
} from "../src/privacy-controls";
import { DiagramEngine } from "../src/diagram-engine";
import { buildSelectionEditPrompt, buildUserPrompt } from "../src/prompts";
import { sanitizeMermaidDiagrams, streamChatCompletion } from "../src/api";
import { replaceCapturedSelection } from "../src/selection-editor";
import { UsefulDiagramPlanner } from "../src/useful-diagram-planner";
import { DESTINATION_MODE_OPTIONS, supportsPlacementFolderScope } from "../src/destination-modes";
import { DEFAULT_TEXT_MODEL, resolveTextModel } from "../src/model-defaults";
import { organizeAtomicPlan } from "../src/atomic-organization-planner";
import { normalizeGeneratedNoteMarkdown } from "../src/generated-markdown";

test("Super is the default text model", () => {
  assert.equal(DEFAULT_TEXT_MODEL, "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(resolveTextModel(), DEFAULT_TEXT_MODEL);
  assert.equal(resolveTextModel("nvidia/nemotron-3-ultra-550b-a55b"), DEFAULT_TEXT_MODEL);
  assert.equal(resolveTextModel("nvidia/nemotron-3.5-lightning-30b-a3b"), DEFAULT_TEXT_MODEL);
  assert.equal(resolveTextModel("custom/model"), "custom/model");
});

test("streaming retries one temporary read timeout", async () => {
  const originalRequest = http.request;
  let attempts = 0;

  (http as any).request = (_url: URL, _options: unknown, onResponse: (response: EventEmitter & { statusCode: number }) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
      write: () => void;
    };
    request.write = () => {};
    request.destroy = (error?: Error) => {
      if (error) request.emit("error", error);
    };
    request.end = () => {
      queueMicrotask(() => {
        attempts += 1;
        if (attempts === 1) {
          request.emit("error", Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }));
          return;
        }

        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        onResponse(response);
        response.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n'));
        response.emit("end");
      });
    };
    return request;
  };

  try {
    const result = await streamChatCompletion({
      apiKey: "test-key",
      baseUrl: "http://nvidia.test/v1",
      model: DEFAULT_TEXT_MODEL,
      temperature: 1,
      topP: 0.95,
      maxTokens: 100,
      enableThinking: true,
    } as never, "system", "user");

    assert.equal(result.content, "Recovered");
    assert.equal(attempts, 2);
  } finally {
    (http as any).request = originalRequest;
  }
});

test("streaming retries the same model after a temporary degraded-function response", async () => {
  const originalRequest = http.request;
  const requestedModels: string[] = [];

  (http as any).request = (_url: URL, _options: unknown, onResponse: (response: EventEmitter & { statusCode: number }) => void) => {
    let requestBody = "";
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
      write: (chunk: string) => void;
    };
    request.write = (chunk: string) => { requestBody += chunk; };
    request.destroy = (error?: Error) => {
      if (error) request.emit("error", error);
    };
    request.end = () => {
      queueMicrotask(() => {
        requestedModels.push(JSON.parse(requestBody).model);
        const isFirstAttempt = requestedModels.length === 1;
        const response = Object.assign(new EventEmitter(), { statusCode: isFirstAttempt ? 400 : 200 });
        onResponse(response);
        if (isFirstAttempt) {
          response.emit("data", Buffer.from(JSON.stringify({
            status: 400,
            title: "Bad Request",
            detail: "Function is in DEGRADED state and cannot be invoked",
          })));
        } else {
          response.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n'));
        }
        response.emit("end");
      });
    };
    return request;
  };

  try {
    const statuses: string[] = [];
    const result = await streamChatCompletion({
      apiKey: "test-key",
      baseUrl: "http://nvidia.test/v1",
      model: DEFAULT_TEXT_MODEL,
      temperature: 1,
      topP: 0.95,
      maxTokens: 100,
      enableThinking: true,
    } as never, "system", "user", { onStatus: (status) => statuses.push(status) });

    assert.equal(result.content, "Recovered");
    assert.deepEqual(requestedModels, [DEFAULT_TEXT_MODEL, DEFAULT_TEXT_MODEL]);
    assert.match(statuses.join(" "), /degraded.*retry/i);
  } finally {
    (http as any).request = originalRequest;
  }
});

test("the configured model is not substituted after a route 404", async () => {
  const originalRequest = http.request;
  const requestedModels: string[] = [];

  (http as any).request = (_url: URL, _options: unknown, onResponse: (response: EventEmitter & { statusCode: number }) => void) => {
    let requestBody = "";
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
      write: (chunk: string) => void;
    };
    request.write = (chunk: string) => { requestBody += chunk; };
    request.destroy = (error?: Error) => {
      if (error) request.emit("error", error);
    };
    request.end = () => {
      queueMicrotask(() => {
        requestedModels.push(JSON.parse(requestBody).model);
        const response = Object.assign(new EventEmitter(), { statusCode: 404 });
        onResponse(response);
        response.emit("end");
      });
    };
    return request;
  };

  try {
    await assert.rejects(
      () => streamChatCompletion({
        apiKey: "test-key",
        baseUrl: "http://nvidia.test/v1",
        model: DEFAULT_TEXT_MODEL,
        temperature: 1,
        topP: 0.95,
        maxTokens: 100,
        enableThinking: true,
      } as never, "system", "user"),
      /requested model endpoint is unavailable/i
    );

    assert.deepEqual(requestedModels, [DEFAULT_TEXT_MODEL]);
  } finally {
    (http as any).request = originalRequest;
  }
});

test("Smart and Atomic placement expose the same folder limit", () => {
  assert.equal(supportsPlacementFolderScope("smart"), true);
  assert.equal(supportsPlacementFolderScope("multi_note"), true);
  assert.equal(supportsPlacementFolderScope("multi_note_folder"), false);

  const smartLabel = DESTINATION_MODE_OPTIONS.find((option) => option.value === "smart")?.label || "";
  assert.match(smartLabel, /Smart Placement/);
  assert.doesNotMatch(smartLabel, /Single Note/i);
});

test("Atomic placement rejects targets outside its selected folder", () => {
  assert.deepEqual(
    resolveAtomicPlacementTarget(
      { action: "append_to_note", targetNotePath: "Practical/HTTP.md", targetFolder: "Practical" },
      "Theoretical",
    ),
    { action: "create_new_note", targetFolder: "Theoretical" },
  );
  assert.deepEqual(
    resolveAtomicPlacementTarget(
      { action: "create_new_note", targetFolder: "Theoretical/Networking/HTTP" },
      "Theoretical",
    ),
    { action: "create_new_note", targetFolder: "Theoretical/Networking/HTTP" },
  );
});

test("Atomic placement anchors topic subfolders under the selected folder", () => {
  assert.deepEqual(
    resolveAtomicPlacementTarget(
      { action: "create_new_note", targetFolder: "Joins" },
      "Database Exercises",
    ),
    { action: "create_new_note", targetFolder: "Database Exercises/Joins" },
  );
  assert.deepEqual(
    resolveAtomicPlacementTarget(
      { action: "create_new_note", targetFolder: "Transactions/Isolation" },
      "Database Exercises",
    ),
    { action: "create_new_note", targetFolder: "Database Exercises/Transactions/Isolation" },
  );
});

test("Atomic parser preserves the model's folder strategy", () => {
  const [item] = extractAtomicDecompositionPlan(`=== ATOMIC NOTE ===
Action: create_new_note
Placement: existing_subfolder
Folder: DB/SQL
Topic: Joins
Title: JOIN Types.md
--- CONTENT ---
Join notes.
=== END NOTE ===`);

  assert.equal((item as { topicFolder?: string }).topicFolder, "Joins");
  assert.equal((item as { folderStrategy?: string }).folderStrategy, "existing_subfolder");
});

test("Atomic organization adapts to the complete note plan", () => {
  const note = (
    title: string,
    folderStrategy: "root" | "existing_subfolder" | "new_subfolder",
    targetFolder: string,
  ) => ({
    action: "create_new_note" as const,
    title,
    reason: "Study note",
    content: title,
    folderStrategy,
    targetFolder,
  });

  assert.deepEqual(
    resolveAtomicPlacementPlan(
      [note("CASE Expressions", "root", "DB/SQL/Expressions")],
      "DB/SQL",
      ["DB/SQL/Exercises"],
    ),
    [{ action: "create_new_note", targetFolder: "DB/SQL" }],
  );

  assert.deepEqual(
    resolveAtomicPlacementPlan(
      [note("Join Exercise", "existing_subfolder", "Joins")],
      "DB/SQL",
      ["DB/SQL/Joins"],
    ),
    [{ action: "create_new_note", targetFolder: "DB/SQL/Joins" }],
  );

  assert.deepEqual(
    resolveAtomicPlacementPlan(
      [
        note("Inner Joins", "new_subfolder", "Joins"),
        note("Outer Joins", "new_subfolder", "Joins"),
        note("Transactions", "new_subfolder", "Transactions"),
      ],
      "DB/SQL",
      [],
    ),
    [
      { action: "create_new_note", targetFolder: "DB/SQL/Joins" },
      { action: "create_new_note", targetFolder: "DB/SQL/Joins" },
      { action: "create_new_note", targetFolder: "DB/SQL/Transactions" },
    ],
  );

  assert.deepEqual(
    resolveAtomicPlacementPlan(
      [
        note("Keep Flat", "root", "Window Functions"),
        note("One Window Note", "new_subfolder", "Window Functions"),
      ],
      "DB/SQL",
      [],
    ),
    [
      { action: "create_new_note", targetFolder: "DB/SQL" },
      { action: "create_new_note", targetFolder: "DB/SQL/Window Functions" },
    ],
  );
});

test("Atomic parsing preserves a full scoped folder path", () => {
  const [item] = extractAtomicDecompositionPlan(`=== ATOMIC NOTE ===
Action: create_new_note
Folder: Areas/Theoretical/Networking/HTTP
Title: HTTP semantics
--- CONTENT ---
Protocol theory.
=== END NOTE ===`);

  assert.equal(item.targetFolder, "Areas/Theoretical/Networking/HTTP");
  assert.deepEqual(
    resolveAtomicPlacementTarget(item, "Areas/Theoretical"),
    { action: "create_new_note", targetFolder: "Areas/Theoretical/Networking/HTTP" },
  );
});

test("useful diagram planner can skip every changed note", async () => {
  const planner = new UsefulDiagramPlanner({
    decide: async (request) => ({
      decisions: request.candidates.map((candidate) => ({
        id: candidate.id,
        action: "skip",
        reason: "The note is clearer as prose.",
      })),
    }),
  });

  const plan = await planner.plan([{
    path: "Theory.md",
    title: "Theory",
    action: "created",
    addedContent: "A concise factual explanation.",
    finalContent: "A concise factual explanation.",
  }], 3);

  assert.equal(plan.selected.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "The note is clearer as prose.");
});

test("useful diagram planner applies the operation limit after ranking", async () => {
  const planner = new UsefulDiagramPlanner({
    decide: async (request) => ({ decisions: request.candidates.map((candidate, index) => ({
      id: candidate.id,
      action: "draw",
      reason: "The process has useful relationships.",
      focusQuestion: `How does ${candidate.title} work?`,
      type: "flowchart",
      priority: index + 1,
    })) }),
  });
  const changes = ["Low", "High"].map((title) => ({
    path: `${title}.md`,
    title,
    action: "created" as const,
    addedContent: "First validate. Then publish.",
    finalContent: "First validate. Then publish.",
  }));

  const plan = await planner.plan(changes, 1);

  assert.deepEqual(plan.selected.map((decision) => decision.notePath), ["High.md"]);
  assert.match(plan.decisions.find((decision) => decision.notePath === "Low.md")!.reason, /diagram limit/i);
});

test("useful diagram planner updates an existing drawing and keeps late content", async () => {
  const lateDecision = "UNIQUE-LATE-DECISION";
  let receivedFinalContent = "";
  const planner = new UsefulDiagramPlanner({
    decide: async (request) => {
      receivedFinalContent = request.candidates[0].finalContent;
      return { decisions: [{
        id: request.candidates[0].id,
        action: "draw",
        reason: "The decision has meaningful branches.",
        focusQuestion: "Which branch should the reader choose?",
        type: "decision-tree",
        priority: 5,
      }] };
    },
  });

  const plan = await planner.plan([{
    path: "Choice.md",
    title: "Choice",
    action: "appended",
    addedContent: `${"context ".repeat(1500)}${lateDecision}`,
    finalContent: `${"context ".repeat(1500)}${lateDecision}`,
    existingDrawingPath: "Excalidrawings/Choice.excalidraw.md",
  }], 3);

  assert.equal(plan.selected[0].action, "update");
  assert.match(receivedFinalContent, new RegExp(lateDecision));
});

test("useful diagram planner does not create a fallback drawing after a model failure", async () => {
  const planner = new UsefulDiagramPlanner({ decide: async () => { throw new Error("offline"); } });
  const plan = await planner.plan([{
    path: "Process.md",
    title: "Process",
    action: "created",
    addedContent: "First validate. Then publish.",
    finalContent: "First validate. Then publish.",
  }], 3);

  assert.equal(plan.selected.length, 0);
  assert.match(plan.skipped[0].reason, /check failed/i);
});

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

test("automatic useful diagrams reject fallback output", async () => {
  const engine = new DiagramEngine({ synthesize: async () => { throw new Error("offline"); } });
  await assert.rejects(
    () => engine.generate(
      { title: "Release", content: "First validate. Then publish." },
      { allowFallback: false },
    ),
    /offline/,
  );
});

test("focused diagrams show their question and group each visual card", async () => {
  const engine = new DiagramEngine({ synthesize: async () => ({
    type: "flowchart",
    title: "Release",
    nodes: [
      { id: "validate", title: "Validate", kind: "process" },
      { id: "publish", title: "Publish", kind: "result" },
    ],
    edges: [{ from: "validate", to: "publish" }],
  }) });
  const result = await engine.generate({
    title: "Release",
    content: "First validate. Then publish.",
    sourceNotePath: "Release.md",
    focusQuestion: "How does a safe release reach publication?",
  });
  const scene = JSON.parse(result.excalidrawJson);
  const subtitle = scene.elements.find((element: { id: string }) => element.id === "diagram-subtitle");
  const card = scene.elements.find((element: { id: string }) => element.id === "validate");
  const cardTitle = scene.elements.find((element: { id: string }) => element.id === "validate-title-text");

  assert.equal(subtitle.text, "How does a safe release reach publication?");
  assert.deepEqual(card.groupIds, cardTitle.groupIds);
  assert.equal(card.link, "[[Release.md]]");
});

test("Mermaid sanitizer preserves Go slice notation inside node labels", () => {
  const markdown = `\`\`\`mermaid
flowchart TD
B1 --> C1["Write []byte to Socket"]
\`\`\``;
  const sanitized = sanitizeMermaidDiagrams(markdown);

  assert.match(sanitized, /C1\["Write #91;#93;byte to Socket"\]/);
  assert.doesNotMatch(sanitized, /C1\["Write \["\]byte/);
});

test("Mermaid sanitizer handles several code delimiters and nodes on one line", () => {
  const markdown = `\`\`\`mermaid
flowchart LR
A["Call main(\"\") and return []byte"] --> B{"Has map[string]int?"}
\`\`\``;
  const sanitized = sanitizeMermaidDiagrams(markdown);

  assert.match(sanitized, /A\["Call main#40;#quot;#quot;#41; and return #91;#93;byte"\]/);
  assert.match(sanitized, /B\{"Has map#91;string#93;int\?"\}/);
});

test("highlighted-text prompts request only replacement Markdown", () => {
  const prompt = buildSelectionEditPrompt("## Memory\nOriginal text.", "expand");
  assert.match(prompt, /Expand with useful details/);
  assert.match(prompt, /Return only the replacement Markdown/);
  assert.match(prompt, /## Memory\nOriginal text\./);
  assert.doesNotMatch(prompt, /YAML properties block/);
});

test("highlighted-text edits replace only the captured range", () => {
  let document = "before target after";
  const editor = {
    getValue: () => document,
    getRange: () => document.slice(7, 13),
    replaceRange: (replacement: string) => { document = `${document.slice(0, 7)}${replacement}${document.slice(13)}`; },
  };
  const captured = { text: "target", from: { line: 0, ch: 7 }, to: { line: 0, ch: 13 }, document };

  const updated = replaceCapturedSelection(editor as never, captured, "expanded details");
  assert.equal(updated, "before expanded details after");
});

test("highlighted-text edits stop when the note changed", () => {
  const captured = { text: "target", from: { line: 0, ch: 7 }, to: { line: 0, ch: 13 }, document: "before target after" };
  const editor = {
    getValue: () => "changed target after",
    getRange: () => "target",
    replaceRange: () => assert.fail("replaceRange must not run"),
  };

  assert.throws(() => replaceCapturedSelection(editor as never, captured, "replacement"), /note changed/);
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

test("Smart folder scope excludes notes outside the selected folder", () => {
  const note = (title: string, path: string, about: string) => ({ title, path, about, mtime: 1, tags: [] });
  const index = {
    tree: {
      name: "Vault",
      path: "",
      about: "",
      topics: [],
      notes: [
        note("Practical HTTP", "Practical/HTTP.md", "HTTP server implementation and socket buffers."),
        note("Theoretical HTTP", "Theoretical/Networking/HTTP.md", "HTTP protocol theory and semantics."),
      ],
      subfolders: [],
    },
  } as never;

  const selected = selectVaultContext(index, "HTTP protocol", 10, "Theoretical");
  assert.deepEqual(selected.map((item) => item.path), ["Theoretical/Networking/HTTP.md"]);
  assert.equal(isPathInFolder("Theoretical/Networking/HTTP.md", "Theoretical"), true);
  assert.equal(isPathInFolder("Practical/HTTP.md", "Theoretical"), false);
});

test("Smart folder scope keeps new notes under the full selected path", () => {
  assert.equal(
    resolveFolderWithinScope("Areas/Theoretical/Networking/TCP/Details", "Areas/Theoretical", 2),
    "Areas/Theoretical/Networking/TCP",
  );
  assert.equal(
    resolveFolderWithinScope("Areas/Practical", "Areas/Theoretical", 2),
    "Areas/Theoretical",
  );
});

test("smart placement finds a strong existing note from generated image content", () => {
  const note = (title: string, path: string, about: string) => ({ title, path, about, mtime: 1, tags: [] });
  const index = {
    tree: {
      name: "Vault",
      path: "",
      about: "",
      topics: [],
      notes: [
        note("Cooking", "Home/Cooking.md", "Bread recipes and kitchen tools."),
        note(
          "HTTP Server Implementation Guide",
          "Notes/HTTP Protocol/HTTP Server Implementation Guide.md",
          "Build an HTTP server in Go. Stream large responses and set Content-Length headers.",
        ),
      ],
      subfolders: [],
    },
  } as never;

  const content = "## Video streaming\nAn HTTP server can stream a large response with Content-Length or chunked encoding.";
  assert.equal(
    selectStrongRelatedNote(index, content)?.path,
    "Notes/HTTP Protocol/HTTP Server Implementation Guide.md",
  );
});

test("smart placement does not force an unrelated append", () => {
  const index = {
    tree: {
      name: "Vault",
      path: "",
      about: "",
      topics: [],
      notes: [{ title: "Cooking", path: "Cooking.md", about: "Bread recipes.", mtime: 1, tags: [] }],
      subfolders: [],
    },
  } as never;

  assert.equal(selectStrongRelatedNote(index, "TCP socket buffer management in Go"), null);
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

test("Smart prompts state the selected folder scope", () => {
  const prompt = buildUserPrompt(
    "HTTP protocol semantics",
    "smart",
    "concise",
    undefined,
    ["HTTP"],
    "- Theoretical/HTTP.md: Protocol semantics",
    true,
    "Theoretical",
  );

  assert.match(prompt, /SMART PLACEMENT SCOPE/);
  assert.match(prompt, /limited placement to "Theoretical" and its subfolders/);
  assert.match(prompt, /Never select a note or folder outside this scope/);
});

test("Atomic prompts state the selected folder scope", () => {
  const prompt = buildUserPrompt(
    "HTTP protocol semantics",
    "multi_note",
    "concise",
    undefined,
    ["HTTP"],
    "- Theoretical/HTTP.md: Protocol semantics",
    true,
    "Theoretical",
  );

  assert.match(prompt, /PLACEMENT FOLDER LIMIT/);
  assert.match(prompt, /limited placement to "Theoretical" and its subfolders/);
  assert.match(prompt, /Never append to a note outside this folder/);
});

test("Atomic prompts request adaptive folders and concise source-grounded notes", () => {
  const prompt = buildUserPrompt(
    "A study conversation about joins and transactions.",
    "multi_note",
    "concise",
    undefined,
    [],
    undefined,
    true,
    "Database Exercises",
    ["Database Exercises/Practice", "Database Exercises/Joins"],
  );

  assert.match(prompt, /major topic branch/i);
  assert.match(prompt, /Database Exercises\/Joins/);
  assert.match(prompt, /EXISTING FOLDERS IN SCOPE/);
  assert.match(prompt, /Database Exercises\/Practice/);
  assert.match(prompt, /Placement: <root \| existing_subfolder \| new_subfolder>/);
  assert.match(prompt, /FolderReason: <why this placement improves long-term organization>/);
  assert.match(prompt, /FutureNotes: <2-4 likely future note topics/);
  assert.match(prompt, /One note can justify a new folder/i);
  assert.match(prompt, /folder decision.*not.*note count/i);
  assert.match(prompt, /supported by the input/i);
  assert.match(prompt, /usually be 80-250 words/i);
  assert.match(prompt, /Do not add unrelated background/i);

  const atomicDescription = DESTINATION_MODE_OPTIONS.find((option) => option.value === "multi_note")?.description || "";
  assert.match(atomicDescription, /right level/i);
  assert.match(atomicDescription, /durable topic/i);
});

test("Atomic organization reviews the complete note set before placement", async () => {
  const plan = [
    { action: "create_new_note" as const, title: "JOIN Syntax Fundamentals", reason: "JOIN syntax", content: "# JOIN Syntax" },
    { action: "create_new_note" as const, title: "Types of SQL Joins", reason: "JOIN types", content: "# Join Types" },
    { action: "create_new_note" as const, title: "LEFT JOIN", reason: "LEFT JOIN behavior", content: "# LEFT JOIN" },
    { action: "create_new_note" as const, title: "CASE Expressions", reason: "Conditional SQL", content: "# CASE" },
  ];
  let request = "";

  const organized = await organizeAtomicPlan(
    plan,
    { scopeFolder: "DB/SQL", existingFolders: [] },
    async (_systemPrompt, userPrompt) => {
      request = userPrompt;
      return JSON.stringify([
        { id: "note-1", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable SQL category." },
        { id: "note-2", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable SQL category." },
        { id: "note-3", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable SQL category." },
        { id: "note-4", placement: "root", targetFolder: "DB/SQL", reason: "This narrow topic fits the selected folder." },
      ]);
    },
  );

  assert.match(request, /JOIN Syntax Fundamentals/);
  assert.match(request, /Types of SQL Joins/);
  assert.match(request, /LEFT JOIN/);
  assert.match(request, /CASE Expressions/);
  assert.deepEqual(
    organized.map((item) => item.targetFolder),
    ["DB/SQL/Joins", "DB/SQL/Joins", "DB/SQL/Joins", "DB/SQL"],
  );
  assert.deepEqual(
    organized.map((item) => item.folderStrategy),
    ["new_subfolder", "new_subfolder", "new_subfolder", "root"],
  );
});

test("Atomic organization creates a folder when the model mislabels it as existing", async () => {
  const [organized] = await organizeAtomicPlan(
    [{
      action: "create_new_note",
      title: "LEFT JOIN",
      reason: "LEFT JOIN behavior",
      content: "# LEFT JOIN",
    }],
    { scopeFolder: "DB/SQL", existingFolders: [] },
    async () => JSON.stringify([
      {
        id: "note-1",
        placement: "existing_subfolder",
        targetFolder: "DB/SQL/Joins",
        reason: "Joins is a durable category.",
      },
    ]),
  );

  assert.equal(organized.folderStrategy, "new_subfolder");
  assert.equal(organized.targetFolder, "DB/SQL/Joins");
});

test("Atomic organization audits a flat first decision before placement", async () => {
  const plan = [
    { action: "create_new_note" as const, title: "JOIN Basics and Common Mistakes", reason: "JOIN syntax", content: "# JOIN Basics" },
    { action: "create_new_note" as const, title: "Joining Three Tables", reason: "Multi-table joins", content: "# Joining Three Tables" },
    { action: "create_new_note" as const, title: "Self-Join and Subquery for Hierarchical Data", reason: "Self-joins", content: "# Self-Join" },
    { action: "create_new_note" as const, title: "CASE Expressions for Conditional Labeling", reason: "Conditional SQL", content: "# CASE" },
  ];
  let calls = 0;

  const organized = await organizeAtomicPlan(
    plan,
    { scopeFolder: "DB/SQL", existingFolders: [] },
    async (_systemPrompt, userPrompt) => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify(plan.map((_item, index) => ({
          id: `note-${index + 1}`,
          placement: "root",
          targetFolder: "DB/SQL",
          reason: "Keep SQL notes together.",
        })));
      }

      assert.match(userPrompt, /audit/i);
      assert.match(userPrompt, /JOIN Basics and Common Mistakes/);
      return JSON.stringify([
        { id: "note-1", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable category." },
        { id: "note-2", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable category." },
        { id: "note-3", placement: "new_subfolder", targetFolder: "DB/SQL/Joins", reason: "Joins is a durable category." },
        { id: "note-4", placement: "root", targetFolder: "DB/SQL", reason: "This narrow topic fits SQL." },
      ]);
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(
    organized.map((item) => item.targetFolder),
    ["DB/SQL/Joins", "DB/SQL/Joins", "DB/SQL/Joins", "DB/SQL"],
  );
});

test("generated notes unwrap fenced YAML frontmatter", () => {
  const generated = `\`\`\`yaml
---
title: "LEFT JOIN"
tags:
  - notes/DB/SQL/Joins
---
\`\`\`

# LEFT JOIN

\`\`\`sql
SELECT * FROM users;
\`\`\``;

  const normalized = normalizeGeneratedNoteMarkdown(generated);

  assert.match(normalized, /^---\n/);
  assert.doesNotMatch(normalized, /^\`\`\`yaml/);
  assert.match(normalized, /\`\`\`sql\nSELECT \* FROM users;/);
});

test("frontmatter instructions forbid YAML code fences", () => {
  const prompt = buildUserPrompt("LEFT JOIN", "new_file", "concise", undefined, [], undefined, true);
  assert.match(prompt, /first line must be ---/i);
  assert.match(prompt, /Never wrap.*YAML.*code fence/i);
  assert.doesNotMatch(prompt, /\`\`\`ya?ml/);
});

test("nested note folders create every folder in the selected path", async () => {
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
    createNewNoteFile(content: string, title: string, folder: string, properties: boolean, depth: null): Promise<{
      snaps: FileSnapshot[];
      foldersCreated: string[];
    }>;
  }).createNewNoteFile("# Buffer Growth", "Buffer Growth.md", "Areas/Engineering/HTTP", false, null);

  assert.equal(result.snaps[0]?.path, "Areas/Engineering/HTTP/Buffer Growth.md");
  assert.deepEqual(result.foldersCreated, ["Areas", "Areas/Engineering", "Areas/Engineering/HTTP"]);
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
  assert.match(result.fileSnapshot.newContent, /nemotron-renderer: 7/);

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
