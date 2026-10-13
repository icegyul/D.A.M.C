# Claude — copy-ready config

Three different Claude clients, three configs. All reach the **same** gateway
and the **same** shared memory.

## Claude Code (recommended — one command)

```bash
claude mcp add --transport http damc http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <YOUR_DAMC_API_KEY>"
```

Remote DAMC (tunnel or `DAMC_PUBLIC_URL` host):

```bash
claude mcp add --transport http damc https://<your-host>/mcp \
  --header "Authorization: Bearer <YOUR_DAMC_API_KEY>"
```

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

Remote DAMC: replace the URL with `https://<your-host>/mcp`.

## Claude.ai (web)

Custom connectors there require OAuth 2.1, which DAMC does not serve yet —
`NOT_SUPPORTED` for this client until OAuth lands. Use Claude Code or the
Desktop bridge above; both use the identical gateway and memory.

## Verify

> "Use DAMC session_start for my project."

Then: *"decision_create: 배포 방식은 Docker로 결정했다"* — watch the Sync
Center's Claude card move to Active with a new Last write.
