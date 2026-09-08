# Architecture

## Design goal

The user runs several AI coding agents on one Windows box (OpenCode, Hermes, FreeBuff)
and wants them to act as a **multi-mind**: coordinating, delegating, sharing context, and
syncing file changes — without re-plumbing each pair.

The hard constraint discovered during design: **FreeBuff has no public API** (cloud-backed
orchestrator, use-through-UI only). So a single transport can't reach every program. We need
a hub with *multiple adapters* — one WebSocket transport for programs that can speak it, plus
a **file-drop bridge** so no-API programs participate through the filesystem.

Hermes is reached three ways at once (its own multi-surface reality):

| surface | how the bridge uses it | capability |
|---|---|---|
| **CLI** (`hermes.exe`) | `adapters/hermes-adapter.js` shells out | one-shot tasks, status, sessions, cron, memory, gateway status |
| **MCP serve** (`hermes mcp serve`) | `mcp/hermes-gateway.mjs` is the MCP *client* | messaging gateway (Telegram/Discord/WhatsApp/...) |
| **MCP client** (Hermes → us) | `hermes mcp add bridge` registered | the running Hermes app itself can publish/rpc to the hub |

And the hub is intentionally multi-agent: any number of peers (a second OpenCode, OpenHand,
generic workers) can join with one small adapter (`adapters/worker.js` is the template).

## Components

```
                      ┌────────────────────────────┐
 OpenCode (MCP tools) │                            │
  bridge_publish      │        hub/server.js       │
  bridge_rpc          │  WebSocket broker 127.0.0.1│    Hermes adapter ── hermes CLI
  bridge_list_agents  │  agents registry           │    bridge_rpc "run/status/send"
        │             │  event store (ndjson)      │
        │             │  state mirror (JSON)       │
 CLI  bin/bridge.js ──┤  topic filter              ├──── file-bridge:
        │             │                            │       inbox/*.json → task
 FreeBuff / OpenHand /│                            │       hub → outbox/*.json
 any script  ─────────┘                            ┘
```

### 1. hub/server.js — the broker
- Listens `ws://127.0.0.1:8177` (bind 127.0.0.1 only).
- `hello` registers an agent (id, type, capabilities, topics). A client may advertise
  `proxy-from` capability to attribute messages to another origin (used by the file bridge
  so a file dropped by FreeBuff shows up as `from: freebuff`, not `from: filebridge`).
- `publish` fans out an envelope to all clients that match the topic filter.
- Every published event is appended to `bridge-data/events/events.ndjson` (the event store —
  a durable, replayable log).
- `state` payloads with a `key` are mirrored to `bridge-data/state/<key>.json` (shared
  context store).
- `rpc`/`rpc_result` provide request/response delegation with a per-request id.
- `list` returns connected agents (used by `bridge rpc` and the MCP `bridge_list_agents`).

### 2. lib/client.js — WireClient
Small promise-based WS client used by the CLI, adapters, and the MCP server. Handles
hello/ack, subscribe, publish, rpc (with pending-map + timeout), list, ping.

### 3. bin/bridge.js — CLI
`list | publish <kind> [json] | listen [topic...] | rpc <to> <method> [json] | ping`.
The generic escape hatch: any script, CI job, or agent can join without writing code.

### 4. adapters/file-bridge.js — no-API programs
- **Inbox**: watches `bridge-data/inbox/`. A dropped file becomes a published message:
  - JSON files: `{"from","kind","to","payload"}` control the envelope.
  - non-JSON: `name.anything` → task body, from `name`.
  - Consumed files are renamed to `<name>.consumed.done` and skipped, so a single drop
    publishes exactly once (prevents the fs.watch re-fire loop).
  - It advertises `proxy-from`, so the origin is attributed correctly.
- **Outbox**: every delivered message the hub sends is also written to
  `bridge-data/outbox/<seq>-<from>-<kind>.json` so a file-based agent can pick it up.
- Also useful as event-sync: the events.ndjson is a full changelog of everything.
- Advertises `proxy-from` **and** `mirror`: attribute origin correctly, and receive
  everything so the outbox stays a complete record even for directed messages.

### 5. adapters/hermes-adapter.js — Hermes (CLI surface)
Agent `hermes` on the hub. Inbound tasks run `hermes -z "<prompt>"` (headless one-shot) and
publish the result back as a `task_result`. RPC methods:
- `run`        — one-shot task (`hermes -z`)
- `status`     — `hermes status`
- `send`       — `hermes send --to <platform>` (messaging backplane; requires a configured
  platform via `hermes gateway setup`)
- `sessions`   — `hermes sessions list` (everything Hermes has worked on)
- `cron`       — `hermes cron list`; plus `cron_status`, `cron_pause/cron_resume/cron_run`
- `memory`     — `hermes memory status`
- `gateway`    — `hermes gateway status`
- `ping`       — identity/liveness (fast, no model call)

Hermes' own ACP (`hermes-acp.exe`) is a separate stdio protocol; the bridge reaches Hermes
through the CLI, so no ACP client handshake was needed for v1.

### 5b. mcp/hermes-gateway.mjs — Hermes (MCP-serve messaging surface)
Agent `hermes-gw` on the hub. Spawns `hermes mcp serve` and acts as its **MCP client**,
exposing Hermes' messaging gateway (Telegram/Discord/WhatsApp/Slack/...) to every hub agent:
- `channels` / `conversations` / `read` — see what/where the channels are
- `send` — `messages_send` to `platform:chat_id`; **any** agent (or a dropped file!) can post
- `poll` — event-stream cursor
- inbound hub tasks of kind `message` with `{target, message}` are sent out
- returns `[]`/0 until a messaging platform is configured (`hermes gateway setup`)

### 5c. Hermes → hub (Hermes as MCP client)
`hermes mcp add bridge --command <node> --args <mcp/server/index.js>` registers our hub as an
MCP server inside Hermes (persisted in `~/AppData/Local/hermes/config.yaml`, all 4 tools
enabled). The **running Hermes app** is then a full peer — it can `bridge_publish`,
`bridge_rpc`, `bridge_list_agents`. Verify with `hermes mcp list` / `hermes mcp test bridge`.

### 5d. adapters/worker.js — generic peer (N-agent proof)
Joins as `worker-1` (override `BRIDGE_ID`), acks `task` messages, answers `ping`/`status`.
Copy-and-rename template for any new agent — a second OpenCode instance, OpenHand, a CI
runner: same file, different id.

### 6. mcp/server/index.js — OpenCode integration
Registers `bridge_*` tools so JARVIS can drive the hub directly. Registered in
`opencode.jsonc` under `mcp.bridge`; loads at OpenCode start.

## Wire protocol
See `docs/PROTOCOL.md`. Envelope = JSON over WS:
`{ v, type, from, to, kind, seq, ts, payload }`.

## Consistency & durability
- Events: append-only `events.ndjson`.
- State: last-write-wins JSON mirror per key.
- Outbox: one JSON file per delivered message.
- The hub holds no long-lived queue; delivery is best-effort fan-out plus the durable
  event log / outbox for programs that need it. (A future backlog/retry is an easy add.)

## Why WebSocket + files (not MQTT/Redis)
Node v22 + `ws` is already in the toolchain; adding an MQTT broker or Redis is extra infra
for what is essentially 3–6 local processes. The file-drop bridge solves the no-API case
that a broker alone could not.

## Security decisions
- Loopback-only bind.
- Optional `BRIDGE_TOKEN` shared secret (in `.env`), checked at `hello`.
- `proxy-from` is a capability granted to trusted bridge adapters only — arbitrary clients
  cannot spoof `from`.
- No secrets in payloads by convention.