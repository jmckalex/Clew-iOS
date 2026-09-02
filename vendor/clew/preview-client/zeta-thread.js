// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The ZetaOffice office-thread script (spike rig): runs inside the LOWA
// worker (listed in Module.uno_scripts after zeta.js), where the zetajs
// UNO bridge lives. Loads and stores documents on orders from zeta-page.js
// over zetajs.mainPort. NOT a module — the worker loads it verbatim.
//
// Debugging note: in devtools this is the "em-pthread" worker with the
// most memory, the one where `zetajs` is defined.

'use strict';

let zetajs, css, context, desktop, xModel;

function tell(msg) { zetajs.mainPort.postMessage(msg); }

function tryUno(what, fn) {
	try {
		fn();
	} catch (e) {
		let detail;
		try { detail = zetajs.fromAny(zetajs.catchUnoException(e)).Message; }
		catch { detail = String(e); }
		tell({ cmd: 'error', message: `${what}: ${detail}` });
	}
}

// LibreOffice's own Save on a .docx/.xlsx/.pptx pops a "keep current
// format?" dialog by default. The format is not in question — the file
// keeps its own — so turn the warning off before any document loads.
function disableAlienFormatWarning() {
	tryUno('config', () => {
		const config = css.configuration.ReadWriteAccess.create(context, 'en-US');
		const save = config.getByHierarchicalName('/org.openoffice.Office.Common/Save/Document');
		save.setPropertyValue('WarnAlienFormat', false);
		config.commitChanges();
	});
}

// File-menu commands that operate on the Emscripten FS — Open, Recent
// Documents, Save As, New — are not harmful, just disorienting: they show
// a phantom filesystem the user's real files are not in. LibreOffice's
// own kiosk mechanism (the DisableCommands set, which also strips the
// entries from menus and toolbars) turns them off; the document's real
// save path — toolbar Save / Ctrl+S / the app's zeta-save — stays.
// Command names per the DisableCommands convention: the .uno: URL minus
// its prefix.
const DISABLED_COMMANDS = [
	'AddDirect', 'NewDoc', 'Open', 'OpenFromWriter', 'OpenFromCalc',
	'OpenRemote', 'SaveRemote', 'SaveAsRemote', 'RecentFileList',
	'SaveAs', 'SaveACopy', 'SaveAll', 'ExportTo', 'ExportToPDF',
	'ExportDirectToPDF', 'CloseDoc', 'CloseWin', 'Quit',
];

function disableFileCommands() {
	tryUno('config', () => {
		const config = css.configuration.ReadWriteAccess.create(context, 'en-US');
		const disabled = config.getByHierarchicalName('/org.openoffice.Office.Commands/Execute/Disabled');
		let n = 0;
		for (const command of DISABLED_COMMANDS) {
			const node = disabled.createInstance();
			node.setPropertyValue('Command', command);
			disabled.insertByName('clew' + n++, node);
		}
		config.commitChanges();
	});
}

function loadFile(fileUrl, chromeless) {
	// Small (16 px) toolbar icons, set BEFORE the document UI builds —
	// unlike the icon THEME (resolved once at startup; see zeta-icons.js),
	// the size is consulted when each toolbar is built, so this lands.
	// The keys are UNO shorts: a bare JS number arrives as the wrong type
	// and configmgr refuses it ("inappropriate property value").
	tryUno('iconsize', () => {
		const config = css.configuration.ReadWriteAccess.create(context, 'en-US');
		const misc = config.getByHierarchicalName('/org.openoffice.Office.Common/Misc');
		misc.setPropertyValue('SymbolSet', new zetajs.Any(zetajs.type.short, 0));
		misc.setPropertyValue('SidebarIconSize', new zetajs.Any(zetajs.type.short, 1));
		config.commitChanges();
	});
	tryUno('load', () => {
		xModel = desktop.loadComponentFromURL(fileUrl, '_default', 0, []);
		const ctrl = xModel.getCurrentController();
		ctrl.getFrame().getContainerWindow().FullScreen = true;
		if (chromeless) {
			// Thumbnail mode: the capture wants the DOCUMENT, so every piece
			// of LibreOffice chrome goes — toolbars/menubar/statusbar via the
			// layout manager, the sidebar via its own toggle (it opens by
			// default and the layout manager does not own it).
			tryUno('chromeless', () => {
				ctrl.getFrame().LayoutManager.setVisible(false);
				ctrl.getFrame().LayoutManager.hideElement('private:resource/menubar/menubar');
				const dispatcher = css.frame.DispatchHelper.create(context);
				// Both are TOGGLES (default on): the sidebar rail and the ruler.
				dispatcher.executeDispatch(ctrl.getFrame(), '.uno:Sidebar', '', 0, []);
				dispatcher.executeDispatch(ctrl.getFrame(), '.uno:Ruler', '', 0, []);
			});
		}
		// Dirty-state tracking: every store (ours, the toolbar's, Ctrl+S)
		// resets the modified flag, so the page can treat modified→false as
		// "the Emscripten FS now matches the model — push it to the vault".
		const listener = zetajs.unoObject([css.util.XModifyListener], {
			modified: () => tell({ cmd: 'modified', state: xModel.isModified() }),
			disposing: () => {},
		});
		xModel.addModifyListener(listener);
		tell({ cmd: 'ui_ready' });
	});
}

// Explicit save from the host page: same location, same format, no UI.
function storeInPlace() {
	tryUno('save', () => {
		if (xModel.isModified()) xModel.store();
		else tell({ cmd: 'modified', state: false });
	});
}

// Smoke-harness hook: a real edit through UNO, so the save pipeline can be
// verified end-to-end without keyboard synthesis. Writer gets a marker
// string; other document types just get their modified flag raised.
function testEdit() {
	tryUno('testedit', () => {
		const xTextDoc = xModel.queryInterface(zetajs.type.interface(css.text.XTextDocument));
		if (xTextDoc) {
			const text = xTextDoc.getText();
			text.insertString(text.createTextCursor(), 'ZETA-SPIKE-EDIT ', false);
		} else {
			xModel.setModified(true);
		}
		tell({ cmd: 'edited' });
	});
}

function saveFile(fileUrl, filterName) {
	tryUno('save', () => {
		const props = [new css.beans.PropertyValue({ Name: 'Overwrite', Value: true })];
		if (filterName) {
			props.push(new css.beans.PropertyValue({ Name: 'FilterName', Value: filterName }));
		}
		xModel.storeToURL(fileUrl, props);
		tell({ cmd: 'saved' });
	});
}

Module.zetajs.then((pZetajs) => {
	zetajs = pZetajs;
	css = zetajs.uno.com.sun.star;
	context = zetajs.getUnoComponentContext();
	desktop = css.frame.Desktop.create(context);

	zetajs.mainPort.onmessage = (e) => {
		switch (e.data.cmd) {
		case 'load': loadFile(e.data.fileUrl, e.data.chromeless === true); break;
		case 'save': storeInPlace(); break;
		case 'testedit': testEdit(); break;
		case 'savetest': saveFile(e.data.fileUrl, e.data.filterName); break;
		default: tell({ cmd: 'error', message: 'unknown command ' + e.data.cmd });
		}
	};
	disableAlienFormatWarning();
	disableFileCommands();
	tell({ cmd: 'thr_running' });
});
