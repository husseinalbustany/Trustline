/**
 * The small markup a document's sections are written in: paragraphs,
 * headings of levels 1 to 3, bulleted and numbered lists (nested by
 * indenting) and bold. This reads it into a tree of plain values; the
 * screens draw the tree with React, which puts every piece of text in as
 * text. Nothing here produces HTML, so a tag typed in a section (`<b>`,
 * `<script>`) is shown as the characters it is, never run or drawn. What
 * the markup does not have (links, images, code, quotes, tables, deeper
 * headings) is kept as ordinary text: the API refuses it anyway.
 */

/** A run of text, bold or not. */
export type Inline = { text: string; bold: boolean };

export type ListItem = { lines: Inline[][]; children: Block[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: Inline[] }
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] };

const HEADING = /^ {0,3}(#{1,3})(?: +(.*?))?\s*#*\s*$/;
const LIST_ITEM = /^( *)([-*]|(\d{1,3})[.)]) +(.*)$/;

/** Bold is `**…**`, on one line. Anything else is text as typed. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*(\S(?:.*?\S)?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), bold: false });
    out.push({ text: match[1], bold: true });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

type Line = { indent: number; text: string };

/** Lists, from lines that start with a marker, by how far each is indented. */
function readList(lines: Line[], start: number, indent: number) {
  const first = LIST_ITEM.exec(" ".repeat(lines[start].indent) + lines[start].text);
  const ordered = !!first?.[3];
  const list: Block & { kind: "list" } = {
    kind: "list",
    ordered,
    start: ordered ? Number(first?.[3]) : 1,
    items: [],
  };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const raw = " ".repeat(line.indent) + line.text;
    const item = LIST_ITEM.exec(raw);
    if (item && item[1].length === indent && !!item[3] === ordered) {
      list.items.push({ lines: [inline(item[4])], children: [] });
      i++;
      continue;
    }
    if (item && item[1].length > indent && list.items.length > 0) {
      // A list inside the last item.
      const nested = readList(lines, i, item[1].length);
      list.items[list.items.length - 1].children.push(nested.list);
      i = nested.next;
      continue;
    }
    if (!item && line.indent > indent && list.items.length > 0) {
      // A line that carries on the last item.
      list.items[list.items.length - 1].lines.push(inline(line.text));
      i++;
      continue;
    }
    break;
  }
  return { list, next: i };
}

/** Reads a section's text into blocks. */
export function parseMarkup(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") {
      i++;
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: inline(heading[2] ?? ""),
      });
      i++;
      continue;
    }
    const item = LIST_ITEM.exec(raw);
    if (item) {
      // The run of lines that belong to the list: items, and lines indented
      // under them, up to a blank line followed by something else.
      const run: Line[] = [];
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
          const after = lines[i + 1];
          if (after !== undefined && LIST_ITEM.test(after)) {
            i++;
            continue;
          }
          break;
        }
        const indent = line.length - line.trimStart().length;
        if (!LIST_ITEM.test(line) && indent === 0 && run.length > 0) break;
        if (HEADING.test(line)) break;
        run.push({ indent, text: line.trimStart() });
        i++;
      }
      let at = 0;
      while (at < run.length) {
        const read = readList(run, at, run[at].indent);
        blocks.push(read.list);
        // A line that fits nowhere starts a list of its own.
        at = read.next > at ? read.next : at + 1;
      }
      continue;
    }
    const paragraph: Inline[][] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i])
    ) {
      paragraph.push(inline(lines[i].trim()));
      i++;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

/** What the editor's toolbar does to the lines a selection touches. */
export type LineStyle = "paragraph" | "bulleted" | "numbered" | 1 | 2 | 3;

const MARKERS = /^( *)(#{1,6} +|[-*] +|\d{1,3}[.)] +)?/;

/**
 * Restyles whole lines: each line touched by the selection loses its
 * heading or list marker and takes the one asked for (none for a
 * paragraph). Numbered lines are counted 1, 2, 3 in order.
 */
export function styleLines(
  text: string,
  from: number,
  to: number,
  style: LineStyle,
): { text: string; from: number; to: number } {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const endBreak = text.indexOf("\n", Math.max(to, from));
  const end = endBreak === -1 ? text.length : endBreak;
  let n = 0;
  const styled = text
    .slice(start, end)
    .split("\n")
    .map((line) => {
      const bare = line.replace(MARKERS, (_whole, indent: string) =>
        typeof style === "number" ? "" : indent,
      );
      // A paragraph starts at the margin: indented, it would read as code.
      if (style === "paragraph") return bare.trimStart();
      if (bare.trim() === "") return bare;
      if (style === "bulleted") return insertAfterIndent(bare, "- ");
      if (style === "numbered") return insertAfterIndent(bare, `${++n}. `);
      return `${"#".repeat(style)} ${bare.trimStart()}`;
    })
    .join("\n");
  return {
    text: text.slice(0, start) + styled + text.slice(end),
    from: start,
    to: start + styled.length,
  };
}

const insertAfterIndent = (line: string, marker: string) => {
  const indent = line.length - line.trimStart().length;
  return line.slice(0, indent) + marker + line.slice(indent);
};

/**
 * Bold around the selection, or taken away when it is already bold. With
 * nothing selected, two pairs of stars with the cursor between them.
 */
export function toggleBold(
  text: string,
  from: number,
  to: number,
): { text: string; from: number; to: number } {
  const selected = text.slice(from, to);
  if (
    text.slice(from - 2, from) === "**" &&
    text.slice(to, to + 2) === "**"
  ) {
    return {
      text: text.slice(0, from - 2) + selected + text.slice(to + 2),
      from: from - 2,
      to: to - 2,
    };
  }
  if (/^\*\*[\s\S]+\*\*$/.test(selected)) {
    const inner = selected.slice(2, -2);
    return {
      text: text.slice(0, from) + inner + text.slice(to),
      from,
      to: from + inner.length,
    };
  }
  // Spaces at either end stay outside the stars, where they mean text.
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const core = selected.trim();
  const wrapped = `${selected.slice(0, lead)}**${core}**${selected.slice(selected.length - trail)}`;
  return {
    text: text.slice(0, from) + wrapped + text.slice(to),
    from: from + lead + 2,
    to: from + lead + 2 + core.length,
  };
}
