// App-level settings on iOS: localStorage instead of Electron's userData
// file. Same keys and surface as vendor/clew/main/settings.js.
//
// The defaults are upstream's (main/settings.js) with the iOS overrides the
// live-edit plan records (UPSTREAM-LIVE-EDIT-PLAN.md §2), each explained at
// its line. The renderer reads several of these WITHOUT a fallback
// (graphReferences, texFragments, previewPane, editorToolbarGroups,
// slashCommands, selectionBubble, defaultEditMode, newTabMode), so every
// key upstream defines must be defined here too.
const DEFAULTS = {
	recentVaults: [],
	openVaults: [],
	// Live is the default EDIT mode on iOS (plan §2.11): upstream keeps new
	// tabs in source ("do not move users"); the iPad has no users to move,
	// no chords, and the toolbar — the only formatting surface without a
	// hardware keyboard — is shown by default only in live mode. A tab's
	// mode is per vault in workspace.json, so a tab opened live here is
	// live on the desktop next time, which is upstream's own design.
	newTabMode: 'live', // 'source' | 'live' | 'reading'
	defaultEditMode: 'live', // where the mode toggle returns from reading
	liveReveal: 'construct', // 'construct' | 'line'
	liveRenderMath: true,
	liveRenderFences: true,
	liveRenderEmbeds: true,
	// Upstream caps live block documents at 16 per editor; each is a full
	// preview document (~22 MB measured on desktop, plus a wasm engine for
	// a figure), and an iPad's content process is jetsam-killed well short
	// of what a Mac tolerates. Half, until the device says otherwise (§2.3).
	liveFrameCap: 8,
	// 'always', not upstream's 'live': the toolbar is the formatting
	// surface on a touch screen, so source mode gets it too (§2.11).
	editorToolbar: 'always',
	editorToolbarPrev: 'live',
	editorToolbarGroups: null,
	// The selection bubble appears above the selection on pointerup —
	// exactly where and when iOS draws its own callout (Copy · Look Up …),
	// and every command on it is on the toolbar (§2.6). Reversible.
	selectionBubble: false,
	slashCommands: true,
	// Link hover previews need a hover. Touch has none, and WebKit's
	// tap-synthesised mousemove would arm the 500 ms timer with no
	// mouseleave ever coming — a tap that only reveals would pop a 440 px
	// preview half a second later (§2.5). An iPad with a trackpad delivers
	// real hover, and the setting stays in Settings for that reader.
	linkPreview: 'off', // 'hover' | 'mod' | 'off'
	previewPane: 'on', // 'on' | 'off'
	graphReferences: false,
	sidenotes: 'auto', // 'auto' | 'on' | 'off'
	explorerOpenMode: 'new-tab',
	diaryMode: 'files',
	diaryLogFile: 'Diary.md',
	lastVault: null,
	theme: 'dark',
	// Paper for "Export as PDF (reading view)" — upstream's default.
	printPaperSize: 'a4',
	// Named TeX fragments a figure can ask for with `clew-fragments=`
	// ([{ name, text }] — vendor/clew/engine/tex-fragments.js). These are
	// the GLOBAL ones (this device's); a vault's own live in its
	// vault-settings.json and shadow these where the names meet.
	texFragments: [],
	// Custom callout types, this device's (Settings → Callouts; a vault's own
	// are in its vault-settings.json). Resolved by the shim (ipc.js).
	callouts: [],
	// Desktop-only, kept so a settings object reads the same everywhere: no
	// LaTeX toolchain (the row is dropped, scripts/build.js), no CJK font
	// download (its section is dropped), no shell (stubbed).
	latexEngine: 'auto',
	pdfCjkFonts: false,
	shellFont: '',
	// The daily update check (Clew-app 036befe) is desktop's: the iPad's
	// updates are the App Store's, so it is off and UPDATE_CHECK says so.
	updateCheck: 'off',
	skippedUpdate: null,
};

const STORE_KEY = 'clew-settings';

class Settings {
	#data = { ...DEFAULTS };

	load() {
		try {
			this.#data = { ...DEFAULTS, ...JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') };
		} catch {
			this.#data = { ...DEFAULTS };
		}
	}

	get(key) {
		return key === undefined ? { ...this.#data } : this.#data[key];
	}

	set(key, value) {
		this.#data[key] = value;
		this.#save();
	}

	rememberVault(vaultPath) {
		const recent = this.#data.recentVaults.filter((p) => p !== vaultPath);
		recent.unshift(vaultPath);
		this.#data.recentVaults = recent.slice(0, 10);
		this.#data.lastVault = vaultPath;
		this.#save();
	}

	/** The remembered list, rewritten (the vault switcher: one entry per
	 *  vault, at its current path). */
	setRecentVaults(list) {
		this.#data.recentVaults = list.slice(0, 10);
		this.#save();
	}

	/** A remembered vault removed from the list (the vault switcher). */
	forgetVault(vaultPath) {
		this.#data.recentVaults = this.#data.recentVaults.filter((p) => p !== vaultPath);
		this.#save();
	}

	#save() {
		try {
			globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(this.#data));
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}
}

export const settings = new Settings();
settings.load();
