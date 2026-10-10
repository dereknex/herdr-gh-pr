// Untrusted review text must not execute terminal escape/control sequences.
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "    ");
}

export function displayLines(text: string, width: number): string[] {
  const safe = sanitizeTerminalText(text);
  return safe.split("\n").flatMap(line => {
    if (!line) return [""];
    const rows: string[] = [];
    let row = "", columns = 0;
    for (const char of line) {
      const size = Bun.stringWidth(char);
      if (columns + size > width && row) { rows.push(row); row = ""; columns = 0; }
      row += char; columns += size;
    }
    rows.push(row);
    return rows;
  });
}
