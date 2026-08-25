export type DiagramType = "mind-map" | "flowchart" | "architecture" | "timeline" | "decision-tree" | "comparison";
export type DiagramKind = "concept" | "process" | "decision" | "data" | "warning" | "result";
export type DiagramTheme = "dark" | "light";

export interface DiagramNode {
  id: string;
  title: string;
  details: string[];
  kind: DiagramKind;
  importance: 1 | 2 | 3;
  groupId?: string;
  sourceHeading?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  kind?: "normal" | "error" | "optional";
}

export interface DiagramGroup { id: string; title: string; }
export interface DiagramSpec {
  type: DiagramType;
  title: string;
  subtitle?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  takeaways: string[];
}

export interface DiagramInput { title: string; content: string; sourceNotePath?: string; }
export interface DiagramOptions {
  type: DiagramType | "auto";
  detail: "compact" | "balanced" | "detailed";
  direction: "right" | "down";
  theme: DiagramTheme;
  maxNodes: number;
}
export interface DiagramSynthesisRequest extends DiagramInput { type: DiagramType; maxNodes: number; }
export interface DiagramSynthesizer { synthesize(request: DiagramSynthesisRequest, signal?: AbortSignal): Promise<unknown>; }
export interface DiagramResult { spec: DiagramSpec; excalidrawJson: string; warnings: string[]; }

const DEFAULT_OPTIONS: DiagramOptions = { type: "auto", detail: "balanced", direction: "right", theme: "dark", maxNodes: 10 };
const TYPES = new Set<DiagramType>(["mind-map", "flowchart", "architecture", "timeline", "decision-tree", "comparison"]);
const KINDS = new Set<DiagramKind>(["concept", "process", "decision", "data", "warning", "result"]);

export class DiagramEngine {
  constructor(private readonly synthesizer?: DiagramSynthesizer) {}

  public async generate(input: DiagramInput, supplied: Partial<DiagramOptions> = {}, signal?: AbortSignal): Promise<DiagramResult> {
    const options = { ...DEFAULT_OPTIONS, ...supplied };
    options.maxNodes = Math.max(3, Math.min(30, Math.round(options.maxNodes)));
    const visualLimit = options.detail === "compact" ? 7 : options.detail === "detailed" ? 14 : 10;
    options.maxNodes = Math.min(options.maxNodes, visualLimit);
    const detected = options.type === "auto" ? detectDiagramType(input.content) : options.type;
    const warnings: string[] = [];
    let raw: unknown;
    if (this.synthesizer) {
      try {
        raw = await this.synthesizer.synthesize({ ...input, type: detected, maxNodes: options.maxNodes }, signal);
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        warnings.push("Model synthesis failed. A local content diagram was used.");
      }
    }
    const spec = normalizeSpec(raw, input, detected, options, warnings);
    return { spec, warnings, excalidrawJson: renderExcalidraw(spec, options, input.sourceNotePath) };
  }
}

export function detectDiagramType(content: string): DiagramType {
  const text = content.toLowerCase();
  const score: Record<DiagramType, number> = {
    "mind-map": count(text, /\b(concept|idea|topic|principle|overview|includes|consists)\b/g),
    flowchart: count(text, /\b(first|then|next|finally|step|process|workflow|input|output)\b/g),
    architecture: count(text, /\b(system|service|module|database|server|client|architecture|component)\b/g),
    timeline: count(text, /\b(year|month|day|before|after|timeline|history|phase|milestone|\d{4})\b/g),
    "decision-tree": count(text, /\b(if|else|when|otherwise|decision|choose|condition|yes|no)\b/g),
    comparison: count(text, /\b(versus|vs\.?|compare|difference|advantage|disadvantage|pros|cons)\b/g),
  };
  return (Object.entries(score) as [DiagramType, number][]).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? (Object.entries(score) as [DiagramType, number][]).sort((a, b) => b[1] - a[1])[0][0]
    : "mind-map";
}

function count(value: string, pattern: RegExp): number { return value.match(pattern)?.length ?? 0; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" ? value as Record<string, unknown> : null; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.trim() : fallback; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "node"; }
function list(value: unknown, max: number): string[] { return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean).slice(0, max) : []; }

