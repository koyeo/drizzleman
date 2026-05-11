export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );
  const pad = (cell: string, w: number) => cell + ' '.repeat(w - stripAnsi(cell).length);
  const sep = (l: string, m: string, r: string) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const fmt = (cells: string[]) =>
    '│ ' + cells.map((c, i) => pad(c, widths[i]!)).join(' │ ') + ' │';
  return [
    sep('┌', '┬', '┐'),
    fmt(headers),
    sep('├', '┼', '┤'),
    ...rows.map(fmt),
    sep('└', '┴', '┘'),
  ].join('\n');
}
