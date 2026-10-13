# DAMC Connector Strategy

## Goal
DAMC must automatically acquire the user's AI knowledge without storing provider passwords or relying on session-cookie scraping.

## Current implementation
- `ChatGPTConnector` and `ClaudeConnector` implement the common connector interface.
- Official account-data exports can be normalized into DAMC through `/v1/import/chatgpt` and `/v1/import/claude`.
- `/v1/connectors/capabilities` exposes what is actually supported.

## Required next phase
1. Verify the official connection surfaces available to the target ChatGPT and Claude plans.
2. Implement provider-specific export parsers instead of assuming one generic JSON shape.
3. Add authenticated MCP transport so AI clients can query DAMC memory.
4. Add incremental sync only where the provider officially exposes it.
5. Never implement password capture, cookie extraction, CAPTCHA bypass, or hidden browser scraping.

## Product rule
If a provider cannot officially expose historical conversations directly, DAMC must clearly show the limitation and make the official export/import path as close to one-click as possible. Never claim direct account sync when the connector does not have it.
