import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GeminiTurn {
  user: string;
  gemini: string;
  attachments: number;
}

export interface GeminiConversation {
  title: string;
  url: string;
  turns: GeminiTurn[];
}

export type GeminiImportProgress =
  | { stage: "opening" }
  | { stage: "reading"; completed: number; total: number }
  | { stage: "finalizing" };

export function parseGeminiShareUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error("Paste a public Gemini conversation link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !["g.co", "gemini.google.com", "share.gemini.google"].includes(url.hostname.toLowerCase())) {
    throw new Error("Use a public Gemini conversation share link.");
  }
  const host = url.hostname.toLowerCase();
  const match = (host === "g.co"
    ? /^\/gemini\/share\/([a-zA-Z0-9_-]{6,64})\/?$/
    : host === "share.gemini.google"
    ? /^\/([a-zA-Z0-9_-]{6,64})\/?$/
    : /^\/share\/([a-zA-Z0-9_-]{6,64})\/?$/).exec(url.pathname);
  if (!match) throw new Error("This is not a Gemini conversation share link. In Gemini, choose Share conversation.");
  if (host === "share.gemini.google") return `https://share.gemini.google/${match[1]}`;
  return `https://gemini.google.com/share/${match[1]}`;
}

function cleanText(value: string): string {
  return value.replace(/\r/g, "").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatGeminiConversation(conversation: GeminiConversation): string {
  if (!conversation.turns.length) throw new Error("The shared page has no conversation turns.");
  const lines = [
    `# ${cleanText(conversation.title) || "Gemini conversation"}`,
    "",
    `Source: ${conversation.url}`,
  ];
  conversation.turns.forEach((turn, index) => {
    lines.push("", `## ${index + 1}. You`, "", cleanText(turn.user));
    if (turn.attachments) lines.push("", `[${turn.attachments} attachment${turn.attachments === 1 ? "" : "s"} in the shared conversation; open the source link to view.]`);
    lines.push("", `## ${index + 1}. Gemini`, "", cleanText(turn.gemini));
  });
  return cleanText(lines.join("\n"));
}

async function readGeminiPage(
  document: Document,
  signal?: AbortSignal,
  onProgress?: (progress: GeminiImportProgress) => void,
): Promise<Omit<GeminiConversation, "url">> {
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    if (["button", "script", "style", "svg", "mat-icon"].includes(tag)
      || node.getAttribute("aria-hidden") === "true"
      || node.classList.contains("cdk-visually-hidden")) return "";
    if (tag === "br") return "\n";
    if (tag === "pre") {
      const code = node.querySelector("code");
      const language = code?.className.match(/language-([\w+-]+)/)?.[1] || "";
      return `\n\n\`\`\`${language}\n${(code || node).textContent?.trim() || ""}\n\`\`\`\n\n`;
    }
    const inside = Array.from(node.childNodes).map(render).join("");
    if (tag === "code") return `\`${inside}\``;
    if (tag === "a") {
      const href = node.getAttribute("href");
      return href && /^https?:\/\//.test(href) ? `[${inside.trim()}](${href})` : inside;
    }
    if (["td", "th"].includes(tag)) return `${inside.trim()} | `;
    if (tag === "tr") return `\n| ${inside.trim()}\n`;
    if (tag === "li") return `\n- ${inside.trim()}\n`;
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inside.trim()}\n\n`;
    if (["p", "blockquote"].includes(tag)) return `\n${inside.trim()}\n`;
    if (["div", "ul", "ol", "table"].includes(tag)) return `${inside}\n`;
    return inside;
  };
  const clean = (value: string) => value.replace(/\r/g, "").replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  const turnElements = Array.from(document.querySelectorAll("share-turn-viewer"));
  const turns: GeminiTurn[] = [];
  onProgress?.({ stage: "reading", completed: 0, total: turnElements.length });
  for (const [index, turn] of turnElements.entries()) {
    if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
    const userLines = Array.from(turn.querySelectorAll("user-query .query-text-line"));
    const userAttachments = turn.querySelectorAll("user-query-file-preview").length;
    const userText = clean(userLines.map((line) => line.textContent || "").join("\n"));
    // An image/file-only prompt is a complete message, not an unloaded turn.
    const user = userText || (userAttachments > 0 ? "[Attachment-only message; no text was included.]" : "");
    const response = turn.querySelector("message-content .markdown");
    const gemini = response ? clean(render(response)) : "";
    const attachments = userAttachments + turn.querySelectorAll("message-content .markdown img").length;
    turns.push({ user, gemini, attachments });
    if ((index + 1) % 10 === 0 || index + 1 === turnElements.length) {
      onProgress?.({ stage: "reading", completed: index + 1, total: turnElements.length });
      if (index + 1 < turnElements.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return {
    title: document.querySelector("share-viewer h1")?.textContent?.trim() || "Gemini conversation",
    turns,
  };
}

function browserCandidates(): string[] {
  if (process.platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  if (process.platform === "win32") {
    const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((path): path is string => !!path);
    return ["chrome.exe", "msedge.exe", "brave.exe", ...programFiles.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ])];
  }
  return ["chromium", "chromium-browser", "google-chrome", "brave-browser", "brave"];
}

export async function importGeminiConversation(
  input: string,
  signal?: AbortSignal,
  onProgress?: (progress: GeminiImportProgress) => void,
): Promise<GeminiConversation> {
  const url = parseGeminiShareUrl(input);
  if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
  onProgress?.({ stage: "opening" });
  const profile = await mkdtemp(join(tmpdir(), "autonatic-gemini-"));
  try {
    const args = [
      "--headless", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions",
      "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=15000", "--dump-dom", url,
    ];
    let html = "";
    let foundBrowser = false;
    for (const browser of browserCandidates()) {
      try {
        const result = await execFileAsync(browser, args, { maxBuffer: 50 * 1024 * 1024, timeout: 45000, signal });
        html = result.stdout;
        foundBrowser = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
        throw new Error("Could not open the public Gemini page. Open it in your browser and copy the conversation text instead.");
      }
    }
    if (!foundBrowser) throw new Error("Gemini link import needs Chrome, Chromium, Edge, or Brave on this computer. You can copy the conversation text instead.");
    const document = new DOMParser().parseFromString(html, "text/html");
    const conversation = { ...await readGeminiPage(document, signal, onProgress), url };
    if (!conversation.turns.length || conversation.turns.some((turn) => !turn.user || !turn.gemini)) {
      throw new Error("The shared conversation did not load completely. Open the link in your browser and copy the conversation text instead.");
    }
    onProgress?.({ stage: "finalizing" });
    if (formatGeminiConversation(conversation).length > 1_000_000) {
      throw new Error("This conversation exceeds the 1 million character import limit.");
    }
    return conversation;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
