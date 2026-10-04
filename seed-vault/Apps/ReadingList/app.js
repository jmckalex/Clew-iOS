// Reading List — every note in the vault whose properties say `status:
// to-read`, in a note (Features/App Gallery). It lists the vault's notes
// (`query`), reads each one's properties (`notes.read`) and opens the one
// you pick (`links.open`). It changes nothing.
const $ = (id) => document.getElementById(id);
const BATCH = 10;

const baseName = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');
const text = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

async function scan() {
	$('refresh').disabled = true;
	$('status').textContent = 'Looking through the vault…';
	const paths = (await clew.notes.list()).filter((p) => /\.(md|jmd)$/i.test(p));
	const found = [];
	for (let i = 0; i < paths.length; i += BATCH) {
		const props = await Promise.all(paths.slice(i, i + BATCH).map((p) => clew.properties.get(p).catch(() => null)));
		props.forEach((pr, k) => {
			if (pr && String(pr.status ?? '').trim().toLowerCase() === 'to-read') found.push({ path: paths[i + k], ...pr });
		});
	}
	found.sort((a, b) => text(a.date).localeCompare(text(b.date)) || baseName(a.path).localeCompare(baseName(b.path)));
	const list = $('list');
	list.replaceChildren();
	for (const item of found) {
		const li = document.createElement('li');
		const b = document.createElement('button');
		b.type = 'button';
		const title = document.createElement('span');
		title.className = 'title';
		title.textContent = text(item.title) || baseName(item.path);
		const date = document.createElement('span');
		date.className = 'date';
		date.textContent = text(item.date);
		const author = document.createElement('span');
		author.className = 'author';
		author.textContent = text(item.author) || '—';
		b.append(title, date, author);
		b.title = `Open ${item.path}`;
		b.addEventListener('click', () => clew.open(item.path).catch((err) => { $('status').textContent = `Could not open it: ${err.message}`; }));
		li.append(b);
		list.append(li);
	}
	document.body.dataset.count = String(found.length);
	$('status').textContent = found.length
		? `${found.length} to read, of ${paths.length} notes — give a note “status: to-read” to add it.`
		: 'Nothing to read: give a note the property status: to-read.';
	$('refresh').disabled = false;
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	if (!clew.can('query') || !clew.can('notes.read')) {
		$('status').textContent = 'Allow it to search this vault and read its notes to see the list.';
		return;
	}
	$('refresh').addEventListener('click', () => scan().catch((err) => { $('status').textContent = err.message; }));
	await scan();
}

main().catch((err) => { $('status').textContent = `Reading List: ${err.message}`; });