function normalizeSpec(raw: unknown, input: DiagramInput, detected: DiagramType, options: DiagramOptions, warnings: string[]): DiagramSpec {
  const source = record(raw);
  if (!source || !Array.isArray(source.nodes)) {
    if (raw !== undefined) warnings.push("The model diagram was invalid. A local content diagram was used.");
    return fallbackSpec(input, detected, options);
  }
  const typeValue = text(source.type) as DiagramType;
  const type = TYPES.has(typeValue) ? typeValue : detected;
  const detailLimit = options.detail === "compact" ? 0 : options.detail === "detailed" ? 2 : 1;
  const used = new Set<string>();
  const originalIds = new Set<string>();
  const nodes: DiagramNode[] = [];
  for (const item of source.nodes.slice(0, options.maxNodes)) {
    const node = record(item);
    if (!node) continue;
    const title = text(node.title).slice(0, 72);
    if (!title) continue;
    const original = slug(text(node.id, title));
    let id = original;
    let suffix = 2;
    while (used.has(id)) id = `${original}-${suffix++}`;
    used.add(id);
    originalIds.add(original);
    const kindValue = text(node.kind) as DiagramKind;
    const importance = Number(node.importance);
    nodes.push({
      id,
      title: title.slice(0, 48),
      details: list(node.details ?? node.bullets, detailLimit).map((item) => item.slice(0, 76)),
      kind: KINDS.has(kindValue) ? kindValue : "concept",
      importance: importance === 1 || importance === 3 ? importance : 2,
      groupId: text(node.groupId) ? slug(text(node.groupId)) : undefined,
      sourceHeading: text(node.sourceHeading) || undefined,
    });
  }
  if (nodes.length < 2) return fallbackSpec(input, detected, options);
  const ids = new Set(nodes.map((node) => node.id));
  const duplicateOriginals = new Set(nodes.filter((node) => /-\d+$/.test(node.id)).map((node) => node.id.replace(/-\d+$/, "")));
  const edges: DiagramEdge[] = [];
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  if (Array.isArray(source.edges)) {
    const candidates: DiagramEdge[] = [];
    for (const item of source.edges) {
      const edge = record(item);
      if (!edge) continue;
      const from = slug(text(edge.from));
      const to = slug(text(edge.to));
      if (!ids.has(from) || !ids.has(to) || from === to || duplicateOriginals.has(from) || duplicateOriginals.has(to)) continue;
      candidates.push({ from, to, label: text(edge.label).slice(0, 28) || undefined, kind: text(edge.kind) === "error" ? "error" : text(edge.kind) === "optional" ? "optional" : "normal" });
    }
    const priority = { error: 0, normal: 1, optional: 2 } as const;
    candidates.sort((a, b) => priority[a.kind ?? "normal"] - priority[b.kind ?? "normal"]);
    for (const edge of candidates) {
      if ((outgoingCount.get(edge.from) ?? 0) >= 2 || (incomingCount.get(edge.to) ?? 0) >= 2 || edges.length >= nodes.length + 2) continue;
      edges.push(edge);
      outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }
  }
  const groups = Array.isArray(source.groups) ? source.groups.map(record).filter(Boolean).map((group) => ({ id: slug(text(group!.id, text(group!.title))), title: text(group!.title).slice(0, 56) })).filter((group) => group.title) : [];
  return { type, title: text(source.title, input.title).slice(0, 80), subtitle: text(source.subtitle).slice(0, 100) || undefined, nodes, edges, groups, takeaways: list(source.takeaways, 5) };
}

