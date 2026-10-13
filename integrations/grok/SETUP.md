# Grok — detailed setup

Goal: **Read / Write / Update / Context / Session** through the same gateway.

xAI documents **Remote MCP Tools** (https://docs.x.ai/developers/tools/remote-mcp):
Grok consumes external MCP servers as tools. DAMC's gateway speaks the standard
Streamable HTTP transport with Bearer auth, so an MCP-capable Grok setup is a
first-class DAMC client.

## 1. Create the API key

DAMC → AI Connections → API keys → **Create API Key** (e.g. `grok`).

## 2. Publish DAMC (only if Grok runs outside this machine)

- Remote Access in DAMC (AI Connections → Remote Access), or
- your own reverse proxy with `DAMC_PUBLIC_URL=https://your-host`.

Loopback `http://127.0.0.1:8787/mcp` works when the Grok client runs on the
same machine.

## 3. Register the tool server

Follow the xAI docs' Remote MCP flow with:

- server URL: `https://<your-host>/mcp`
- header: `Authorization: Bearer <YOUR_DAMC_API_KEY>`

Config shape (for MCP-generic Grok tooling):

```json
{
  "mcpServers": {
    "damc": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <YOUR_DAMC_API_KEY>" }
    }
  }
}
```

## 4. Verify

> "Use DAMC active_decisions for \<project\>."

## Honest limits

Consumer Grok surfaces that expose no MCP simply are not DAMC clients yet —
that is shown as a platform limit, never as a fake connection. liveSync and
push are false for the same reason: no such Grok API exists; the real path is
Grok calling DAMC tools.
