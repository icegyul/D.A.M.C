# DAMC Web Dashboard

The dashboard is served by the DAMC backend itself at `/`. It is static
HTML + CSS + ES modules with no framework, no bundler and no build step.
Editing a file under `web/` and reloading the page is the whole workflow.

## Files

```
web/
  index.html          document shell, loads /app.js as a module
  app.css             all styling, light + dark via [data-theme]
  app.js              routing, shell chrome, connection banner, page mounting
  api.js              HTTP client, endpoint map, live/demo switch
  state.js            observable app state and per-page view state
  demo-data.js        offline sample data shaped like real API responses
  ui.js               escaping, formatting, loading/empty/error blocks
  pages/
    overview.js  memory.js  current-state.js  obsidian.js
    connections.js  import.js  sync.js  settings.js
```

Each page module exports `{ id, title, subtitle, mount(root, ctx) }`.
`mount` renders into `root` and wires its own listeners; there are no inline
`onclick` handlers and no globals. Every value interpolated into HTML passes
through `esc()`.

## LIVE and DEMO

On load, `api.detectConnection()` calls `GET /health`.

- Response ok → **LIVE**. Every screen reads from the backend.
- No response → **DEMO**. Reads are served from `demo-data.js`; a banner and a
  topbar chip say so; writes are **refused**, never simulated. Attempting a write
  raises `DemoModeError` and the UI reports that a live backend is required.

The page never claims a capability it does not have. Nothing is labelled
"Connected", "Realtime" or "Synced" unless the backend reports it.

## Settings

`Settings` stores the API endpoint, an optional API key and an optional dev user
id in `localStorage` under `damc.settings.v1`. Nothing is hardcoded in source.
Leave the endpoint empty to use the origin serving the page. `Test connection`
calls `GET /health` and reports the real result.

## Routes

Hash routing: `#/overview`, `#/memory`, `#/current-state`, `#/obsidian`,
`#/connections`, `#/import`, `#/sync`, `#/settings`.

## Obsidian

The in-app graph page was removed in 1.2.0. DAMC does not draw the knowledge
graph itself: the Obsidian page syncs one Markdown note per memory (relations as
wikilinks) into a host folder, and Obsidian's Graph View draws it. `GET /v1/graph`
is still served for API clients. What follows describes that API's data.

Nodes are memories from `GET /v1/graph`. Solid edges are rows in the `relations`
table. Project nodes and the dashed lines to them are derived client-side from
`memories.project_id`; the page states this so derived edges are not mistaken for
stored relations. Rendering is capped at 220 nodes with a visible notice.

## Current State

`Global scope` means memories with **no** project, which is what
`buildCurrentState` returns when no `projectId` is supplied. Select a project to
see that project's state. `Rebuild from memories` calls `GET /v1/state`, which
recomputes and persists into `current_states`.

## Accessibility

Skip link, landmark elements, `aria-current` on the active nav item, labelled
form controls, `aria-live` on data panes, visible focus rings, Escape closes the
mobile drawer and returns focus to the menu button, and graph nodes are
focusable buttons that respond to Enter and Space.

## Known limitations

- Memory extraction quality is whatever the backend heuristic produces; the
  dashboard displays it without re-interpreting it.
- There is no write path for editing memory content — only lifecycle status
  changes and relation building, which are the endpoints the backend exposes.
- Relevance sort only differs from the default when a search query is present.
