import { Fragment, type ReactNode } from "react";

/*
 * A deliberately small Markdown renderer for model answers.
 * Supports what the answer prompt produces: paragraphs, headings, bullet and numbered lists,
 * block quotes, fenced code, **bold**, *italic*, `code`, and [n] citation markers.
 * It builds React elements directly (never HTML strings), so model output can't inject markup.
 * Unfinished syntax while streaming simply shows as text until it is closed.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 3 | 4; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; head: string[]; rows: string[][]; align: ("left" | "center" | "right" | undefined)[] };

const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
// GFM table separator row: | --- | :---: | ---: |
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // a table needs a header row followed by a separator row; until the separator streams in it shows as text
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? ("center" as const) : c.endsWith(":") ? ("right" as const) : c.startsWith(":") ? ("left" as const) : undefined,
      );
      const head = splitRow(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ kind: "table", head, rows, align });
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flush();
      blocks.push({ kind: "h", level: h[1].length <= 2 ? 3 : 4, text: h[2] });
      continue;
    }
    const b = line.match(BULLET);
    const n = line.match(NUMBERED);
    if (b || n) {
      flush();
      const kind = b ? "ul" : "ol";
      const last = blocks.at(-1);
      // consecutive items (even with a blank line between them) form one list
      if (last && last.kind === kind) last.items.push(b ? b[1] : n![2]);
      else blocks.push({ kind, items: [b ? b[1] : n![2]], start: n ? Number(n[1]) : 1 });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const text = line.replace(/^\s*>\s?/, "");
      const last = blocks.at(-1);
      if (last?.kind === "quote") last.text += "\n" + text;
      else blocks.push({ kind: "quote", text });
      continue;
    }
    // an indented line right after a list item continues that item
    const last = blocks.at(-1);
    if (!para.length && last && (last.kind === "ul" || last.kind === "ol") && /^\s{2,}\S/.test(line) && i > 0 && lines[i - 1].trim()) {
      last.items[last.items.length - 1] += " " + line.trim();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

// Underscore emphasis must sit on word boundaries so names like file_name_v2 stay intact.
const INLINE = /(\[\d+(?:\s*,\s*\d+)*\]|\*\*[^*\n]+\*\*|(?<!\w)__[^_\n]+__(?!\w)|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))/g;

function renderInline(text: string, cite: (n: number) => ReactNode, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(INLINE).forEach((part, i) => {
    if (!part) return;
    const key = `${keyBase}-${i}`;
    const c = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (c) {
      c[1].split(",").forEach((n, j) => out.push(<Fragment key={`${key}-${j}`}>{cite(Number(n.trim()))}</Fragment>));
    } else if (/^(\*\*|__).+\1$/.test(part)) {
      out.push(<strong key={key}>{renderInline(part.slice(2, -2), cite, key)}</strong>);
    } else if (/^`.+`$/.test(part)) {
      out.push(<code key={key}>{part.slice(1, -1)}</code>);
    } else if (/^([*_]).+\1$/.test(part)) {
      out.push(<em key={key}>{renderInline(part.slice(1, -1), cite, key)}</em>);
    } else {
      // keep single line breaks inside a paragraph
      part.split("\n").forEach((seg, j) => {
        if (j) out.push(<br key={`${key}-br${j}`} />);
        if (seg) out.push(<Fragment key={`${key}-t${j}`}>{seg}</Fragment>);
      });
    }
  });
  return out;
}

export function Markdown({
  text,
  renderCitation,
  trailing,
}: {
  text: string;
  renderCitation: (n: number) => ReactNode;
  trailing?: ReactNode; // e.g. the streaming caret, placed at the end of the last line
}) {
  const blocks = parseBlocks(text);
  const lastIdx = blocks.length - 1;
  return (
    <div className="prose-answer">
      {blocks.map((b, i) => {
        const end = i === lastIdx ? trailing : null;
        const inl = (t: string, k: string) => renderInline(t, renderCitation, k);
        switch (b.kind) {
          case "h":
            return b.level === 3 ? (
              <h3 key={i}>
                {inl(b.text, `${i}`)}
                {end}
              </h3>
            ) : (
              <h4 key={i}>
                {inl(b.text, `${i}`)}
                {end}
              </h4>
            );
          case "ul":
          case "ol": {
            const items = b.items.map((it, j) => (
              <li key={j}>
                {inl(it, `${i}-${j}`)}
                {j === b.items.length - 1 ? end : null}
              </li>
            ));
            return b.kind === "ul" ? (
              <ul key={i}>{items}</ul>
            ) : (
              <ol key={i} start={b.start}>
                {items}
              </ol>
            );
          }
          case "quote":
            return (
              <blockquote key={i}>
                {inl(b.text, `${i}`)}
                {end}
              </blockquote>
            );
          case "table":
            return (
              <Fragment key={i}>
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Table">
                  <table>
                    <thead>
                      <tr>
                        {b.head.map((c, j) => (
                          <th key={j} style={{ textAlign: b.align[j] }}>
                            {inl(c, `${i}-h${j}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((r, ri) => (
                        <tr key={ri}>
                          {b.head.map((_, j) => (
                            <td key={j} style={{ textAlign: b.align[j] }}>
                              {inl(r[j] ?? "", `${i}-${ri}-${j}`)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {end}
              </Fragment>
            );
          case "code":
            return (
              <Fragment key={i}>
                <pre>
                  <code>{b.text}</code>
                </pre>
                {end}
              </Fragment>
            );
          default:
            return (
              <p key={i}>
                {inl(b.text, `${i}`)}
                {end}
              </p>
            );
        }
      })}
      {blocks.length === 0 && trailing}
    </div>
  );
}
