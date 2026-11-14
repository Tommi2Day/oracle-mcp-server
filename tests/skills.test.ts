/**
 * Contract between the Claude skills (skills/<name>/SKILL.md) and the MCP tools (no database needed):
 * every parameter and value a skill tells Claude to pass must exist in the tool schemas, and every tool is
 * covered by at least one skill. The workflows themselves run against a real database in
 * tests/skills.integration.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";
import { SKILLS_DIR, loadSkills, paramSnippets } from "./skills-helpers.js";

type Schema = { properties?: Record<string, { enum?: string[] }> };

/** Tool name → input schema of a server with every feature (perf, Diagnostics and Tuning Pack) enabled. */
async function allTools(): Promise<Map<string, Schema>> {
  const server = createMcpServer(() => Promise.reject(new Error("no database")), "skills-contract", "-",
    { perf: true, diagnostics: true, tuning: true });
  const client = new Client({ name: "contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map(t => [t.name, t.inputSchema as Schema]));
}

const skills = loadSkills();

describe("skills", () => {
  it("one skill per directory, with matching name and a useful description", () => {
    expect(skills.map(s => s.dir)).toEqual([
      "oracle-db-status", "oracle-document", "oracle-error-analysis",
      "oracle-problem-detection", "oracle-sql-tuning", "oracle-top-sessions-sql",
    ]);
    for (const s of skills) {
      expect(s.name, s.dir).toBe(s.dir);
      expect(s.description.length, s.dir).toBeGreaterThan(80);
    }
  });

  it("are listed in docs/skills.md", () => {
    const doc = fs.readFileSync(path.resolve(SKILLS_DIR, "../docs/skills.md"), "utf8");
    for (const s of skills) expect(doc, s.dir).toContain(`skills/${s.dir}/SKILL.md`);
  });

  it.each(skills.map(s => [s.dir, s] as const))("%s: tools, parameters and values exist", async (_dir, skill) => {
    const tools = await allTools();
    const params = new Map<string, Set<string> | null>(); // param → union of enum values (null = free text)
    for (const schema of tools.values()) {
      for (const [p, def] of Object.entries(schema.properties ?? {})) {
        const known = params.get(p);
        if (known === null || (params.has(p) && !def.enum)) { params.set(p, null); continue; }
        params.set(p, new Set([...(known ?? []), ...(def.enum ?? [])]));
        if (!def.enum) params.set(p, null);
      }
    }
    const snippets = paramSnippets(skill.body);
    for (const { param, value } of snippets) {
      expect(params.has(param), `${skill.dir}: parameter "${param}" is not a parameter of any tool`).toBe(true);
      const allowed = params.get(param);
      if (allowed) expect(allowed.has(JSON.parse(value)), `${skill.dir}: ${param}: ${value} is not in ${[...allowed]}`).toBe(true);
    }
  });

  it("every tool except the generic ones is covered by a skill", async () => {
    const tools = await allTools();
    const text = skills.map(s => s.body).join("\n");
    const missing = [...tools.keys()].filter(t => !text.includes(`\`${t}\``));
    expect(missing).toEqual([]);
  });

  it("the skills contain parameter snippets to check", () => {
    const all = paramSnippets(skills.map(s => s.body).join("\n"));
    expect(all.length).toBeGreaterThan(15);
    expect(all).toContainEqual({ param: "order_by", value: '"elapsed_per_exec"' });
  });

  it("parameter snippet parser handles lists and ignores wait event names", () => {
    expect(paramSnippets('use `context: 14, lines: 40` and `enq: TX - row lock contention` and `errors_only: true`'))
      .toEqual([{ param: "context", value: "14" }, { param: "lines", value: "40" }, { param: "errors_only", value: "true" }]);
  });
});
