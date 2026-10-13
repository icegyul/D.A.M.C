# Hermes — copy-ready config

Two files. The key goes in `.env`; `config.yaml` carries only a reference to it.

Config location:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\hermes\config.yaml` and `%LOCALAPPDATA%\hermes\.env` |
| macOS / Linux | `~/.hermes/config.yaml` and `~/.hermes/.env` |

Confirm yours rather than assuming — `hermes doctor` prints the active paths.

## `.env`

```
MCP_DAMC_API_KEY=<YOUR_DAMC_API_KEY>
```

## `config.yaml` — local DAMC

```yaml
mcp_servers:
  damc:
    url: http://127.0.0.1:8787/v1/mcp
    headers:
      Authorization: Bearer ${MCP_DAMC_API_KEY}
      X-DAMC-Client: hermes
      X-DAMC-Client-Version: 0.21.2
    enabled: true

tools:
  tool_search:
    enabled: "off"
```

## `config.yaml` — remote DAMC (tunnel or `DAMC_PUBLIC_URL` host)

Use the authenticated gateway path `/mcp` rather than `/v1/mcp`:

```yaml
mcp_servers:
  damc:
    url: https://<your-host>/mcp
    headers:
      Authorization: Bearer ${MCP_DAMC_API_KEY}
      X-DAMC-Client: hermes
    enabled: true
```

## Steps

1. DAMC → AI Connections → API keys → **Create API Key** (e.g. `hermes-desktop`).
2. Add `MCP_DAMC_API_KEY=` plus the key to Hermes' `.env`.
3. Merge one `config.yaml` block above. Keep `${MCP_DAMC_API_KEY}` as a
   reference — do not paste the key here.
4. `hermes gateway restart` if a gateway is running.
5. Verify: `hermes mcp test damc` → `connected`, 22 tools.

## Checking it really works

`hermes mcp test damc` proves the transport. It does **not** prove the model will
use DAMC — that is what `tool_search.enabled: "off"` is for. To prove the whole
chain, ask a question about the past and then look at DAMC → AI Connections →
recent activity. A row with `client=hermes` is server-side evidence; the agent
listing tool names is not, because a model will happily read tool names out of
its own system prompt.

To confirm the tool surface a given run actually holds:

```
hermes -z "List the exact names of every tool you can call. Nothing else." -t damc
```

Expect 22 `mcp__damc__*` names. Note that `-t` **replaces** the toolset list, so
that run has no terminal, file, memory or session-search tools — which is also
the cleanest way to prove a recall came from DAMC and not from somewhere local.

## Do not

- Put the key in `config.yaml`, or in any file inside a repo.
- Use `--safe-mode` while testing: it disables MCP servers, so DAMC disappears
  and the failure looks like a DAMC problem.
- Expect `--ignore-rules` to skip the prompt on a `-z` run; it has no effect
  there.
