# ChatGPT — detailed setup

Goal: ChatGPT reads DAMC context (**Read + Context**). Write/update stay off —
ChatGPT's connector authentication has no API-key slot, and DAMC never serves an
unauthenticated endpoint. Do not expect write to appear until your environment
provides a key-carrying path.

## 1. Publish the gateway

Pick one (both keep /mcp behind the API key):

- **Remote Access in DAMC** — AI Connections → Remote Access → *Enable*. With
  cloudflared installed, DAMC starts a quick tunnel and shows the endpoint.
  NOTE: a quick tunnel is public HTTPS with no auth at the edge — for ChatGPT
  specifically you still need the key enforced, so prefer a reverse proxy that
  checks the key before forwarding, or keep ChatGPT on the read-only path and
  rely on your other AIs for writes.
- **Own endpoint** — set `DAMC_PUBLIC_URL=https://your-host` and front DAMC
  with Caddy/nginx that requires the key.

## 2. Add the connector

1. ChatGPT → Settings → **Apps & Connectors** → enable **Developer Mode**
   (availability depends on plan/region).
2. Create → custom connector → paste `https://<your-host>/mcp`.
3. Choose the authentication your build offers. If it cannot present the DAMC
   key, the proxy must enforce it (section 1).

## 3. Verify

> "Use DAMC context_pack for \<project\>."

You should get active decisions, open tasks, constraints — with provenance.

## What ChatGPT gets

| READ | CONTEXT | WRITE | UPDATE | SESSION | LIVE SYNC | PUSH |
|---|---|---|---|---|---|---|
| ✓ | ✓ | ✕ platform-limited | ✕ platform-limited | ✓ (read side) | ✕ | ✕ |

## History

Past conversations still enter DAMC through the official export file
(Import page or `C:\DAMC_IMPORT`) — independent of this connector.
