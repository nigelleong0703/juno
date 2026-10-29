/** One block of a changed document: unchanged context, a block only the draft has, or a block only the saved version has. */
export interface DiffBlock {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Blocks are the parts between blank lines, except that a fenced code block stays in one piece. */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** A simple block diff (longest common subsequence of blocks): what the draft adds to and removes from the saved version. */
export function diffBlocks(before: string, after: string): DiffBlock[] {
  const a = splitBlocks(before);
  const b = splitBlocks(after);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ kind: "added", text: b[j]! });
      j += 1;
    } else {
      out.push({ kind: "removed", text: a[i]! });
      i += 1;
    }
  }
  return out;
}
