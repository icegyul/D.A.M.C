# Cursor ↔ DAMC

Full **Read / Write / Context** — Cursor supports remote (HTTP) MCP servers
with custom headers natively.

## Setup (3 steps)

1. Create an API key: DAMC dashboard → AI Connections → API keys.
2. Merge this into `~/.cursor/mcp.json` (global) or `.cursor/mcp.json`
   (per project):

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

3. Restart Cursor, approve the DAMC server, verify:
   *"Use DAMC session_start for my project."*

The Sync Center generates this exact config for you (with your origin and,
right after key creation, your actual key) — AI Connections → Cursor → Setup →
Copy.

## Usage rules

Drop the shared [DAMC skill](../SKILL.md) into
`.cursor/rules/damc.mdc` so Cursor uses the same memory semantics as Claude and
the rest: context before work, decisions on settle, supersede on change,
`session_save` at the end.
