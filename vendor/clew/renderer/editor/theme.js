// CodeMirror theme: everything maps to CSS classes / custom properties, so
// switching Clew's theme (body[data-theme]) restyles the editor with no
// CM reconfiguration. Colors live in styles/themes/{light,dark}.css.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const clewEditorTheme = EditorView.theme({
	'&': {
		height: '100%',
		fontSize: 'var(--clew-editor-font-size)',
		backgroundColor: 'transparent',
		color: 'var(--clew-text-normal)',
	},
	'.cm-content': {
		fontFamily: 'var(--clew-editor-font)',
		caretColor: 'var(--clew-accent)',
		padding: '24px 0 40vh 0',
		maxWidth: 'var(--clew-editor-line-width)',
		margin: '0 auto',
		lineHeight: '1.6',
	},
	'.cm-scroller': { fontFamily: 'var(--clew-editor-font)' },
	'.cm-line': { padding: '0 24px' },
	'&.cm-focused': { outline: 'none' },
	'.cm-cursor': { borderLeftColor: 'var(--clew-accent)' },
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
		backgroundColor: 'var(--clew-selection) !important',
	},
	'.cm-activeLine': { backgroundColor: 'var(--clew-active-line)' },
	'.cm-gutters': { display: 'none' },
	'.cm-panels': {
		backgroundColor: 'var(--clew-bg-secondary)',
		color: 'var(--clew-text-normal)',
		border: 'none',
	},
	'.cm-panel.cm-search': {
		padding: '6px 8px',
		fontFamily: 'var(--clew-ui-font)',
		fontSize: '13px',
	},
	'.cm-panel.cm-search label': { color: 'var(--clew-text-muted)' },
	'.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--clew-accent)' },
	'.cm-panel.cm-search [name=close]': {
		color: 'var(--clew-text-muted)',
		fontSize: '18px',
		padding: '0 6px',
	},
	'.cm-textfield': {
		backgroundColor: 'var(--clew-bg-primary)',
		color: 'var(--clew-text-normal)',
		border: '1px solid var(--clew-border)',
		borderRadius: '4px',
	},
	'.cm-textfield:focus': { borderColor: 'var(--clew-accent)', outline: 'none' },
	'.cm-button': {
		backgroundColor: 'var(--clew-bg-tertiary)',
		backgroundImage: 'none',
		color: 'var(--clew-text-normal)',
		border: '1px solid var(--clew-border)',
		borderRadius: '4px',
	},
	'.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--clew-active-item)' },
	'.cm-searchMatch': { backgroundColor: 'var(--clew-search-match)' },
	'.cm-searchMatch-selected': { backgroundColor: 'var(--clew-search-match-selected)' },
	'.cm-tooltip': {
		backgroundColor: 'var(--clew-bg-secondary)',
		border: '1px solid var(--clew-border)',
		borderRadius: '6px',
	},
	'.cm-tooltip-autocomplete ul li[aria-selected]': {
		backgroundColor: 'var(--clew-accent)',
		color: 'var(--clew-text-on-accent)',
	},
});

// Markdown syntax → classes; colors are supplied by the theme CSS files.
// (The jmarkdown dialect overlay arrives in M3 and layers on top of this.)
export const clewHighlighting = syntaxHighlighting(HighlightStyle.define([
	{ tag: tags.heading1, class: 'cmt-heading cmt-heading1' },
	{ tag: tags.heading2, class: 'cmt-heading cmt-heading2' },
	{ tag: tags.heading3, class: 'cmt-heading cmt-heading3' },
	{ tag: tags.heading4, class: 'cmt-heading cmt-heading4' },
	{ tag: tags.heading5, class: 'cmt-heading cmt-heading5' },
	{ tag: tags.heading6, class: 'cmt-heading cmt-heading6' },
	{ tag: tags.emphasis, class: 'cmt-emphasis' },
	{ tag: tags.strong, class: 'cmt-strong' },
	{ tag: tags.strikethrough, class: 'cmt-strikethrough' },
	{ tag: tags.link, class: 'cmt-link' },
	{ tag: tags.url, class: 'cmt-url' },
	{ tag: tags.monospace, class: 'cmt-code' },
	{ tag: tags.quote, class: 'cmt-quote' },
	{ tag: tags.list, class: 'cmt-list' },
	{ tag: tags.meta, class: 'cmt-meta' },
	{ tag: tags.processingInstruction, class: 'cmt-formatting' },
	{ tag: tags.labelName, class: 'cmt-label' },
	{ tag: tags.comment, class: 'cmt-comment' },
	{ tag: tags.contentSeparator, class: 'cmt-hr' },
]));
