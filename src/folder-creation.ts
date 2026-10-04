import { TFolder, type App } from "obsidian";
import { normalizeVaultFolderPath } from "./note-destination";

/** Create a vault folder only after its full path has passed validation. */
export async function createVaultFolder(app: Pick<App, "vault">, requestedPath: string): Promise<string> {
  const path = normalizeVaultFolderPath(requestedPath);
  if (!path) throw new Error("Enter a folder name.");
  const parts = path.split("/");
  const prefixes = parts.map((_, index) => parts.slice(0, index + 1).join("/"));

  for (const prefix of prefixes) {
    const existing = app.vault.getAbstractFileByPath(prefix);
    if (existing && !(existing instanceof TFolder)) {
      throw new Error(`A file already uses the path “${prefix}”.`);
    }
  }

  for (const prefix of prefixes) {
    const existing = app.vault.getAbstractFileByPath(prefix);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`A file already uses the path “${prefix}”.`);
    try {
      await app.vault.createFolder(prefix);
    } catch (error) {
      // Another picker or a sync update may have created the same folder.
      if (!(app.vault.getAbstractFileByPath(prefix) instanceof TFolder)) throw error;
    }
  }
  return path;
}
