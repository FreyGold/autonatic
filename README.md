# Nemotron Note Crafter - Obsidian Plugin

Transform raw, dense, or unorganized text into concise, beautifully structured notes strictly formatted **"The Obsidian Way"**, powered by NVIDIA's `nvidia/nemotron-3-ultra-550b-a55b` model.

## ✨ Features

- 🧠 **NVIDIA Nemotron-3 Ultra Integration**: Pre-configured with NVIDIA integrate API, streaming responses, and reasoning/thinking support.
- 📝 **The Obsidian Way Skill Prompt**:
  - **YAML Properties / Frontmatter**: `title`, `aliases`, `tags`, `created`, `summary`, `status`.
  - **Callouts**: Strategic use of `> [!summary]`, `> [!info]`, `> [!tip]`, `> [!warning]`.
  - **Wikilinks**: Auto-links related concepts `[[Topic]]` for Obsidian Graph View connectivity.
  - **Structure**: Clear headings, bold lead-in bullet points, tables, and mermaid diagrams.
- 🎯 **Dual Generation Modes**:
  - **Create New Note File**: Creates a new `.md` file in your vault with auto-detected title or custom folder.
  - **Append to Current Note**: Adds the formatted section directly to the end of your active note.
  - **In-Place Replace**: Transform selected text right inside the active editor.
- ⚡ **Interactive UI**:
  - Ribbon icon for one-click access.
  - Streaming live preview with collapsible reasoning thought process.
  - Full settings tab to customize API keys, models, temperatures, folders, and prompt instructions.

## 🚀 How to Use

1. Click the **wand ribbon icon** or use `Ctrl/Cmd + P` and search for **"Nemotron Note Crafter"**.
2. Paste any text into the modal (or select text in an editor first to auto-populate).
3. Choose your destination:
   - **Create New Note File** (Specify title and folder if desired).
   - **Append to Current Active Note**.
4. Click **⚡ Transform to Obsidian Note**.

## ⚙️ Settings

Go to **Obsidian Settings > Nemotron Note Crafter** to configure:
- **API Key**: Pre-configured default NVIDIA API key.
- **Model**: `nvidia/nemotron-3-ultra-550b-a55b`.
- **Enable Thinking**: Toggle deep reasoning tokens.
- **Obsidian Skill System Prompt**: Customize the formatting instructions.
- **Default Folder**: Folder path where new notes are created.
