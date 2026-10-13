# Claude — detailed setup

Goal: full **Read / Write / Update / Context / Session** against DAMC.

## 1. Create the API key

DAMC → AI Connections → API keys → **Create API Key** (name it e.g.
`claude-laptop`). The raw key is shown once.

## 2a. Claude Code (one command)

```bash
claude mcp add --transport http damc http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <YOUR_DAMC_API_KEY>"
```

Cloud DAMC: swap in `https://<your-host>/mcp` (Remote Access or your proxy).

## 2b. Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "damc": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp",
               "--header", "Authorization: Bearer <YOUR_DAMC_API_KEY>"]
    }
  }
}
```

## 2c. Claude.ai (web)

Custom connectors there require OAuth 2.1; DAMC serves API keys. Until OAuth
support lands, Claude Code / Desktop are the supported paths.

## 3. Verify

1. *"Use DAMC session_start for my project."* → Context Pack with provenance.
2. *"decision_create: 배포 방식은 Docker로 결정했다"* → stored, visible in the
   Sync Center's Claude card (Last write).

## 4. Memory rules

Install [DAMC_SKILL.md](./DAMC_SKILL.md) as a CLAUDE.md/rules fragment so
Claude uses the same memory semantics as every other AI.
