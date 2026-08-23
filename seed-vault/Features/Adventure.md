# Adventure: The Gate

A tiny game whose world is spread across three notes — shared state in
`clewdata.json`, movement via `clew.open`. The vault is the program;
the notes are its rooms. (A *clew*, of course, is the ball of thread
Ariadne gave Theseus. This app was inevitable.)

<style>
.adv { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px 16px; margin: 10px 0; }
.adv button { font: inherit; color: inherit; padding: 3px 12px; border-radius: 6px; margin: 2px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent); cursor: pointer; }
.adv button:hover { background: color-mix(in srgb, currentColor 16%, transparent); }
.adv .inv { font-size: 0.85em; opacity: 0.7; margin-top: 8px; }
</style>

<div class="adv" id="adv">Loading…</div>

<script>
(async () => {
  if (!window.clew) return;
  async function build() {
    const s = await clew.kv.list('adventure:');
    const thread = !!s['adventure:thread'];
    const won = !!s['adventure:won'];
    const el = document.getElementById('adv');
    if (!el) return;
    el.innerHTML = won
      ? `<p>The labyrinth stands quiet behind you. The thread brought you home.</p>
         <button data-act="reset">Play again</button>`
      : `<p>You stand before the labyrinth of notes. On a hook by the gate
         hangs ${thread ? 'nothing — the clew of thread is in your hand' : 'a <b>clew of thread</b>'}.</p>
         ${thread ? '' : '<button data-act="take">Take the clew</button>'}
         <button data-act="go" data-to="Adventure Labyrinth">Enter the labyrinth</button>
         <div class="inv">Inventory: ${thread ? '🧶 a clew of thread' : 'nothing'}</div>`;
  }
  document.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (act === 'take') await clew.kv.set('adventure:thread', true);
    if (act === 'go') await clew.open(e.target.dataset.to, { newTab: false, mode: 'reading' });
    if (act === 'reset') {
      await clew.kv.delete('adventure:thread');
      await clew.kv.delete('adventure:won');
    }
  });
  clew.on('kv', ({ key }) => { if (key.startsWith('adventure:')) build(); });
  build();
})();
</script>
