// Word Count — the smallest useful app-surface plugin; copy me.
clew.commands.register({
	id: 'count',
	name: 'Word count of the active note',
	hotkeys: ['Mod-Alt-w'],
	run: async () => {
		const path = clew.workspace.activePath();
		if (!path) { clew.ui.notice('No active note'); return; }
		const text = await clew.vault.read(path);
		const words = (text.match(/\S+/g) ?? []).length;
		const lines = text.split('\n').length;
		clew.ui.notice(`${words.toLocaleString()} words · ${text.length.toLocaleString()} characters · ${lines.toLocaleString()} lines`);
	},
});
