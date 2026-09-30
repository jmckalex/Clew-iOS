import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
//import { config } from './utils.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import Mustache from 'mustache';
import { noteCodeAllowed, refuseNoteCode } from './note-code.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDirectoryExists(dirPath) {
	// Check if the directory exists
	if (!fs.existsSync(dirPath)) {
	    // If it doesn't exist, create it
		fs.mkdirSync(dirPath, { recursive: true });
		console.log(`Created directory: ${dirPath}`);
	} 
}

/*
	wolframscript, run WITHOUT a shell, its stdout written straight into
	`outFile` when one is given — which is what the `> "file"` of the shell
	commands this replaced did, file created first and all. The cache paths sit
	under the document's own folder, and a folder name is the document's to
	choose: interpolated into a shell string, a name holding `$(…)` or a
	backtick ran as a command.

	PAGE_WIDTH is what wolframscript has always been handed. The shell strings
	read "SetOptions[$Output, PageWidth->100]" inside double quotes, where the
	shell expanded `$Output` — an unset variable — to nothing. Passing
	`$Output` intact would change the output of every cached computation, so
	that is left for the owner to decide rather than done by a security fix.
*/
const PAGE_WIDTH = 'SetOptions[, PageWidth->100]';
function wolframscript(args, { cwd, outFile } = {}) {
	if (!outFile) return execFileSync('wolframscript', args, cwd ? { cwd } : {});
	const fd = fs.openSync(outFile, 'w');
	try {
		execFileSync('wolframscript', args, { cwd, stdio: ['pipe', fd, 'inherit'] });
	}
	finally {
		fs.closeSync(fd);
	}
}

function generateHash(string) {
	return crypto.createHash('md5').update(string).digest('hex');
}

function emptyCache(Mathematica_directory) {
	const files = fs.readdirSync(Mathematica_directory);

	for (const file of files) {
		const filePath = path.join(Mathematica_directory, file);
		if (fs.statSync(filePath).isFile()) {
			fs.unlinkSync(filePath);
			console.log(`Deleted: ${file}`);
		}
	}
}


