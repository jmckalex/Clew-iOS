import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
//import { config } from './utils.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { htmlCachePath, cacheDir } from './figure-cache.js';
import Mustache from 'mustache';
import { noteCodeAllowed, refuseNoteCode, noteCodeError } from './note-code.js';
import { escapeTexText } from './latex-escape.js';
import { addWarning } from './warnings.js';

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
	let failed = true;
	try {
		execFileSync('wolframscript', args, { cwd, stdio: ['pipe', fd, 'inherit'] });
		failed = false;
	}
	finally {
		fs.closeSync(fd);
		// A run that failed leaves no output behind. `outFile` is the cache:
		// a later build finds it and never asks again, so a licence refused
		// under load (wolframscript exits 255 or 40, with nothing or a
		// fragment on stdout) went on printing that, empty, for good. The
		// error still reaches the caller, as before.
		if (failed) fs.rmSync(outFile, { force: true });
	}
}

/*
	What a failed inline run says, in the page and in the build warning. Not
	execFileSync's message: that is the command line, whose file sits in the
	cache folder, and it would have put the user's own folders into the page.
*/
function failureMessage(error) {
	if (error?.code === 'ENOENT' && error?.syscall?.startsWith('spawn')) return 'wolframscript was not found';
	if (typeof error?.status === 'number') {
		const said = error.stderr?.toString().trim().split('\n')[0];
		return `wolframscript exited with status ${error.status}${said ? `: ${said}` : ''}`;
	}
	if (error?.signal) return `wolframscript was stopped (${error.signal})`;
	return error?.code ?? 'unknown error';
}

// A run's log text with its cache folder written `<cache>`, in either spelling
// (as given, and real: /var/… is /private/var/… on macOS), the longer first,
// so the page names none of the user's folders.
function withoutCacheFolder(text, folder) {
	let real = folder;
	try { real = fs.realpathSync(folder); } catch {}
	for (const spelling of [...new Set([real, folder])].sort((a, b) => b.length - a.length)) {
		text = text.split(spelling).join('<cache>');
	}
	return text;
}

/*
	A result's text is Wolfram Language's output, not HTML or markdown, so it
	prints as text (the owner, 2026-10-23). In HTML its `&`, `<` and `>` are
	escaped: `x<y` showed as `x` and a broken tag. Maths in it is unchanged,
	since MathJax reads the text the browser shows. In LaTeX, maths in it —
	what MathJax finds in the page: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`; the
	owner's notes build `$$…$$` strings — passes through as written, and the
	rest is escaped as plain text (escapeTexText), so the PDF shows what the
	page does and a `_` or `#` in it cannot stop the build. A `\$` outside
	maths is a dollar, as MathJax reads it (processEscapes), and opens none.
*/
const RESULT_MATHS = /\\\$|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$]+?\$/g;

