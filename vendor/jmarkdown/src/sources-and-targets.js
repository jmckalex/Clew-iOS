import { registerBlockEnvironment } from './begin-end-core.js';

export const targets = {
	level: 'inline',
	label: 'target',
	marker: ':',
	renderer(token) {
		if (token.meta.name === "target") {
			return `<span data-target-id='${token.text.trim()}'></span>`;
		}
		return false;
	}
}

export const sources = {
	level: 'container',
	label: "source",
	// tokenizer: function(text, token) {
	// 	token.text = text.replace("\n", '');
	// 	return token;
	// },
	renderer(token) {
		if (token.meta.name === "source") {
			const target = token.attrs.target.trim();
			return `<div data-target='${target}'>${this.parser.parse(token.tokens)}</div>`;
		}
		return false;
	}
};


export const inlineTarget = {
	name: 'inlineTarget',
	level: 'inline',
	start(src) { return src.match(/🎯/)?.index },
	tokenizer(src) {
		const match = src.match(/^🎯([a-zA-Z0-9_-]+)/);
		if (match) {
			const token = {
				type: 'inlineTarget',
				raw: match[0],
				text: match[1].trim(),
				tokens: []
			};
			return token;
		}
	},
	renderer(token) {
		return `<span data-target-id='${token.text}'></span>`;
	}
};


/*
	@-sigil ports of the colon forms, sharing the begin-end registry (the ':::source'
	container and ':target' inline stay live alongside). Both are HTML-only — the colon
	renderers never branch on global.isLatex, so an `html`-only handler reproduces them
	in both output formats. The emoji `🎯` inlineTarget is not a colon directive and is
	untouched.

	  @begin(source){target=X} … @end(source)   ≡  :::source{target=X} … :::
	  @target[X]                                 ≡  :target[X]
*/
registerBlockEnvironment('source', {
	mode: 'markdown',
	html: (ctx) => `<div data-target='${(ctx.attrs?.target ?? '').trim()}'>${ctx.inner}</div>`
});
registerBlockEnvironment('target', {
	mode: 'verbatim',
	html: (ctx) => `<span data-target-id='${ctx.text.trim()}'></span>`
});


export function replaceTargetsBySources($) {
	$('[data-target]').each(function () {
		const $sourceElement = $(this);
		const targetID = $sourceElement.attr('data-target');
		// Find all target elements
		$(`[data-target-id='${targetID}']`).each(function() {
			const $targetElement = $(this);
			$sourceElement.removeAttr('data-target');
			$targetElement.replaceWith($sourceElement.clone());
		});
		$sourceElement.remove();
	})
}