export function createMathematica(marker) {
	return {
		level: 'container',
		marker: marker,
		label: "Mathematica",
		tokenizer: function(text, token) {
			// `Run note code: false` (note-code.js): Wolfram Language is code,
			// so nothing is written and wolframscript is never asked.
			if (!noteCodeAllowed()) {
				token['refused'] = true;
				return token;
			}
			if (text.includes("DisplayMath")) {
				token['DisplayMath'] = true;
			}
			else if (text.includes("InlineMath")) {
				token['InlineMath'] = true;
			}
			text = mathematica_code_header + text; //.replace("\n", '');
			const home_directory = configManager.get('Markdown file directory');
			const mathematica_directory = path.join(home_directory, "Mathematica");
			const hash = generateHash(text);
			const file_name = path.join(mathematica_directory, `${hash}.m`);
			const svg_name = file_name.replace('.m', '.svg');
			const png_name = file_name.replace('.m', '.png');
			const jpg_name = file_name.replace('.m', '.jpg');
			//const hash_name = file_name.replace('.m', '.hash');
			
			ensureDirectoryExists(mathematica_directory);
			if (token?.attrs?.['empty-cache'] == 'true' || token?.attrs?.['empty-cache'] == 'empty-cache') {
				console.log("Removing all cached Mathematica files...");
				emptyCache(mathematica_directory);
			}

			token['file name'] = file_name;
			token['has_error'] = false;
			token['error_log'] = '';

			// Since Mathematica can generate different output types, and someone might first generate SVG
			// output but then change their mind to another type, we need to check whether the requested
			// output file exists...
			let output_file = file_name.replace('.m', ".txt"); // This is the default
			if (token?.attrs?.output) {
				const type = token?.attrs?.output?.toLowerCase();
				output_file = output_file.replace('.txt', `.${type}`);
			}

			if (fs.existsSync(output_file) == false) {
				try {
					fs.writeFileSync(file_name, text);
					const cwd = mathematica_directory;
					const args = ['-c', PAGE_WIDTH, '-f', file_name, '-print'];
					//console.log(`Trying to process the Mathematica file with options ${opts}`);
					if (token?.attrs?.output?.toLowerCase() == 'svg') {
						wolframscript([...args, '-format', 'SVG'], { cwd, outFile: svg_name });
					}
					else if (token?.attrs?.output?.toLowerCase() == 'png') {
						wolframscript([...args, '-format', 'PNG'], { cwd, outFile: png_name });
					}
					else if (token?.attrs?.output?.toLowerCase() == 'jpg' || token?.attrs?.output?.toLowerCase() == 'jpeg') {
						wolframscript([...args, '-format', 'JPEG'], { cwd, outFile: jpg_name });
					}
					else {
						const output = file_name.replace('.m', '.txt');
						wolframscript(args, { cwd, outFile: output });
					}
				}
				catch (error) {
					token['has_error'] = true;
					// Try to read the log file
					try {
						const log_name = file_name.replace(/\.m$/, '.log');
						if (fs.existsSync(log_name)) {
							token['error_log'] = fs.readFileSync(log_name, 'utf8');
						} else {
							token['error_log'] = error.message || 'Unknown error';
						}
					} catch (logError) {
						token['error_log'] = error.message || 'Unknown error, unable to read log file';
					}

					console.error(`Error processing Mathematica: ${error.message}`);
				}
			}

			return token;
		},
		renderer(token) {
			if (token.meta.name === "Mathematica") {
				if (token['refused']) return refuseNoteCode('Mathematica', { block: true });
				// The Mathematica directive emits an SVG <img>/<div>; suppress
				// it in LaTeX mode rather than leaking raw HTML into the .tex.
				if (global.isLatex) return '';
				if (token['has_error']) {
					// Create a button that opens the error log
					const errorLogBase64 = Buffer.from(token['error_log']).toString('base64');
					const errorLogId = `tikz-error-${Math.random().toString(36).substring(2, 9)}`;

					return `<div class="tikz-error">
				        <p class="tikz-error-message">Error processing TikZ diagram</p>
				        <button onclick="showTikzError('${errorLogId}')">Show Error Log</button>
				        <script>
				            if (!window.tikzErrorHandlerAdded) {
				            window.tikzErrorHandlerAdded = true;
				            window.showTikzError = function(id) {
				                const logData = document.getElementById(id).dataset.log;
				                const logContent = atob(logData);
				                const errorWindow = window.open('', 'TikZ Error Log', 'width=800,height=600');
				                errorWindow.document.write('<html><head><title>TikZ Error Log</title>');
				                errorWindow.document.write('<style>body { font-family: monospace; white-space: pre; }</style>');
				                errorWindow.document.write('</head><body>');
				                errorWindow.document.write(logContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
				                errorWindow.document.write('</body></html>');
				                errorWindow.document.close();
				              };
				            }
				          </script>
				          <div id="${errorLogId}" data-log="${errorLogBase64}" style="display:none;"></div>
				        </div>`;
				}
				else {
					const home_directory = configManager.get('Markdown file directory');
					const mathematica_directory = path.join(home_directory, "Mathematica");
					const svg_file_name = path.basename(token['file name']).replace('.m', '.svg');
					const svg_full_path = path.join(mathematica_directory, svg_file_name);
					const png_file_name = path.basename(token['file name']).replace('.m', '.png');
					const png_full_path = path.join(mathematica_directory, png_file_name);
					const jpg_file_name = path.basename(token['file name']).replace('.m', '.jpg');
					const jpg_full_path = path.join(mathematica_directory, jpg_file_name);

					const style = token.attrs?.style ? ` style='${token.attrs.style}'` : '';
					// construct strings for class= and id= attributes
					let classes = " class='mathematica";
					switch (token.attrs?.output?.toLowerCase()) {
						case "png": classes += " png "; break;
						case "svg": classes += " svg "; break;
						case "jpg":
						case "jpeg": classes += " jpg "; break;
						default: classes += " txt "; break;
					}
					classes += (token.attrs?.class ?? '') + "'";
					const id = (token.attrs?.id) ? " id='" + token.attrs.id + "'" : '';

					// Construct the object to be returned — either a graphic or a string
					let obj;
					if (token.attrs?.output?.toLowerCase() == "svg") {
						if (token.attrs?.embed) {
							try {
								// Read the SVG file
								const svgContent = fs.readFileSync(svg_full_path, 'base64');

								// Create a data URL
								obj = `<img ${classes} ${id} ${style} src="data:image/svg+xml;base64,${svgContent}">`;
							} catch (error) {
								console.error(`Error embedding SVG: ${error.message}`);
								// Fall back to normal image reference
								obj = `<img  ${classes} ${id} ${style} src='Mathematica/${svg_file_name}'>`;
							}
						} else {
							obj = `<img  ${classes} ${id} ${style}  src='Mathematica/${svg_file_name}'>`;
						}
					}
					else if (token.attrs?.output?.toLowerCase() == "png") {
						if (token.attrs?.embed) {
							try {
								// Read the png file
								const pngContent = fs.readFileSync(png_full_path, 'base64');

								// Create a data URL
								obj = `<img ${classes} ${id} ${style} src="data:image/png;base64,${pngContent}">`;
							} catch (error) {
								console.error(`Error embedding PNG: ${error.message}`);
								// Fall back to normal image reference
								obj = `<img ${classes} ${id} ${style} src='Mathematica/${png_file_name}'>`;
							}
						} else {
							obj = `<img ${classes} ${id} ${style} src='Mathematica/${png_file_name}'>`;
						}
					}
					else if (token.attrs?.output?.toLowerCase() == "jpg" || token.attrs?.output?.toLowerCase() == "jpeg") {
						if (token.attrs?.embed) {
							try {
								// Read the png file
								const jpgContent = fs.readFileSync(jpg_full_path, 'base64');

								// Create a data URL
								obj = `<img ${classes} ${id} ${style} src="data:image/jpg;base64,${jpgContent}">`;
							} catch (error) {
								console.error(`Error embedding JPG: ${error.message}`);
								// Fall back to normal image reference
								obj = `<img ${classes} ${id} ${style} src='Mathematica/${jpg_file_name}'>`;
							}
						} else {
							obj = `<img ${classes} ${id} ${style} src='Mathematica/${jpg_file_name}'>`;
						}
					}
					else {
						obj = fs.readFileSync(svg_full_path.replace('.svg', '.txt'), 'utf8');
					}

					if (token['DisplayMath'] == true) {
						obj = "$$" + obj + "$$"; 
					}
					else if (token['InlineMath'] == true) {
						obj = "$" + obj + "$"; 
					}

					if (obj.startsWith("<img")) {
						return `<p class='mathematica'>${obj}</p>`;
					}
					else {
						return `<p  ${classes} ${id} ${style} >${obj}</p>`;
					}

					//return `<p${classes}${id}>` + obj + "</p>";
				}
			}
			return false;
		}
	}
}

