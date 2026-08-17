// Shared frontmatter parsing/writing for note types (todo/meeting/status/project — see
// specification/specs.md's `type`, `status`, `project`, `date`, `attendees` fields). A minimal
// YAML-frontmatter subset — scalar `key: value` lines plus a `key:` followed by `- item` block
// list (for fields like `attendees`) — is all Todowai's own vocabulary needs, so this
// deliberately isn't a full YAML parser. Fields are kept as an ordered list rather than a plain
// object so re-serializing an untouched note reproduces its original field order, and unknown
// keys always survive a read/edit/save round-trip since nothing here special-cases which keys
// exist.
export type FrontmatterValue = string | string[];
export type FrontmatterField = [key: string, value: FrontmatterValue];

export type ParsedNote = {
  frontmatter: FrontmatterField[];
  body: string;
};

const DELIMITER = '---';
const FIELD_PATTERN = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const LIST_ITEM_PATTERN = /^\s*-\s+(.*)$/;

// Content with no recognizable frontmatter block (no leading `---` fence, or an unterminated
// one) round-trips as an empty field list and the untouched original text as the body — plain
// notes elsewhere in the vault are exactly this case, not an error.
export function parseFrontmatter(content: string): ParsedNote {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== DELIMITER) {
    return { frontmatter: [], body: content };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closingIndex === -1) {
    return { frontmatter: [], body: content };
  }

  const frontmatter: FrontmatterField[] = [];
  const fmLines = lines.slice(1, closingIndex);
  for (let i = 0; i < fmLines.length; i += 1) {
    const match = fmLines[i].match(FIELD_PATTERN);
    if (!match) {
      continue;
    }
    const [, key, inlineValue] = match;
    if (inlineValue.trim() !== '') {
      frontmatter.push([key, inlineValue.trim()]);
      continue;
    }

    const items: string[] = [];
    while (i + 1 < fmLines.length) {
      const itemMatch = fmLines[i + 1].match(LIST_ITEM_PATTERN);
      if (!itemMatch) {
        break;
      }
      i += 1;
      items.push(itemMatch[1].trim());
    }
    frontmatter.push([key, items]);
  }

  // A single blank separator line between the closing fence and the body is the convention this
  // module itself writes (see serializeFrontmatter) — drop exactly one so repeated parse/
  // serialize cycles don't accumulate blank lines, but leave any further intentional blank
  // lines in the body alone.
  const bodyLines = lines.slice(closingIndex + 1);
  if (bodyLines[0] === '') {
    bodyLines.shift();
  }

  return { frontmatter, body: bodyLines.join('\n') };
}

export function serializeFrontmatter(note: ParsedNote): string {
  if (note.frontmatter.length === 0) {
    return note.body;
  }

  const fmLines = note.frontmatter.flatMap(([key, value]) =>
    Array.isArray(value) ? [`${key}:`, ...value.map((item) => `  - ${item}`)] : [`${key}: ${value}`]
  );

  return `${DELIMITER}\n${fmLines.join('\n')}\n${DELIMITER}\n\n${note.body}`;
}

export function getFrontmatterValue(frontmatter: FrontmatterField[], key: string): FrontmatterValue | undefined {
  return frontmatter.find(([fieldKey]) => fieldKey === key)?.[1];
}

// Updates `key` in place when it already exists (preserving field order), otherwise appends it —
// either way, every other field passes through untouched.
export function setFrontmatterValue(
  frontmatter: FrontmatterField[],
  key: string,
  value: FrontmatterValue
): FrontmatterField[] {
  const index = frontmatter.findIndex(([fieldKey]) => fieldKey === key);
  if (index === -1) {
    return [...frontmatter, [key, value]];
  }
  const next = [...frontmatter];
  next[index] = [key, value];
  return next;
}
