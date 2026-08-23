# Adventure: The Labyrinth

<style>
.adv { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px 16px; margin: 10px 0; }
.adv button { font: inherit; color: inherit; padding: 3px 12px; border-radius: 6px; margin: 2px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent); cursor: pointer; }
.adv button:hover { background: color-mix(in srgb, currentColor 16%, transparent); }
</style>

<div class="adv" id="adv">Loading…</div>

<script>
(async () => {
  if (!window.clew) return;
  async function build() {
    const s = await clew.kv.list('adventure:');
    const thread = !!s['adventure:thread'];
    const el = document.getElementById('adv');
    if (!el) return;
    el.innerHTML = thread
      ? `<p>Corridors of half-remembered notes branch endlessly, but the
         thread pays out behind you, sure as a backlink. Ahead, a warm
         light: the heart of the labyrinth.</p>
         <button data-act="go" data-to="Adventure Heart">Follow the thread inward</button>
         <button data-act="go" data-to="Adventure">Return to the gate</button>`
      : `<p>Ten steps in, every corridor looks like every other corridor.
         Without a thread to pay out behind you, you circle back to where
         you began. <i>Something by the gate might help.</i></p>
         <button data-act="go" data-to="Adventure">Stumble back to the gate</button>`;
  }
  document.addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'go') await clew.open(e.target.dataset.to, { newTab: false, mode: 'reading' });
  });
  clew.on('kv', ({ key }) => { if (key.startsWith('adventure:')) build(); });
  build();
})();
</script>
