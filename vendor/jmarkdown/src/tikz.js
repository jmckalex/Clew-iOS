/*
	This is a directive designed for typesetting side-by-side displays
	of markdown (or HTML) code on the left, and the compiled / formatted
	version on the right. 
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
//import { config } from './utils.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import { requirePackage, addPreamble } from './preamble.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { htmlCachePath, compileInRunDir, cacheDir } from './figure-cache.js';
import { figureEngineWanted, figureToolsRefused, refuseFigure } from './figure-engine.js';
import Mustache from 'mustache';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The tikz libraries loaded both for the standalone SVG compile (HTML) and the
// main-document preamble (native LaTeX output). One list, no drift.
const TIKZ_LIBRARIES = 'arrows,arrows.meta,positioning,shapes,backgrounds,calc,fit,decorations,decorations.pathreplacing,decorations.markings,patterns,matrix,calligraphy,trees,graphs,intersections,through,shapes.geometric,datavisualization';

const LaTeX_template =
	String.raw`\documentclass[tikz,border=3mm,12pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{` + TIKZ_LIBRARIES + String.raw`}
{{#LaTeX_preamble}}
{{{.}}}
{{/LaTeX_preamble}}
\begin{document}
{{{TiKZ}}}
\end{document}`


const LIBGS = "--libgs=" + configManager.get('TiKZ libgs'); ///opt/homebrew/Cellar/ghostscript/10.05.0_1/lib/libgs.10.05.dylib";
const OPTIMISE = "--optimize=" + configManager.get('TiKZ optimise'); //group-attributes,collapse-groups";

function ensureDirectoryExists(dirPath) {
	// Check if the directory exists
	if (!fs.existsSync(dirPath)) {
	    // If it doesn't exist, create it
		fs.mkdirSync(dirPath, { recursive: true });
		console.log(`Created directory: ${dirPath}`);
	} 
}

function generateHash(string) {
	return crypto.createHash('md5').update(string).digest('hex');
}

// Files only: a run folder another build is compiling in is left alone.
function emptyCache(TiKZ_directory) {
	const files = fs.readdirSync(TiKZ_directory);

	for (const file of files) {
		const filePath = path.join(TiKZ_directory, file);
		if (fs.statSync(filePath).isFile()) {
			fs.unlinkSync(filePath);
			console.log(`Deleted: ${file}`);
		}
	}
}

// The installed tools: lualatex then dvisvgm, unless the SVG is cached.
// Never under `Figure engine: wasm`, on any path (figure-engine.js): the figure
// is refused instead — before the tools' cache too, so `wasm` shows only what
// the library drew.
function compileTikzExternal(token, doc, dir, hash) {
	if (figureToolsRefused()) {
		token.figureRefused = true;
		return;
	}
	if (fs.existsSync(path.join(dir, `${hash}.svg`))) return;
	// Compiled in a run folder of its own (figure-cache.js): only
	// the SVG is kept; the .aux/.dvi/.log, and anything the
	// document's TeX wrote (\openout), go with the folder.
	compileInRunDir(dir, (run) => {
		const tex = path.join(run, `${hash}.tex`);
		try {
			fs.writeFileSync(tex, doc);
			const opts = { cwd: run };
			// Argument arrays, no shell: the paths sit under the
			// document's own folder, whose name is the document's to
			// choose — in a shell string, `$(…)` in it ran as a command.
			let args = ['--output-format=dvi', tex];
			console.log(`Executing: lualatex ${args.join(' ')}`);
			execFileSync('lualatex', args, opts);
			args = ['--bbox=min', LIBGS, '--no-fonts=1', OPTIMISE, tex.replace(/\.tex$/, '.dvi')];
			console.log(`Executing: dvisvgm ${args.join(' ')}`);
			execFileSync('dvisvgm', args, opts);
			return [`${hash}.svg`];
		}
		catch (error) {
			token['has_error'] = true;
			const log = path.join(run, `${hash}.log`);
			try {
				token['error_log'] = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : (error.message || 'Unknown error');
			} catch {
				token['error_log'] = error.message || 'Unknown error, unable to read log file';
			}
			console.error(`Error processing TikZ: ${error.message}`);
			return [];
		}
	});
}

function createTiKZ(marker) {
	return {
		level: 'container',
		marker: marker,
		label: "TiKZ",
		tokenizer: function(text, token) {
			if (text.includes('begin{tikzpicture}') == false) {
				text = "\\begin{tikzpicture}[>=latex]\n" + text + "\n\\end{tikzpicture}";
			}
			// Keep the raw source for native LaTeX output (see renderer). In LaTeX
			// mode we don't need the cached SVG at all, so skip the (expensive)
			// lualatex+dvisvgm compile entirely.
			token['tikz'] = text;
			if (global.isLatex) return token;

			const opts = { 'TiKZ': text, 'LaTeX_preamble': configManager.get('LaTeX preamble') };
			const file_contents = Mustache.render(LaTeX_template, opts);

			const TiKZ_directory = cacheDir('TiKZ');
			const hash = generateHash(file_contents);
			const file_name = path.join(TiKZ_directory, `${hash}.tex`);
			const svg_name = file_name.replace('.tex', '.svg');

			ensureDirectoryExists(TiKZ_directory);
			if (token?.attrs?.['empty-cache'] == 'true' || token?.attrs?.['empty-cache'] == 'empty-cache') {
				console.log("Removing all cached TiKZ files...");
				emptyCache(TiKZ_directory);
			}

			token['file name'] = file_name;
			token['has_error'] = false;
			token['error_log'] = '';

			// With mp-tikz-wasm as the figure engine (figure-engine.js), the
			// figure is filled from the async walk, not compiled here; the
			// installed tools remain its fallback.
			if (figureEngineWanted()) {
				const job = token.figureJob = { kind: 'tikz', doc: file_contents, dir: TiKZ_directory };
				job.use = (tex) => { token['file name'] = tex; job.done = true; };
				job.fail = (log) => { token['has_error'] = true; token['error_log'] = log; job.done = true; };
				// The tools' run; what failed (their log or error), or null when drawn.
				job.external = () => {
					compileTikzExternal(token, file_contents, TiKZ_directory, hash);
					job.done = true;
					return token['has_error'] ? (token['error_log'] || 'failed') : null;
				};
				return token;
			}
			compileTikzExternal(token, file_contents, TiKZ_directory, hash);

			return token;
		},
		renderer(token) {
			if (token.meta.name === "TiKZ") {
				// LaTeX: emit the tikzpicture natively (true vector, document
				// fonts) rather than the cached SVG. Pull in tikz + its libraries.
				if (global.isLatex) {
					requirePackage('tikz');
					addPreamble(`\\usetikzlibrary{${TIKZ_LIBRARIES}}`);
					return `\\begin{center}\n${token['tikz']}\n\\end{center}\n\n`;
				}
				// A figure the walk never filled (a parse that was not async):
				// the installed tools, as before.
				if (token.figureJob && !token.figureJob.done) token.figureJob.external();
				if (token.figureRefused) return refuseFigure('TiKZ');
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
					const TiKZ_directory = cacheDir('TiKZ');
					const svg_file_name = path.basename(token['file name']).replace('.tex', '.svg');
					const svg_full_path = path.join(TiKZ_directory, svg_file_name);

					// Check if scale was provided in the directive attributes
					let scaleStyle = '';
					if (token.attrs?.scale) {
						scaleStyle = ` style="transform: scale(${token.attrs.scale}); transform-origin: left top;"`;
					} else if (token.attrs?.width) {
						scaleStyle = ` style="width: ${token.attrs.width};"`;
					}

					// Check if the embed attribute was specified
					if (token.attrs?.embed) {
						try {
							// Read the SVG file
							const svgContent = fs.readFileSync(svg_full_path, 'base64');

							// Create a data URL
							return `<img src="data:image/svg+xml;base64,${svgContent}"${scaleStyle}>`;
						} catch (error) {
							console.error(`Error embedding SVG: ${error.message}`);
							// Fall back to normal image reference
							return `<img src='${htmlCachePath(svg_full_path)}'${scaleStyle}>`;
						}
					} else {
						return `<img src='${htmlCachePath(svg_full_path)}'${scaleStyle}>`;
					}
				}
			}
			return false;
		}
	}
}


/*
	Mirror :::TiKZ as @begin(TiKZ), reusing the directive's own tokenizer and
	renderer verbatim (the strongest no-drift guarantee — same functions, not
	copies), exactly as strategic-form-games.js does for @begin(game). One boundary
	adaptation is needed:

	  • Shape the body like a container directive's content. @begin hands us the
	    dedented body without the leading '\n' the tokenizer expects, and with a
	    trailing newline before @end. Prepending '\n' and trimming trailing newlines
	    makes the tokenizer input byte-identical to the :::TiKZ case (verified against
	    the tikz-diagrams/diagram golden — the [>=latex]\n\n…{T};\n\end spacing needs
	    exactly a leading \n and stripped trailing newline).

	The directive renderer keys off token.meta.name and reads this.parser, so we set
	meta.name and call it with the active parser as `this`. It already branches on
	global.isLatex, so one format-independent `render` covers both outputs. attrs
	(scale/width/embed/empty-cache) arrive via token.attrs, which begin-end-core
	parses with the same attributes-parser and sets before calling tokenize.

	mode 'custom' hands the body raw to the directive tokenizer (which owns the
	lualatex/dvisvgm compile + cache) rather than re-lexing it as markdown.
*/
const tikzEnvInstance = createTiKZ();   // marker arg unused by tokenizer/renderer
registerBlockEnvironment('TiKZ', {
	mode: 'custom',
	tokenize(body, token) {
		token.meta = { name: 'TiKZ' };
		tikzEnvInstance.tokenizer.call(this, '\n' + body.replace(/\n+$/, ''), token);
	},
	render: (ctx) => tikzEnvInstance.renderer.call({ parser: ctx.parser }, ctx.token)
});

export default createTiKZ;