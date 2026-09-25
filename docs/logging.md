# Log format and shipping to Filebeat / Logstash

oracle-mcp-server writes all log output to **stderr** as plain text lines (no files, no JSON).
In Docker and Kubernetes the container runtime stores them like any other container log, so the
usual Filebeat → Logstash → Elasticsearch setup works without changes to the server.

Ready-to-use configurations (tested with Filebeat and Logstash 9.5):

| File | Purpose |
|------|---------|
| [`logging/filebeat-docker.yml`](logging/filebeat-docker.yml) | Filebeat on a Docker host (autodiscover by image name) |
| [`logging/filebeat-kubernetes.yml`](logging/filebeat-kubernetes.yml) | Filebeat DaemonSet in Kubernetes (autodiscover by the Helm chart label) |
| [`logging/logstash-oracle-mcp-server.conf`](logging/logstash-oracle-mcp-server.conf) | Logstash pipeline: parse, structure, index |

## Line format

```
[<timestamp>] [<LEVEL>] [<CATEGORY>] <message>
```

| Part | Format | Example |
|------|--------|---------|
| `timestamp` | ISO 8601, UTC, milliseconds (`Date.toISOString()`) | `2026-09-25T10:49:43.427Z` |
| `LEVEL` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` | `INFO` |
| `CATEGORY` | `MCP` \| `SESSION` \| `AUTH` \| `ADMIN` \| `STORE` \| `DB` \| `HTTP` \| `FATAL` | `SESSION` |
| `message` | structured `key="value"` pairs (MCP, SESSION, AUTH, ADMIN) or free text (other categories) | see below |

Only lines at or above `LOG_LEVEL` (default `info`) are written.

### Structured messages

Pairs are separated by a single space. Values are enclosed in double quotes, except:

- `params=` — a JSON object, always the **last** pair (tool arguments)
- `error=` — a JSON string literal (quotes inside are escaped as `\"`), always the **last** pair
- `duration=` — `<seconds>s`, unquoted

| Category | Level | Keys (in this order) | Meaning |
|----------|-------|----------------------|---------|
| `MCP` | info | `token` `action` `ip` [`params`] | Tool call. `action` = tool name. `params` is omitted for tools without arguments; `params.sql` is replaced by `<N chars, LOG_LEVEL=debug to show>` unless `LOG_LEVEL=debug` |
| `MCP` | error | `token` `action` `ip` `error` | Tool call failed |
| `SESSION` | info | `token` `action` `session` `ip` [`duration`] | `action` = `start` \| `stop`; `duration` only on `stop` |
| `AUTH` | warn | `result` [`token`] `action` `ip` `reason` | Rejected request (HTTP 401). `result` = `denied`; `action` = `<METHOD> <path>`; `reason` = `missing token` \| `invalid admin token` \| `unknown token` \| `token disabled` (only the last one has `token`). The presented token is never logged |
| `ADMIN` | info | `token` `action` `ip` | Admin API call; `token` = `admin` or `anonymous` (auth disabled) |
| `ADMIN` | error | `token` `action` `ip` `error` | Admin API call failed |

`token` is `admin` (the `AUTH_TOKEN`), `anonymous` (auth disabled) or the name of a file token.
`ip` is resolved from `X-Real-IP` → first `X-Forwarded-For` entry → socket address.

Examples:

```
[2026-09-25T10:49:43.427Z] [INFO] [SESSION] token="claude-desktop" action="start" session="61827f60-6990-4f71-9485-60ae72587db0" ip="192.0.2.21"
[2026-09-25T10:49:46.588Z] [INFO] [MCP] token="claude-desktop" action="describe_table" ip="192.0.2.21" params={"schema":"public","table":"orders"}
[2026-09-25T10:49:44.926Z] [INFO] [MCP] token="reporting-team" action="query" ip="192.0.2.35" params={"sql":"<51 chars, LOG_LEVEL=debug to show>"}
[2026-09-25T10:49:45.974Z] [ERROR] [MCP] token="reporting-team" action="execute" ip="192.0.2.35" error="permission denied for table orders"
[2026-09-25T10:49:45.889Z] [WARN] [AUTH] result="denied" token="old-laptop" action="POST /mcp" ip="198.51.100.7" reason="token disabled"
[2026-09-25T10:49:48.695Z] [INFO] [SESSION] token="claude-desktop" action="stop" session="61827f60-6990-4f71-9485-60ae72587db0" ip="192.0.2.21" duration=5s
[2026-09-25T11:25:33.818Z] [ERROR] [ADMIN] token="admin" action="POST /admin/tokens" ip="192.0.2.10" error="Unexpected token 'b', \"{\"name\": broken\" is not valid JSON"
```

### Free-text messages and multi-line entries

- `STORE`, `DB`, `HTTP`, `FATAL` carry a plain text message.
- **Stack traces** (`HTTP`/`FATAL` at error, admin errors at debug) span several lines; the continuation
  lines start with whitespace (`    at …`).
- The **startup banner** and the container entrypoint messages have no `[timestamp]` prefix; the banner's
  detail lines are indented.

Rule for collectors: **a line starting with whitespace belongs to the previous line.** The Filebeat
configurations join them into one event (`multiline` with pattern `^\s`), so a stack trace and the
startup banner each become a single event.

### Stability and caveats

- The format is part of the public interface; changes are listed in the [CHANGELOG](../CHANGELOG.md).
  Consumers should ignore unknown keys and categories.
