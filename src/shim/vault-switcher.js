// The vault switcher — the iPad's way from one vault to another. Desktop
// opens another vault in another window and keeps its vault UI (recents,
// Create, the demo) on the Welcome screen, which a window with a vault
// never shows; the iPad has one scene, so without this, once a vault was
// open there was no finding another (the owner's report, 2026-10-03).
//
// Three ways in: the vault's name at the top of the file explorer, the
// palette's "Switch vault…", and ⌘⇧O (desktop's Open Vault). The sheet
// lists the remembered vaults — removable, and an unreachable one says why
// and offers to go — then Open Folder…, Create New Vault… and the demo.
// The switch itself is the shim's (ipc.js vaultSwitch): the open vault is
// settled — Save / Discard / Cancel for anything dirty, every save landed —
// and the page reloads into the next one, as desktop opens a fresh window.
//
// Also the app page's Save / Discard / Cancel dialog (CONFIRM_DISCARD).
import { registerCommand } from '../../vendor/clew/renderer/commands/registry.js';

const shim = () => window.__clewShim;

/** A modal sheet: centred, above everything, fitted to the VISUAL viewport
 *  (the software keyboard may be up), closed by Esc or its backdrop. */
function sheet({ label, onClose }) {
	const backdrop = document.createElement('div');
	backdrop.className = 'ios-sheet-backdrop';
	const box = document.createElement('div');
	box.className = 'ios-sheet';
	box.setAttribute('role', 'dialog');
	box.setAttribute('aria-modal', 'true');
	box.setAttribute('aria-label', label);
	backdrop.append(box);
	const fit = () => {
		const vv = window.visualViewport;
		const top = vv ? vv.offsetTop : 0;
		const height = vv ? vv.height : window.innerHeight;
		backdrop.style.top = `${Math.round(top)}px`;
		backdrop.style.height = `${Math.round(height)}px`;
		box.style.maxHeight = `${Math.max(160, Math.round(height - 32))}px`;
	};
	const keys = (e) => {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
	};
	const close = () => {
		window.visualViewport?.removeEventListener('resize', fit);
		window.visualViewport?.removeEventListener('scroll', fit);
		window.removeEventListener('keydown', keys, true);
		backdrop.remove();
		onClose?.();
	};
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	window.visualViewport?.addEventListener('resize', fit);
	window.visualViewport?.addEventListener('scroll', fit);
	window.addEventListener('keydown', keys, true);
	document.body.append(backdrop);
	fit();
	return { box, close, fit };
}

const button = (text, className, onClick) => {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = className;
	b.textContent = text;
	b.addEventListener('click', onClick);
	return b;
};

/** Where a remembered vault lives, in words. */
function placeOf(st) {
	if (st.kind === 'documents') return st.name === 'Demo Vault' ? 'On My iPad · the demo vault' : 'On My iPad';
	const p = String(st.resolved ?? st.path);
	if (/Mobile Documents\/com~apple~CloudDocs/.test(p)) return 'iCloud Drive';
	if (/File Provider Storage|CloudStorage/.test(p)) return 'Files';
	return 'Elsewhere';
}

let open = null;

