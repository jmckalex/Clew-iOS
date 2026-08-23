# Habit Tracker

A small app living in a note. The grid below is built from
`clewdata.json` — click any cell to toggle that habit on that day.
Because the state travels with the vault, your streaks sync wherever the
vault goes; because every view listens for changes, an embedded copy of
this note on a canvas updates in real time.

<style>
.habit-app table { border-collapse: collapse; }
.habit-app td, .habit-app th { border: none; padding: 2px 3px; text-align: center; }
.habit-app th { font-size: 0.75em; opacity: 0.65; font-weight: 600; }
.habit-app .habit-name { text-align: right; padding-right: 10px; font-weight: 600; }
.habit-app .cell { width: 22px; height: 22px; border-radius: 5px; cursor: pointer;
  background: color-mix(in srgb, currentColor 10%, transparent); }
.habit-app .cell.is-done { background: #44cf6e; }
.habit-app .cell.is-today { outline: 2px solid color-mix(in srgb, currentColor 40%, transparent); }
.habit-app .streak { font-size: 0.85em; opacity: 0.75; padding-left: 10px; }
</style>

<div class="habit-app" id="habit-app">Loading…</div>

<script>
(async () => {
  if (!window.clew) return;
  const HABITS = ['Write', 'Read', 'Walk'];
  const DAYS = 14;

  const iso = (d) => d.toISOString().slice(0, 10);
  const dayList = () => {
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(iso(d));
    }
    return days;
  };

  async function build() {
    const stored = await clew.kv.list('habit:');
    const doneOn = (day, habit) => (stored[`habit:${day}`] ?? []).includes(habit);
    const days = dayList();
    const today = days[days.length - 1];

    const header = '<tr><th></th>' + days.map((d) =>
      `<th title="${d}">${d.slice(8)}</th>`).join('') + '<th></th></tr>';
    const rows = HABITS.map((habit) => {
      let streak = 0;
      for (let i = days.length - 1; i >= 0 && doneOn(days[i], habit); i--) streak++;
      const cells = days.map((day) =>
        `<td><div class="cell${doneOn(day, habit) ? ' is-done' : ''}`
        + `${day === today ? ' is-today' : ''}" data-day="${day}" data-habit="${habit}"></div></td>`).join('');
      return `<tr><td class="habit-name">${habit}</td>${cells}`
        + `<td class="streak">${streak ? streak + '🔥' : ''}</td></tr>`;
    }).join('');

    const el = document.getElementById('habit-app');
    if (el) el.innerHTML = `<table>${header}${rows}</table>`;
  }

  document.addEventListener('click', async (e) => {
    const { day, habit } = e.target.dataset;
    if (!day || !habit) return;
    const key = `habit:${day}`;
    const current = (await clew.kv.get(key)) ?? [];
    const next = current.includes(habit)
      ? current.filter((h) => h !== habit)
      : [...current, habit];
    await clew.kv.set(key, next.length ? next : null);
  });

  clew.on('kv', ({ key }) => { if (key.startsWith('habit:')) build(); });
  build();
})();
</script>

Change the `HABITS` list in this note's source to track your own. The
same pattern — a list of keys in the store, a grid renderer, a click
handler, a `kv` listener — is the skeleton of most small vault apps.