const mathematica_code_header = `DisplayMath[a_] := a //TeXForm//ToString; InlineMath[a_] := a //TeXForm//ToString;`

/*
import request from 'sync-request';

function send_code_to_mathematica(code) {
	console.log("Trying to send code to mathematica...");

	try {
		const res = request('POST', 'http://127.0.0.1:56980', {
		    json: { code: code },
		    headers: {
		      'Content-Type': 'application/json'
		    }
		});
	  
	  // Get the response body
		console.log(res);
	  const body = res.getBody('utf8');
	  
	  // Parse JSON if applicable
	  const data = JSON.parse(body);
	  
	  console.log('Response:', data);
	  
	  // Code here executes only after the request completes
	} catch (error) {
	  console.error('Error making request:', error);
	}
}
*/

export const inlineMathematica = {
	name: "inlineMathematica",
	level: 'inline',
	start(src) {
        const match = src.match(/⟦/);
        return match ? match.index : -1;
    },
	label: "Mathematica",
	tokenizer(src, tokens) {
		const match = /^⟦([\s\S]*?)⟧/.exec(src);
		if (match) {
			// `Run note code: false` (note-code.js): refused, even where a cached
			// result exists — the rule is about the construct, not the cache.
			if (!noteCodeAllowed()) {
				return {
					type: 'inlineMathematica',
					raw: match[0],
					code: match[1],
					refused: true,
					text: ''
				};
			}
			const home_directory = configManager.get('Markdown file directory');
			const mathematica_directory = path.join(home_directory, "Mathematica");
			const opts = { cwd: mathematica_directory };
			//const file_name = path.join(mathematica_directory, `file-${file_index++}.m`);
			
			const code_to_evaluate = mathematica_code_header + match[1];
			const hash = generateHash(code_to_evaluate);
			const file_name = path.join(mathematica_directory, `${hash}.m`);
			const svg_name = file_name.replace('.m', '.svg');
			const txt_name = file_name.replace('.m', '.txt');

			// Check to see if one of the output files already exists
			let output_file = false;
			if (fs.existsSync(svg_name)) {
				output_file = `${hash}.svg`;
			}
			else if(fs.existsSync(txt_name)) {
				output_file = `${hash}.txt`;
			}

			if (output_file != false) {
				const token = {
	                type: 'inlineMathematica',
	                raw: match[0],
	                code: match[1],
	                include: output_file,
	                text: ''
	            };
	            return token;
			}

			// The code is either new or changed, so process it...

			//send_code_to_mathematica(code_to_evaluate);
			console.log(code_to_evaluate);
			console.log(`Attempting to write file ${file_name} to disk`);
			fs.writeFileSync(file_name, code_to_evaluate);

			const output = wolframscript(['-f', file_name, '-print']).toString();
			console.log(output);
			if (output.includes("-Graphics-") || output.includes("-Graphics3D-") ) {
				console.log("Attempting to generate SVG output for inline Mathematica code.");
				wolframscript(['-f', file_name, '-print', '-format', 'SVG'], { cwd: opts.cwd, outFile: svg_name });
				output_file = `${hash}.svg`;
			}
			else {
				wolframscript(['-f', file_name, '-print'], { cwd: opts.cwd, outFile: txt_name });
				output_file = `${hash}.txt`;
			}
			
			const token = {
                type: 'inlineMathematica',
                raw: match[0],
                code: match[1],
                include: output_file,
                text: ''
            };
            return token;
		}
	},
	renderer(token) {
		if (token.refused) return refuseNoteCode('Mathematica');
		if (token.code.includes("InlineMath")) {
			return "$" + fs.readFileSync(token.include, 'utf8') + "$";	
		}
		else if (token.code.includes("DisplayMath")) {
			return "$$" + fs.readFileSync(token.include, 'utf8') + "$$";
		}
		else {
			// Embedding SVG code from mathematica is generally a bad idea
			// as it doesn't generate unique IDs for the output
			if (global.isLatex) return '';
			console.log(token.include);
			return `<img class='mathematica svg' src='Mathematica/${token.include}'>`;
			//return fs.readFileSync(token.include, 'utf8');
		}

		if (token['has_error']) {
			// Create a button that opens the error log
			const errorLogBase64 = Buffer.from(token['error_log']).toString('base64');
			const errorLogId = `tikz-error-${Math.random().toString(36).substring(2, 9)}`;

			return `<div class="tikz-error">
		        <p class="tikz-error-message">Error processing TikZ diagram</p>
		        <button onclick="showTikzError('${errorLogId}')">Show Error Log</button>
		        <script>
		            if (!window.tikzErrorHandlerAdded) {
		            window.tikzErrorHandlerAdded = true;
		            window.showTikzError = function(id) {
		                const logData = document.getElementById(id).dataset.log;
		                const logContent = atob(logData);
		                const errorWindow = window.open('', 'TikZ Error Log', 'width=800,height=600');
		                errorWindow.document.write('<html><head><title>TikZ Error Log</title>');
		                errorWindow.document.write('<style>body { font-family: monospace; white-space: pre; }</style>');
		                errorWindow.document.write('</head><body>');
		                errorWindow.document.write(logContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
		                errorWindow.document.write('</body></html>');
		                errorWindow.document.close();
		              };
		            }
		          </script>
		          <div id="${errorLogId}" data-log="${errorLogBase64}" style="display:none;"></div>
		        </div>`;
		}
		else {
			const home_directory = configManager.get('Markdown file directory');
			const mathematica_directory = path.join(home_directory, "Mathematica");
			const svg_file_name = path.basename(token['file name']).replace('.m', '.svg');
			const svg_full_path = path.join(mathematica_directory, svg_file_name);
			const png_file_name = path.basename(token['file name']).replace('.m', '.png');
			const png_full_path = path.join(mathematica_directory, png_file_name);
			const jpg_file_name = path.basename(token['file name']).replace('.m', '.jpg');
			const jpg_full_path = path.join(mathematica_directory, jpg_file_name);

			const style = token.attrs?.style ? ` style='${token.attrs.style}'` : '';
			// construct strings for class= and id= attributes
			let classes = " class='mathematica";
			switch (token.attrs?.output?.toLowerCase()) {
			case "png": classes += " png "; break;
			case "svg": classes += " svg "; break;
			case "jpg":
			case "jpeg": classes += " jpg "; break;
			default: classes += " txt "; break;
			}
			classes += (token.attrs?.class ?? '') + "'";
			const id = (token.attrs?.id) ? " id='" + token.attrs.id + "'" : '';

			// Construct the object to be returned — either a graphic or a string
			let obj;
			if (token.attrs?.output?.toLowerCase() == "svg") {
				if (token.attrs?.embed) {
					try {
						// Read the SVG file
						const svgContent = fs.readFileSync(svg_full_path, 'base64');

						// Create a data URL
						obj = `<img ${classes} ${id} ${style} src="data:image/svg+xml;base64,${svgContent}">`;
					} catch (error) {
						console.error(`Error embedding SVG: ${error.message}`);
						// Fall back to normal image reference
						obj = `<img  ${classes} ${id} ${style} src='Mathematica/${svg_file_name}'>`;
					}
				} else {
					obj = `<img  ${classes} ${id} ${style}  src='Mathematica/${svg_file_name}'>`;
				}
			}
			else if (token.attrs?.output?.toLowerCase() == "png") {
				if (token.attrs?.embed) {
					try {
						// Read the png file
						const pngContent = fs.readFileSync(png_full_path, 'base64');

						// Create a data URL
						obj = `<img ${classes} ${id} ${style} src="data:image/png;base64,${pngContent}">`;
					} catch (error) {
						console.error(`Error embedding PNG: ${error.message}`);
						// Fall back to normal image reference
						obj = `<img ${classes} ${id} ${style} src='Mathematica/${png_file_name}'>`;
					}
				} else {
					obj = `<img ${classes} ${id} ${style} src='Mathematica/${png_file_name}'>`;
				}
			}
			else if (token.attrs?.output?.toLowerCase() == "jpg" || token.attrs?.output?.toLowerCase() == "jpeg") {
				if (token.attrs?.embed) {
					try {
						// Read the png file
						const jpgContent = fs.readFileSync(jpg_full_path, 'base64');

						// Create a data URL
						obj = `<img ${classes} ${id} ${style} src="data:image/jpg;base64,${jpgContent}">`;
					} catch (error) {
						console.error(`Error embedding JPG: ${error.message}`);
						// Fall back to normal image reference
						obj = `<img ${classes} ${id} ${style} src='Mathematica/${jpg_file_name}'>`;
					}
				} else {
					obj = `<img ${classes} ${id} ${style} src='Mathematica/${jpg_file_name}'>`;
				}
			}
			else {
				if (token.attrs?.TeX?.toLowerCase() == "inline") {
					obj = "$" + fs.readFileSync(svg_full_path.replace('.svg', '.txt'), 'utf8') + "$";
				}
				else if (token.attrs?.TeX?.toLowerCase() == "block") {
					obj = "$$" + fs.readFileSync(svg_full_path.replace('.svg', '.txt'), 'utf8') + "$$";
				}
				else {
					obj = fs.readFileSync(svg_full_path.replace('.svg', '.txt'), 'utf8');
				}
			}

			if (obj.startsWith("<img")) {
				return `<p class='mathematica'>${obj}</p>`;
			}
			else {
				return `<p  ${classes} ${id} ${style} >${obj}</p>`;
			}

			//return `<p${classes}${id}>` + obj + "</p>";
		}
	}
}

