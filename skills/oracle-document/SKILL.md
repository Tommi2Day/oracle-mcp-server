---
name: oracle-document
description: Document an Oracle schema or database objects — data dictionary, relationships (ERD), indexes, row counts — or write up a diagnosis, tuning result or incident as a runbook or post-mortem. Use when the user asks to document a schema, tables, an application's data model, or to write up findings from an Oracle investigation.
---

# Documenting Oracle schemas and findings

Two modes. Both are read-only against the database and produce Markdown that the user can save in the
repository or wiki.

## Ground rules

- Document what the database says; mark everything inferred (e.g. a relationship guessed from column names
  without a foreign key) as **inferred**.
- Do not copy data values into documentation. Column names, types, counts and comments only; no sample rows
  unless the user asks, and then no personal or secret data.
- Ask where to write the file (default: `docs/<schema>.md` in the current repository) before creating it.
- Schemas can be large: ask for scope (schema, table prefix) when `list_tables` returns more than ~50 objects,
  and document in batches instead of one huge answer.

## Mode A — schema / data model documentation

1. `test_connection` for database, container and user; `list_schemas` if the user did not name the schema.
2. `list_tables` for the schema (tables, views, materialized views).
3. For each table/view in scope, `describe_table`: columns, types, nullability, defaults, primary key and
   **comments** (keep the comment text — it is the best documentation the database has).
4. Relationships — `query` on the dictionary (replace `<OWNER>`):

   ```sql
   SELECT c.table_name, c.constraint_name, cc.column_name, r.table_name AS ref_table, rc.column_name AS ref_column,
          c.delete_rule
     FROM all_constraints c
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     JOIN all_constraints r  ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
     JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
    WHERE c.constraint_type = 'R' AND c.owner = '<OWNER>'
    ORDER BY c.table_name, c.constraint_name, cc.position
   ```

   Other constraints (unique, check): `all_constraints` with `constraint_type IN ('U','C')` and
   `search_condition_vc` (21c+) or `search_condition`.
5. Size and activity: `table_stats` per important table gives rows, blocks, last analyzed and indexes with
   columns/uniqueness. Row counts are optimizer estimates — say "approx. (statistics of <date>)".
6. Code objects, if requested: `query` on `all_objects` (`PROCEDURE`, `FUNCTION`, `PACKAGE`, `TRIGGER`,
   `SEQUENCE`, `SYNONYM`), and `all_source` for the header comment of a package — summarise, do not paste code.
7. Write the document:

   ```markdown
   # <Schema> data model
   Database/container, extraction date, scope. Source: data dictionary via oracle-mcp-server.
   ## Overview          – purpose (from comments / table names), counts of tables, views, indexes
   ## Entity relationship – mermaid `erDiagram` built from the foreign keys (inferred links marked)
   ## Tables            – per table: purpose, approx. rows, columns table (name, type, null, default, comment),
                          primary key, foreign keys, indexes, notable constraints
   ## Views / code      – one paragraph each
   ## Observations      – missing comments, tables without primary key, foreign keys without index
                          (column list not covered by an index), unusual types, stale statistics
   ```

   Useful observation queries (replace `<OWNER>`): tables without primary key (`all_tables` minus `all_constraints`
   type `P`), and foreign keys whose column does not lead any index (a frequent cause of TM lock waits and slow
   joins/deletes; approximate — composite FKs are listed per constraint, check the full column list):

   ```sql
   SELECT c.table_name, c.constraint_name, LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) AS fk_columns
     FROM all_constraints c
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
    WHERE c.constraint_type = 'R' AND c.owner = '<OWNER>'
      AND NOT EXISTS (SELECT 1 FROM all_ind_columns ic
                       WHERE ic.table_owner = c.owner AND ic.table_name = c.table_name
                         AND ic.column_name = cc.column_name AND ic.column_position = 1)
    GROUP BY c.table_name, c.constraint_name
   ```

## Mode B — documenting a diagnosis, tuning result or incident

Use the findings of the current session (tool outputs are the evidence). Structure:

```markdown
# <Title> — <date>
**Status:** resolved | mitigated | open     **Database:** <name/container>  **Impact:** who/what was affected, how long
## Summary          – 3 sentences: symptom, root cause, fix
## Timeline         – timestamps from alert_log / session data (with time zone)
## Evidence         – sql_id, plan facts, wait events, SIDs, ORA- errors, trace file names (no data values)
## Root cause       – the chain of causes, labelled "confirmed" or "assumed"
## Actions taken / recommended – exact statements, owner, risk, rollback
## Prevention       – monitoring, code/config change, follow-ups
```

For a **tuning** write-up add before/after: plan hash, elapsed per execution, buffer gets, and the exact change.
For a **runbook**, turn the diagnosis into numbered steps with the tool or SQL to run and the expected result.

Never include credentials, connection strings with passwords, or trace-file content with data values.
Offer to save the file; write it only after the user confirms the path.