- Quoted values are not escaped. Token names containing `"` break key/value parsing — use
  names without quotes (e.g. `team-reporting`, `claude-desktop`).
- At `LOG_LEVEL=debug`, `params.sql` contains the full SQL text including literal values. Treat such
  logs as sensitive data (retention, index permissions).

## Filebeat

Both configurations select only oracle-mcp-server containers, unwrap the container log format, join
multi-line entries and tag the events with `fields.service: oracle-mcp-server`, which the Logstash
pipeline uses to pick them out of a shared pipeline.

**Docker host** — [`logging/filebeat-docker.yml`](logging/filebeat-docker.yml): autodiscover by image
name (`docker.container.image` contains `oracle-mcp-server`). Run Filebeat as root with
`/var/lib/docker/containers` and `/var/run/docker.sock` mounted read-only:

```bash
docker run -d --name filebeat -u root \
  -v $PWD/docs/logging/filebeat-docker.yml:/usr/share/filebeat/filebeat.yml:ro \
  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  elastic/filebeat:9.5.3 -e --strict.perms=false
```

**Kubernetes** — [`logging/filebeat-kubernetes.yml`](logging/filebeat-kubernetes.yml): use it as
`filebeat.yml` of the standard Filebeat DaemonSet (with `NODE_NAME` from `spec.nodeName` and
`/var/log/containers` mounted). Pods are selected by the Helm chart label
`app.kubernetes.io/name: oracle-mcp-server`.

Core of both configurations:

```yaml
parsers:
  - container:
      stream: all
  - multiline:
      type: pattern
      pattern: '^\s'
      negate: false
      match: after
      skip_newline: true     # each line already ends with its own newline
fields:
  service: oracle-mcp-server
```

Adjust `output.logstash.hosts` to your Logstash.

## Logstash

[`logging/logstash-oracle-mcp-server.conf`](logging/logstash-oracle-mcp-server.conf) contains a complete
pipeline (beats input → filter → Elasticsearch output). To add it to an existing pipeline, copy the
`filter` block; adapt the `output` block to your cluster.

The filter

1. strips the trailing newline and splits `[timestamp] [LEVEL] [CATEGORY] message` (`grok`);
   lines without the prefix are tagged `pgmcp_unstructured` and kept unchanged,
2. sets `@timestamp` from the log line (`date`) and lowercases the level,
3. parses the `key="value"` pairs (`kv`), `params` (`json` → object) and `error` (`json` → string, quotes unescaped),
4. converts `duration` to an integer `pgmcp.duration_s` and moves `ip` to `source.ip`,
5. keeps free text of unstructured categories (and stack traces) in `pgmcp.text`.

Resulting fields:

| Field | Type | Content |
|-------|------|---------|
| `@timestamp` | date | Time of the log line |
| `log.level` | keyword | `debug` \| `info` \| `warn` \| `error` |
| `pgmcp.category` | keyword | `MCP`, `SESSION`, `AUTH`, `ADMIN`, `STORE`, `DB`, `HTTP`, `FATAL` |
| `pgmcp.token` | keyword | Token name |
| `pgmcp.action` | keyword | Tool name, `start`/`stop` or `<METHOD> <path>` |
| `pgmcp.params` | object | Tool arguments (`schema`, `table`, `sql`, …) |
| `pgmcp.session` | keyword | MCP session id |
| `pgmcp.duration_s` | integer | Session duration in seconds |
| `pgmcp.result`, `pgmcp.reason` | keyword | Rejected login: `denied` and the reason |
| `pgmcp.error` | text | Error message |
| `pgmcp.text` | text | Free text (STORE, DB, HTTP, FATAL, stack traces) |
| `source.ip` | ip | Client IP |
| `message` | text | Original line(s) |

Example document (tool call, from the test run):

```json
{
  "@timestamp": "2026-09-25T10:49:46.588Z",
  "log":    { "level": "info" },
  "source": { "ip": "192.0.2.21" },
  "pgmcp":  {
    "category": "MCP",
    "token": "claude-desktop",
    "action": "describe_table",
    "params": { "schema": "public", "table": "orders" }
  },
  "fields": { "service": "oracle-mcp-server" },
  "message": "[2026-09-25T10:49:46.588Z] [INFO] [MCP] token=\"claude-desktop\" action=\"describe_table\" ip=\"192.0.2.21\" params={\"schema\":\"public\",\"table\":\"orders\"}"
}
```

Mapping hints for the index template: `source.ip` as `ip`, `pgmcp.*` string fields as `keyword`,
`pgmcp.error`/`pgmcp.text`/`message` as `text`, and `pgmcp.params` as `flattened` (the argument
keys differ per tool; `flattened` avoids mapping growth and type conflicts).

## Useful queries (KQL)

| Question | Query |
|----------|-------|
| Rejected logins | `pgmcp.category:AUTH` — group by `source.ip` and `pgmcp.reason` to spot brute force |
| Use of disabled tokens | `pgmcp.reason:"token disabled"` |
| Failed tool calls | `pgmcp.category:MCP and log.level:error` |
| Write statements | `pgmcp.action:execute` |
| Activity of one client | `pgmcp.token:"reporting-team"` |
| Long sessions | `pgmcp.duration_s > 3600` |
| Token administration | `pgmcp.category:ADMIN and not pgmcp.action:GET*` |