// Start a profile so that all the sessions can be shared
//execSync(`wolframscript -wstpserver -startprofile -c '2+2'`);

/*
	Mirror :::Mathematica as @begin(Mathematica), reusing the directive's own
	tokenizer and renderer verbatim (same no-drift pattern as @begin(game) /
	@begin(TiKZ)). The tokenizer hashes its input (mathematica_code_header + text) to
	name the cache file that the rendered <img> then references, so the body MUST be
	shaped exactly like the :::Mathematica container's text or the emitted filename
	would diverge. Both are createDirectives ':::' containers, so the game shim
	('\n' + body with trailing newlines stripped) reproduces the container input —
	the same shim @begin(TiKZ) is verified against. (Every Mathematica path invokes
	wolframscript even for LaTeX, so this parity is verified by inspection + a manual
	smoke test rather than a golden fixture.)

	The renderer keys off token.meta.name and reads this.parser; it branches on
	global.isLatex (LaTeX suppresses the <img>), so one format-independent `render`
	covers both outputs. The inline ⟦…⟧ Mathematica extension is intentionally left
	untouched — it is not a colon directive.

	mode 'custom' hands the body raw to the tokenizer (which owns the wolframscript
	run + cache) rather than re-lexing it as markdown.
*/
const mathematicaEnvInstance = createMathematica();   // marker arg unused by tokenizer/renderer
registerBlockEnvironment('Mathematica', {
	mode: 'custom',
	tokenize(body, token) {
		token.meta = { name: 'Mathematica' };
		mathematicaEnvInstance.tokenizer.call(this, '\n' + body.replace(/\n+$/, ''), token);
	},
	render: (ctx) => mathematicaEnvInstance.renderer.call({ parser: ctx.parser }, ctx.token)
});

export default createMathematica;