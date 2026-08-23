import { App, TFile, normalizePath } from "obsidian";
import type { NemotronPluginSettings } from "./settings";
import * as https from "https";
import * as http from "http";

export interface RichDiagramCard {
  title: string;
  bullets?: string[];
  codeSnippet?: string;
  role?: "ingress" | "core" | "process" | "validation" | "warning" | "success" | "dispatch";
}

export interface RichDiagramContainer {
  title: string;
  type?: "ingress" | "core" | "process" | "validation" | "dispatch" | "storage";
  cards: RichDiagramCard[];
}

export interface RichDiagramFlow {
  from: string;
  to: string;
  label?: string;
  isError?: boolean;
}

export interface RichDiagramSummary {
  title: string;
  items: string[];
}

export interface RichDiagramSpec {
  title: string;
  subtitle?: string;
  containers: RichDiagramContainer[];
  flows: RichDiagramFlow[];
  summaryBox?: RichDiagramSummary;
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

const THEME = {
  canvasBg: "#0f172a", // Slate 900
  banner: { bg: "#312e81", stroke: "#6366f1", text: "#ffffff", subtext: "#c7d2fe" },
  container: {
    ingress: { bg: "rgba(14, 165, 233, 0.06)", stroke: "#0284c7", labelBg: "#0369a1", labelText: "#ffffff" },
    core: { bg: "rgba(99, 102, 241, 0.06)", stroke: "#6366f1", labelBg: "#4f46e5", labelText: "#ffffff" },
    process: { bg: "rgba(20, 184, 166, 0.06)", stroke: "#0d9488", labelBg: "#0f766e", labelText: "#ffffff" },
    validation: { bg: "rgba(245, 158, 11, 0.06)", stroke: "#d97706", labelBg: "#b45309", labelText: "#ffffff" },
    dispatch: { bg: "rgba(139, 92, 246, 0.06)", stroke: "#7c3aed", labelBg: "#6d28d9", labelText: "#ffffff" },
    storage: { bg: "rgba(16, 185, 129, 0.06)", stroke: "#059669", labelBg: "#047857", labelText: "#ffffff" },
    default: { bg: "rgba(71, 85, 105, 0.06)", stroke: "#475569", labelBg: "#334155", labelText: "#ffffff" },
  },
  card: {
    ingress: { bg: "#0c4a6e", stroke: "#38bdf8", text: "#f0f9ff", bullet: "#7dd3fc" },
    core: { bg: "#1e1b4b", stroke: "#818cf8", text: "#e0e7ff", bullet: "#a5b4fc" },
    process: { bg: "#134e4a", stroke: "#2dd4bf", text: "#ccfbf1", bullet: "#5eead4" },
    validation: { bg: "#451a03", stroke: "#fbbf24", text: "#fef3c7", bullet: "#fcd34d" },
    warning: { bg: "#4c0519", stroke: "#f43f5e", text: "#ffe4e6", bullet: "#fda4af" },
    success: { bg: "#064e3b", stroke: "#34d399", text: "#d1fae5", bullet: "#6ee7b7" },
    dispatch: { bg: "#2e1065", stroke: "#a78bfa", text: "#ede9fe", bullet: "#c4b5fd" },
    default: { bg: "#1e293b", stroke: "#64748b", text: "#f8fafc", bullet: "#94a3b8" },
  },
  codeChip: { bg: "#020617", stroke: "#334155", text: "#38bdf8" },
  summary: { bg: "#1e1b4b", stroke: "#a855f7", headerBg: "#7e22ce", text: "#faf5ff" },
  flow: {
    normal: { stroke: "#38bdf8", labelBg: "#0f172a", labelText: "#7dd3fc", strokeWidth: 2 },
    error: { stroke: "#f43f5e", labelBg: "#0f172a", labelText: "#fda4af", strokeWidth: 2 },
  },
};

/**
 * AI-powered Deep Semantic Diagram Synthesizer via Nemotron
 */
export async function synthesizeRichDiagramSpec(
  settings: NemotronPluginSettings,
  noteTitle: string,
  noteContent: string
): Promise<RichDiagramSpec> {
  const urlStr = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const urlObj = new URL(urlStr);

  const systemPrompt = `You are a Principal Software & Systems Architect and Visual Diagram Master.
Your mission is to transform technical notes into comprehensive, high-density, professional visual architecture diagrams.

Decompose the note into 3 to 4 distinct functional subsystem containers (e.g. Ingress/Input, Core Engine/State Machine, Execution/Processing, Error Handling/Output).
Inside each container, create 2 to 3 detailed component cards with specific technical bullets and code/signature snippets extracted from the note.
Define explicit directed flows between cards with informative technical labels on the data transitions.
Provide an Architectural Takeaways & Rules summary box.

Output ONLY valid JSON strictly adhering to this schema:
{
  "title": "<Concise Architectural Title (<= 6 words)>",
  "subtitle": "<Subsystem Goal / RFC / Core Pattern (<= 8 words)>",
  "containers": [
    {
      "title": "<Subsystem Name, e.g. 1. Ingress & Buffer Parsing>",
      "type": "ingress" | "core" | "process" | "validation" | "dispatch" | "storage",
      "cards": [
        {
          "title": "<Component / Struct / Method Name>",
          "bullets": [
            "<Key technical detail or specification rule 1>",
            "<Key technical detail or specification rule 2>"
          ],
          "codeSnippet": "<optional short code snippet or signature, e.g. Parse(buf []byte)>",
          "role": "ingress" | "core" | "process" | "validation" | "warning" | "success" | "dispatch"
        }
      ]
    }
  ],
  "flows": [
    {
      "from": "<Exact Card Title A>",
      "to": "<Exact Card Title B>",
      "label": "<Short descriptive transition label, e.g. Validated Tokens>",
      "isError": false
    }
  ],
  "summaryBox": {
    "title": "Architectural Takeaways & Rules",
    "items": [
      "<Core takeaway / performance constraint 1>",
      "<Core takeaway / performance constraint 2>",
      "<Core takeaway / performance constraint 3>"
    ]
  }
}`;

  const requestBody = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Technical Note Title: ${noteTitle}\n\nNote Content:\n${noteContent.slice(0, 4500)}` },
    ],
    temperature: 0.2,
    max_tokens: 3500,
  };

  const postData = JSON.stringify(requestBody);
  const isHttps = urlObj.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;

  return new Promise((resolve) => {
    const fallbackSpec: RichDiagramSpec = createFallbackSpec(noteTitle, noteContent);

    const req = requestFn(
      urlObj,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const raw = parsed.choices?.[0]?.message?.content || "";
            const jsonMatch = raw.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/) || [null, raw];
            const data: RichDiagramSpec = JSON.parse((jsonMatch[1] || raw).trim());

            if (data && data.containers && Array.isArray(data.containers) && data.containers.length > 0) {
              resolve(data);
              return;
            }
          } catch {}
          resolve(fallbackSpec);
        });
      }
    );

    req.on("error", () => resolve(fallbackSpec));
    req.write(postData);
    req.end();
  });
}

function createFallbackSpec(noteTitle: string, noteContent: string): RichDiagramSpec {
  return {
    title: noteTitle,
    subtitle: "Architecture & Concept Flow",
    containers: [
      {
        title: "1. Core Specifications & Structure",
        type: "ingress",
        cards: [
          {
            title: "Concept Definition",
            bullets: ["Key specifications and semantics", "Initial state initialization"],
            role: "ingress",
          },
        ],
      },
      {
        title: "2. Execution & State Processing",
        type: "core",
        cards: [
          {
            title: "Processing Pipeline",
            bullets: ["Core transformation mechanics", "Resource lifecycle & validation"],
            role: "core",
          },
        ],
      },
      {
        title: "3. Constraints & Outcomes",
        type: "dispatch",
        cards: [
          {
            title: "Validation Gate",
            bullets: ["Fail-fast rule checks", "Safe error propagation"],
            role: "warning",
          },
        ],
      },
    ],
    flows: [
      { from: "Concept Definition", to: "Processing Pipeline", label: "Initializes" },
      { from: "Processing Pipeline", to: "Validation Gate", label: "Evaluates" },
    ],
    summaryBox: {
      title: "Architectural Takeaways",
      items: ["Enforces modular separation of concerns", "Optimized execution flow with clear boundaries"],
    },
  };
}

/**
 * Builds high-density, professional Excalidraw canvas JSON from RichDiagramSpec
 */
export function buildRichExcalidrawJson(spec: RichDiagramSpec, sourceNotePath?: string): string {
  const elements: ExcalidrawElement[] = [];
  let seedCounter = 20000;
  const getSeed = () => ++seedCounter;
  const generateId = (prefix: string) => `${prefix}_${Math.random().toString(36).substring(2, 9)}`;

  // Spatial Dimensions
  const CANVAS_START_X = 80;
  const CANVAS_START_Y = 60;
  const CONTAINER_W = 340;
  const CONTAINER_GAP_X = 60;
  const CONTAINER_PADDING_X = 18;
  const CONTAINER_PADDING_TOP = 50;
  const CARD_W = CONTAINER_W - CONTAINER_PADDING_X * 2;
  const CARD_GAP_Y = 24;

  const cardPositionMap = new Map<string, { x: number; y: number; w: number; h: number; id: string }>();

  // 1. Top Banner Header
  const bannerW = Math.max(880, spec.containers.length * (CONTAINER_W + CONTAINER_GAP_X) - CONTAINER_GAP_X);
  const bannerH = 90;
  const bannerBoxId = generateId("banner_box");
  const bannerTitleId = generateId("banner_title");
  const bannerSubId = generateId("banner_sub");

  elements.push({
    id: bannerBoxId,
    type: "rectangle",
    x: CANVAS_START_X,
    y: CANVAS_START_Y,
    width: bannerW,
    height: bannerH,
    angle: 0,
    strokeColor: THEME.banner.stroke,
    backgroundColor: THEME.banner.bg,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: getSeed(),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: sourceNotePath ? `[[${sourceNotePath}]]` : null,
    locked: false,
  });

  elements.push({
    id: bannerTitleId,
    type: "text",
    x: CANVAS_START_X + 24,
    y: CANVAS_START_Y + 16,
    width: bannerW - 48,
    height: 32,
    angle: 0,
    strokeColor: THEME.banner.text,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
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
    text: spec.title.toUpperCase(),
    fontSize: 22,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 22,
    containerId: null,
    originalText: spec.title.toUpperCase(),
    lineHeight: 1.2,
  });

  const subtitleText = spec.subtitle
    ? `Architecture Overview • ${spec.subtitle}`
    : "Architecture Overview • Systems & Conceptual Flow";

  elements.push({
    id: bannerSubId,
    type: "text",
    x: CANVAS_START_X + 24,
    y: CANVAS_START_Y + 52,
    width: bannerW - 48,
    height: 20,
    angle: 0,
    strokeColor: THEME.banner.subtext,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
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
    text: subtitleText,
    fontSize: 14,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 14,
    containerId: null,
    originalText: subtitleText,
    lineHeight: 1.2,
  });

  // 2. Render Subsystem Containers & Cards
  const CONTAINERS_START_Y = CANVAS_START_Y + bannerH + 40;
  let maxContainerBottom = CONTAINERS_START_Y;

  spec.containers.forEach((cont, cIdx) => {
    const contX = CANVAS_START_X + cIdx * (CONTAINER_W + CONTAINER_GAP_X);
    const contType = cont.type || "default";
    const contTheme = (THEME.container as any)[contType] || THEME.container.default;

    // Calculate height based on cards
    let currentCardY = CONTAINERS_START_Y + CONTAINER_PADDING_TOP;

    const cardsGeometry: { card: RichDiagramCard; y: number; h: number; cardId: string }[] = [];

    cont.cards.forEach((card) => {
      const bulletCount = (card.bullets || []).length;
      const hasSnippet = !!card.codeSnippet;
      let cardH = 48 + bulletCount * 22 + (hasSnippet ? 42 : 0) + 16;
      cardH = Math.max(cardH, 80);

      const cardId = generateId("card");
      cardsGeometry.push({ card, y: currentCardY, h: cardH, cardId });
      cardPositionMap.set(card.title.trim().toLowerCase(), {
        x: contX + CONTAINER_PADDING_X,
        y: currentCardY,
        w: CARD_W,
        h: cardH,
        id: cardId,
      });

      currentCardY += cardH + CARD_GAP_Y;
    });

    const contH = currentCardY - CONTAINERS_START_Y + 10;
    if (CONTAINERS_START_Y + contH > maxContainerBottom) {
      maxContainerBottom = CONTAINERS_START_Y + contH;
    }

    // Container Boundary Box
    elements.push({
      id: generateId("cont_box"),
      type: "rectangle",
      x: contX,
      y: CONTAINERS_START_Y,
      width: CONTAINER_W,
      height: contH,
      angle: 0,
      strokeColor: contTheme.stroke,
      backgroundColor: contTheme.bg,
      fillStyle: "solid",
      strokeWidth: 1.5,
      strokeStyle: "dashed",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: null,
      locked: false,
    });

    // Container Label Badge
    const labelBadgeH = 28;
    const labelBadgeW = CONTAINER_W - 24;
    elements.push({
      id: generateId("cont_badge"),
      type: "rectangle",
      x: contX + 12,
      y: CONTAINERS_START_Y + 10,
      width: labelBadgeW,
      height: labelBadgeH,
      angle: 0,
      strokeColor: contTheme.stroke,
      backgroundColor: contTheme.labelBg,
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 2 },
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: null,
      locked: false,
    });

    elements.push({
      id: generateId("cont_badge_txt"),
      type: "text",
      x: contX + 16,
      y: CONTAINERS_START_Y + 15,
      width: labelBadgeW - 8,
      height: 18,
      angle: 0,
      strokeColor: contTheme.labelText,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
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
      text: cont.title.toUpperCase(),
      fontSize: 12,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: 12,
      containerId: null,
      originalText: cont.title.toUpperCase(),
      lineHeight: 1.2,
    });

    // Render Cards in Container
    cardsGeometry.forEach(({ card, y, h, cardId }) => {
      const cardRole = card.role || "default";
      const cardTheme = (THEME.card as any)[cardRole] || THEME.card.default;
      const cardX = contX + CONTAINER_PADDING_X;

      // Card Background Box
      elements.push({
        id: cardId,
        type: "rectangle",
        x: cardX,
        y: y,
        width: CARD_W,
        height: h,
        angle: 0,
        strokeColor: cardTheme.stroke,
        backgroundColor: cardTheme.bg,
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: getSeed(),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: [],
        updated: Date.now(),
        link: null,
        locked: false,
      });

      // Card Title Text
      elements.push({
        id: generateId("card_title"),
        type: "text",
        x: cardX + 12,
        y: y + 12,
        width: CARD_W - 24,
        height: 20,
        angle: 0,
        strokeColor: cardTheme.text,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
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
        text: card.title,
        fontSize: 14,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        baseline: 14,
        containerId: null,
        originalText: card.title,
        lineHeight: 1.2,
      });

      // Bullets
      let bulletY = y + 36;
      (card.bullets || []).forEach((bText) => {
        elements.push({
          id: generateId("bullet_txt"),
          type: "text",
          x: cardX + 12,
          y: bulletY,
          width: CARD_W - 24,
          height: 18,
          angle: 0,
          strokeColor: cardTheme.bullet,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
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
          text: `• ${bText}`,
          fontSize: 12,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          baseline: 12,
          containerId: null,
          originalText: `• ${bText}`,
          lineHeight: 1.2,
        });
        bulletY += 20;
      });

      // Code Snippet Chip
      if (card.codeSnippet) {
        const chipY = bulletY + 4;
        elements.push({
          id: generateId("code_chip"),
          type: "rectangle",
          x: cardX + 10,
          y: chipY,
          width: CARD_W - 20,
          height: 26,
          angle: 0,
          strokeColor: THEME.codeChip.stroke,
          backgroundColor: THEME.codeChip.bg,
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: { type: 2 },
          seed: getSeed(),
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: [],
          updated: Date.now(),
          link: null,
          locked: false,
        });

        elements.push({
          id: generateId("code_txt"),
          type: "text",
          x: cardX + 16,
          y: chipY + 5,
          width: CARD_W - 32,
          height: 16,
          angle: 0,
          strokeColor: THEME.codeChip.text,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
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
          text: card.codeSnippet,
          fontSize: 11,
          fontFamily: 3, // Code / Monospace
          textAlign: "left",
          verticalAlign: "middle",
          baseline: 11,
          containerId: null,
          originalText: card.codeSnippet,
          lineHeight: 1.2,
        });
      }
    });
  });

  // 3. Render Directed Flows with Label Badges
  (spec.flows || []).forEach((flow) => {
    const fromKey = flow.from.trim().toLowerCase();
    const toKey = flow.to.trim().toLowerCase();

    const fromGeom = cardPositionMap.get(fromKey) || findPartialGeom(fromKey, cardPositionMap);
    const toGeom = cardPositionMap.get(toKey) || findPartialGeom(toKey, cardPositionMap);

    if (fromGeom && toGeom) {
      const flowTheme = flow.isError ? THEME.flow.error : THEME.flow.normal;

      const isSameContainer = Math.abs(fromGeom.x - toGeom.x) < 50;

      let startX = 0;
      let startY = 0;
      let endX = 0;
      let endY = 0;

      if (isSameContainer) {
        // Vertical connection
        startX = fromGeom.x + fromGeom.w / 2;
        startY = fromGeom.y + fromGeom.h;
        endX = toGeom.x + toGeom.w / 2;
        endY = toGeom.y;
      } else if (fromGeom.x < toGeom.x) {
        // Left-to-right connection
        startX = fromGeom.x + fromGeom.w;
        startY = fromGeom.y + fromGeom.h / 2;
        endX = toGeom.x;
        endY = toGeom.y + toGeom.h / 2;
      } else {
        // Right-to-left connection
        startX = fromGeom.x;
        startY = fromGeom.y + fromGeom.h / 2;
        endX = toGeom.x + toGeom.w;
        endY = toGeom.y + toGeom.h / 2;
      }

      const arrowId = generateId("flow_arrow");
      elements.push({
        id: arrowId,
        type: "arrow",
        x: startX,
        y: startY,
        width: endX - startX,
        height: endY - startY,
        angle: 0,
        strokeColor: flowTheme.stroke,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: flowTheme.strokeWidth,
        strokeStyle: flow.isError ? "dashed" : "solid",
        roughness: 0,
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
          [endX - startX, endY - startY],
        ],
        lastCommittedPoint: null,
        startBinding: { elementId: fromGeom.id, focus: 0, gap: 4 },
        endBinding: { elementId: toGeom.id, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
      });

      // Flow Label Badge
      if (flow.label && flow.label.trim()) {
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        const labelW = Math.max(100, flow.label.length * 7 + 16);
        const labelH = 22;

        elements.push({
          id: generateId("flow_label_bg"),
          type: "rectangle",
          x: midX - labelW / 2,
          y: midY - labelH / 2,
          width: labelW,
          height: labelH,
          angle: 0,
          strokeColor: flowTheme.stroke,
          backgroundColor: flowTheme.labelBg,
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: { type: 2 },
          seed: getSeed(),
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: [],
          updated: Date.now(),
          link: null,
          locked: false,
        });

        elements.push({
          id: generateId("flow_label_txt"),
          type: "text",
          x: midX - labelW / 2 + 4,
          y: midY - 7,
          width: labelW - 8,
          height: 14,
          angle: 0,
          strokeColor: flowTheme.labelText,
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
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
          text: flow.label,
          fontSize: 11,
          fontFamily: 1,
          textAlign: "center",
          verticalAlign: "middle",
          baseline: 11,
          containerId: null,
          originalText: flow.label,
          lineHeight: 1.2,
        });
      }
    }
  });

  // 4. Architectural Summary Box (Bottom Card)
  if (spec.summaryBox && spec.summaryBox.items && spec.summaryBox.items.length > 0) {
    const summaryY = maxContainerBottom + 40;
    const summaryW = bannerW;
    const summaryItems = spec.summaryBox.items;
    const summaryH = 44 + summaryItems.length * 22 + 16;

    elements.push({
      id: generateId("sum_box"),
      type: "rectangle",
      x: CANVAS_START_X,
      y: summaryY,
      width: summaryW,
      height: summaryH,
      angle: 0,
      strokeColor: THEME.summary.stroke,
      backgroundColor: THEME.summary.bg,
      fillStyle: "solid",
      strokeWidth: 1.5,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: getSeed(),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [],
      updated: Date.now(),
      link: null,
      locked: false,
    });

    elements.push({
      id: generateId("sum_title"),
      type: "text",
      x: CANVAS_START_X + 20,
      y: summaryY + 14,
      width: summaryW - 40,
      height: 20,
      angle: 0,
      strokeColor: "#f3e8ff",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
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
      text: spec.summaryBox.title.toUpperCase(),
      fontSize: 14,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      baseline: 14,
      containerId: null,
      originalText: spec.summaryBox.title.toUpperCase(),
      lineHeight: 1.2,
    });

    let sItemY = summaryY + 40;
    summaryItems.forEach((item) => {
      elements.push({
        id: generateId("sum_item"),
        type: "text",
        x: CANVAS_START_X + 20,
        y: sItemY,
        width: summaryW - 40,
        height: 18,
        angle: 0,
        strokeColor: "#e9d5ff",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
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
        text: `★ ${item}`,
        fontSize: 12,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        baseline: 12,
        containerId: null,
        originalText: `★ ${item}`,
        lineHeight: 1.2,
      });
      sItemY += 22;
    });
  }

  const excalidrawDoc = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: THEME.canvasBg,
    },
    files: {},
  };

  return JSON.stringify(excalidrawDoc, null, 2);
}

function findPartialGeom(key: string, map: Map<string, { x: number; y: number; w: number; h: number; id: string }>) {
  for (const [k, v] of map.entries()) {
    if (k.includes(key) || key.includes(k)) {
      return v;
    }
  }
  return undefined;
}

/**
 * Creates high-effort mirrored Excalidraw drawing file
 */
export async function createMirroredExcalidrawDrawing(
  app: App,
  settings: NemotronPluginSettings,
  noteFile: TFile,
  noteContent: string,
  rootExcalidrawFolder: string = "Excalidrawings"
): Promise<{ drawingPath: string; drawingFile: TFile; foldersCreated: string[] }> {
  const foldersCreated: string[] = [];
  const noteRelativeDir = noteFile.parent ? (noteFile.parent.path === "/" ? "" : noteFile.parent.path) : "";

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

  // Synthesize Rich AI Diagram Spec with Nemotron
  const spec = await synthesizeRichDiagramSpec(settings, noteFile.basename, noteContent);
  const excalidrawJson = buildRichExcalidrawJson(spec, noteFile.path);

  const drawingFileName = `${noteFile.basename}.excalidraw.md`;
  const drawingPath = normalizePath(`${targetDir}/${drawingFileName}`);

  const excalidrawFileContent = `---

excalidraw-plugin: parsed
tags: [ea/drawing, excalidraw, architecture]

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

/**
 * Creates a rich standalone Excalidraw drawing in a specified folder
 */
export async function createStandaloneRichExcalidrawDrawing(
  app: App,
  settings: NemotronPluginSettings,
  title: string,
  content: string,
  targetFolder: string = "Excalidrawings",
  sourceNotePath?: string
): Promise<{ drawingPath: string; drawingFile: TFile; foldersCreated: string[] }> {
  const foldersCreated: string[] = [];
  const cleanFolder = targetFolder ? normalizePath(targetFolder) : "Excalidrawings";

  const segments = cleanFolder.split("/").filter((s) => s.trim().length > 0);
  let currentDir = "";

  for (const seg of segments) {
    currentDir = currentDir ? `${currentDir}/${seg}` : seg;
    const exists = app.vault.getAbstractFileByPath(normalizePath(currentDir));
    if (!exists) {
      await app.vault.createFolder(normalizePath(currentDir));
      foldersCreated.push(normalizePath(currentDir));
    }
  }

  // Synthesize Rich AI Diagram Spec with Nemotron
  const spec = await synthesizeRichDiagramSpec(settings, title, content);
  const excalidrawJson = buildRichExcalidrawJson(spec, sourceNotePath);

  let safeTitle = title.replace(/[\\/:\*\?"<>\|]/g, "_").trim() || "Excalidraw Architecture";
  const drawingFileName = `${safeTitle}.excalidraw.md`;
  let drawingPath = normalizePath(`${cleanFolder}/${drawingFileName}`);

  let counter = 1;
  while (app.vault.getAbstractFileByPath(drawingPath)) {
    const altTitle = `${safeTitle} (${counter})`;
    drawingPath = normalizePath(`${cleanFolder}/${altTitle}.excalidraw.md`);
    counter++;
  }

  const linkedNoteHeader = sourceNotePath
    ? `> [!info] Linked Source Note\n> Source: [[${sourceNotePath}]]\n\n`
    : "";

  const excalidrawFileContent = `---

excalidraw-plugin: parsed
tags: [ea/drawing, excalidraw, architecture]

---
==Decompressed Markdown File==
${linkedNoteHeader}# Drawing
\`\`\`json
${excalidrawJson}
\`\`\`
%%
# Text Elements
%%
`;

  const drawingFile = (await app.vault.create(drawingPath, excalidrawFileContent)) as TFile;

  return {
    drawingPath,
    drawingFile,
    foldersCreated,
  };
}
