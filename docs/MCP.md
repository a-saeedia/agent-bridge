# Use agent-bridge as MCP in ANY agent

The MCP server (`mcp/server/index.js`) is a **generic connector**: any MCP-capable host —
Claude Desktop, Cursor, Windsurf, Cline, Roo, OpenCode, Hermes, or a `npx` process — can
join the bridge and get 4 tools that unlock the whole mesh.

## Tools

| tool               | what it does                                        |
|--------------------|-----------------------------------------------------|
| `bridge_list_agents` | who is connected right now (hermes, filebridge, worker-1, ...) |
| `bridge_publish`     | publish a message: `kind` + `payload`, `to` a specific agent or `*` |
| `bridge_rpc`         | call a method on another agent (e.g. `run` a one-shot task on Hermes) and get the result |
| `bridge_ping`        | liveness check against the hub                      |

Example RPC methods on the built-in `hermes` agent: `run`, `status`, `send`, `sessions`,
`cron`, `memory`, `gateway`, `ping`.

## Requirements

- The hub must be running on the machine: `./start.ps1` (or `node hub/server.js`).
- Node `>=18`.

## Install

### Any MCP host (generic)

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["PATH/TO/agent-bridge/mcp/server/index.js"],
      "env": {
        "BRIDGE_ID": "my-agent",        // this host's name on the hub
        "BRIDGE_AGENT": "my-agent-type" // optional, advertised agent type
      }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["C:\\Users\\you\\agent-bridge\\mcp\\server\\index.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or Cursor settings → MCP):

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["C:\\Users\\you\\agent-bridge\\mcp\\server\\index.js"]
    }
  }
}
```

### OpenCode

Already wired — `opencode.jsonc` has an `mcp.bridge` entry pointing at this server.

### Hermes

```powershell
hermes mcp add bridge --command node --args "C:\Users\you\agent-bridge\mcp\server\index.js"
hermes mcp list        # verify
hermes mcp test bridge # verify connection
```

### Package install (npm)

Published as `bridge-mcp` (see `mcp/package.json`):

```powershell
# global install → `bridge-mcp` binary on PATH
npm install -g bridge-mcp
# then point any MCP host at:
#   command: bridge-mcp
```

## Environment variables

| var              | default           | meaning                              |
|------------------|-------------------|--------------------------------------|
| `BRIDGE_URL`     | `ws://127.0.0.1:8177` | hub URL                          |
| `BRIDGE_TOKEN`   | *(empty)*         | hub auth token if enabled            |
| `BRIDGE_ID`      | `opencode`        | this host's agent id on the hub      |
| `BRIDGE_AGENT`   | `opencode`        | agent type advertised to the hub     |

## Security

- The hub binds `127.0.0.1` only — never exposed off-box.
- Optional `BRIDGE_TOKEN` (set in `hub/.env`) authenticates every client.
- This connector makes no outbound calls except the local hub.