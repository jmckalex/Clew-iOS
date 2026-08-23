# API Playground

This note is **alive**: press ⌘E and the controls below run against the
real app through `window.clew` (see [[Note API]]). Everything here is
plain script tags in the markdown — view this note in source mode to
read the code.

<style>
.api-demo { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.api-demo button { font: inherit; color: inherit; padding: 3px 12px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent); cursor: pointer; }
.api-demo button:hover { background: color-mix(in srgb, currentColor 16%, transparent); }
.api-demo .bar { height: 8px; border-radius: 4px; margin: 3px 0 8px;
  background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
.api-demo .bar > div { height: 100%; background: #7aa2f7; }
.api-demo input { font: inherit; padding: 3px 8px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: transparent; color: inherit; width: 55%; }
.api-note { font-size: 0.85em; opacity: 0.7; }
</style>

## A shared counter

<div class="api-demo">
  <button id="counter-dec">−</button>
  <strong id="counter-value" style="display:inline-block;min-width:2.5em;text-align:center">…</strong>
  <button id="counter-inc">+</button>
  <span class="api-note">Lives in <code>clewdata.json</code>. Open this note in a
  second pane (or a canvas embed): every view updates the instant any of
  them clicks.</span>
</div>

<script>
(async () => {
  if (!window.clew) return; // exported HTML: stay static
  const show = (v) => {
    const el = document.getElementById('counter-value');
    if (el) el.textContent = v ?? 0;
  };
  show(await clew.kv.get('playground:counter'));
  clew.on('kv', ({ key, value }) => { if (key === 'playground:counter') show(value); });
  document.addEventListener('click', async (e) => {
    const delta = e.target.id === 'counter-inc' ? 1 : e.target.id === 'counter-dec' ? -1 : 0;
    if (!delta) return;
    const current = (await clew.kv.get('playground:counter')) ?? 0;
    await clew.kv.set('playground:counter', current + delta);
  });
})();
</script>

## Task rollup across the vault

<div class="api-demo" id="task-rollup">Loading…</div>

<script>
(async () => {
  if (!window.clew) return;
  const box = () => document.getElementById('task-rollup');
  async function build() {
    const rows = [];
    for (const path of await clew.notes.list()) {
      const text = await clew.notes.read(path);
      const done = (text.match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length;
      const open = (text.match(/^\s*[-*+]\s+\[ \]/gm) ?? []).length;
      if (done + open > 0) rows.push({ path, done, total: done + open });
    }
    rows.sort((a, b) => b.total - a.total);
    const el = box();
    if (!el) return;
    el.innerHTML = rows.map(({ path, done, total }) => {
      const name = path.split('/').pop().replace(/\.(md|jmd)$/i, '');
      const pct = Math.round((100 * done) / total);
      return `<div><button data-open="${path}">${name}</button>`
        + ` <span class="api-note">${done}/${total} done</span>`
        + `<div class="bar"><div style="width:${pct}%"></div></div></div>`;
    }).join('') + `<button id="task-refresh">Refresh</button>`;
  }
  build();
  document.addEventListener('click', (e) => {
    if (e.target.dataset.open) clew.open(e.target.dataset.open);
    if (e.target.id === 'task-refresh') build();
  });
})();
</script>

## Quick capture

<div class="api-demo">
  <input id="capture-input" placeholder="A thought to keep…">
  <button id="capture-send">Capture</button>
  <span class="api-note">Appends a timestamped line to
  <code>Inbox.md</code> (created on first use).</span>
</div>

<script>
(() => {
  if (!window.clew) return;
  async function capture() {
    const input = document.getElementById('capture-input');
    const text = input?.value.trim();
    if (!text) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await clew.notes.append('Inbox.md', `- ${stamp} — ${text}`);
    input.value = '';
    input.placeholder = 'Captured ✓';
  }
  document.addEventListener('click', (e) => { if (e.target.id === 'capture-send') capture(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'capture-input') capture();
  });
})();
</script>

## Command deck

<div class="api-demo">
  <button data-command="view:toggle-theme">Toggle theme</button>
  <button data-command="nav:graph">Graph view</button>
  <button data-command="nav:daily-note">Today's daily note</button>
  <button data-command="workspace:split-right">Split right</button>
  <span class="api-note">Any palette command is a button away.</span>
</div>

<script>
(() => {
  if (!window.clew) return;
  document.addEventListener('click', (e) => {
    if (e.target.dataset.command) clew.command(e.target.dataset.command);
  });
})();
</script>

## Vault stats

<div class="api-demo" id="vault-stats">Loading…</div>

<script>
(async () => {
  if (!window.clew) return;
  const paths = await clew.notes.list();
  let links = 0;
  const tags = new Set();
  for (const path of paths) {
    const meta = await clew.index.get(path);
    links += meta?.links?.length ?? 0;
    for (const t of meta?.tags ?? []) tags.add(t.tag);
  }
  const el = document.getElementById('vault-stats');
  if (el) el.textContent =
    `${paths.length} notes · ${links} links · ${tags.size} distinct tags`;
})();
</script>

---

More live notes: [[Habit Tracker]] is a small app; [[Adventure]] is a
tiny game whose world is spread across notes — the vault as the program.
