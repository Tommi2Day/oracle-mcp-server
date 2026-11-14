/** Shared by tests/skills.test.ts and tests/skills.integration.test.ts. */
import fs from "node:fs";
import path from "node:path";

export const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills");

interface Skill { dir: string; name: string; description: string; body: string }

export function loadSkills(): Skill[] {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const md = fs.readFileSync(path.join(SKILLS_DIR, e.name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? "";
    return {
      dir: e.name,
      name: /^name:\s*(.+)$/m.exec(fm)?.[1].trim() ?? "",
      description: /^description:\s*(.+)$/m.exec(fm)?.[1].trim() ?? "",
      body: md,
    };
  }).sort((a, b) => a.dir.localeCompare(b.dir));
}

/** `param: value` snippets of a skill, e.g. `order_by: "cpu"`, `errors_only: true`, `context: 14, lines: 40`. */
export function paramSnippets(body: string): { param: string; value: string }[] {
  const out: { param: string; value: string }[] = [];
  for (const m of body.matchAll(/`([a-z_]+): ?([^`]+)`/g)) {
    for (const part of `${m[1]}: ${m[2]}`.split(/, (?=[a-z_]+: )/)) {
      const kv = /^([a-z_]+): ?(.*)$/.exec(part);
      if (kv && /^("[^"]*"|true|false|\d+)$/.test(kv[2])) out.push({ param: kv[1], value: kv[2] });
    }
  }
  return out;
}
