# Claude ↔ DAMC

Full **Read / Write / Context**. Two real paths, pick one:

## Claude Code (recommended — one command)

```bash
claude mcp add --transport http damc http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <YOUR_DAMC_API_KEY>"
```

For a cloud-hosted DAMC, replace the URL with `https://<your-host>/mcp`.

## Claude Desktop (via mcp-remote bridge)

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

Restart Claude Desktop and approve the DAMC server when prompted.

## Claude.ai (web)

Custom connectors there authenticate with OAuth 2.1, which DAMC does not serve
yet — a Bearer header alone will not satisfy them. Until OAuth lands (tracked
as a known limitation in `docs/REMOTE_MCP_GATEWAY.md`), use Claude Code or the
Desktop bridge; both use the identical gateway and memory.

## Verify

*"Use DAMC session_start for my project."* — you should get the project's
Context Pack. Then: *"decision_create: 배포 방식은 Docker로 결정했다"* and watch
the Sync Center's activity line for Claude move.

## Usage rules

Use the shared [DAMC skill](../SKILL.md) as a CLAUDE.md/rules fragment so
Claude's memory semantics match every other AI.
