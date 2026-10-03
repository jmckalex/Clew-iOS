// Flashcards — a small app in a note (Guide/Apps in Notes). It reads the
// note it sits in (`note.read`) for lines starting `Q:` and `A:`, and keeps
// its best score in its own corner of clewdata.json (`app.kv`); a card
// added to the note appears when the note is saved (`note-changed`). Everything
// goes through window.clew, which Clew injects; the app runs on an origin
// of its own and reaches nothing it was not allowed.
const $ = (id) => document.getElementById(id);
let cards = [];
let order = [];
let shown = false;
let right = 0;
let seen = 0;
let best = null;

function cardsIn(text) {
	const out = [];
	let question = null;
	for (const line of text.split('\n')) {
		const q = /^\s*(?:[-*]\s+)?Q:\s*(.+)$/.exec(line);
		if (q) { question = q[1].trim(); continue; }
		const a = /^\s*(?:[-*]\s+)?A:\s*(.+)$/.exec(line);
		if (a && question) { out.push({ q: question, a: a[1].trim() }); question = null; }
	}
	return out;
}

function draw() {
	const card = cards[order[0]];
	if (!card) {
		$('card').textContent = cards.length ? `Done: ${right} of ${seen} on the first try.` : 'No cards: write lines starting “Q:” and “A:” in the note.';
		for (const id of ['flip', 'know', 'again']) $(id).disabled = true;
		return;
	}
	$('card').innerHTML = '';
	const q = document.createElement('div');
	q.textContent = card.q;
	$('card').append(q);
	if (shown) {
		const a = document.createElement('div');
		a.className = 'answer';
		a.textContent = card.a;
		$('card').append(a);
	}
	$('flip').disabled = shown;
	$('know').disabled = $('again').disabled = !shown;
	$('score').textContent = `${right} right of ${seen}${best !== null ? ` · best ${best}` : ''}`;
}

async function answered(knew) {
	seen++;
	if (knew) right++;
	const current = order.shift();
	if (!knew) order.push(current);
	shown = false;
	if (order.length === 0 && clew.can('app.kv') && right > (best ?? 0)) {
		best = right;
		await clew.kv.set('best', best);
	}
	draw();
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	if (!clew.can('note.read')) {
		$('card').textContent = 'Allow “read this note” (Settings → This vault → Apps) to see the cards.';
		return;
	}
	cards = cardsIn(await clew.notes.read());
	order = cards.map((_, i) => i);
	// The note was saved with new cards (or fewer): start the round again.
	clew.on('note-changed', async () => {
		const next = cardsIn(await clew.notes.read());
		if (JSON.stringify(next) === JSON.stringify(cards)) return;
		cards = next;
		order = cards.map((_, i) => i);
		shown = false;
		right = seen = 0;
		draw();
	});
	if (clew.can('app.kv')) best = (await clew.kv.get('best')) ?? null;
	$('flip').onclick = () => { shown = true; draw(); };
	$('know').onclick = () => answered(true);
	$('again').onclick = () => answered(false);
	draw();
}

main().catch((err) => { $('card').textContent = `Flashcards: ${err.message}`; });
