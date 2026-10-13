# DAMC Production Deployment — public HTTPS for real AI clients

Goal: `https://<your-host>/mcp` serving the **same** gateway the local
dashboard uses, authenticated per user, so cloud AI clients (Claude, ChatGPT,
Grok, Perplexity) and remote Cursor installs share one memory. Loopback
`http://127.0.0.1:8787` keeps working unchanged.

Rule zero: **never expose the Windows dev PC with a raw `0.0.0.0` port.**
Public traffic always enters through a tunnel or a reverse proxy that
terminates TLS in front of the loopback server.

## 0. Ship the hub code first

The published image must contain the hub (`POST /mcp`, Remote Access,
activity feed). Rebuild from this source and recreate the app container —
the `damc_pg` volume (all memories) survives a recreate:

```powershell
cd D:\APP\DAMC_app
docker compose build app
docker compose up -d
curl.exe -s -X POST http://127.0.0.1:8787/mcp -H "Content-Type: application/json" `
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# want: HTTP 401 (gateway present, auth enforced). 404 = old image still running.
```

## Option A — Cloudflare quick tunnel (no domain, fastest)

1. Install cloudflared on the DAMC host
   (`winget install cloudflare.cloudflared`, or set `DAMC_CLOUDFLARED_PATH`).
   The DAMC image already bundles it — nothing to install inside Docker.
2. DAMC dashboard → AI Connections → Remote Access → **Enable**.
3. The UI shows `https://<random>.trycloudflare.com` — that origin plus
   `/mcp` is the production endpoint. Verify with the UI's **Verify endpoint**
   button (probes `/health` as DAMC; the result persists as "Last reachable").
4. Limits, stated plainly: the URL changes on every restart, and TLS
   terminates at Cloudflare with no edge auth — the DAMC API key is still
   required on every `/mcp` call, and hosts that cannot send it (ChatGPT)
   need Option B instead. After a restart, re-point local apps with
   `damc ai repoint --apply` (keys preserved, backups taken).

## Option A+ — DAMC-managed named tunnel (stable URL, same one toggle)

Same toggle, persistent hostname. One-time Cloudflare setup (needs a domain
on your Cloudflare account):

1. `cloudflared tunnel login` → `cloudflared tunnel create damc` →
   `cloudflared tunnel route dns <tunnel-id> memory.<domain>`.
2. Tunnel overview → Configure → copy the **token**.
3. Give DAMC `DAMC_TUNNEL_TOKEN=<token>` and
   `DAMC_TUNNEL_HOSTNAME=memory.<domain>` (compose environment — never
   committed, never logged, never returned by any API).
4. AI Connections → Remote Access → **Enable**. DAMC runs
   `cloudflared tunnel run` itself and advertises the stable
   `https://memory.<domain>` endpoint, across restarts.

## Option B — own domain + reverse proxy (stable URL, recommended)

1. Point `memory.<domain>` at the host (or use a **named** Cloudflare tunnel —
   same config file shape, stable hostname, no open ports):

   ```yaml
   # cloudflared config.yml (named tunnel)
   tunnel: <tunnel-id>
   credentials-file: C:\cloudflared\<tunnel-id>.json
   ingress:
     - hostname: memory.<domain>
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

   or Caddy on any host with ports 80/443:

   ```
   # Caddyfile — TLS is automatic, Authorization header passes through untouched
   memory.<domain> {
       reverse_proxy 127.0.0.1:8787
   }
   ```

2. Set the public origin so every generated config and the Sync Center show
   the real endpoint (compose override — never committed with secrets):

   ```yaml
   # docker-compose.prod.yml
   services:
     app:
       environment:
         DAMC_PUBLIC_URL: https://memory.<domain>
         DAMC_DEV_MODE: "false"
         DAMC_API_KEY_ADMIN: <long-random-value>
   ```

   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

3. Never strip the `Authorization` header at the proxy; never add a second
   unauthenticated path to `/mcp`.

## Option C — VPS / container hosting

Same `docker-compose.yml` on any Docker host, plus Option B's proxy in front
and the `DAMC_DEV_MODE=false` override. Firewall: only 80/443 inbound.
Back up the `damc_pg` volume before host moves.

## Production checklist

- [ ] `POST https://<host>/mcp` without credentials → **401** (not 404, not 200)
- [ ] Same call with `Authorization: Bearer damc_…` → **200** (`initialize`
      returns `protocolVersion`, `tools/list` returns 22 tools)
- [ ] `DAMC_DEV_MODE=false` on anything reachable beyond loopback
- [ ] One API key per AI client (revoke cuts exactly that client off)
- [ ] `DAMC_MCP_RATE_LIMIT_PER_MINUTE` set for the expected client count
- [ ] Sync Center → Test Memory returns real counts over the public URL
- [ ] User A / User B keys see disjoint memories (probe: `session_start`
      per key, compare project lists)

## Client wiring (all from the live public URL)

| Client | Path | Honest ceiling |
|---|---|---|
| Claude Code | `claude mcp add --transport http damc https://<host>/mcp --header "Authorization: Bearer <key>"` | full read/write — actually connectable today |
| Cursor | `mcpServers.damc` with `url` + `headers` in `mcp.json` | full read/write — actually connectable today |
| ChatGPT | Developer Mode custom connector, key enforced at proxy | read/context; write platform-limited |
| Grok | xAI Remote MCP Tools registration | limited — MCP-capable tooling only |
| Perplexity | custom remote connector | limited — MCP-capable tooling only |

Per-client copy-ready files: `integrations/<ai>/CONFIG.md`. Connection
states in the Sync Center (`AUTHENTICATED` vs `READ_READY`/`WRITE_READY` vs
`ACTIVE`, plus "connected but unused") update from real audit activity —
re-check them after the first real client call, and treat any provider with
no audit rows as code-ready, not connected.
