// Ephemeral UI state: focus context, tab-drag state, open modal.
// Never persisted.
import { Emitter } from '../lib/emitter.js';

class UiStore extends Emitter {
	/** @type {{tabId: string, fromGroupId: string} | null} */
	drag = null;
	editorFocused = false;

	startDrag(drag) { this.drag = drag; this.emit('drag-changed', drag); }
	endDrag() { this.drag = null; this.emit('drag-changed', null); }

	setEditorFocused(focused) {
		this.editorFocused = focused;
		this.emit('focus-changed');
	}
}

export const uiStore = new UiStore();
