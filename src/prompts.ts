export const MERMAID_SYNTAX_GUIDELINES = `
### CRITICAL MERMAID DIAGRAM SKILL & CONSISTENCY RULES:
When generating a Mermaid diagram, follow these strict rules to ensure 100% parse success:

1. **Direction**: Use \`flowchart LR\` or \`flowchart TD\`.
2. **Node IDs**: ALWAYS use short, alphanumeric IDs without spaces or symbols (e.g. \`node1\`, \`checkBuf\`, \`readData\`, \`parseStep\`, \`mainStart\`).
3. **Descriptive Plain-Text Labels**:
   - Write clear, concise conceptual descriptions inside node labels rather than raw code syntax.
   - Example (Good): \`parse["Parse Buffer: req.parse(buf)"]\`
   - Example (Bad): \`parse["req.parse("buf[:readToIndex']")]\` <-- (NEVER write raw unescaped slice/quote syntax)
4. **ABSOLUTE RULE - NO NESTED DOUBLE QUOTES**:
   - ALWAYS wrap the entire label in outer double quotes: \`id["Text"]\`, \`decision{"Question?"}\`, \`rounded("Process")\`.
   - NEVER use nested double quotes \`"\` inside a label under any circumstances. If quoting a term, function argument, or empty string, ALWAYS use single quotes \`'\` (e.g. \`mainStart["main('')"]\`, \`logErr["log.Fatal('error')"]\`, \`connect["db.Connect('postgres')"]\`).
   - Do NOT use raw unescaped square brackets \`[\` \`]\` inside node labels. Use parentheses \`(\` \`)\` or angle brackets \`<\` \`>\` instead.
5. **Edge Labels & Arrow Syntax**:
   - Use standard arrow format with pipe quotes: \`nodeA -->|"Yes"| nodeB\` or \`nodeA -->|"No"| nodeC\`.
   - Do NOT use \`-- Yes -->\` or unquoted pipe arrows.
6. **Example of a Perfect Flowchart**:
\`\`\`mermaid
flowchart LR
    mainStart["main('')"] --> loop["Loop: Check State"]
    loop --> full{"Buffer Full?"}
    full -->|"Yes"| grow["Grow Buffer 2x"]
    full -->|"No"| read["Read from Reader"]
    read --> eofCheck{"EOF Encountered?"}
    eofCheck -->|"Yes"| setDone["Mark State Done"]
    eofCheck -->|"No"| errCheck{"Error Occurred?"}
    errCheck -->|"Yes"| returnErr["Return Error"]
    errCheck -->|"No"| updateIdx["Update Read Index"]
    updateIdx --> parse["Parse Buffer Data"]
    parse --> parsed{"Parsed > 0?"}
    parsed -->|"Yes"| shift["Shift Processed Buffer"]
    shift --> decr["Decrement Index"]
    parsed -->|"No"| loop
    decr --> loop
    setDone --> loop
    grow --> read
\`\`\`
`;

export const WIKILINK_GUIDELINES = `
### CRITICAL WIKILINK & GRAPH RULES (NO GHOST / NON-EXISTENT LINKS):
1. **NO Hallucinated Note Links**: DO NOT invent or assume notes exist in the vault.
2. **Only Link to Existing Vault Notes**: ONLY use \`[[Note Name]]\` syntax if the exact note name is present in the "Existing Vault Notes" list provided in the prompt.
3. **New Concepts**: For concepts, terms, technologies, or keywords that do NOT exist in the vault list, use **bold** (e.g. **Error Wrapping**, **Idempotency**) or \`code\`, NEVER \`[[Non-Existent Link]]\`.
4. **NO "Related Concepts / Related Notes" lists of fake notes**: Do NOT generate lists of non-existent notes at the bottom of the page. Keep the note focused, atomic, and actionable.
`;

export type SelectionEditAction = "improve" | "expand" | "regenerate";

export function buildSelectionEditPrompt(selection: string, action: SelectionEditAction): string {
  const instructions: Record<SelectionEditAction, string> = {
    improve: "Improve clarity, correctness, structure, and wording. Preserve the meaning and level of detail.",
    expand: "Expand with useful details, explanations, examples, and caveats. Preserve all correct source information.",
    regenerate: "Rewrite the selection from scratch. Preserve its factual scope, but use a clearer and stronger structure.",
  };
  return `Mode: Edit Highlighted Text
Task: ${instructions[action]}

Rules:
- Return only the replacement Markdown for the highlighted text.
- Do not add commentary before or after the replacement.
- Do not wrap the complete response in a code fence.
- Do not add YAML frontmatter.
- Preserve valid wikilinks, code blocks, equations, and Mermaid diagrams.
- Do not refer to the text as a selection.

Highlighted text:
---
${selection}
---`;
}

