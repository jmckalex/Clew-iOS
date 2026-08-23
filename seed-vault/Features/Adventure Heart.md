# Adventure: The Heart

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
    const el = document.getElementById('adv');
    if (!el) return;
    if (!s['adventure:thread']) {
      el.innerHTML = `<p>You shouldn't be here without the thread — the
        corridors close ranks and usher you out.</p>
        <button data-act="go" data-to="Adventure">Back to the gate</button>`;
      return;
    }
    el.innerHTML = s['adventure:won']
      ? `<p>The heart of the labyrinth is just a quiet room with a
         well-kept index. You've already made peace here.</p>
         <button data-act="go" data-to="Adventure">Walk out along the thread</button>`
      : `<p>At the center sits not a monster but a librarian, hopelessly
         lost among unlinked notes. You hand over the clew of thread.
         "<i>Ah,</i>" it says, "<i>backlinks.</i>" The labyrinth begins,
         gratefully, to index itself.</p>
         <button data-act="win">Give the librarian your thread</button>`;
  }
  document.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (act === 'go') await clew.open(e.target.dataset.to, { newTab: false, mode: 'reading' });
    if (act === 'win') {
      await clew.kv.set('adventure:won', true);
      await clew.kv.delete('adventure:thread');
    }
  });
  clew.on('kv', ({ key }) => { if (key.startsWith('adventure:')) build(); });
  build();
})();
</script>
