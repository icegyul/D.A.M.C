# Perplexity — detailed setup

Goal: **Read / Write / Update / Context / Session** through the same gateway.

Perplexity officially supports **custom remote connectors**
(https://www.perplexity.ai/help-center — "Adding Custom Remote Connectors").
Their connector flow leans on OAuth-style registration; where a Bearer header
is accepted it connects directly, otherwise put the key in your proxy — exactly
like the ChatGPT path.

## 1. Create the API key

DAMC → AI Connections → API keys → **Create API Key** (e.g. `perplexity`).

## 2. Publish DAMC (remote Perplexity tooling)

- Remote Access in DAMC (AI Connections → Remote Access), or
- your own reverse proxy + `DAMC_PUBLIC_URL=https://your-host`.

## 3. Add the connector

Perplexity → Settings → Connectors → **Add custom remote connector**:

- URL: `https://<your-host>/mcp`
- If the form accepts headers: `Authorization: Bearer <YOUR_DAMC_API_KEY>`
- If it refuses headers: enforce the key at the proxy instead.

## 4. Verify

> "Use DAMC context_pack for \<project\>."

## Honest limits

The consumer search product itself is not an MCP client; capabilities here
describe Perplexity tooling that speaks MCP. liveSync/push are false — no such
Perplexity API exists, and DAMC does not fake them.
