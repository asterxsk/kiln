// Removes disabled skills from a built system prompt.
//
// pi renders loaded skills as a verbatim XML block:
//
//   <available_skills>
//     <skill>
//       <name>...</name>
//       <description>...</description>
//       <location>...</location>
//     </skill>
//     ...
//   </available_skills>
//
// Filtering is done by verbatim block surgery (kept blocks are untouched),
// so prompt output never depends on re-escaping. When every skill is
// disabled the whole section (intro + wrapper) is removed.

const SECTION_INTRO = "The following skills provide specialized instructions for specific tasks.";
const OPEN_TAG = "<available_skills>";
const CLOSE_TAG = "</available_skills>";

function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function filterSkillsPrompt(
  systemPrompt: string,
  disabled: string[] | Set<string> | undefined,
): string {
  const disabledSet = disabled instanceof Set ? disabled : new Set(disabled ?? []);
  if (disabledSet.size === 0) return systemPrompt;

  // Locate the section. The intro is preceded by two newlines in the template;
  // include them so full removal leaves no stray blank lines.
  let start = systemPrompt.indexOf("\n\n" + SECTION_INTRO);
  let introLen = 2 + SECTION_INTRO.length;
  if (start === -1) {
    start = systemPrompt.indexOf(SECTION_INTRO);
    introLen = SECTION_INTRO.length;
    if (start === -1) return systemPrompt;
  }
  const openIdx = systemPrompt.indexOf(OPEN_TAG, start);
  if (openIdx === -1) return systemPrompt;
  const closeIdx = systemPrompt.indexOf(CLOSE_TAG, openIdx);
  if (closeIdx === -1) return systemPrompt;

  const bodyStart = openIdx + OPEN_TAG.length;
  const closeEnd = closeIdx + CLOSE_TAG.length;
  const body = systemPrompt.slice(bodyStart, closeIdx);

  const blockRe = /  <skill>\n[\s\S]*?\n  <\/skill>/g;
  const blocks = body.match(blockRe);
  if (!blocks) return systemPrompt;

  const kept: string[] = [];
  let removed = 0;
  for (const b of blocks) {
    const m = b.match(/<name>([\s\S]*?)<\/name>/);
    const name = m ? unescapeXml(m[1]) : "";
    if (name && disabledSet.has(name)) removed++;
    else kept.push(b);
  }
  if (removed === 0) return systemPrompt;
  if (kept.length === 0) {
    // Drop the entire section including its leading blank lines.
    return systemPrompt.slice(0, start) + systemPrompt.slice(closeEnd);
  }
  return systemPrompt.slice(0, bodyStart) + "\n" + kept.join("\n") + "\n" + systemPrompt.slice(closeIdx);
}
