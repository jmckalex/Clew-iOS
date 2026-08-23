// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Pointer-event tab dragging (HTML5 DnD is janky in Electron and unstylable).
// Started from a tab's pointerdown; a 4px movement threshold separates drags
// from clicks. Drop targets: a tab bar (insertion index) or a tab-group body
// (5 regions: center = move into group, edges = split that side).
import { workspaceStore } from '../state/workspace-store.js';
import { uiStore } from '../state/ui-store.js';

const THRESHOLD = 4;

export function startTabDrag(e, { tabId, groupId, tabEl }) {
	if (e.button !== 0) return;
	const startX = e.clientX;
	const startY = e.clientY;
	let ghost = null;
	let marker = null;
	let hoverGroup = null;
	let dropTarget = null; // {kind:'bar', groupId, index} | {kind:'group', groupId, region}

	const clearIndicators = () => {
		hoverGroup?.clearDrop();
		hoverGroup = null;
		marker?.remove();
		marker = null;
	};

	const onMove = (ev) => {
		if (!ghost) {
			if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
			ghost = makeGhost(tabEl);
			uiStore.startDrag({ tabId, fromGroupId: groupId });
			document.body.classList.add('is-tab-dragging');
		}
		ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;

		const under = document.elementFromPoint(ev.clientX, ev.clientY);
		const bar = under?.closest('clew-tab-bar');
		const group = under?.closest('clew-tab-group');
		clearIndicators();
		dropTarget = null;
		if (bar) {
			const index = barInsertionIndex(bar, ev.clientX);
			marker = placeMarker(bar, index);
			dropTarget = { kind: 'bar', groupId: bar.groupId, index };
		} else if (group) {
			const region = groupRegion(group, ev.clientX, ev.clientY);
			hoverGroup = group;
			group.showDrop(region);
			dropTarget = { kind: 'group', groupId: group.groupId, region };
		}
	};

	const finish = (apply) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onCancel);
		window.removeEventListener('keydown', onKey, true);
		// Belt and braces: no drag artifact may outlive the drag, even if a
		// re-render replaced elements mid-flight.
		document.querySelectorAll('.tab-ghost, .tab-drop-marker').forEach((el) => el.remove());
		clearIndicators();
		ghost?.remove();
		document.body.classList.remove('is-tab-dragging');
		const wasDragging = ghost !== null;
		ghost = null;
		uiStore.endDrag();
		if (apply && wasDragging && dropTarget) {
			if (dropTarget.kind === 'bar') {
				workspaceStore.moveTab(tabId, dropTarget.groupId, dropTarget.index);
			} else if (dropTarget.region === 'center') {
				workspaceStore.moveTab(tabId, dropTarget.groupId, Infinity);
			} else {
				workspaceStore.splitWithTab(dropTarget.groupId, dropTarget.region, tabId);
			}
		}
	};

	const onUp = () => finish(true);
	const onCancel = () => finish(false);
	const onKey = (ev) => {
		if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
	};

	// Window-level listeners: a mid-drag tab-bar rebuild can replace tabEl,
	// and element-bound listeners (with pointer capture) would then never
	// see pointerup — orphaning the ghost and drop marker on screen.
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onCancel);
	window.addEventListener('keydown', onKey, true);
}

function makeGhost(tabEl) {
	const ghost = document.createElement('div');
	ghost.className = 'tab-ghost';
	ghost.textContent = tabEl.querySelector('.tab-title')?.textContent ?? '';
	document.body.append(ghost);
	return ghost;
}

function barInsertionIndex(bar, x) {
	const tabs = [...bar.querySelectorAll('.tab')];
	for (let i = 0; i < tabs.length; i++) {
		const rect = tabs[i].getBoundingClientRect();
		if (x < rect.left + rect.width / 2) return i;
	}
	return tabs.length;
}

function placeMarker(bar, index) {
	const tabs = [...bar.querySelectorAll('.tab')];
	const marker = document.createElement('div');
	marker.className = 'tab-drop-marker';
	const barRect = bar.getBoundingClientRect();
	let x;
	if (tabs.length === 0) x = 4;
	else if (index < tabs.length) x = tabs[index].getBoundingClientRect().left - barRect.left;
	else {
		const last = tabs[tabs.length - 1].getBoundingClientRect();
		x = last.right - barRect.left;
	}
	marker.style.left = `${x}px`;
	bar.append(marker);
	return marker;
}

function groupRegion(group, x, y) {
	const rect = group.getBoundingClientRect();
	const rx = (x - rect.left) / rect.width;
	const ry = (y - rect.top) / rect.height;
	const EDGE = 0.25;
	if (rx < EDGE) return 'left';
	if (rx > 1 - EDGE) return 'right';
	if (ry < EDGE) return 'top';
	if (ry > 1 - EDGE) return 'bottom';
	return 'center';
}
