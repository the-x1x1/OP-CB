# The local read-only API, and the MCP server (for Formicaria and AI clients)

Your own programs on this computer can read what a running WORLDVIEW knows, without the network
and without being able to change anything. The design and its rules are
[ADR-014](../adr/ADR-014-local-api.md); what was verified is in
[VERIFICATION.md](VERIFICATION.md) §M6.

## Turning it on

Settings → **Local API** (Linux and Windows):

- _Let other programs on this computer read WORLDVIEW_ — on Linux opens the socket
  `$XDG_RUNTIME_DIR/worldview/api.sock` (usually `/run/user/1000/worldview/api.sock`), which only
  your user can open; on Windows the named pipe `\\.\pipe\worldview-api-<your user name>`,
  which only your user (and administrators) can write to. Either is gone when you turn this off
  or quit.
- _Include this computer's position_ — a separate permission for `/v1/own-position`.

Nothing listens on any network port, loopback included.

Help → **Diagnostics** → Sidecars has a `local-api` line: off, or the socket or pipe it listens
on with how many requests it has answered and refused and when the last came. It never says
what was asked.

## The MCP server: WorldView as a tool for Formicaria and AI clients

WorldView ships a [Model Context Protocol](https://modelcontextprotocol.io) server that any MCP
client on this computer can start (operator decision 2026-10-20). It is the local API with a
tool for each endpoint — `worldview_status`, `worldview_sources`, `worldview_objects`,
`worldview_track`, `worldview_offline`, `worldview_own_position` — read-only, with the same
limits and the same refusals: nothing the local API will not give, the tools cannot give. The
client runs WorldView's own executable as Node on the server script; WorldView itself has to be
running with Settings → Local API on, or every tool answers that it is not.

An MCP client's configuration names the executable, the script and the variable. For a desktop AI assistant's `mcpServers` entry, on Windows:

```json
{
  "mcpServers": {
    "worldview": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\WorldView\\WorldView.exe",
      "args": [
        "C:\\Users\\<you>\\AppData\\Local\\Programs\\WorldView\\resources\\app.asar.unpacked\\dist\\mcp\\worldview-mcp.cjs"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

and on Linux:

```json
{
  "mcpServers": {
    "worldview": {
      "command": "/opt/WorldView/worldview",
      "args": ["/opt/WorldView/resources/app.asar.unpacked/dist/mcp/worldview-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE=1` makes the executable run the script as plain Node, with no window and
no second WorldView. `WORLDVIEW_API` names another socket or pipe to read, if yours is elsewhere.
Messages are JSON-RPC over stdio, one a line, in order; the server speaks MCP 2025-06-18 and the
two before it. It is tested with a fake local API (`apps/desktop/src/mcp/mcp-server.test.ts`); it
has not yet been run from a real MCP client.

## Reading it

```bash
node tools/local-api-client/consumer.mjs /v1
node tools/local-api-client/consumer.mjs '/v1/objects?lat=21.3&lon=-157.9&radiusKm=50&type=aircraft'
curl --unix-socket "$XDG_RUNTIME_DIR/worldview/api.sock" http://worldview/v1/health
```

| Path               | Answers                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `/v1`              | version, endpoints, limits, whether own position is allowed                               |
| `/v1/health`       | connection (and Work offline), sources live / on, whether the data is recorded (demo)     |
| `/v1/sources`      | each source: status, last data, object count, and whether its data may be read here       |
| `/v1/objects`      | objects now: `lat`, `lon`, `radiusKm` (≤ 500), `type`, `since`, `limit` (≤ 500), `cursor` |
| `/v1/track`        | one object's track: `id`, `from`, `to` (≤ 24 h)                                           |
| `/v1/offline`      | offline capabilities, packs, vault labels and states                                      |
| `/v1/own-position` | this computer's GPS fix, its time and accuracy — no coordinates with NO FIX               |

Example answers for each are in `fixtures/local-api/v1/`. Errors are
`{ "error": { "code", "message" } }`: 400 bad query, 403 not allowed, 404, 405 not GET, 413 too
large, 429 more than 120 requests a minute.

## What it never gives

- Anything from a source whose data policy does not allow it out of the app — the Meshtastic
  mesh (other people's positions) above all. Such objects are left out without a trace, and such a source's size and activity are not given.
- Where your drives are mounted, settings, keys, files, or any way to change or start anything.
