/**
 * The user-experience contract from docs/DAMC_AX_USER_EXPERIENCE_REPORT.md.
 *
 * Each block pins one finding from that review so it cannot quietly come back:
 * a help screen that sends users to the docs folder, an installer that tells the
 * user to go start Docker by hand, a "Connect" button that only scrolls, a status
 * label that calls a merely configured client connected, an Obsidian export that
 * lands where Obsidian cannot see it, a graph page that contradicts the product
 * direction, and a first screen that says nothing about what to do next.
 *
 * Static checks on purpose: they read the files the user actually gets — the
 * dashboard sources, the shipped compose, the start script and the Inno script —
 * so a regression fails here before it reaches a machine.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const dict = async () => (await import('../web/i18n.js') as any).DICTIONARIES as { en: Record<string, string>; ko: Record<string, string> };

// ---------------------------------------------------------------- help
describe('in-app help is self-contained', () => {
  const REQUIRED_TOPICS: Array<[string, RegExp]> = [
    ['what DAMC is', /help\.whatIs/],
    ['what it stores', /help\.whatStores/],
    ['why it is needed', /help\.whatWhy/],
    ['ChatGPT import', /help\.importChatgpt/],
    ['Claude import', /help\.importClaude/],
    ['Memory/Decision/Task', /help\.typeMemory/],
    ['connecting an AI', /help\.connectSteps/],
    ['Hermes', /help\.hermes1/],
    ['why Obsidian', /help\.obsWhy/],
    ['how to know an import finished', /help\.importDone/],
    ['where data is stored', /help\.dataWhere/],
    ['what reinstall/uninstall does to data', /help\.dataReinstall/]
  ];

  it('covers every topic a first-time user needs, in both languages', async () => {
    const help = await read('web/pages/help.js');
    const d = await dict();
    for (const [topic, re] of REQUIRED_TOPICS) {
      const key = re.source.replace('\\.', '.');
      expect(help, topic).toMatch(new RegExp(key.split('.')[1]));
      expect(d.en[key], `en ${key}`).toBeTruthy();
      expect(d.ko[key], `ko ${key}`).toBeTruthy();
    }
    expect(help).toContain("'dataUninstall'");
  });

  it('never sends a user to the docs folder for something they need', async () => {
    // docs/ stays the developer reference. The one mention left is explicitly
    // addressed to developers and says the user does not need it.
    const d = await dict();
    const userFacing = Object.entries(d.ko).filter(([k]) => k.startsWith('help.') && k !== 'help.devDocs');
    for (const [k, v] of userFacing) {
      expect(v, k).not.toMatch(/docs\s*폴더|docs\//);
    }
    expect(d.ko['help.devDocs']).toMatch(/필요하지 않습니다/);
  });

  it('states the four-sentence product model up front', async () => {
    const d = await dict();
    expect(d.ko['help.model1']).toMatch(/장기 기억.*Memory Center/);
    expect(d.ko['help.model2']).toMatch(/ChatGPT.*Claude/);
    expect(d.ko['help.model3']).toMatch(/Hermes/);
    expect(d.ko['help.model4']).toMatch(/Obsidian.*Graph View/);
  });

  it('explains MCP in plain words wherever the acronym appears', async () => {
    const d = await dict();
    for (const key of ['help.connectMcp', 'connections.mcpPlain']) {
      expect(d.ko[key], key).toMatch(/기억을 읽고 (쓸|쓰)/);
    }
  });
});

// ------------------------------------------------------- first run / empty
describe('first run', () => {
  it('shows a welcome with next steps only while the database is empty', async () => {
    const overview = await read('web/pages/overview.js');
    expect(overview).toContain('welcomeCard()');
    // Gated on the real totals — not on a flag, not on a stored "seen" marker.
    expect(overview).toMatch(/totals\.memory\?\.total.*totals\.conversations\?\.total.*totals\.projects\?\.total/s);
    for (const btn of ['import:chatgpt', 'import:claude', 'connections', 'obsidian']) {
      expect(overview, btn).toContain(`data-welcome="${btn}"`);
    }
    const d = await dict();
    expect(d.ko['overview.welcomeTitle']).toBe('DAMC에 오신 것을 환영합니다');
    expect(d.ko['overview.welcomeEmpty']).toBe('아직 저장된 데이터가 없습니다.');
  });

  it('writes nothing to produce the welcome or any empty state', async () => {
    // The welcome is markup and strings. Nothing on the overview page posts.
    const overview = await read('web/pages/overview.js');
    expect(overview).not.toMatch(/method:\s*'POST'|api\.create|api\.import/);
    const d = await dict();
    // Empty-state copy explains and points forward; it does not describe a failure.
    expect(d.ko['overview.globalEmpty']).not.toMatch(/전역 범위/);
    expect(d.ko['overview.globalEmpty']).toMatch(/아직/);
  });
});

// ------------------------------------------------------- Docker prerequisite
describe('Docker prerequisite handling', () => {
  it('installer distinguishes installed-but-stopped from missing, and starts Docker itself', async () => {
    const iss = await read('release/installer/DAMC.iss');
    // Installed is judged from the product, not from the CLI being on PATH.
    expect(iss).toContain('Docker Desktop.exe');
    expect(iss).toMatch(/Uninstall\\Docker Desktop/);
    // Running is judged from the engine.
    expect(iss).toContain('docker info');
    // A comment may explain why the old check was wrong; the code must not run it.
    expect(iss).not.toMatch(/\/c docker --version/);
    // Case B: launch and wait with visible progress, bounded.
    expect(iss).toMatch(/ShellExec\('',\s*DockerDesktopExe\(\)/);
    expect(iss).toMatch(/WaitForDocker\(180\)/);
    expect(iss).toContain("CustomMessage('DockerWaiting')");
  });

  it('installer offers only the official Docker download and ships no Docker binary', async () => {
    const iss = await read('release/installer/DAMC.iss');
    expect(iss).toContain('https://www.docker.com/products/docker-desktop/');
    expect(iss).not.toMatch(/docker.*\.exe";\s*DestDir/i);
    const payload = await fs.readdir(path.join(root, 'release/payload'), { recursive: true }) as string[];
    expect(payload.filter(f => /docker.*(setup|installer).*\.exe/i.test(f))).toEqual([]);
  });

  it('installer disables the post-install start when the engine never came up', async () => {
    const iss = await read('release/installer/DAMC.iss');
    // v2: the start lives in [Code] and is skipped when the engine never came up;
    // the finish page's only Run item (the browser) follows DamcStarted.
    expect(iss).toMatch(/if not DockerReady then\s+Exit;/);
    expect(iss).toMatch(/WizardForm\.RunList\.Checked\[0\] := DamcStarted;/);
    expect(iss).toContain("CustomMessage('DockerNotReady')");
  });

  it('installer speaks Korean and English from one message table', async () => {
    const iss = await read('release/installer/DAMC.iss');
    expect(iss).toMatch(/Name: "korean";\s+MessagesFile: "compiler:Languages\\Korean\.isl"/);
    for (const id of ['DockerMissingBody', 'DockerMissingContinue', 'DockerNotReady', 'DockerWaiting', 'UninstallKeepData', 'DamcPreparing', 'StartFailed', 'RunOpen']) {
      expect(iss, id).toMatch(new RegExp(`korean\\.${id}=`));
      expect(iss, id).toMatch(new RegExp(`english\\.${id}=`));
    }
    // UTF-8 with BOM, or ISCC reads the Korean in cp949 and garbles it.
    const bytes = await fs.readFile(path.join(root, 'release/installer/DAMC.iss'));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('start script starts Docker Desktop and waits, instead of telling the user to', async () => {
    const start = await read('release/payload/scripts/damc-start.cmd');
    expect(start).toMatch(/if exist "%ProgramFiles%\\Docker\\Docker\\Docker Desktop\.exe"/);
    expect(start).toMatch(/start "" "%ProgramFiles%\\Docker\\Docker\\Docker Desktop\.exe"/);
    expect(start).toMatch(/docker info >nul 2>&1 && set "DOCKERUP=1"/);
    // Missing Docker is still the user's step — with the official page, nothing else.
    const vbs = new TextDecoder('euc-kr').decode(await fs.readFile(path.join(root, 'release/payload/scripts/damc-launch.vbs')));
    expect(vbs).toContain('https://www.docker.com/products/docker-desktop/');
    // The image-load rule is pinned in production-readiness; here, only that the
    // script never shows any of this to a person: no echo to the console at all.
    expect(start).toMatch(/docker load/i);
    expect(start).not.toMatch(/^\s*echo (?!\[%date%)/m);
  });

  it('start script is still ASCII with CRLF line endings', async () => {
    const bytes = await fs.readFile(path.join(root, 'release/payload/scripts/damc-start.cmd'));
    expect(bytes.every(b => b < 0x80)).toBe(true);
    expect(bytes.includes(Buffer.from('\r\n'))).toBe(true);
    expect(bytes.toString('latin1').replace(/\r\n/g, '')).not.toMatch(/\n/);
  });
});

// ------------------------------------------------------------ launcher
describe('the user never sees a console', () => {
  it('every shortcut and the installer go through the hidden launcher', async () => {
    const iss = await read('release/installer/DAMC.iss');
    // Open / Start / Stop / desktop: wscript + the .vbs, never a .cmd.
    const launcherIcons = iss.split('\n').filter(l => l.startsWith('Name: "{group}\\DAMC"') || l.startsWith('Name: "{group}\\Start DAMC"') || l.startsWith('Name: "{group}\\Stop DAMC"') || l.startsWith('Name: "{autodesktop}\\DAMC"'));
    expect(launcherIcons).toHaveLength(4);
    for (const l of launcherIcons) {
      expect(l).toContain('{sys}\\wscript.exe');
      expect(l).toContain('damc-launch.vbs');
    }
    // No [Run] entry executes a .cmd; the post-install start is hidden, from [Code].
    const run = iss.slice(iss.indexOf('[Run]'), iss.indexOf('[UninstallRun]'));
    expect(run).not.toMatch(/\.cmd/);
    expect(iss).toMatch(/wscript\.exe'\),\s*\n?\s*'"' \+ ExpandConstant\('\{app\}\\scripts\\damc-launch\.vbs'\) \+ '" start nogui'/);
    expect(iss).toMatch(/damc-launch\.vbs'\) \+ '" start nogui',[\s\S]{0,120}SW_HIDE/);
    // The wizard tells the user what is happening instead of a console.
    expect(iss).toContain("CustomMessage('DamcPreparing')");
    // The browser is offered only if the start succeeded.
    expect(run).toContain('Check: DamcStartedCheck');
  });

  it('launcher runs the start script with window style 0 and reports failures in a dialog', async () => {
    const bytes = await fs.readFile(path.join(root, 'release/payload/scripts/damc-launch.vbs'));
    // Windows-949 on purpose: wscript reads the system code page. A UTF-8 BOM would
    // be executed as garbage on the first line.
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const vbs = new TextDecoder('euc-kr').decode(bytes);
    expect(vbs).toMatch(/damc-start\.cmd"" --no-pause""", 0, True\)/);
    expect(vbs).toMatch(/damc-stop\.cmd""""", 0, True\)/);
    // Duplicate-start guard on "open": a healthy DAMC means browser only.
    expect(vbs).toMatch(/If mode = "open" And Healthy\(\) Then/);
    // One message per exit code, a log offer, and a nogui mode for the installer.
    for (const code of ['Case 2', 'Case 3', 'Case 4', 'Case 5, 6', 'Case 7', 'Case 8']) expect(vbs).toContain(code);
    expect(vbs).toMatch(/MsgBox\(msg/);
    expect(vbs).toMatch(/If nogui Then/);
    expect(vbs).toContain('notepad.exe');
  });

  it('start script is silent, checks for a running DAMC before loading anything, and reports by exit code', async () => {
    const start = await read('release/payload/scripts/damc-start.cmd');
    // No echo except log lines: nothing is printed for a person.
    expect(start).not.toMatch(/^\s*echo (?!\[%date%)/m);
    expect(start).not.toMatch(/\bpause\b/);
    // Health check comes before the image/database/start work.
    expect(start.indexOf('/health')).toBeGreaterThan(-1);
    expect(start.indexOf('/health')).toBeLessThan(start.indexOf('docker load'));
    expect(start).toMatch(/already running - nothing to do[\s\S]{0,40}exit \/b 0/);
    for (const code of [2, 3, 4, 5, 6, 7, 8]) expect(start, `exit ${code}`).toContain(`exit /b ${code}`);
  });
});

// ----------------------------------------------------------- AI connection
describe('AI connection UX', () => {
  it('has no connect button that merely scrolls', async () => {
    const page = await read('web/pages/connections.js');
    expect(page).not.toContain('data-connect-ai');
    expect(page).toContain("t('connections.openSetup')");
    expect(page).toContain("t('connections.testConnection')");
  });

  it('walks the user through key → config → test inside one dialog', async () => {
    const page = await read('web/pages/connections.js');
    for (const step of ['connections.step1', 'connections.step2', 'connections.step3']) expect(page).toContain(step);
    // Step 1 creates the key in place and keeps the dialog open.
    expect(page).toMatch(/#modal-create-key'\)\?\.addEventListener\('click', async/);
    expect(page).toMatch(/api\.createApiKey\(`\$\{setupModalFor\}-/);
    expect(page).not.toMatch(/#modal-create-key[\s\S]{0,200}setupModalFor = null/);
  });

  it('shows a test result with a cause and a next step, and re-reads status afterwards', async () => {
    const page = await read('web/pages/connections.js');
    expect(page).toContain("'connections.testResultOk'");
    expect(page).toContain("'connections.testResultFail'");
    expect(page).toContain("'connections.testNext'");
    expect(page).toMatch(/lastTest\[provider\] = \{ ok: false/);
    expect(page).toMatch(/busyTest = null;[\s\S]{0,300}await load\(\);/);
  });

  it('never calls a configured client connected', async () => {
    const d = await dict();
    for (const lang of ['en', 'ko'] as const) {
      const v = d[lang];
      // "Configured (not connected)" is the intended wording: the state name itself
      // must carry the negation, never read as a bare "Connected".
      expect(v['connections.connConfigured'], lang).toMatch(/not connected|미연결/);
      expect(v['connections.connConfigured'], lang).not.toMatch(/^connected|^연결됨/i);
      expect(v['connections.hintConfigured'], lang).toMatch(/not connected|연결됨이 아닙/);
      expect(v['connections.unusedHint'], lang).not.toMatch(/^Connected|연결은 되었/);
      // Only ACTIVE may say connected.
      expect(v['connections.hintActive'], lang).toMatch(/Connected|연결됨/);
    }
    const page = await read('web/pages/connections.js');
    expect(page).toMatch(/ACTIVE: 'connections\.hintActive'/);
    expect(page).toMatch(/CONFIGURED: 'connections\.hintConfigured'/);
  });

  it('separates MCP agents from app-connected services and explains MCP', async () => {
    const service = await read('src/services/connector-status-service.ts');
    expect(service).toMatch(/kind: 'agent' \| 'service'/);
    // Each catalog entry, from its provider line to the next one, carries its kind.
    const catalog = service.slice(service.indexOf('function aiClients('), service.indexOf('export async function getConnectorStatus'));
    for (const [prov, kind] of [['hermes', 'agent'], ['cursor', 'agent'], ['claude', 'agent'], ['chatgpt', 'service'], ['grok', 'service'], ['perplexity', 'service']]) {
      const start = catalog.indexOf(`provider: '${prov}',`);
      expect(start, prov).toBeGreaterThan(-1);
      const next = catalog.indexOf('provider: ', start + 10);
      const entry = catalog.slice(start, next === -1 ? undefined : next);
      expect(entry, prov).toContain(`kind: '${kind}',`);
    }
    const page = await read('web/pages/connections.js');
    expect(page).toContain("'connections.groupAgents'");
    expect(page).toContain("'connections.groupServices'");
    expect(page).toContain("t('connections.mcpPlain')");
  });
});

// ------------------------------------------------------------- Obsidian
describe('Obsidian replaces the in-app graph', () => {
  it('menu says Obsidian, not Graph, and there is no graph page or renderer', async () => {
    const app = await read('web/app.js');
    expect(app).toContain("import obsidian from './pages/obsidian.js'");
    expect(app).not.toMatch(/pages\/graph\.js|id: 'graph'/);
    await expect(fs.stat(path.join(root, 'web/pages/graph.js'))).rejects.toBeDefined();
    const d = await dict();
    expect(d.ko['nav.obsidian']).toBe('Obsidian');
    expect(Object.keys(d.en).filter(k => k.startsWith('graph.') || k === 'nav.graph')).toEqual([]);
    // No graph engine, per the product decision.
    const pkg = JSON.parse(await read('package.json'));
    for (const lib of ['d3', 'cytoscape', 'vis-network', 'sigma', 'force-graph']) {
      expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), lib).not.toContain(lib);
    }
  });

  it('page shows connection state, vault location, last sync and sync targets, with sync / copy / how-to', async () => {
    const page = await read('web/pages/obsidian.js');
    for (const key of ['obsidian.vaultLabel', 'obsidian.lastSync', 'obsidian.targets', 'obsidian.sync', 'obsidian.copyPath', 'obsidian.howTo',
                       'obsidian.tMemories', 'obsidian.tDecisions', 'obsidian.tTasks', 'obsidian.tRelations']) {
      expect(page, key).toContain(key);
    }
    expect(page).toContain('api.getObsidianStatus()');
    expect(page).toContain('api.exportObsidian()');
    // One-way: nothing on this page writes memory from Obsidian back into DAMC.
    expect(page).not.toMatch(/api\.(createMemory|updateMemory|importFile)/);
  });

  it('shipped runtime writes the vault to a real Windows folder, not inside the container volume', async () => {
    const compose = await read('release/payload/docker-compose.yml');
    expect(compose).toMatch(/OBSIDIAN_VAULT_PATH:\s*\/damc-obsidian/);
    expect(compose).toMatch(/- C:\/DAMC_OBSIDIAN:\/damc-obsidian/);
    expect(compose).toMatch(/DAMC_OBSIDIAN_HOST_DIR:\s*C:\\DAMC_OBSIDIAN/);
    const start = await read('release/payload/scripts/damc-start.cmd');
    expect(start).toMatch(/mkdir "C:\\DAMC_OBSIDIAN"/);
  });

  it('status endpoint reads the folder rather than a flag', async () => {
    const { obsidianStatus } = await import('../src/services/export-service.js');
    const svc = await read('src/services/export-service.ts');
    expect(svc).toContain("_DAMC_INDEX.md");
    expect(typeof obsidianStatus).toBe('function');
    const routes = await read('src/http/routes.ts');
    expect(routes).toContain("app.get('/v1/export/obsidian/status'");
  });
});

// ------------------------------------------------ Obsidian note names
describe('Obsidian note file names survive the real data', () => {
  // Found by syncing the real database: 583 notes in, ENAMETOOLONG on a title made
  // of box-drawing characters. The old cap was 150 characters; the limit is bytes.
  it('bounds a name in UTF-8 bytes, cutting on a character boundary', async () => {
    const { obsidianNoteName } = await import('../src/services/export-service.js');
    const boxes = '═'.repeat(100) + ' EARTHUS V2 — 메뉴';
    const name = obsidianNoteName(boxes);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(name + '-2aa60252.md', 'utf8')).toBeLessThan(255);
    expect(name).not.toMatch(/\uFFFD/);            // no split multi-byte character
    const korean = '가'.repeat(80);                 // 240 bytes
    expect(Buffer.byteLength(obsidianNoteName(korean), 'utf8')).toBeLessThanOrEqual(120);
    expect(obsidianNoteName(korean)).toMatch(/^가+$/);
  });

  it('produces names NTFS accepts through the bind mount', async () => {
    const { obsidianNoteName } = await import('../src/services/export-service.js');
    expect(obsidianNoteName('결정. ')).toBe('결정');            // trailing dot/space
    expect(obsidianNoteName('a\tb\u0007c')).toBe('a b c');     // control characters
    expect(obsidianNoteName('con')).toBe('con-note');          // reserved device name
    expect(obsidianNoteName('what/why: "x"?')).toBe('what-why- -x--');
    expect(obsidianNoteName('   ')).toBe('memory');
  });

  it('links relations to the files it actually wrote', async () => {
    // The index already used name-id8; the relations block did not, so every
    // wikilink pointed at a file that did not exist and Obsidian drew no edges.
    const svc = await fs.readFile(path.join(root, 'src/services/export-service.ts'), 'utf8');
    expect(svc).toMatch(/const noteName = \(m: \{ id: string; title: string \}\) => `\$\{safeName\(m\.title\)\}-\$\{m\.id\.slice\(0, 8\)\}`/);
    expect(svc).toMatch(/\[\[\$\{map\.get\(l\.id\) \?\? noteName\(l\)\}\]\]/);
    expect(svc).not.toMatch(/map\.set\(m\.id, safeName\(m\.title\)\)/);
    // And one bad note no longer aborts the sync.
    expect(svc).toMatch(/failed \+= 1/);
    expect(svc).toMatch(/return \{ root, memories: memories\.rows\.length - failed, failed \}/);
  });
});

// ----------------------------------------------------------- import UX
describe('import completion shows what actually happened', () => {
  it('lists every observed count and only observed counts', async () => {
    const page = await read('web/pages/import.js');
    for (const f of ['metaConversations', 'metaMessages', 'metaImported', 'metaDeduplicated', 'metaMemories', 'metaDecisions', 'metaTasks', 'metaProjects']) {
      expect(page, f).toContain(`import.${f}`);
    }
    // A missing value is omitted, never rendered as 0.
    expect(page).toMatch(/o\.decisions != null \?/);
    expect(page).toMatch(/o\.projects != null \?/);
    const d = await dict();
    expect(d.ko['import.doneTitle']).toBe('가져오기가 완료되었습니다');
  });
});

// ------------------------------------------------------------ no demo
describe('no demo data behind the friendlier empty states', () => {
  it('demo datasets are still empty and the seeder is still gone', async () => {
    const demo = await import('../web/demo-data.js') as Record<string, unknown>;
    for (const [name, value] of Object.entries(demo)) {
      if (Array.isArray(value)) expect(value, name).toEqual([]);
    }
    await expect(fs.stat(path.join(root, 'scripts/seed.ts'))).rejects.toBeDefined();
  });

  it('the Obsidian status helper reports a missing folder as a state, not by creating it', async () => {
    // Pure folder read: a status call on a path that does not exist must not create it.
    const { obsidianStatus } = await import('../src/services/export-service.js');
    const missing = path.join(os.tmpdir(), `damc-obsidian-status-${process.pid}-${Date.now()}`);
    let result: any = null;
    try { result = await obsidianStatus('00000000-0000-0000-0000-0000000000ff', missing); }
    catch { /* no database in this test: the folder half of the check is what matters */ }
    await expect(fs.stat(missing)).rejects.toBeDefined();
    if (result) {
      expect(result.folderExists).toBe(false);
      expect(result.synced).toBe(false);
    }
  });
});
