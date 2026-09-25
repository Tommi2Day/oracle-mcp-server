/**
 * Result formatting helpers — pure, no driver imports.
 */

/** Text for one result cell. DATE and TIMESTAMP carry no time zone and are returned by
 *  the driver in local time, so they are printed from local components (the value as
 *  stored); time-zone aware types are printed as ISO-8601 UTC. */
export function formatCell(value: unknown, dbTypeName?: string): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return dbTypeName === "DATE" || dbTypeName === "TIMESTAMP" ? formatLocalDate(value) : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return value.length <= 32 ? "0x" + value.toString("hex").toUpperCase() : `<binary ${value.length} bytes>`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatLocalDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.getMilliseconds() ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

/**
 * Column-aligned text table. Numbers are right-aligned; cells longer than maxWidth
 * are cut with "…" (the last column is never cut, so SQL text stays readable).
 */
export function formatTable(cols: string[], rows: unknown[][], maxWidth = 40): string {
  const cells = rows.map(r => r.map((v, i) => {
    const s = formatCell(v).replace(/\s+/g, " ");
    return i < cols.length - 1 && s.length > maxWidth ? s.slice(0, maxWidth - 1) + "…" : s;
  }));
  const numeric = cols.map((_, i) => rows.length > 0 && rows.every(r => r[i] === null || r[i] === undefined || typeof r[i] === "number"));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map(r => (i < cols.length - 1 ? r[i].length : 0))));
  const line = (vals: string[]) => vals.map((v, i) => {
    if (i === cols.length - 1) return v;
    return numeric[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]);
  }).join("  ").trimEnd();
  const header = line(cols);
  const sep = widths.map((w, i) => "─".repeat(i === cols.length - 1 ? Math.max(cols[i].length, 8) : w)).join("  ");
  return [header, sep, ...cells.map(line)].join("\n");
}
