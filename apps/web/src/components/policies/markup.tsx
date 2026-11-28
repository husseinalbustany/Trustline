import { createContext, Fragment, useContext, type ReactNode } from "react";
import { parseMarkup, type Block, type Inline } from "@/lib/markup";

/**
 * A section's text, drawn from the small markup it is written in. Every
 * piece goes in as React text, so nothing typed is ever read as HTML.
 * Headings sit under the section's own numbered heading, so a level 1
 * heading inside a section is one level below it.
 */
export function Markup({
  text,
  highlight,
}: {
  text: string;
  /** Draws some words apart (an AI draft's gaps and assumptions); still as text. */
  highlight?: (text: string) => ReactNode;
}) {
  return (
    <Highlight.Provider value={highlight ?? null}>
      <div className="flex flex-col gap-3 text-sm leading-relaxed break-words">
        {parseMarkup(text).map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </Highlight.Provider>
  );
}

const Highlight = createContext<((text: string) => ReactNode) | null>(null);

function Runs({ runs }: { runs: Inline[] }) {
  const highlight = useContext(Highlight);
  const draw = (text: string) => (highlight ? highlight(text) : text);
  return runs.map((run, i) =>
    run.bold ? (
      <strong key={i} className="font-semibold">
        {draw(run.text)}
      </strong>
    ) : (
      <Fragment key={i}>{draw(run.text)}</Fragment>
    ),
  );
}

function Lines({ lines }: { lines: Inline[][] }) {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      <Runs runs={line} />
    </Fragment>
  ));
}

const headingClass = {
  1: "text-base font-semibold",
  2: "text-sm font-semibold",
  3: "text-sm font-medium text-muted",
};

function BlockView({ block }: { block: Block }): ReactNode {
  if (block.kind === "heading") {
    const Tag = (["h4", "h5", "h6"] as const)[block.level - 1];
    return (
      <Tag className={headingClass[block.level]}>
        <Runs runs={block.text} />
      </Tag>
    );
  }
  if (block.kind === "paragraph") {
    return (
      <p>
        <Lines lines={block.lines} />
      </p>
    );
  }
  // Markers on the start side, so lists mirror in a right-to-left text.
  const items = block.items.map((item, i) => (
    <li key={i} className="ps-1">
      <Lines lines={item.lines} />
      {item.children.map((child, j) => (
        <div key={j} className="mt-1">
          <BlockView block={child} />
        </div>
      ))}
    </li>
  ));
  return block.ordered ? (
    <ol
      start={block.start}
      className="flex list-decimal flex-col gap-1 ps-6"
    >
      {items}
    </ol>
  ) : (
    <ul className="flex list-disc flex-col gap-1 ps-6">{items}</ul>
  );
}
