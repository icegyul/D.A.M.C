# Cursor — detailed setup

Goal: full **Read / Write / Update / Context / Session** inside the editor.

## 1. Create the API key

DAMC → AI Connections → API keys → **Create API Key** (e.g. `cursor-laptop`).
The Sync Center can substitute it into the config for you right after creation.

## 2. Merge the config

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

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

Remote DAMC: use the Remote Access endpoint instead of loopback.

The Sync Center's Cursor card → **Setup** → **Copy Cursor config** generates
this exact JSON (and embeds the key you just created, when there is one).

## 3. Restart and approve

Restart Cursor → approve the `damc` server when prompted.

## 4. Verify

1. *"Use DAMC session_start for my project."* → Context Pack.
2. *"task_create: 다음 스프린트까지 인증 모듈 구현"* → visible in DAMC within
   seconds, with Cursor as the provenance provider.

## 5. Rules

Add [DAMC_SKILL.md](./DAMC_SKILL.md) as `.cursor/rules/damc.mdc` so Cursor
uses the shared memory semantics (context before work, decisions on settle,
supersede on change, session_save at the end).