function resultHTML(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resultLaTeX(text) {
	let latex = '';
	let at = 0;
	for (const maths of text.matchAll(RESULT_MATHS)) {
		latex += escapeTexText(text.slice(at, maths.index)) + maths[0];
		at = maths.index + maths[0].length;
	}
	return latex + escapeTexText(text.slice(at));
}

/*
	A block's result in LaTeX, a paragraph of its own: a text result as the
	page shows it (resultLaTeX), DisplayMath's and InlineMath's TeX as written,
	as the page's MathJax reads them (the owner, 2026-10-23: "a text result
	also prints in LaTeX/PDF, as it does in HTML"). A graphic (output=svg, png,
	jpg) and a failed run are left out, as before; so is a result missing
	from the cache.
*/
function blockLaTeX(token) {
	const output = token.attrs?.output?.toLowerCase();
	if (token['has_error'] || ['svg', 'png', 'jpg', 'jpeg'].includes(output)) return '';
	const file = path.join(cacheDir('Mathematica'), path.basename(token['file name']).replace(/\.m$/, '.txt'));
	if (!fs.existsSync(file)) return '';
	const text = fs.readFileSync(file, 'utf8');
	if (token['DisplayMath']) return `$$${text}$$\n\n`;
	if (token['InlineMath']) return `$${text}$\n\n`;
	return `${resultLaTeX(text.replace(/\n+$/, ''))}\n\n`;
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
			const mathematica_directory = cacheDir('Mathematica');
			const hash = generateHash(text);
			const file_name = path.join(mathematica_directory, `${hash}.m`);
			// Each output changes the extension at the END: a folder on the way can
			// hold `.m` too (`my.math notes`), and replacing the first one named a
			// folder that does not exist.
			const svg_name = file_name.replace(/\.m$/, '.svg');
			const png_name = file_name.replace(/\.m$/, '.png');
			const jpg_name = file_name.replace(/\.m$/, '.jpg');
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
			let output_file = file_name.replace(/\.m$/, '.txt'); // This is the default
			if (token?.attrs?.output) {
				const type = token?.attrs?.output?.toLowerCase();
				output_file = output_file.replace(/\.txt$/, `.${type}`);
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
						const output = file_name.replace(/\.m$/, '.txt');
						wolframscript(args, { cwd, outFile: output });
					}
				}
				catch (error) {
					token['has_error'] = true;
					// What the build warning says (failureMessage: no folders).
					token['failed'] = failureMessage(error);
					// The error box's log says the same, then the run's log file if
					// one was written, its cache folder written `<cache>`. It held
					// execFileSync's message — the command line, whose .m file sits
					// in the cache folder — which put the user's folders, base64,
					// into the page.
					token['error_log'] = token['failed'];
					try {
						const log_name = file_name.replace(/\.m$/, '.log');
						if (fs.existsSync(log_name)) {
							token['error_log'] += '\n\n' + withoutCacheFolder(fs.readFileSync(log_name, 'utf8'), mathematica_directory);
						}
					} catch (logError) {
						// The log could not be read: the message stands alone.
					}

					console.error(`Error processing Mathematica: ${error.message}`);
				}
			}

			return token;
		},
		renderer(token) {
			if (token.meta.name === "Mathematica") {
				if (token['refused']) return refuseNoteCode('Mathematica', { block: true });
				// A failed run is warned, in the inline form's words (noteCodeError),
				// in both outputs: the HTML shows its error box, but LaTeX leaves
				// the block out, and the PDF lost it with nothing said.
				if (token['has_error']) addWarning(`Mathematica failed: ${token['failed']}`);
				// In LaTeX a text result prints, as the inline form's does
				// (blockLaTeX); a graphic or a failed run is left out, rather
				// than leaking its <img>/<div> into the .tex.
				if (global.isLatex) return blockLaTeX(token);
				if (token['has_error']) {
					// Create a button that opens the error log. The box is TikZ's
					// (tikz.js), and kept its class for its style; it was copied with
					// TikZ's words too, and named TikZ. Its log opens through a handler
					// of its own, so on a page that also has a failed TikZ diagram each
					// log opens under its own name.
					const errorLogBase64 = Buffer.from(token['error_log']).toString('base64');
					const errorLogId = `mathematica-error-${Math.random().toString(36).substring(2, 9)}`;

					return `<div class="tikz-error">
				        <p class="tikz-error-message">Error processing Mathematica</p>
				        <button onclick="showMathematicaError('${errorLogId}')">Show Error Log</button>
				        <script>
				            if (!window.mathematicaErrorHandlerAdded) {
				            window.mathematicaErrorHandlerAdded = true;
				            window.showMathematicaError = function(id) {
				                const logData = document.getElementById(id).dataset.log;
				                const logContent = atob(logData);
				                const errorWindow = window.open('', 'Mathematica Error Log', 'width=800,height=600');
				                errorWindow.document.write('<html><head><title>Mathematica Error Log</title>');
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
					const mathematica_directory = cacheDir('Mathematica');
					const svg_file_name = path.basename(token['file name']).replace(/\.m$/, '.svg');
					const svg_full_path = path.join(mathematica_directory, svg_file_name);
					const png_file_name = path.basename(token['file name']).replace(/\.m$/, '.png');
					const png_full_path = path.join(mathematica_directory, png_file_name);
					const jpg_file_name = path.basename(token['file name']).replace(/\.m$/, '.jpg');
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
								obj = `<img  ${classes} ${id} ${style} src='${htmlCachePath(svg_full_path)}'>`;
							}
						} else {
							obj = `<img  ${classes} ${id} ${style}  src='${htmlCachePath(svg_full_path)}'>`;
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
								obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(png_full_path)}'>`;
							}
						} else {
							obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(png_full_path)}'>`;
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
								obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(jpg_full_path)}'>`;
							}
						} else {
							obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(jpg_full_path)}'>`;
						}
					}
					else {
						// Text, escaped (resultHTML): it was printed as markup.
						obj = resultHTML(fs.readFileSync(svg_full_path.replace(/\.svg$/, '.txt'), 'utf8'));
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
			const mathematica_directory = cacheDir('Mathematica');
			const opts = { cwd: mathematica_directory };
			//const file_name = path.join(mathematica_directory, `file-${file_index++}.m`);
			
			const code_to_evaluate = mathematica_code_header + match[1];
			const hash = generateHash(code_to_evaluate);
			const file_name = path.join(mathematica_directory, `${hash}.m`);
			const svg_name = file_name.replace(/\.m$/, '.svg');
			const txt_name = file_name.replace(/\.m$/, '.txt');

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
			// A run that fails no longer stops the build: the result is marked
			// where it stands (the renderer's noteCodeError), as a failed block
			// shows its error box, and nothing is cached, so the next build asks
			// again.
			try {
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
			}
			catch (error) {
				console.error(`Error processing Mathematica: ${error.message}`);
				return {
					type: 'inlineMathematica',
					raw: match[0],
					code: match[1],
					failed: failureMessage(error),
					text: ''
				};
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
		if (token.failed) return noteCodeError('Mathematica', token.failed);
		// `include` is the cached result's file NAME, so it is read, and
		// referred to, in the cache folder, as the block form's results are.
		// Read by its name alone it was looked for in the working folder, and
		// InlineMath and DisplayMath stopped the build; an <img> of
		// `Mathematica/<name>` held only for a page written beside the note.
		const cached = path.join(cacheDir('Mathematica'), token.include);
		// The maths is TeX: as it is in LaTeX, escaped in HTML (resultHTML).
		const tex = () => {
			const text = fs.readFileSync(cached, 'utf8');
			return global.isLatex ? text : resultHTML(text);
		};
		if (token.code.includes("InlineMath")) {
			return "$" + tex() + "$";
		}
		else if (token.code.includes("DisplayMath")) {
			return "$$" + tex() + "$$";
		}
		else {
			// Embedding SVG code from mathematica is generally a bad idea
			// as it doesn't generate unique IDs for the output
			const text = token.include.endsWith('.txt') ? fs.readFileSync(cached, 'utf8').replace(/\n+$/, '') : null;
			// A text result prints in LaTeX too, as the page shows it
			// (resultLaTeX); a graphic is still left out.
			if (global.isLatex) return text === null ? '' : resultLaTeX(text);
			// A text result is printed as the block form prints its own, as
			// text (resultHTML), where it was an <img> of the .txt file, a
			// broken image.
			if (text !== null) {
				return `<span class='mathematica txt'>${resultHTML(text)}</span>`;
			}
			return `<img class='mathematica svg' src='${htmlCachePath(cached)}'>`;
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
			const mathematica_directory = cacheDir('Mathematica');
			const svg_file_name = path.basename(token['file name']).replace(/\.m$/, '.svg');
			const svg_full_path = path.join(mathematica_directory, svg_file_name);
			const png_file_name = path.basename(token['file name']).replace(/\.m$/, '.png');
			const png_full_path = path.join(mathematica_directory, png_file_name);
			const jpg_file_name = path.basename(token['file name']).replace(/\.m$/, '.jpg');
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
						obj = `<img  ${classes} ${id} ${style} src='${htmlCachePath(svg_full_path)}'>`;
					}
				} else {
					obj = `<img  ${classes} ${id} ${style}  src='${htmlCachePath(svg_full_path)}'>`;
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
						obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(png_full_path)}'>`;
					}
				} else {
					obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(png_full_path)}'>`;
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
						obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(jpg_full_path)}'>`;
					}
				} else {
					obj = `<img ${classes} ${id} ${style} src='${htmlCachePath(jpg_full_path)}'>`;
				}
			}
			else {
				if (token.attrs?.TeX?.toLowerCase() == "inline") {
					obj = "$" + fs.readFileSync(svg_full_path.replace(/\.svg$/, '.txt'), 'utf8') + "$";
				}
				else if (token.attrs?.TeX?.toLowerCase() == "block") {
					obj = "$$" + fs.readFileSync(svg_full_path.replace(/\.svg$/, '.txt'), 'utf8') + "$$";
				}
				else {
					obj = fs.readFileSync(svg_full_path.replace(/\.svg$/, '.txt'), 'utf8');
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