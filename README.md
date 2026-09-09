# agent-bridge

A **local bridge** that connects the AI programs on this machine — OpenCode (JARVIS),
Hermes, and FreeBuff (and OpenHand, or any other program) — so they can talk to each
other, delegate tasks, share context, and sync on file events.

## What it does

One local hub (WebSocket, `127.0.0.1:8177`) + a small wire protocol. Each program joins as
an agent. Then any agent can:

- **publish** messages (notes, tasks, state) to any topic or to a specific agent
- **delegate** work via RPC calls (e.g. OpenCode asks Hermes to run a one-shot task)
- **subscribe** to messages it cares about
- get **file/event sync** through the file-drop bridge, which lets *any* program
  participate even if it has no public API (that's exactly FreeBuff and OpenHand's case)

## The agents

| program   | how it connects               | notes |
|-----------|-------------------------------|-------|
| OpenCode (me) | MCP server: `bridge_*` tools + a CLI | tools appear in OpenCode automatically |
| Hermes    | 3 surfaces at once: CLI adapter, messaging-gateway adapter (`hermes mcp serve`), and Hermes itself connects to us (`hermes mcp add bridge`) | full capability bridge |
| FreeBuff  | file-drop (`bridge-data/inbox|outbox`) | no public API → drops/reads JSON files |
| OpenHand  | file-drop, or the `bridge` CLI | install later as needed |
| any script | `bin/bridge.js` CLI | `publish`, `listen`, `rpc`, `list`, `ping` |
| more agents | `adapters/worker.js` (1 file) | `BRIDGE_ID=agent-2 node adapters/worker.js` |
| **any MCP host** | `mcp/server/index.js` (MCP server) | Claude Desktop, Cursor, Cline, Windsurf… see [docs/MCP.md](docs/MCP.md) |

## Use it inside ANY agent (MCP)

Claude Desktop, Cursor, Windsurf, Cline, OpenCode, Hermes — any MCP-capable host can join the
mesh as a first-class agent with 4 tools (`bridge_list_agents`, `bridge_publish`,
`bridge_rpc`, `bridge_ping`). Point the host at:

```
node path/to/agent-bridge/mcp/server/index.js
```

Full per-host configs live in [docs/MCP.md](docs/MCP.md).

## Quick start

```powershell
# 1. start the hub + adapters
.\start.ps1

# 2. (optional) check who's connected
C:\Users\User\tools\node\node.exe bin\bridge.js list

# 3. publish a note from any shell
C:\Users\User\tools\node\node.exe bin\bridge.js publish note "{\"body\":\"hello world\"}"

# 4. ask Hermes what it's up to
C:\Users\User\tools\node\node.exe bin\bridge.js rpc hermes status "{}"

# 5. stop everything
.\stop.ps1
```

## File-drop bridge (the "any program" adapter)

Programs without an API (FreeBuff, OpenHand) participate through two folders:

- `bridge-data/inbox/` — drop a file here and it becomes a `task` message.
  - JSON: `{"from":"freebuff","kind":"task","to":"*","payload":{...}}`
  - Plain text: `myagent.anything` → task from `myagent`.
- `bridge-data/outbox/` — the hub writes every delivered message here as `<seq>-<from>-<kind>.json`
  so a file-based program can pick it up.

## How OpenCode uses it

An MCP server is registered in `opencode.jsonc`. In OpenCode you get four tools:

- `bridge_list_agents` — who's connected
- `bridge_publish` — send a note/task to a topic or agent
- `bridge_rpc` — call a method on another agent (Hermes: `run`/`status`/`send`/`ping`)
- `bridge_ping` — is the hub up

Restart OpenCode after adding the MCP entry (the running session won't pick it up live).

## Security

- Hub binds to `127.0.0.1` only — never off-box.
- Optional shared token: set `BRIDGE_TOKEN=` in `.env` (copy from `.env.example`); every
  client must send it or the connection is dropped.
- No secrets in payloads by convention.

## Layout

```
hub/server.js            the WebSocket hub (event store, state mirror, agents registry)
lib/client.js            shared client library (BridgeClient)
bin/bridge.js            CLI: list / publish / listen / rpc / ping
adapters/file-bridge.js  inbox→hub, hub→outbox (for FreeBuff / OpenHand / anything)
adapters/hermes-adapter.js  hub → hermes CLI (tasks, sessions, cron, memory, gateway)
adapters/worker.js       generic peer template (N agents: worker-1, worker-2, ...)
mcp/server/index.js      MCP server that gives OpenCode (and Hermes) bridge_* tools
mcp/hermes-gateway.mjs   hub → hermes mcp serve (messaging: Telegram/Discord/...)
bridge-data/             inbox / outbox / events / state (runtime files)
test/                    smoke + proxy + mcp smoke tests
docs/PROTOCOL.md         wire protocol spec
```

## Verification

Auto-tests (run with the hub up):

```powershell
C:\Users\User\tools\node\node.exe test\smoke.js        # publish/subscribe + rpc
C:\Users\User\tools\node\node.exe test\proxy.js        # freebuff attribution through file bridge
C:\Users\User\tools\node\node.exe test\mcp-smoke.js    # MCP server tools
```