function fallbackSpec(input: DiagramInput, type: DiagramType, options: DiagramOptions): DiagramSpec {
  const headings = [...input.content.matchAll(/^#{1,4}\s+(.+)$/gm)].map((match) => match[1].trim());
  const sentences = input.content.replace(/^---[\s\S]*?---\s*/m, "").split(/(?:\r?\n)+|(?<=[.!?])\s+/).map((part) => part.replace(/^[-*\d.)\s]+/, "").trim()).filter((part) => part.length > 12);
  const labels = (headings.length >= 2 ? headings : sentences).slice(0, options.maxNodes - 1);
  const rootId = slug(input.title);
  const nodes: DiagramNode[] = [{ id: rootId, title: input.title, details: [], kind: "concept", importance: 3 }];
  labels.forEach((label, index) => nodes.push({ id: uniqueId(slug(label), nodes), title: label.slice(0, 72), details: sentences.filter((sentence) => sentence !== label).slice(index, index + (options.detail === "compact" ? 1 : 2)).map((sentence) => sentence.slice(0, 100)), kind: type === "decision-tree" && /\b(if|when|whether)\b/i.test(label) ? "decision" : type === "timeline" ? "process" : "concept", importance: 2 }));
  if (nodes.length < 3) {
    ["Core idea", "Key details"].forEach((title) => nodes.push({ id: uniqueId(slug(title), nodes), title, details: [], kind: "concept", importance: 2 }));
  }
  const edges = type === "mind-map" ? nodes.slice(1).map((node) => ({ from: rootId, to: node.id })) : nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return { type, title: input.title, subtitle: typeLabel(type), nodes, edges, groups: [], takeaways: sentences.slice(0, 3).map((sentence) => sentence.slice(0, 120)) };
}

function uniqueId(base: string, nodes: DiagramNode[]): string { let id = base, n = 2; const ids = new Set(nodes.map((node) => node.id)); while (ids.has(id)) id = `${base}-${n++}`; return id; }
function typeLabel(type: DiagramType): string { return type.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }

interface Box { id: string; x: number; y: number; width: number; height: number; }
const PALETTES = {
  dark: { canvas: "#0b1020", panel: "#182033", text: "#f8fafc", muted: "#cbd5e1", edge: "#7dd3fc", accents: ["#2563eb", "#7c3aed", "#0f766e", "#b45309", "#be123c"] },
  light: { canvas: "#f8fafc", panel: "#ffffff", text: "#172033", muted: "#475569", edge: "#0369a1", accents: ["#bfdbfe", "#ddd6fe", "#99f6e4", "#fde68a", "#fecdd3"] },
};
const KIND_COLORS: Record<DiagramKind, string> = {
  concept: "#8b5cf6",
  process: "#3b82f6",
  decision: "#14b8a6",
  data: "#f59e0b",
  warning: "#ef4444",
  result: "#10b981",
};

function wrap(value: string, max = 32): string[] {
  const words = value.split(/\s+/); const lines: string[] = []; let line = "";
  for (const word of words) { if (`${line} ${word}`.trim().length > max && line) { lines.push(line); line = word; } else line = `${line} ${word}`.trim(); }
  if (line) lines.push(line); return lines;
}

function nodeTextMetrics(node: DiagramNode): { titleLines: string[]; detailLines: string[]; contentHeight: number } {
  const isDecision = node.kind === "decision";
  const titleLines = wrap(node.title, isDecision ? 18 : 26);
  const detailLines = node.details.flatMap((item) => wrap(`• ${item}`, isDecision ? 20 : 34));
  const contentHeight = titleLines.length * 24 + (detailLines.length ? 8 + detailLines.length * 22 : 0);
  return { titleLines, detailLines, contentHeight };
}

function layout(spec: DiagramSpec, direction: "right" | "down"): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const dimensions = new Map(spec.nodes.map((node) => {
    const metrics = nodeTextMetrics(node);
    if (node.kind === "decision") {
      const width = node.importance === 3 ? 380 : 360;
      const height = Math.max(160, Math.ceil((metrics.contentHeight + 8) / 0.42));
      return [node.id, { width, height }];
    }
    return [node.id, { width: node.importance === 3 ? 340 : 300, height: Math.max(112, 38 + metrics.titleLines.length * 24 + metrics.detailLines.length * 22) }];
  }));
  if (spec.type === "mind-map") {
    const root = spec.nodes[0]; const rootDim = dimensions.get(root.id)!; const rest = spec.nodes.slice(1); const sideCount = Math.ceil(rest.length / 2);
    boxes.set(root.id, { id: root.id, x: 520, y: 180 + Math.max(0, sideCount - 1) * 145, ...rootDim });
    rest.forEach((node, index) => { const left = index % 2 === 0; const row = Math.floor(index / 2); const dim = dimensions.get(node.id)!; boxes.set(node.id, { id: node.id, x: left ? 80 : 980, y: 140 + row * 290, ...dim }); });
    return boxes;
  }
  if (spec.type === "timeline") {
    spec.nodes.forEach((node, index) => { const dim = dimensions.get(node.id)!; boxes.set(node.id, { id: node.id, x: 100 + index * 330, y: 280 + (index % 2) * 170, ...dim }); }); return boxes;
  }
  if (spec.type === "comparison") {
    const groupOrder = [...new Set(spec.nodes.map((node) => node.groupId || "items"))]; const counters = new Map<string, number>();
    spec.nodes.forEach((node) => { const group = node.groupId || "items"; const col = groupOrder.indexOf(group); const row = counters.get(group) ?? 0; counters.set(group, row + 1); const dim = dimensions.get(node.id)!; boxes.set(node.id, { id: node.id, x: 120 + col * 380, y: 240 + row * 290, ...dim }); }); return boxes;
  }
  const order = new Map(spec.nodes.map((node, index) => [node.id, index]));
  const rank = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    for (const edge of spec.edges) {
      if ((order.get(edge.to) ?? 0) <= (order.get(edge.from) ?? 0)) continue;
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(edge.from) ?? 0) + 1));
    }
  }
  const levels = new Map<number, DiagramNode[]>();
  spec.nodes.forEach((node) => { const level = rank.get(node.id)!; levels.set(level, [...(levels.get(level) ?? []), node]); });
  const laneById = new Map<string, number>();
  [...levels.keys()].sort((a, b) => a - b).forEach((level) => {
    const nodes = levels.get(level)!;
    if (level > 0) {
      nodes.sort((a, b) => {
        const averageLane = (node: DiagramNode) => {
          const lanes = spec.edges.filter((edge) => edge.to === node.id).map((edge) => laneById.get(edge.from)).filter((lane): lane is number => lane !== undefined);
          return lanes.length ? lanes.reduce((sum, lane) => sum + lane, 0) / lanes.length : Number.MAX_SAFE_INTEGER;
        };
        return averageLane(a) - averageLane(b);
      });
    }
    nodes.forEach((node, lane) => {
      laneById.set(node.id, lane);
      const dim = dimensions.get(node.id)!;
      boxes.set(node.id, direction === "right" ? { id: node.id, x: 120 + level * 400, y: 180 + lane * 290, ...dim } : { id: node.id, x: 120 + lane * 380, y: 170 + level * 320, ...dim });
    });
  });
  return boxes;
}

