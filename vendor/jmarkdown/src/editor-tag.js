export const editors = {
	name: 'editors',
	level: 'inline',
	start(src) { return src.match(/✍️/)?.index },
	tokenizer(src) {
		const match = src.match(/^✍️/);
		if (match) {
			const token = {
				type: 'editors',
				raw: match[0],
				text: "",
				tokens: []
			};
			return token;
		}
	},
	renderer(token) {
		// A class, not an id: editor tags repeat, and duplicate ids are
		// invalid HTML. The tokenizer captures no per-tag value anyway.
		return `<span class='editor-tag'>✍️</span>`;
	}
};



