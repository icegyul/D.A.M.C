# Cursor — copy-ready config

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).
The Sync Center (AI Connections → Cursor → Setup → Copy Cursor config)
generates exactly this, with your origin — and your real key, right after
you create one.

## Local DAMC

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

## Remote DAMC (tunnel or `DAMC_PUBLIC_URL` host)

```json
{
  "mcpServers": {
    "damc": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_DAMC_API_KEY>" }
    }
  }
}
```

## Steps

1. DAMC → AI Connections → API keys → **Create API Key** (e.g. `cursor-laptop`).
2. Merge one block above into your `mcp.json`, replacing
   `<YOUR_DAMC_API_KEY>`.
3. Restart Cursor → approve the `damc` server when prompted.
4. Verify: *"Use DAMC session_start for my project."*

Never commit a file containing the real key. Global config stays outside
any repo; per-project `.cursor/mcp.json` must keep the placeholder.