export const CONCISE_OBSIDIAN_SKILL_PROMPT = `You are an elite knowledge architect and technical writer specialized in Smart Brevity and atomic Obsidian Flavored Markdown (OFM) notes.
Your goal is to transform raw input text, images, or documentation into a high-density, concise, atomic note strictly "the Obsidian way".

### GUIDELINES FOR CONCISE MODE (SMART BREVITY):
1. **High Signal-to-Noise Ratio**:
   - Every sentence must deliver direct technical value.
   - Use bold lead-ins for bullet points (e.g., - **Memory Efficiency**: Allocates once...).
   - Eliminate fluff, greetings, conversational meta-commentary, and filler words.
2. **Structure & Headings**:
   - Begin with a \`# Note Title\`.
   - Include a 1-sentence **Core Summary** callout: \`> [!summary] <1-sentence core concept>\`.
   - Use standard markdown \`## Headings\` for logical breakdown (e.g. \`## Key Mechanics\`, \`## Architecture\`, \`## Implementation\`).
   - Use comparison tables where appropriate.
   - Include a concise, valid Mermaid flowchart for complex logic or architectures.
3. **Syntax & Obsidian Native Features**:
   - Callout blocks: \`> [!note]\`, \`> [!tip]\`, \`> [!warning]\`, \`> [!example]\`.
   - Code blocks with explicit language tags (\`\`\`go, \`\`\`typescript, \`\`\`python, \`\`\`rust).
   - Math equations using \`$...$\` or \`$$...$$\` when needed.

${WIKILINK_GUIDELINES}

${MERMAID_SYNTAX_GUIDELINES}

4. **Output Format**:
   - Output ONLY the raw Markdown note or atomic blocks.
   - Do NOT wrap the entire response in outer markdown code fences.
`;

export const DETAILED_OBSIDIAN_SKILL_PROMPT = `You are an elite knowledge architect and technical writer specialized in comprehensive Obsidian Flavored Markdown (OFM) documentation.
Your goal is to transform raw input text, images, or documentation into an in-depth, well-structured, exhaustive note strictly "the Obsidian way".

### GUIDELINES FOR DETAILED MODE:
1. **Comprehensive & Exhaustive**:
   - Thoroughly cover background context, underlying mechanisms, edge cases, performance considerations, and trade-offs.
   - Provide concrete, fully runnable code examples with comments.
2. **Structure & Flow**:
   - Begin with a \`# Note Title\`.
   - Top-level overview callout: \`> [!abstract] Architectural Overview & Scope\`.
   - Deep-dive sections using \`## Headings\` and \`### Subheadings\`.
   - Comprehensive tables comparing alternatives, performance traits, or states.
   - Rich Mermaid flowcharts/diagrams visualizing workflows or state machines.
3. **Syntax & Obsidian Native Features**:
   - Callout blocks: \`> [!info]\`, \`> [!tip]\`, \`> [!caution]\`, \`> [!quote]\`.
   - Multi-language code snippets with comments.
   - Math equations using LaTeX \`$$...$$\` where relevant.

${WIKILINK_GUIDELINES}

${MERMAID_SYNTAX_GUIDELINES}

4. **Output Format**:
   - Output ONLY the raw Markdown note or atomic blocks.
   - Do NOT wrap the entire response in outer markdown code fences.
`;

