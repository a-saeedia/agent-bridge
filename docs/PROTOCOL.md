# Bridge Wire Protocol (v1)

Local, JSON-over-WebSocket hub for connecting AI agents and programs on one machine
(OpenCode, Hermes, FreeBuff, OpenHand, or anything else).

## Transport

- **Hub**: a single Node process listening on a local WebSocket port (default **8177**,
  `127.0.0.1` only — never exposed off-box).
- Each program connects as a **client** with an `id` and an `agent` type.
- All messages are JSON envelopes. Text frames only.

## Envelope

```json
{
  "v": 1,
  "type": "<message type>",
  "from": "opencode",
  "to": "*",              // "*" = broadcast, or a specific agent id
  "kind": "<topic>",      // free-form topic string, e.g. "task", "note", "state"
  "seq": 123,             // per-sender increasing int
  "ts": "2026-09-03T...", // ISO-8601 UTC
  "payload": { ... }
}
```

## Message types (client <-> hub)

| type      | direction      | meaning                                               |
|-----------|----------------|-------------------------------------------------------|
| `hello`   | client -> hub  | register with `{ agent, id, capabilities }`           |
| `hello_ack`| hub -> client | returns `{ agent_id, welcome, ts }`                   |
| `publish` | client -> hub  | envelope to fan out                                    |
| `deliver` | hub -> client  | an envelope addressed to this client (incl. broadcast)|
| `subscribe`| client -> hub | `{ topics: ["task", ...] }` — filter deliveries        |
| `rpc`     | client -> hub  | a request addressed to one agent, `{ method, params, request_id }` |
| `rpc_result` | hub/client | response to an rpc, `{ request_id, ok, result \| error }` |
| `ping` / `pong` | both   | liveness                                            |
| `list`    | client -> hub  | ask for connected agents (returns `agents` array)     |

## Topics

Topics are free-form strings. Convention:
- `task`      — a task to delegate to another agent
- `note`      — a note / finding for shared context
- `state`     — a shared-state write (also mirrored to `bridge-data/state/`)
- `file`      — a file/event-sync notification

## File-drop bridge (no-API agents)

Programs that cannot speak WebSocket (FreeBuff, OpenHand, any script) participate
through **watched folders** under `bridge-data/`:

- `bridge-data/inbox/NAME.score`   — a file named `<agent-id>.<ext>` dropped here is
  published to the hub as a `task` from `<agent-id>`.
- `bridge-data/outbox/NAME.score`  — the hub writes deliveries intended for a
  no-API agent here as `<message-seq>.json`.

Score format: plain text body (the payload), or JSON if it has a `.json` extension.

## Adapters

| program   | adapter | method                                   |
|-----------|---------|------------------------------------------|
| Hermes    | `hermes`| via `hermes-acp.exe` (ACP) / gateway      |
| OpenCode  | `opencode`| via the `bridge` MCP/CLI tool          |
| FreeBuff  | file    | inbox/outbox JSON files (no public API)  |

## Directed delivery

Every envelope may carry `to` (a single agent id, or `*`).

- `to: "*"` (or omitted) — **broadcast** to every connected agent whose topic
  filter matches the kind.
- `to: <id>` — **directed**: delivered only to that agent (plus any client with
  the `mirror` capability). Other agents never see it — no cross-talk or
  duplicate acks.
- A `to` naming an agent that isn't connected is still appended to the event
  log / outbox, so it can be picked up later.

### Mirror capability

An agent advertising the `mirror` capability receives *every* envelope regardless
of `to` — the file-bridge uses it so the outbox is a complete filesystem record,
while live agents only get their own mail.

## Security

- Binds to `127.0.0.1` only.
- Optional shared `BRIDGE_TOKEN` in `hub/.env`; if set, every `hello` must include
  `token` matching, else the connection is closed.
- No secrets in payloads by convention.
