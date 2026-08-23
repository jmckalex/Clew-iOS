// Cmd/Ctrl+click a [[wikilink]] in the editor to open it (creating the note
// when unresolved, Obsidian-style). Finds the link by scanning the clicked
// line's text — independent of the highlighting overlay.
import { EditorView } from '@codemirror/view';
import * as actions from '../commands/actions.js';

const LINK_RE = /(!?)\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

export function wikilinkClick() {
	return EditorView.domEventHandlers({
		mousedown(event, view) {
			if (!(event.metaKey || event.ctrlKey)) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return false;
			const line = view.state.doc.lineAt(pos);
			const column = pos - line.from;

			LINK_RE.lastIndex = 0;
			let match;
			while ((match = LINK_RE.exec(line.text)) !== null) {
				const start = match.index;
				const end = start + match[0].length;
				if (column >= start && column <= end) {
					event.preventDefault();
					const target = match[2].trim() + (match[3] ? `#${match[3].trim()}` : '');
					actions.openWikilink(target, { newTab: event.altKey });
					return true;
				}
			}
			return false;
		},
	});
}
