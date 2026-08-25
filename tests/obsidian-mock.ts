export class TFolder {
  path: string;
  name: string;
  parent: TFolder | null;
  children: Array<TFile | TFolder> = [];

  constructor(path: string, parent: TFolder | null = null) {
    this.path = path;
    this.name = path.split("/").pop() || "";
    this.parent = parent;
  }
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  parent: TFolder | null;
  stat = { mtime: 1 };

  constructor(path: string, parent: TFolder | null = null) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    this.basename = this.name.replace(/\.md$/, "");
    this.parent = parent;
  }
}

export class Modal {
  app: unknown;
  contentEl = { empty() {} };

  constructor(app: unknown) {
    this.app = app;
  }

  close() {}
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class MarkdownView {}
export class Menu {}
export class App {}

export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const part of input.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export async function requestUrl(): Promise<never> {
  throw new Error("Network requests are not available in tests.");
}
