import type { DiagramType } from "./diagram-engine";

export type SmartNoteChangeAction = "created" | "appended" | "split";
export type DiagramDecisionAction = "skip" | "create" | "update";

export interface SmartNoteChange {
  path: string;
  title: string;
  action: SmartNoteChangeAction;
  addedContent: string;
  finalContent: string;
  existingDrawingPath?: string;
}

export interface DiagramDecision {
  action: DiagramDecisionAction;
  notePath: string;
  reason: string;
  focusQuestion?: string;
  type?: DiagramType;
  priority: number;
  existingDrawingPath?: string;
}

export interface DiagramPlan {
  decisions: DiagramDecision[];
  selected: DiagramDecision[];
  skipped: DiagramDecision[];
}

export interface DiagramPlanningRequest {
  candidates: Array<{
    id: string;
    path: string;
    title: string;
    action: SmartNoteChangeAction;
    addedContent: string;
    finalContent: string;
    hasExistingDrawing: boolean;
  }>;
}

export interface DiagramPlanningAdapter {
  decide(request: DiagramPlanningRequest, signal?: AbortSignal): Promise<unknown>;
}

const BATCH_SIZE = 8;
const MAX_EXCERPT_LENGTH = 5000;
const DIAGRAM_TYPES = new Set<DiagramType>([
  "mind-map",
  "flowchart",
  "architecture",
  "timeline",
  "decision-tree",
  "comparison",
]);

/**
 * Chooses useful diagrams after every Smart note write has completed.
 * Model failures are conservative: an unapproved candidate is skipped.
 */
export class UsefulDiagramPlanner {
  constructor(private readonly adapter: DiagramPlanningAdapter) {}

  async plan(changes: SmartNoteChange[], maxAutomaticDiagrams: number, signal?: AbortSignal): Promise<DiagramPlan> {
    const uniqueChanges = deduplicateChanges(changes);
    const limit = Math.max(0, Math.floor(maxAutomaticDiagrams));
    if (uniqueChanges.length === 0) return { decisions: [], selected: [], skipped: [] };
    if (limit === 0) {
      const skipped = uniqueChanges.map((change) => skipDecision(change, "Automatic diagrams are disabled."));
      return { decisions: skipped, selected: [], skipped };
    }

    const proposed = new Map<string, DiagramDecision>();
    for (let start = 0; start < uniqueChanges.length; start += BATCH_SIZE) {
      const batch = uniqueChanges.slice(start, start + BATCH_SIZE);
      try {
        const raw = await this.adapter.decide({ candidates: batch.map(toPlanningCandidate) }, signal);
        for (const decision of normalizeBatchDecisions(raw, batch)) {
          proposed.set(decision.notePath, decision);
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        for (const change of batch) {
          proposed.set(change.path, skipDecision(change, "The diagram usefulness check failed."));
        }
      }
    }

    const approved = uniqueChanges
      .map((change) => proposed.get(change.path) ?? skipDecision(change, "The planner did not approve a diagram."))
      .filter((decision) => decision.action !== "skip")
      .sort((left, right) => right.priority - left.priority);
    const selectedPaths = new Set(approved.slice(0, limit).map((decision) => decision.notePath));

    const decisions = uniqueChanges.map((change) => {
      const decision = proposed.get(change.path) ?? skipDecision(change, "The planner did not approve a diagram.");
      if (decision.action !== "skip" && !selectedPaths.has(decision.notePath)) {
        return skipDecision(change, "A higher-value diagram used the automatic diagram limit.");
      }
      return decision;
    });
    return {
      decisions,
      selected: decisions.filter((decision) => decision.action !== "skip"),
      skipped: decisions.filter((decision) => decision.action === "skip"),
    };
  }
}

function deduplicateChanges(changes: SmartNoteChange[]): SmartNoteChange[] {
  const byPath = new Map<string, SmartNoteChange>();
  for (const change of changes) {
    const previous = byPath.get(change.path);
    if (!previous) {
      byPath.set(change.path, change);
      continue;
    }
    byPath.set(change.path, {
      ...change,
      action: previous.action === "created" ? "created" : change.action,
      addedContent: [previous.addedContent, change.addedContent].filter(Boolean).join("\n\n"),
      existingDrawingPath: change.existingDrawingPath ?? previous.existingDrawingPath,
    });
  }
  return Array.from(byPath.values());
}

function toPlanningCandidate(change: SmartNoteChange): DiagramPlanningRequest["candidates"][number] {
  return {
    id: change.path,
    path: change.path,
    title: change.title,
    action: change.action,
    addedContent: balancedExcerpt(change.addedContent || change.finalContent),
    finalContent: balancedExcerpt(change.finalContent),
    hasExistingDrawing: Boolean(change.existingDrawingPath),
  };
}

function balancedExcerpt(content: string): string {
  const clean = content.trim();
  if (clean.length <= MAX_EXCERPT_LENGTH) return clean;
  const divider = "\n\n[...middle omitted for usefulness check...]\n\n";
  const available = MAX_EXCERPT_LENGTH - divider.length;
  const startLength = Math.ceil(available * 0.55);
  return clean.slice(0, startLength) + divider + clean.slice(-(available - startLength));
}

function normalizeBatchDecisions(raw: unknown, batch: SmartNoteChange[]): DiagramDecision[] {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const items = Array.isArray(raw) ? raw : value && Array.isArray(value.decisions) ? value.decisions : [];
  const byPath = new Map(batch.map((change) => [change.path, change]));
  const decisions = new Map<string, DiagramDecision>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const notePath = stringValue(record.id || record.notePath);
    const change = byPath.get(notePath);
    if (!change || decisions.has(notePath)) continue;
    const approved = stringValue(record.action).toLowerCase() !== "skip";
    const reason = stringValue(record.reason) || (approved ? "A visual structure was approved." : "A diagram would not improve this note.");
    if (!approved) {
      decisions.set(notePath, skipDecision(change, reason));
      continue;
    }
    const focusQuestion = stringValue(record.focusQuestion).slice(0, 160);
    const type = stringValue(record.type) as DiagramType;
    if (!focusQuestion || !DIAGRAM_TYPES.has(type)) {
      decisions.set(notePath, skipDecision(change, "The planner did not provide a clear visual question and diagram type."));
      continue;
    }
    decisions.set(notePath, {
      action: change.existingDrawingPath ? "update" : "create",
      notePath,
      reason,
      focusQuestion,
      type,
      priority: clampPriority(record.priority),
      existingDrawingPath: change.existingDrawingPath,
    });
  }

  return batch.map((change) => decisions.get(change.path) ?? skipDecision(change, "The planner did not approve a diagram."));
}

function skipDecision(change: SmartNoteChange, reason: string): DiagramDecision {
  return {
    action: "skip",
    notePath: change.path,
    reason,
    priority: 0,
    existingDrawingPath: change.existingDrawingPath,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampPriority(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(5, Math.round(numeric))) : 3;
}
