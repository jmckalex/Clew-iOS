import { runInThisContext } from './utils.js';
import * as acorn from 'acorn';
import { noteCodeAllowed, refuseNoteCode, noteCodeError } from './note-code.js';

/*
	This file defines several extensions which look for blocks of the form

		<script [...]>
			// JavaScript code
		</script>

	in the jmarkdown file.  There are several different types of scripts it looks for:

	1. Normal javascript blocks to be passed through to the HTML file, verbatim.

	2. JavaScript which defines code to be executed during processing of the jmarkdown file.
		This code can (a) generate HTML code which will be inserted in place of the script
		element, in the HTML file.  Alternatively, it may (b) define a JavaScript function which will
		create a new extension that gives the impression of the JavaScript function
		being called from the jmarkdown file itself.
	
	3. JavaScript which defines code to be executed during post-processing.  This means that the
		jmarkdown file has been processed and the provisional HTML output generated.  However,
		during post-processing, a Cheerio object is initialised with that provisional HTML output,
		and the post-processing code is evaluated with $ defined as that cheerio object.  This allows
		the JavaScript code to do DOM manipulation prior to writing out the final HTML.
*/

/*
	This extension simply looks for <script> tags, which it then captures and
	passes through to the output HTML verbatim.  I needed to write this
	because the marked.js parser occassionally mis-identifies scripts
*/

const script_regexp = /<script(?:\s+(?:src="[^"]*"|type="[^"]*"|defer|async|integrity="[^"]*"|crossorigin(?:="[^"]*")?))*\s*>[\s\S]*?<\/script>/i;

/*
	Where a script BLOCK may start: at the start of a line, and only where the
	extension's own tokenizer (`rule`, anchored with ^) would then claim it.
	A block extension's start() is where marked may cut the paragraph it is
	building; these used to search for `<script` ANYWHERE, so a paragraph or
	blockquote holding `<script>…</script>` in inline code was cut at the tag
	and the script emitted live — it ran in a trusted vault (Clew-app,
	2026-10-04). The rule in CLAUDE.md ("Block extension start() must only
	report positions its tokenizer can match"), applied here.
*/
function scriptBlockStart(src, rule) {
	const lineStarts = /(^|\n)(?=<script\b)/gi;
	let m;
	while ((m = lineStarts.exec(src))) {
		const at = m.index + m[1].length;
		if (rule.test(src.slice(at))) return at;
		lineStarts.lastIndex = at + 1;
	}
	return undefined;
}

const javascript_script = {
				name: 'javascript',
				level: 'block',
				start(src) {
					return scriptBlockStart(src, new RegExp('^' + script_regexp.source, 'i'));
				},
				tokenizer(src) {
					const rule = new RegExp( "^" + script_regexp.source);
					const match = rule.exec(src);

					if (match) {
						// `script_regexp` has no capturing groups, so `match[1]`
						// was always undefined. The renderer emits `token.raw`
						// verbatim, so `text` is only here for marked's convention;
						// point it at the whole match instead of nothing.
						const token = {
							type: 'javascript',
							raw: match[0],
							text: match[0],
							tokens: []
						};
						return token;
					}
				},
				renderer(token) {
					// A page's script has no place in print: in LaTeX it was written
					// into the .tex as text, and its code printed in the PDF.
					return global.isLatex ? '' : `${token.raw}`;
				}
			};

/*
	This extension finds and extracts scripts which should either be
	run during compile time (data-type='jmarkdown') or saved for execution once the final
	document has been assembled (data=type='jmarkdown-postprocess').
*/

export let postprocessor_scripts = []; // array of all the post-processor scripts - this will be exported to the main programme

