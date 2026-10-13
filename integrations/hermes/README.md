# Hermes ↔ DAMC

Full **Read / Write / Update / Context / Session** — Hermes Agent connects as an
MCP client over Streamable HTTP with custom headers, so it gets DAMC's whole
22-tool surface.

Verified against Hermes Agent **v0.21.2** on Windows: handshake, `tools/list`,
a real read, a real write, and a re-read from a separate session — each confirmed
in DAMC's own audit trail, not from the agent's account of itself.

## Setup (4 steps)

1. Create an API key: DAMC dashboard → AI Connections → API keys.
2. Put the key in Hermes' **`.env`**, never in `config.yaml`:

   ```
   MCP_DAMC_API_KEY=<YOUR_DAMC_API_KEY>
   ```

3. Merge this into Hermes' `config.yaml` — `~/.hermes/config.yaml`, or
   `%LOCALAPPDATA%\hermes\config.yaml` on Windows:

   ```yaml
   mcp_servers:
     damc:
       url: http://127.0.0.1:8787/v1/mcp
       headers:
         Authorization: Bearer ${MCP_DAMC_API_KEY}
         X-DAMC-Client: hermes
       enabled: true

   tools:
     tool_search:
       enabled: "off"
   ```

4. Restart a running gateway (`hermes gateway restart`), then verify:

   ```
   hermes mcp test damc
   ```

   Expect `connected` and 22 tools.

## Two settings that are not optional

**`tools.tool_search.enabled: "off"`.** Hermes defaults to `"auto"`, which
collapses every MCP tool behind a `tool_search` / `tool_describe` / `tool_call`
bridge once the deferrable surface is large enough. With 22 DAMC tools deferred,
the model saw 25 tools — none of them DAMC's — and asked *"find the important decision
we made earlier about this project"* it replied that it would have to reach DAMC
through `tool_call`, then stopped. DAMC's audit trail recorded **zero** calls for
that turn. With the bridge off, the same question produced `decision_search` and
`memory_search` immediately.

**`X-DAMC-Client: hermes`.** DAMC files provenance per client. It reads
`x-damc-client` from the transport and otherwise falls back to the MCP
`initialize` handshake's `clientInfo` — but `clientInfo` arrives only on
`initialize`, so without the header every later `tools/call` is recorded as
`unknown` and the AI Connection Center cannot tell you which agent touched your
memory. Add `X-DAMC-Client-Version` too if you want the version on that screen.

## Restart the gateway, not just the CLI

Each `hermes -z` run is a fresh process and picks up `config.yaml` immediately.
A long-running `hermes gateway` (Telegram, Discord, WhatsApp) does **not** — it
keeps the config it started with, so those chats would still use the old
settings. `hermes gateway restart` after any change.

## Role separation

Hermes' built-in `MEMORY.md` / `USER.md` are small and character-budgeted
(2,200 / 1,375 chars by default). They hold the always-true core — who you are,
how you work, and the fact that DAMC is the long-term store. Everything bulky
lives in DAMC and is reached by searching. Do not copy DAMC's contents into
Hermes' memory files: they cannot hold it, and the memory tool will refuse the
write once the budget is gone.

## Usage rules

Put the shared [DAMC skill](../SKILL.md) semantics into Hermes' `SOUL.md`
(`~/.hermes/SOUL.md`), which is the first block of every system prompt and is
independent of the working directory: context before work, decisions on settle,
supersede on change, `session_save` at the end. A project-scoped alternative is
a `.hermes.md` or `AGENTS.md` in the repo, but note that `.hermes.md` shadows a
`CLAUDE.md` in the same tree — only one project context file loads.

Two things to tell the agent, both real limits of this API:

- A `count` field in a tool result is the length of the page returned, not the
  total in the database, and these tools expose no pagination cursor.
- Imported memories carry `status`: a `candidate` is an extraction, not a
  confirmed fact. Read before asserting.
