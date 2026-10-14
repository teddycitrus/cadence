// Requests from the doc editor to the doc's AI assistant (continue writing,
// ask about a passage). The doc page opens the AI panel and sends them.

export const DOC_AI_EVENT = "cadence:doc-ai";

export const askDocAi = (prompt: string) => window.dispatchEvent(new CustomEvent<string>(DOC_AI_EVENT, { detail: prompt }));

/** "Keep writing" from where the cursor is: the passage before it is the context. */
export function continueWritingPrompt(before: string): string {
  const tail = before.trim().slice(-1500);
  return [
    "Keep writing this doc from where my cursor is, matching its tone, structure, and level of detail. Write one or two paragraphs (or the next items, if it is a list), then stop.",
    "Insert the new text right after this passage with docs_edit (old_text is the passage's last sentence, new_text is that sentence followed by what you write). Do not change anything else.",
    "",
    "The text just before the cursor:",
    tail ? tail.split("\n").map((l) => `> ${l}`).join("\n") : "> (the doc is empty; start it from its title)",
  ].join("\n");
}

export const askAboutPrompt = (selected: string) => `About this passage in the doc:\n\n${selected.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
