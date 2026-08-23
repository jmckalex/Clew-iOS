/*
	This is a directive designed for typesetting side-by-side displays
	of markdown (or HTML) code on the left, and the compiled / formatted
	version on the right. 
*/
import hljs from 'highlight.js';
import { marked_copy } from './utils.js';
import { registerBlockEnvironment } from './begin-end-core.js';

function createMarkdownDemo(marker) {
	return {
		level: 'container',
		marker: marker,
		label: "markdown-demo",
		tokenizer: function(text, token) {
			let lang = token?.attrs?.type ?? "markdown";
			this.lexer.blockTokens(text, token.tokens);
			return token;
		},
		renderer(token) {
			if (token.meta.name === "markdown-demo") {
				// There is always a spurious "\n" at the start, so throw it away to avoid
				// introducing unnecessary whitespace.
				let t = token.text.split("\n");
				t.shift();

				// Make the code available to highlight.js directly without
				// wrapping it in code-fenced blocks and processing it with blockTokens().
				// Why?  Because if the demo code includes a code-fenced bit, that will
				// create a parse error.
				const code = t.join('\n');
				const lang = token?.attrs?.type ?? "markdown";
				const highlightedCode = hljs.highlight(code, {language: lang}).value;

				const right = this.parser.parse(token.tokens);
				let display = `<div class='markdown-demo-container'>
	<div class='markdown-demo-code-label'>Markdown code</div>
	<div class='markdown-demo-output-label'>Markdown output</div>
	<div class='markdown-demo-markdown'>
	<pre><code class='hljs language-${lang}'>${highlightedCode}</code></pre>
	</div>
	<div class='markdown-demo-parsed'>
	${right}
	</div>
	</div>`;
				return display;
			}
		return false;
		}
	}
}

/*
	Mirror ::::markdown-demo as @begin(markdown-demo), reusing the directive's own
	tokenizer + renderer verbatim (the game/TiKZ no-drift pattern). The renderer does
	token.text.split('\n') then t.shift() to drop the container's leading blank line,
	so the dedented @begin body is prepended with '\n' to reproduce that; token.text
	and the block-token pass both see the same normalised body. mode:'custom' hands the
	body raw to the demo tokenizer (which block-lexes it into token.tokens) rather than
	re-lexing it as inline markdown. {type=…} still selects the highlight language via
	ctx.attrs (set by begin-end-core before tokenize).
*/
const markdownDemoEnvInstance = createMarkdownDemo();   // marker arg unused by tokenizer/renderer
registerBlockEnvironment('markdown-demo', {
	mode: 'custom',
	tokenize(body, token) {
		token.meta = { name: 'markdown-demo' };
		token.text = '\n' + body.replace(/\n+$/, '');
		markdownDemoEnvInstance.tokenizer.call(this, token.text, token);
	},
	render: (ctx) => markdownDemoEnvInstance.renderer.call({ parser: ctx.parser }, ctx.token)
});

export default createMarkdownDemo;