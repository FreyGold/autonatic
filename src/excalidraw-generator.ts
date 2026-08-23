import { App, TFile, normalizePath } from "obsidian";

export interface MindMapNode {
  id: string;
  text: string;
  colorCategory?: "root" | "concept" | "process" | "warning" | "success";
  children?: MindMapNode[];
}

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: { id: string; type: string }[] | null;
  updated: number;
  link: string | null;
  locked: boolean;
  [key: string]: any;
}

const COLOR_PALETTES = {
  root: { bg: "#4f46e5", stroke: "#818cf8", text: "#ffffff" },       // Indigo/Violet
  concept: { bg: "#0f766e", stroke: "#2dd4bf", text: "#ffffff" },    // Teal
  process: { bg: "#0369a1", stroke: "#38bdf8", text: "#ffffff" },    // Sky Blue
  warning: { bg: "#b45309", stroke: "#fbbf24", text: "#ffffff" },    // Amber
  success: { bg: "#15803d", stroke: "#4ade80", text: "#ffffff" },    // Emerald
  defaultChild: { bg: "#1e293b", stroke: "#94a3b8", text: "#f8fafc" }, // Slate
};

/**
 * Extracts a structured MindMap tree from a markdown note
 */
export function extractMindMapTreeFromNote(noteTitle: string, noteContent: string): MindMapNode {
  const root: MindMapNode = {
    id: "root",
    text: noteTitle,
    colorCategory: "root",
    children: [],
  };

  const lines = noteContent.split(/\r?\n/);
  let currentSection: MindMapNode | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("---") || trimmed.startsWith(">")) continue;

    // Heading level 2 (Main Branches)
    const h2Match = trimmed.match(/^##\s+(.+)$/);
    if (h2Match) {
      const headingText = h2Match[1].replace(/[*_#`\[\]]/g, "").trim();
      let colorCat: "concept" | "process" | "warning" | "success" = "concept";
      const lower = headingText.toLowerCase();
      if (lower.includes("flow") || lower.includes("step") || lower.includes("process") || lower.includes("impl")) {
        colorCat = "process";
      } else if (lower.includes("pitfall") || lower.includes("error") || lower.includes("warning") || lower.includes("edge")) {
        colorCat = "warning";
      } else if (lower.includes("takeaway") || lower.includes("decision") || lower.includes("summary") || lower.includes("rule")) {
        colorCat = "success";
      }

      currentSection = {
        id: `sec_${root.children!.length + 1}`,
        text: headingText.slice(0, 45),
        colorCategory: colorCat,
        children: [],
      };
      root.children!.push(currentSection);
      continue;
    }

    // Heading level 3 or Bullet points under current section
    const h3Match = trimmed.match(/^###\s+(.+)$/);
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);

    if ((h3Match || bulletMatch) && currentSection && currentSection.children!.length < 4) {
      const rawItem = (h3Match ? h3Match[1] : bulletMatch![1]).trim();
      const boldMatch = rawItem.match(/^\*\*([^\*]+)\*\*/);
      let childText = boldMatch ? boldMatch[1] : rawItem;
      childText = childText.replace(/[*_#`\[\]:]/g, "").replace(/\s+/g, " ").trim();
      
      if (childText.length > 0 && childText.length < 60) {
        currentSection.children!.push({
          id: `node_${currentSection.id}_${currentSection.children!.length + 1}`,
          text: childText,
          colorCategory: "concept",
        });
      }
    }
  }

  // Fallback if no headings found
  if (root.children!.length === 0) {
    root.children = [
      { id: "sec_1", text: "Core Concepts", colorCategory: "concept", children: [{ id: "n1", text: "Key Specifications" }] },
      { id: "sec_2", text: "Workflow & Execution", colorCategory: "process", children: [{ id: "n2", text: "Process Flow" }] },
      { id: "sec_3", text: "Validation Rules", colorCategory: "warning", children: [{ id: "n3", text: "Edge Cases" }] },
    ];
  }

  return root;
}

/**
 * Builds a balanced Excalidraw canvas layout from a MindMap tree
 */
export function buildExcalidrawJson(mindMap: MindMapNode, sourceNotePath: string): string {
  const elements: ExcalidrawElement[] = [];
  let seedCounter = 10000;

  const getSeed = () => ++seedCounter;
  const generateId = () => Math.random().toString(36).substring(2, 10);

  const ROOT_X = 600;
  const ROOT_Y = 80;
  const ROOT_W = 280;
  const ROOT_H = 70;

  // 1. Create Root Node
  const rootBoxId = "root_box";
  const rootTextId = "root_text";

  elements.push({
    id: rootBoxId,
    type: "rectangle",
    x: ROOT_X,
    y: ROOT_Y,
    width: ROOT_W,
    height: ROOT_H,
    angle: 0,
    strokeColor: COLOR_PALETTES.root.stroke,
    backgroundColor: COLOR_PALETTES.root.bg,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: getSeed(),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: [{ id: rootTextId, type: "text" }],
    updated: Date.now(),
    link: `[[${sourceNotePath}]]`,
    locked: false,
  });

  elements.push({
    id: rootTextId,
    type: "text",
    x: ROOT_X + 10,
    y: ROOT_Y + 22,
    width: ROOT_W - 20,
    height: 26,
    angle: 0,
    strokeColor: COLOR_PALETTES.root.text,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: getSeed(),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: mindMap.text.slice(0, 32),
    fontSize: 18,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: 18,
    containerId: rootBoxId,
    originalText: mindMap.text.slice(0, 32),
    lineHeight: 1.25,
  });

  // 2. Layout Branch Nodes
  const branches = mindMap.children || [];
  const branchCount = branches.length;
  const BRANCH_W = 240;
  const BRANCH_H = 60;
  const SPACING_X = 300;
  const BRANCH_Y = 240;

  const totalWidth = (branchCount - 1) * SPACING_X;
  const startX = ROOT_X + ROOT_W / 2 - totalWidth / 2 - BRANCH_W / 2;

  branches.forEach((branch, idx) => {
    const branchX = startX + idx * SPACING_X;
    const branchY = BRANCH_Y;
    const branchBoxId = `branch_box_${idx}`;
    const branchTextId = `branch_text_${idx}`;
    const arrowId = `arrow_root_to_branch_${idx}`;

    const palette = COLOR_PALETTES[branch.colorCategory || "concept"];

    // Branch Rectangle
    elements.push({
      id: branchBoxId,
      type: "rectangle",
      x: branchX,
      y: branchY,
      width: BRANCH_W,
      height: BRANCH_H,
      angle: 0,
      strokeColor: palette.stroke,
      backgroundColor: palette.bg,
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [
        { id: branchTextId, type: "text" },
        { id: arrowId, type: "arrow" },
      ],
      updated: Date.now(),
      link: null,
      locked: false,
    });

    // Branch Text
    elements.push({
      id: branchTextId,
      type: "text",
      x: branchX + 10,
      y: branchY + 18,
      width: BRANCH_W - 20,
      height: 24,
      angle: 0,
      strokeColor: palette.text,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      text: branch.text,
      fontSize: 15,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: 15,
      containerId: branchBoxId,
      originalText: branch.text,
      lineHeight: 1.25,
    });

    // Arrow from Root to Branch
    const rootBottomX = ROOT_X + ROOT_W / 2;
    const rootBottomY = ROOT_Y + ROOT_H;
    const branchTopX = branchX + BRANCH_W / 2;
    const branchTopY = branchY;

    elements.push({
      id: arrowId,
      type: "arrow",
      x: rootBottomX,
      y: rootBottomY,
      width: branchTopX - rootBottomX,
      height: branchTopY - rootBottomY,
      angle: 0,
      strokeColor: palette.stroke,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 2 },
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      points: [
        [0, 0],
        [branchTopX - rootBottomX, branchTopY - rootBottomY],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: rootBoxId, focus: 0, gap: 4 },
      endBinding: { elementId: branchBoxId, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
    });

    // 3. Leaf Nodes under Branch
    const leaves = branch.children || [];
    const LEAF_W = 200;
    const LEAF_H = 45;
    const LEAF_GAP_Y = 60;

    leaves.forEach((leaf, leafIdx) => {
      const leafX = branchX + (BRANCH_W - LEAF_W) / 2;
      const leafY = branchY + BRANCH_H + 40 + leafIdx * LEAF_GAP_Y;
      const leafBoxId = `leaf_box_${idx}_${leafIdx}`;
      const leafTextId = `leaf_text_${idx}_${leafIdx}`;
      const leafArrowId = `leaf_arrow_${idx}_${leafIdx}`;

      elements.push({
        id: leafBoxId,
        type: "rectangle",
        x: leafX,
        y: leafY,
        width: LEAF_W,
        height: LEAF_H,
        angle: 0,
        strokeColor: COLOR_PALETTES.defaultChild.stroke,
        backgroundColor: COLOR_PALETTES.defaultChild.bg,
        fillStyle: "solid",
        strokeWidth: 1.5,
        strokeStyle: "dashed",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: getSeed(),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: [
          { id: leafTextId, type: "text" },
          { id: leafArrowId, type: "arrow" },
        ],
        updated: Date.now(),
        link: null,
        locked: false,
      });

      elements.push({
        id: leafTextId,
        type: "text",
        x: leafX + 6,
        y: leafY + 12,
        width: LEAF_W - 12,
        height: 20,
        angle: 0,
        strokeColor: COLOR_PALETTES.defaultChild.text,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: getSeed(),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        text: leaf.text,
        fontSize: 13,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        baseline: 13,
        containerId: leafBoxId,
        originalText: leaf.text,
        lineHeight: 1.25,
      });

      // Arrow from Branch to Leaf
      const prevY = leafIdx === 0 ? branchY + BRANCH_H : leafY - 15;
      elements.push({
        id: leafArrowId,
        type: "arrow",
        x: leafX + LEAF_W / 2,
        y: prevY,
        width: 0,
        height: leafY - prevY,
        angle: 0,
        strokeColor: COLOR_PALETTES.defaultChild.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1.5,
        strokeStyle: "dotted",
        roughness: 1,
        opacity: 80,
        groupIds: [],
        frameId: null,
        roundness: { type: 2 },
        seed: getSeed(),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        points: [
          [0, 0],
          [0, leafY - prevY],
        ],
        lastCommittedPoint: null,
        startBinding: { elementId: leafIdx === 0 ? branchBoxId : `leaf_box_${idx}_${leafIdx - 1}`, focus: 0, gap: 4 },
        endBinding: { elementId: leafBoxId, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
      });
    });
  });

  const excalidrawDoc = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: "#0f172a",
    },
    files: {},
  };

  return JSON.stringify(excalidrawDoc, null, 2);
}

/**
 * Creates the mirrored Excalidraw drawing file in the `Excalidrawings` folder hierarchy
 * and returns the relative path and FileSnapshot.
 */
export async function createMirroredExcalidrawDrawing(
  app: App,
  noteFile: TFile,
  noteContent: string,
  rootExcalidrawFolder: string = "Excalidrawings"
): Promise<{ drawingPath: string; drawingFile: TFile; foldersCreated: string[] }> {
  const foldersCreated: string[] = [];
  const noteRelativeDir = noteFile.parent ? (noteFile.parent.path === "/" ? "" : noteFile.parent.path) : "";

  // 1. Create Mirrored Folder Structure
  const targetDir = noteRelativeDir ? `${rootExcalidrawFolder}/${noteRelativeDir}` : rootExcalidrawFolder;
  const segments = targetDir.split("/").filter((s) => s.trim().length > 0);
  let currentDir = "";

  for (const seg of segments) {
    currentDir = currentDir ? `${currentDir}/${seg}` : seg;
    const exists = app.vault.getAbstractFileByPath(normalizePath(currentDir));
    if (!exists) {
      await app.vault.createFolder(normalizePath(currentDir));
      foldersCreated.push(normalizePath(currentDir));
    }
  }

  // 2. Generate Excalidraw Markdown content
  const mindMapTree = extractMindMapTreeFromNote(noteFile.basename, noteContent);
  const excalidrawJson = buildExcalidrawJson(mindMapTree, noteFile.path);

  const drawingFileName = `${noteFile.basename}.excalidraw.md`;
  const drawingPath = normalizePath(`${targetDir}/${drawingFileName}`);

  const excalidrawFileContent = `---

excalidraw-plugin: parsed
tags: [ea/drawing, excalidraw, mindmap]

---
==Decompressed Markdown File==
> [!info] Linked Source Note
> Source: [[${noteFile.path}|${noteFile.basename}]]

# Drawing
\`\`\`json
${excalidrawJson}
\`\`\`
%%
# Text Elements
%%
`;

  let drawingFile = app.vault.getAbstractFileByPath(drawingPath);
  if (drawingFile instanceof TFile) {
    await app.vault.modify(drawingFile, excalidrawFileContent);
  } else {
    drawingFile = (await app.vault.create(drawingPath, excalidrawFileContent)) as TFile;
  }

  return {
    drawingPath,
    drawingFile: drawingFile as TFile,
    foldersCreated,
  };
}
