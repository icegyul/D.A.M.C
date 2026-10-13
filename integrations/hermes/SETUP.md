# Hermes — setup walkthrough

From nothing to "Hermes recalls a decision it never saw in this conversation".

## 0. Prerequisites

- DAMC running: open http://127.0.0.1:8787 and confirm the dashboard loads.
- Hermes installed: `hermes --version`. This walkthrough was verified on
  **v0.21.2**.

## 1. Create a key

DAMC dashboard → **AI Connections** → API keys → Create API Key, label it
`hermes-desktop`. Copy it once — DAMC stores only a hash and will not show it
again.

## 2. Give Hermes the key, out of band

Open Hermes' `.env` (`%LOCALAPPDATA%\hermes\.env` on Windows, `~/.hermes/.env`
otherwise) and add:

```
MCP_DAMC_API_KEY=<paste the key>
```

## 3. Register DAMC as an MCP server

Add to `config.yaml`:

```yaml
mcp_servers:
  damc:
    url: http://127.0.0.1:8787/v1/mcp
    headers:
      Authorization: Bearer ${MCP_DAMC_API_KEY}
      X-DAMC-Client: hermes
    enabled: true
```

`hermes mcp add` can do this interactively and will create the `.env` entry for
you under the name it derives for the server; editing the two files directly is
equivalent and easier to review.

## 4. Stop Tool Search from hiding DAMC

Add to the same `config.yaml`:

```yaml
tools:
  tool_search:
    enabled: "off"
```

Skip this and the integration will look connected while being useless: Hermes
collapses MCP tools behind a discovery bridge by default, and in that state a
plain question about your own history produced no DAMC call at all.

## 5. Restart a running gateway

```
hermes gateway restart
```

Only needed if you use Telegram/Discord/WhatsApp. CLI runs pick up config
immediately.

## 6. Verify the transport

```
hermes mcp test damc
```

Expect `connected` and **22 tools**.

## 7. Verify the agent actually uses it

Ask something only your past contains:

```
hermes -z "예전에 우리가 정한 중요한 결정을 찾아봐."
```

Then check DAMC → AI Connections. Hermes should appear as **ACTIVE** with a
recent read. That row is the proof; the reply text is not.

## 8. Verify a write, and a cross-session read

```
hermes -z "이 내용을 장기적으로 기억해: <a durable fact>" -t damc
```

`-t damc` restricts that run to DAMC's tools — no file, terminal, memory or
session-search tools — so the fact can only have gone to DAMC. Then, in a
separate run:

```
hermes -z "방금 저장한 그 내용을 DAMC에서 찾아서 record id와 함께 알려줘." -t damc
```

Two different processes, two different session ids, no conversation carry-over.
If the second run returns it, shared long-term memory is working.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `hermes mcp test damc` fails, DAMC dashboard loads | Wrong URL. Local is `/v1/mcp`; the tunnel/gateway path is `/mcp`. |
| 401 | Key revoked, or `.env` not picked up. `hermes mcp test damc` reports the status code. |
| Connected, 22 tools, but no DAMC call on a real question | `tool_search` is still `"auto"`. This is the common one. |
| Works in CLI, not in Telegram | Gateway still running the old config. `hermes gateway restart`. |
| Activity shows `client=unknown` | `X-DAMC-Client` header missing. |
| All DAMC tools vanish | `--safe-mode` disables MCP servers. |