const jmarkdown_script = {
				name: 'jmarkdownScript',
				level: 'block',
				start(src) {
					return scriptBlockStart(src, /^<script\s+data-type=(['"])(?:jmarkdown|jmarkdown-postprocess)\1[^>]*>\s+[\s\S]*?<\/script>/i);
				},
				tokenizer(src) {
					const rule = /^<script[^>]*>(\s+[\s\S]*?)<\/script>/;
					const match = rule.exec(src);

					if (match) {
						// Check to make sure it's jmarkdown script code!
						if (match[0].search(/<script\s+data-type=(['"])(?:jmarkdown|jmarkdown-postprocess)\1/i) == -1) {
							return;
						}

						let script = match[1]
						let [tag, ...rest] = match[0].split('>');

						// `Run note code: false` (note-code.js): the block is claimed,
						// so its source never reaches the page, and neither kind runs.
						if (!noteCodeAllowed()) {
							const kind = tag.includes("jmarkdown-postprocess") ? 'jmarkdown-postprocess script' : 'jmarkdown script';
							return {
								type: 'jmarkdownScript',
								raw: match[0],
								text: match[1],
								output: refuseNoteCode(kind, { block: true }),
								tokens: []
							};
						}

						// Use Acorn to validate the parsing
						let exp;
						try {
							exp = acorn.parse(script, { ecmaVersion: 2022 });
						}
						catch (error) {
							const syntaxError = highlightSyntaxError(error, script);
							const display = `<div class='jmarkdown-script-parse-error'><div>Jmarkdown script parse error</div><pre><code>${syntaxError.display}</code></pre></div>`;
							const token = {
								type: 'jmarkdownScript',
								raw: match[0],
								text: match[1],
								output: display,
								tokens: []
							};
							return token;
						}

						// Check if it's a postprocessor script
						if (tag.includes("jmarkdown-postprocess") == true) {
							global.output = '';
							postprocessor_scripts.push(script);
							return {
								type: 'jmarkdownScript',
								raw: match[0],
								text: match[1],
								output: '',
								tokens: []
							};
						}
						else {
							global.output = '';
							// A script that throws as it runs is shown in place, the
							// way a parse error above is, and the build carries on
							// (note-code.js). Whatever it set before it threw stays set.
							try {
								runInThisContext(script);
							}
							catch (error) {
								return {
									type: 'jmarkdownScript',
									raw: match[0],
									text: match[1],
									output: noteCodeError('jmarkdown script', error, { block: true }),
									tokens: []
								};
							}
							let token = {
								type: 'jmarkdownScript',
								raw: match[0],
								text: match[1],
								output: global.output,
								tokens: []
							};

							if (typeof global.output == "object" && global.output !== null) {
								if ('block' in global.output) {
									token.text = global.output.block;
									token.tokenize = 'block';
									this.lexer.blockTokens(token.text, token.tokens);
								}
								else {
									token.text = global.output.inline;
									token.tokenize = 'inline';
									this.lexer.inline(token.text, token.tokens);
								}
							}
							return token;
						}
						/*
						const token = {
							type: 'jmarkdownScript',
							raw: match[0],
							text: match[1],
							output: global.output,
							tokens: []
						};
						return token;
						*/
					}
				},
				renderer(token) {
					if (token?.tokenize == "inline") {
						return this.parser.parseInline(token.tokens);
					}
					else if (token?.tokenize == 'block') {
						return this.parser.parse(token.tokens);
					}
					else {
						return token.output;
					}
				}
			};

function highlightSyntaxError(error, script) {
	// Initialize the error message and location
	const errorMessage = error.message || "Unknown syntax error";
	const lineNumber = error.loc?.line || 0;
	const columnNumber = error.loc?.column || 0;

	// Split the script into lines
	const lines = script.split('\n');

	// Create a visual error indicator
	let errorDisplay = '';
	let errorIndicator = '';

	// Add context (show a few lines before and after the error)
	const contextStart = Math.max(0, lineNumber - 2);
	const contextEnd = Math.min(lines.length, lineNumber + 2);

	for (let i = contextStart; i < contextEnd; i++) {
	    const lineNum = i + 1; // 1-based line numbers
	    const isErrorLine = lineNum === lineNumber;
	    const linePrefix = `${lineNum}: `;
	    
	    // Add the line with line number
	    //errorDisplay += `${linePrefix}${lines[i]}\n`;
	    
	    // Create the error indicator arrow pointing to the error
	    if (isErrorLine) {
	    	errorDisplay += `${linePrefix}<span class='jmarkdown-error-bad'>${lines[i]}</span>\n`;
		    // Create spacing that aligns with the error column
		    const characters = `${linePrefix}${lines[i]}`.split('');
		    console.log(characters);
		    let current_column = 0;
		    for (const char of characters) {
		    	if (current_column < columnNumber + linePrefix.length) {
		    		if (char == '\t') {
		    			errorIndicator += "\t";
		    		}
		    		else {
		    			errorIndicator += ' ';
		    		}
		    		current_column++;
		    	}
		    	else {
		    		errorIndicator += '^ ' + errorMessage;
		    		errorDisplay += errorIndicator + '\n';
		    		break;
		    	}
		    }
		    console.log(errorIndicator.split(''));
	    	//errorIndicator = ' '.repeat(linePrefix.length + columnNumber) + '^ ' + errorMessage;
	    	//errorDisplay += errorIndicator + '\n';
	    }
	    else {
	    	errorDisplay += `${linePrefix}${lines[i]}\n`;
	    }
	}

	return {
		message: errorMessage,
		line: lineNumber,
		column: columnNumber,
		display: errorDisplay,
		errorObject: error
	};
}




export const jmarkdownScriptExtensions = {
	'javascript': javascript_script,
	'jmarkdown': jmarkdown_script
};