function base(id: string, type: string, x: number, y: number, width: number, height: number) {
  const seed = hash(id); return { id, type, x, y, width, height, angle: 0, strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: type === "rectangle" ? { type: 3 } : null, seed, version: 1, versionNonce: seed + 17, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}
function hash(value: string): number { let h = 2166136261; for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return Math.abs(h) || 1; }

function renderExcalidraw(spec: DiagramSpec, options: DiagramOptions, source?: string): string {
  const palette = PALETTES[options.theme]; const boxes = layout(spec, options.direction); const elements: Record<string, unknown>[] = [];
  elements.push({ ...base("diagram-title", "text", 80, 55, 1000, 40), strokeColor: palette.text, backgroundColor: "transparent", fillStyle: "solid", text: spec.title, originalText: spec.title, fontSize: 28, fontFamily: 1, textAlign: "left", verticalAlign: "top", baseline: 28, containerId: null, lineHeight: 1.2, link: source ? `[[${source}]]` : null });
  if (spec.subtitle) elements.push({ ...base("diagram-subtitle", "text", 80, 98, 1000, 24), strokeColor: palette.muted, backgroundColor: "transparent", fillStyle: "solid", text: spec.subtitle, originalText: spec.subtitle, fontSize: 16, fontFamily: 1, textAlign: "left", verticalAlign: "top", baseline: 16, containerId: null, lineHeight: 1.2 });
  spec.groups.forEach((group, index) => {
    const memberBoxes = spec.nodes.filter((node) => node.groupId === group.id).map((node) => boxes.get(node.id)).filter((box): box is Box => Boolean(box));
    if (!memberBoxes.length) return;
    const left = Math.min(...memberBoxes.map((box) => box.x)) - 28;
    const top = Math.min(...memberBoxes.map((box) => box.y)) - 62;
    const right = Math.max(...memberBoxes.map((box) => box.x + box.width)) + 28;
    const bottom = Math.max(...memberBoxes.map((box) => box.y + box.height)) + 28;
    const color = palette.accents[index % palette.accents.length];
    elements.push({ ...base(`group-${group.id}`, "rectangle", left, top, right - left, bottom - top), strokeColor: color, backgroundColor: "transparent", fillStyle: "solid", strokeStyle: "dashed", strokeWidth: 1, roughness: 0 });
    elements.push({ ...base(`group-${group.id}-title`, "text", left + 16, top + 14, right - left - 32, 24), strokeColor: palette.text, backgroundColor: "transparent", fillStyle: "solid", text: group.title, originalText: group.title, fontSize: 16, fontFamily: 1, textAlign: "left", verticalAlign: "top", baseline: 16, containerId: null, lineHeight: 1.2 });
  });
  const canvasRight = Math.max(...[...boxes.values()].map((box) => box.x + box.width));
  const canvasBottom = Math.max(...[...boxes.values()].map((box) => box.y + box.height));
  let feedbackLane = 0;
  for (const edge of spec.edges) {
    const from = boxes.get(edge.from), to = boxes.get(edge.to); if (!from || !to) continue;
    const sx = from.x + from.width / 2, sy = from.y + from.height / 2, tx = to.x + to.width / 2, ty = to.y + to.height / 2; const horizontal = Math.abs(tx - sx) >= Math.abs(ty - sy);
    const isFeedback = options.direction === "down" ? to.y < from.y : to.x < from.x;
    let startX = horizontal ? (tx > sx ? from.x + from.width : from.x) : sx;
    let startY = horizontal ? sy : (ty > sy ? from.y + from.height : from.y);
    let endX = horizontal ? (tx > sx ? to.x : to.x + to.width) : tx;
    let endY = horizontal ? ty : (ty > sy ? to.y : to.y + to.height);
    let points: number[][];
    let labelX: number;
    let labelY: number;
    if (isFeedback && options.direction === "down") {
      startX = from.x + from.width; startY = sy; endX = to.x + to.width; endY = ty;
      const outsideX = canvasRight + 100 + feedbackLane++ * 36;
      points = [[0, 0], [outsideX - startX, 0], [outsideX - startX, endY - startY], [endX - startX, endY - startY]];
      labelX = outsideX - 70; labelY = (startY + endY) / 2;
    } else if (isFeedback) {
      startX = sx; startY = from.y + from.height; endX = tx; endY = to.y + to.height;
      const outsideY = canvasBottom + 100 + feedbackLane++ * 36;
      points = [[0, 0], [0, outsideY - startY], [endX - startX, outsideY - startY], [endX - startX, endY - startY]];
      labelX = (startX + endX) / 2; labelY = outsideY;
    } else {
      const dx = endX - startX, dy = endY - startY;
      points = horizontal ? [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]] : [[0, 0], [0, dy / 2], [dx, dy / 2], [dx, dy]];
      labelX = (startX + endX) / 2; labelY = (startY + endY) / 2;
    }
    const dx = endX - startX, dy = endY - startY;
    const id = `edge-${edge.from}-${edge.to}`; elements.push({ ...base(id, "arrow", startX, startY, dx, dy), strokeColor: edge.kind === "error" ? "#ef4444" : palette.edge, backgroundColor: "transparent", fillStyle: "solid", strokeStyle: edge.kind === "optional" || edge.kind === "error" ? "dashed" : "solid", points, lastCommittedPoint: null, startBinding: { elementId: from.id, focus: 0, gap: 8 }, endBinding: { elementId: to.id, focus: 0, gap: 8 }, startArrowhead: null, endArrowhead: "arrow" });
    if (edge.label) { const label = edge.label; elements.push({ ...base(`${id}-label`, "text", labelX - 70, labelY - 18, 140, 22), strokeColor: palette.muted, backgroundColor: palette.canvas, fillStyle: "solid", text: label, originalText: label, fontSize: 13, fontFamily: 1, textAlign: "center", verticalAlign: "middle", baseline: 13, containerId: null, lineHeight: 1.2 }); }
  }
  spec.nodes.forEach((node) => {
    const box = boxes.get(node.id)!; const accent = KIND_COLORS[node.kind]; const shape = node.kind === "decision" ? "diamond" : node.kind === "result" ? "ellipse" : "rectangle";
    elements.push({ ...base(node.id, shape, box.x, box.y, box.width, box.height), strokeColor: accent, backgroundColor: node.importance === 3 ? accent : palette.panel, fillStyle: "solid", boundElements: spec.edges.filter((edge) => edge.from === node.id || edge.to === node.id).map((edge) => ({ id: `edge-${edge.from}-${edge.to}`, type: "arrow" })), link: node.sourceHeading && source ? `[[${source}#${node.sourceHeading}]]` : null });
    const { titleLines, detailLines, contentHeight } = nodeTextMetrics(node);
    const titleText = titleLines.join("\n");
    const textColor = node.importance === 3 && options.theme === "dark" ? "#ffffff" : palette.text;
    const isDecision = node.kind === "decision";
    const textWidth = isDecision ? box.width * 0.5 : box.width - 36;
    const textX = isDecision ? box.x + (box.width - textWidth) / 2 : box.x + 18;
    const contentTop = isDecision ? box.y + (box.height - contentHeight) / 2 : box.y + 16;
    elements.push({ ...base(`${node.id}-title-text`, "text", textX, contentTop, textWidth, titleLines.length * 24), strokeColor: textColor, backgroundColor: "transparent", fillStyle: "solid", text: titleText, originalText: titleText, fontSize: node.importance === 3 ? 20 : 18, fontFamily: 1, textAlign: isDecision ? "center" : "left", verticalAlign: "top", baseline: 18, containerId: null, lineHeight: 1.25 });
    if (node.details.length) {
      const detailText = detailLines.join("\n");
      const detailY = contentTop + titleLines.length * 24 + 8;
      elements.push({ ...base(`${node.id}-detail-text`, "text", textX, detailY, textWidth, detailLines.length * 22), strokeColor: node.importance === 3 && options.theme === "dark" ? "#dbeafe" : palette.muted, backgroundColor: "transparent", fillStyle: "solid", text: detailText, originalText: detailText, fontSize: 16, fontFamily: 1, textAlign: isDecision ? "center" : "left", verticalAlign: "top", baseline: 16, containerId: null, lineHeight: 1.35 });
    }
  });
  if (spec.takeaways.length) {
    const boxList = [...boxes.values()];
    const left = Math.min(80, ...boxList.map((box) => box.x));
    const top = Math.max(...boxList.map((box) => box.y + box.height)) + 70;
    const lines = spec.takeaways.flatMap((item) => wrap(`✓ ${item}`, 90));
    const width = Math.max(720, Math.max(...boxList.map((box) => box.x + box.width)) - left);
    const height = 54 + lines.length * 20;
    elements.push({ ...base("diagram-takeaways", "rectangle", left, top, width, height), strokeColor: palette.accents[1], backgroundColor: palette.panel, fillStyle: "solid", roughness: 0 });
    const body = ["Key takeaways", ...lines].join("\n");
    elements.push({ ...base("diagram-takeaways-text", "text", left + 20, top + 16, width - 40, height - 28), strokeColor: palette.text, backgroundColor: "transparent", fillStyle: "solid", text: body, originalText: body, fontSize: 14, fontFamily: 1, textAlign: "left", verticalAlign: "top", baseline: 14, containerId: null, lineHeight: 1.4 });
  }
  return JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { gridSize: null, viewBackgroundColor: palette.canvas }, files: {} }, null, 2);
}
