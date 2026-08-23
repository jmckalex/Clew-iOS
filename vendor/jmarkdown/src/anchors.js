
export const anchors = {
	name: 'anchor',
	level: 'inline',
	start(src) { return src.match(/⚓️/)?.index },
	tokenizer(src) {
		const match = src.match(/^⚓️([a-zA-Z0-9_-]+)/);
		if (match) {
			const token = {
				type: 'anchor',
				raw: match[0],
				text: match[1].trim(),
				tokens: []
			};
			return token;
		}
	},
	renderer(token) {
		return `<span id='${token.text}'></span>`;
	}
};



