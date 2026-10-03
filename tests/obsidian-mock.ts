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
  stat = { mtime: 1, size: 0 };

  constructor(path: string, parent: TFolder | null = null) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    this.basename = this.name.replace(/\.md$/, "");
    this.parent = parent;
  }
}

export class FileSystemAdapter {
  getBasePath(): string { return "test-vault"; }
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

export class Component {
  load() {}
  unload() {}
}

export class MarkdownRenderer {
  static async render() {}
}

export function setIcon() {}
export function addIcon() {}

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

type RequestUrlHandler = (request: Record<string, any>) => unknown | Promise<unknown>;
let requestUrlHandler: RequestUrlHandler | undefined;

export function mockRequestUrl(handler: RequestUrlHandler): () => void {
  const previous = requestUrlHandler;
  requestUrlHandler = handler;
  return () => { requestUrlHandler = previous; };
}

export async function requestUrl(request: Record<string, any>): Promise<any> {
  if (requestUrlHandler) return requestUrlHandler(request);
  throw new Error("Network requests are not available in tests.");
}
