DAMC — Dalur AI Memory Center 1.2.0
===================================

DAMC is a provider-independent long-term memory layer. It runs entirely on this
machine inside Docker and is reachable only from this machine.

  Dashboard   http://127.0.0.1:8787
  Database    PostgreSQL, 127.0.0.1:5432 (loopback only)
  Logs        %LOCALAPPDATA%\DAMC\logs

Requirement
-----------
Docker Desktop must be installed and running. DAMC does not bundle it.
  https://www.docker.com/products/docker-desktop/

Everything else DAMC needs is included: the application image and the
PostgreSQL image are loaded from images\damc-images.tar on first start, so no
download is required.

Using DAMC
----------
  Start DAMC     starts the containers and waits until DAMC answers
  Open DAMC      starts DAMC if needed, then opens the dashboard
  Stop DAMC      stops the containers, keeping all memory data
  DAMC Status    shows Docker, container and health state

Connecting your AIs (Common Memory Hub)
----------------------------------------
DAMC is the shared memory for ChatGPT, Claude, Grok, Perplexity and Cursor.
After starting DAMC:

  1. Open the dashboard and create a project (AI Connections page).
  2. AI Connections -> API keys -> Create API Key (shown once).
  3. Pick an AI and follow its pack: integrations\<ai>\SETUP.md,
     copy the config from integrations\<ai>\CONFIG.md, replacing
     <YOUR_DAMC_API_KEY> with your key.
  4. In that AI: "Use DAMC session_start for my project."

Claude Code and Cursor connect on this machine directly. Cloud AIs need a
public HTTPS endpoint: AI Connections -> Remote Access, or set
DAMC_PUBLIC_URL behind your own reverse proxy. The installer also copies the
packs to the install folder under integrations\ for reference.

Importing conversations
------------------------
Three ways in, all through the same pipeline (parse, dedupe, classify,
supersede) — nothing is treated differently because of how it arrived:
  Dashboard      Import page: upload a .json or .zip export, or drag & drop
  Command line   npm run damc:import -- chatgpt "<path>"  (or claude)
  Watch folder   Drop an export into C:\DAMC_IMPORT. DAMC waits for the copy
                 to finish, then imports it automatically. Done files move to
                 C:\DAMC_IMPORT\processed, failed ones to \failed. Already
                 watching by default — no button to press first.

Your data
---------
Memories live in the Docker volume "damc_damc_pg". Stopping DAMC, restarting
Windows, and uninstalling all keep that volume. Uninstall asks separately, and
defaults to keeping it, before removing any data.

Security
--------
Both ports are published on 127.0.0.1 only, so nothing on your network can
reach DAMC. Because it is local and single-user, the dashboard works without an
API key.

That convenience is limited to requests coming from this machine. Anything that
reaches DAMC through a proxy or a tunnel - including DAMC's own Remote Access
tunnel - must present an API key, so turning Remote Access on does not expose
your memory. The remote MCP endpoint always requires a key. Create one in the
dashboard under Sync Center.

If you republish the ports on a network interface, set DAMC_DEV_MODE=false in
docker-compose.yml and use API keys: a machine on your LAN cannot be told apart
from this one.

DAMC never stores provider passwords, never reads browser cookies or session
tokens, and never calls private APIs. History enters only through official
export files.

Start / Open / Stop from the Start Menu run scripts\damc-launch.vbs, which starts
DAMC with no console window and shows a dialog only if something failed.
scripts\damc-start.cmd is what it runs; its output goes to %LOCALAPPDATA%\DAMC\logs.