/** The vault sheet. */
export async function openVaultSwitcher() {
	if (open) return open;
	const { box, close } = sheet({ label: 'Vaults', onClose: () => { open = null; } });
	open = box;
	box.classList.add('ios-vaults');
	const head = document.createElement('div');
	head.className = 'ios-sheet-head';
	const title = document.createElement('span');
	title.className = 'ios-sheet-title';
	title.textContent = 'Vaults';
	head.append(title, button('Done', 'ios-sheet-done', close));
	const list = document.createElement('div');
	list.className = 'ios-vault-list';
	const problem = document.createElement('div');
	problem.className = 'ios-vault-problem';
	problem.hidden = true;
	const status = document.createElement('p');
	status.className = 'ios-vault-status';
	status.setAttribute('aria-live', 'polite');
	const actions = document.createElement('div');
	actions.className = 'ios-vault-actions';
	box.append(head, list, problem, actions, status);

	let busy = false;
	const setBusy = (on, text = '') => {
		busy = on;
		box.classList.toggle('is-busy', on);
		for (const b of box.querySelectorAll('button:not(.ios-sheet-done)')) b.disabled = on || b.dataset.locked === '1';
		status.textContent = text;
	};
	/** Run a switch; the page reloads on success, so only a refusal or a
	 *  cancel comes back here. */
	const go = async (fn) => {
		if (busy) return;
		problem.hidden = true;
		setBusy(true, 'Opening…');
		try {
			const result = await fn();
			// A result means no reload: the vault chosen is the one open (or
			// one opened in place) — nothing left to choose.
			if (result) { close(); return; }
			setBusy(false, 'Nothing changed.');
		} catch (err) {
			setBusy(false, String(err?.message ?? err).replace(/^Error:\s*/, ''));
		}
	};
	const showProblem = (st) => {
		problem.replaceChildren();
		const text = document.createElement('p');
		text.textContent = `“${st.name}” can’t be opened. ${st.reason ?? ''}`.trim();
		problem.append(text,
			button('Remove from List', 'ios-vault-button is-destructive', async () => { await shim().vaultSwitch.forget(st.path); problem.hidden = true; await render(); }),
			button('Keep', 'ios-vault-button', () => { problem.hidden = true; }));
		problem.hidden = false;
	};
	const render = async () => {
		const recent = await shim().vaultSwitch.recent().catch(() => []);
		list.replaceChildren();
		if (recent.length) {
			const label = document.createElement('div');
			label.className = 'ios-vault-section';
			label.textContent = 'Recent';
			list.append(label);
		}
		for (const st of recent) {
			const row = document.createElement('div');
			row.className = `ios-vault${st.current ? ' is-current' : ''}${st.ok ? '' : ' is-unavailable'}`;
			const openBtn = document.createElement('button');
			openBtn.type = 'button';
			openBtn.className = 'ios-vault-open';
			const name = document.createElement('span');
			name.className = 'ios-vault-name';
			name.textContent = st.name;
			const where = document.createElement('span');
			where.className = 'ios-vault-where';
			where.textContent = st.current ? `${placeOf(st)} · open now` : st.ok ? placeOf(st) : 'Can’t be opened';
			openBtn.append(name, where);
			if (st.current) { openBtn.disabled = true; openBtn.dataset.locked = '1'; openBtn.setAttribute('aria-current', 'true'); }
			openBtn.addEventListener('click', () => {
				if (!st.ok) return showProblem(st);
				go(() => shim().vaultSwitch.switchTo(st.resolved ?? st.path));
			});
			row.append(openBtn);
			if (!st.current) {
				const remove = button('✕', 'ios-vault-remove', async () => { await shim().vaultSwitch.forget(st.path); await render(); });
				remove.setAttribute('aria-label', `Remove ${st.name} from the list`);
				row.append(remove);
			}
			list.append(row);
		}
	};
	actions.append(
		button('Open Folder…', 'ios-vault-button', () => go(() => shim().vaultSwitch.openFolder())),
		button('Create New Vault…', 'ios-vault-button', () => go(() => shim().vaultSwitch.createVault())),
		button('Demo Vault', 'ios-vault-button', () => go(() => shim().vaultSwitch.openDemo())),
	);
	await render();
	box.querySelector('button.ios-vault-open:not([disabled]), .ios-vault-button')?.focus({ preventScroll: true });
	return box;
}

/** Save / Discard / Cancel (CONFIRM_DISCARD): resolves 'save' | 'discard' | 'cancel'. */
export function confirmDiscard({ message = 'Save changes?', detail = '' } = {}) {
	return new Promise((resolve) => {
		let answer = 'cancel';
		const { box, close } = sheet({ label: message, onClose: () => resolve(answer) });
		box.classList.add('ios-confirm');
		const title = document.createElement('p');
		title.className = 'ios-confirm-message';
		title.textContent = message;
		const more = document.createElement('p');
		more.className = 'ios-confirm-detail';
		more.textContent = detail;
		const row = document.createElement('div');
		row.className = 'ios-confirm-actions';
		const pick = (value) => () => { answer = value; close(); };
		row.append(
			button('Don’t Save', 'ios-vault-button is-destructive', pick('discard')),
			button('Cancel', 'ios-vault-button', pick('cancel')),
			button('Save', 'ios-vault-button is-default', pick('save')),
		);
		box.append(title, ...(detail ? [more] : []), row);
		box.querySelector('.is-default').focus({ preventScroll: true });
	});
}

// ---- the ways in ------------------------------------------------------------

// The vault's name at the top of the file explorer.
document.addEventListener('click', (e) => {
	if (e.target.closest?.('clew-file-explorer .panel-header .panel-title')) {
		e.preventDefault();
		openVaultSwitcher();
	}
}, true);
// …marked as the button it is (the explorer re-renders its header, so the
// marking follows it).
const markTitle = () => {
	for (const t of document.querySelectorAll('clew-file-explorer .panel-header .panel-title:not([data-ios-switch])')) {
		t.dataset.iosSwitch = '1';
		t.setAttribute('role', 'button');
		t.setAttribute('tabindex', '0');
		t.setAttribute('aria-label', `${t.textContent} — switch vault`);
		t.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVaultSwitcher(); }
		});
	}
};
let marking = false;
new MutationObserver(() => {
	if (marking) return;
	marking = true;
	requestAnimationFrame(() => { marking = false; markTitle(); });
}).observe(document.body, { childList: true, subtree: true });
markTitle();

// The palette, and desktop's Open Vault chord.
registerCommand({ id: 'vault:switch', name: 'Switch vault…', hotkeys: ['Mod-Shift-o'], run: () => { openVaultSwitcher(); } });

// Save / Discard / Cancel for the shim's CONFIRM_DISCARD.
if (shim()?.ui) shim().ui.confirmDiscard = confirmDiscard;