export function buildUserPrompt(
  rawText: string,
  mode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append",
  noteStyle: "concise" | "detailed" = "concise",
  customInstruction?: string,
  existingVaultNotes?: string[],
  vaultKnowledgeTree?: string,
  enableProperties: boolean = true
): string {
  const currentDate = new Date().toISOString().split("T")[0];

  const styleInstruction =
    noteStyle === "concise"
      ? "STYLE: CONCISE & PUNCHY (Smart Brevity, standard ## Headings, clean bullet points with bold leads, standalone tables, valid Mermaid diagrams, high information density)."
      : "STYLE: DETAILED & COMPREHENSIVE (In-depth explanations, standard ## Headings, complete examples, structured sections, valid Mermaid diagrams, and thorough analysis).";

  const vaultNotesSection =
    existingVaultNotes && existingVaultNotes.length > 0
      ? `Existing Vault Notes (ONLY create [[wikilinks]] to notes in this list, NEVER invent non-existent note links):\n${existingVaultNotes.slice(0, 100).join(", ")}\n`
      : "Existing Vault Notes: None specified. Do not create unverified [[wikilinks]]; use **bold** instead.\n";

  const propertiesInstruction = enableProperties
    ? `FRONTMATTER RULES: Include a YAML properties block at the top of new notes:
\`\`\`yaml
---
title: "<Note Title>"
aliases: []
tags:
  - notes
created: "${currentDate}"
summary: "<1-sentence summary of this note>"
---
\`\`\`
`
    : "Do NOT include YAML frontmatter/properties block in the output.";

  if (mode === "multi_note_folder") {
    return `Current Date: ${currentDate}
Mode: Create Multiple Notes in One Folder
${styleInstruction}
${propertiesInstruction}
${vaultNotesSection}
${customInstruction ? `Special User Instruction: ${customInstruction}\n` : ""}

Analyze the following input. Decompose it into distinct, highly focused atomic concepts.
Create one complete standalone note for each concept. Do not append to existing notes. Do not choose a destination folder. The application will save every note in the directory selected by the user.

Format your ENTIRE response as a sequence of atomic note blocks using this EXACT syntax:

=== ATOMIC NOTE ===
Action: create_new_note
Title: <Descriptive Note Title>
Reason: <1 sentence explaining why this concept needs a separate note>
--- CONTENT ---
<Complete formatted standalone Obsidian note with frontmatter if enabled, callouts, ## headings, code, mermaid>
=== END NOTE ===

Repeat for all decomposed topic pieces.

Input Content:
---
${rawText}
---`;
  }

  if (mode === "multi_note") {
    const treeContext = vaultKnowledgeTree
      ? `### HIERARCHICAL VAULT KNOWLEDGE TREE (FOLDERS AND THEIR CONTAINED NOTES):
\`\`\`
${vaultKnowledgeTree}
\`\`\`
`
      : "";

    return `Current Date: ${currentDate}
Mode: Atomic Decomposition (Multi-Note Synthesis)
${styleInstruction}
${propertiesInstruction}
${vaultNotesSection}
${treeContext}
${customInstruction ? `Special User Instruction: ${customInstruction}\n` : ""}

Analyze the following input. Decompose it into distinct, highly focused atomic concepts.
For each concept, evaluate whether it belongs inside an existing note from the vault tree (as an appended section) or should be created as a new note in an appropriate folder (maximum folder depth 2).

Format your ENTIRE response as a sequence of atomic note blocks using this EXACT syntax:

=== ATOMIC NOTE ===
Action: append_to_note
Target: <exact relative path of target note from vault tree, e.g. "HTTP Protocol/HTTP 1.1.md">
Title: <Section Heading Title>
Reason: <1 sentence explaining why this belongs in this existing note>
--- CONTENT ---
<Complete formatted markdown section ready to append, with ## Headings, code, mermaid, callouts>
=== END NOTE ===

=== ATOMIC NOTE ===
Action: create_new_note
Folder: <chosen folder path from tree or new folder up to max depth 2, e.g. "HTTP Protocol/HTTP 1.1">
Title: <Descriptive Note Title>
Reason: <1 sentence explaining why this new note is created here>
--- CONTENT ---
<Complete formatted standalone Obsidian note with frontmatter if enabled, callout, ## headings, code, mermaid>
=== END NOTE ===

Repeat for all decomposed topic pieces.

Input Content:
---
${rawText}
---`;
  } else if (mode === "smart") {
    const treeContext = vaultKnowledgeTree
      ? `### HIERARCHICAL VAULT KNOWLEDGE TREE (FOLDERS AND THEIR CONTAINED NOTES):
\`\`\`
${vaultKnowledgeTree}
\`\`\`
`
      : "";

    return `Current Date: ${currentDate}
Mode: Smart Placement
${styleInstruction}
${propertiesInstruction}
${vaultNotesSection}
${treeContext}
${customInstruction ? `Special User Instruction: ${customInstruction}\n` : ""}

Analyze the vault knowledge tree and decide the optimal location:
- Prefer 'append_to_note' when any listed note covers the same subject. Use its exact path.
- Use 'create_new_note' only when no listed note covers the same subject. Use the most semantically relevant folder path (maximum depth 2, e.g. "Networking/TCP").
- Never invent a target note path.

Begin your output with this EXACT JSON decision block:
\`\`\`smart-decision
{
  "action": "<create_new_note | append_to_note>",
  "targetNotePath": "<if append_to_note, exact path such as Networking/TCP/Flow Control.md>",
  "targetFolder": "<if create_new_note, folder path such as Networking/TCP>",
  "title": "<Descriptive Note Title>",
  "reason": "<1 sentence explaining why this location was chosen>"
}
\`\`\`

Followed immediately by the note markdown content.

Input Content:
---
${rawText}
---`;
  } else if (mode === "new_file") {
    return `Current Date: ${currentDate}
Mode: New Standalone Note File
${styleInstruction}
${propertiesInstruction}
${vaultNotesSection}
${customInstruction ? `Special User Instruction: ${customInstruction}\n` : ""}
Raw Input / Transcribed Content:
---
${rawText}
---
Transform this content into an Obsidian note strictly following the structure, Mermaid, and Markdown rules.`;
  } else {
    return `Current Date: ${currentDate}
Mode: Section for Appending (Start directly with a relevant ## Heading or > [!summary] callout).
${styleInstruction}
${propertiesInstruction}
${vaultNotesSection}
${customInstruction ? `Special User Instruction: ${customInstruction}\n` : ""}
Raw Input / Transcribed Content:
---
${rawText}
---
Transform this content into an Obsidian note section ready to append.`;
  }
}
