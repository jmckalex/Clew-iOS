#!/usr/bin/env node

import fs from 'fs';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { configManager } from './config-manager.js';
import { resetWarnings, reportWarnings } from './warnings.js';
import { smartTypography } from './smart-typography.js';
import { Command } from 'commander';
import { initialise } from './init.js';
import { showOptions } from './init.js';
import { runInThisContext, marked, marked_copy, registerExtension, registerExtensions } from './utils.js';
import { createRequire } from 'module';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import markedFootnote from 'marked-footnote';
import * as jmarkdownSyntaxEnhancements from './syntax-enhancements.js';
import * as jmarkdownSyntaxModifications from './syntax-modifications.js';
import { anchors } from './anchors.js';
import { editors } from './editor-tag.js';
import { markedExtendedTablesHeaderless } from './marked-extended-tables-headerless.js';
import { markedHighlight } from "marked-highlight";
import hljs from 'highlight.js';
import { createDirectives, presetDirectiveConfigs } from './extended-directives.js';
import additionalDirectives, {titleBox} from './additional-directives.js';
import { createMermaid } from './mermaid.js';
import { createMultilevelOptionals } from './metadata-header.js';
import { targets, sources, inlineTarget } from './sources-and-targets.js';
import markedAlert from 'marked-alert';
import { renderAlertLatex } from './alerts.js';
import createMarkdownDemo from './markdown-demo.js';
import strategicFormGame from './strategic-form-games.js';
import createTiKZ from './tikz.js';
import './metapost.js';   // side-effect: registers the @begin(metapost) block environment
import { inlineMathematica, createMathematica } from './mathematica.js';
import markedMoreLists from 'marked-more-lists';
import { jmarkdownScriptExtensions } from './script-blocks.js';
import export_to_jmarkdown from './function-extensions.js';
import { math, mathjs } from './mathjs-extension.js';
import { blockFunctions, inlineFunctions } from './inline-function-extension.js';
import { citations, bibliography } from './citations.js';
import { indexMark, indexPlacement, resetIndexing, checkIndexPlacements } from './indexing.js';
import { beginEnd, atInline, atBlock } from './begin-end.js';
import { defineEnvironment } from './numbered-environments.js';
import { requirePackage, addPreamble, addLatePreamble } from './preamble.js';
import './floats.js';
import './theorems.js';
import './equations.js';
import { gfmHeadingId, getHeadingList } from "marked-gfm-heading-id";
import { createTOC } from './utils.js';
import { metadata, processYAMLheader } from './metadata-header.js';
import processFileInclusions from './file-inclusion.js';
import { processTemplate } from './html-template.js';
import { processLatexTemplate } from './latex-template.js';
import { preprocessFootnotes, inlineFootnote, endnotesPlacement, fillEndnotes, resetFootnotes } from './inline-footnotes.js';
import { Renderer } from 'marked';
import { header_length } from './metadata-header.js';
import { sourcePositions } from './source-positions.js';
import latexRenderer from './latex-renderer.js';
import * as PostProcessor from './post-processor.js';
import { pathToFileURL } from 'url';

// Load global/project configuration at startup (file-independent; part
// of warm-up so a forked watch worker pays this once on import).
configManager.load();

// The whole per-file build pipeline, callable. Importing this module runs
// only the (file-independent) module-load above; the build runs on call —
// which is what lets a pre-warmed watch worker do exactly one build.
export async function processFile(rawFilename, options) {

const outputFormat = options.to || 'html';
if (!['html', 'latex'].includes(outputFormat)) {
	console.error(`Unknown output format: "${outputFormat}". Supported formats: html, latex`);
	process.exit(1);
}
const isLatex = outputFormat === 'latex';

// Get the markdown file we are supposed to process, or detect stdin mode.
// stdin is used when the filename is '-', or when no filename is given and
// stdin is not a TTY (i.e. the user is piping input in).
const isStdin = rawFilename === '-' || (rawFilename === undefined && !process.stdin.isTTY);
if (!rawFilename && process.stdin.isTTY) {
	console.error("Please provide a filename (or pipe input via stdin, or pass '-' to read from stdin)");
	process.exit(1);
}

const filename = isStdin ? null : rawFilename;
global.current_file = isStdin ? '<stdin>' : filename;
global.isLatex = isLatex;

// Start each build with a clean warning list (module state survives across
// processFile calls in library/watch use); the summary prints after writeOutput.
resetWarnings();
resetIndexing();
const markdownFile = filename;
// In stdin mode, [[file.md]] inclusions and the "Markdown file directory"
// config (used by mathematica/tikz/template/metadata-header) resolve against
// the current working directory — there's no source file to anchor to.
const markdownFileDirectory = isStdin
	? process.cwd()
	: path.dirname(path.resolve(process.cwd(), markdownFile));

// When the rendered output will go to stdout, redirect console.log to stderr so
// progress chatter from extensions (mathematica, tikz, metadata-header, …) can't
// corrupt the document stream. console.error / console.warn already go to stderr.
// Also handle EPIPE gracefully (e.g. `… | head`) instead of crashing.
const writingToStdout = isStdin && !options.output;
if (writingToStdout) {
	const origLog = console.log;
	console.log = (...args) => { console.error(...args); };
	// Keep a reference so anything that grabbed console.log earlier still works.
	void origLog;
	process.stdout.on('error', (err) => {
		if (err.code === 'EPIPE') process.exit(0);
		throw err;
	});
}


// --- Inverse search utilities ---
// Stamp data-source-line onto the first HTML opening tag in a rendered fragment.
// The tag-name class allows hyphens so custom-element wrappers (e.g. the
// `@begin(call-out)` → `<call-out>` form) are stamped correctly rather than split
// mid-name; leading whitespace is tolerated for handlers that emit a newline first.
function addSourceLineAttr(html, token) {
  if (token.sourceLine !== undefined) {
    return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-source-line="${token.sourceLine}"`);
  }
  return html;
}

// Wrap an extension object's renderer so its output gets data-source-line.
// Mutates the extension in place (before registration).
function wrapRendererWithSourceLine(extension) {
  const originalRenderer = extension.renderer;
  extension.renderer = function(token) {
    const html = originalRenderer.call(this, token);
    if (html === false) return false;
    return addSourceLineAttr(html, token);
  };
  return extension;
}

configManager.set("Markdown file directory", markdownFileDirectory);
configManager.set("Jmarkdown app directory", path.dirname(fileURLToPath(import.meta.url)) )

const baseRequire = createRequire(import.meta.url);
// Create a custom require function that checks both the CWD and the original paths
// const customRequire = (modulePath) => {
//   try {
//     // First try to resolve relative to current working directory
//     return baseRequire(path.resolve(process.cwd(), modulePath));
//   } catch (err) {
//     // If that fails, try the original require paths
//     return baseRequire(modulePath);
//   }
// };
// Create a custom require function that checks multiple locations
const customRequire = (modulePath) => {
  const attempts = [
    // 1. Original require (app's node_modules, global modules)
    () => baseRequire(modulePath),
    
    // 2. Current working directory's node_modules
    () => {
      const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
      return cwdRequire(modulePath);
    },
    
    // 3. Try to find package.json in parent directories and create require from there
    () => {
      let currentDir = process.cwd();
      while (currentDir !== path.dirname(currentDir)) {
        const packageJsonPath = path.join(currentDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const dirRequire = createRequire(packageJsonPath);
          return dirRequire(modulePath);
        }
        currentDir = path.dirname(currentDir);
      }
      throw new Error('No package.json found in parent directories');
    }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      lastError = err;
    }
  }
  
  throw lastError;
};

global.require = customRequire;

global.cheerio = cheerio;

// Resolved lazily on first requireGlobal() call: shelling out to npm costs
// hundreds of ms and fails outright where npm isn't on PATH (e.g. a packaged
// Electron host), which would otherwise break import of this module for
// documents that never use requireGlobal. JMARKDOWN_GLOBAL_MODULES overrides.
let globalNodeModulesPath = process.env.JMARKDOWN_GLOBAL_MODULES || null;

function requireGlobal(the_package) {
	if (globalNodeModulesPath === null) {
		globalNodeModulesPath = execSync('npm root -g').toString().trim();
	}
	return require(path.join(globalNodeModulesPath, the_package));
}

global.requireGlobal = requireGlobal;

// Initialise the default footnote extension

// We create two versions of the marked interpreter, because if we want to 
// call the interpreter from a <script> block in the jmarkdown code, we cannot
// pass that markdown into the main interpreter as that can screw up the state.
// However, we initialise the footnote extension only for the main interpreter because
// there's no easy way to handle footnotes in markdown interpreted by the <script> interpreter
marked.use(markedFootnote({
	rendererOptions: {
        containerTagName: 'section',
        containerClassName: 'footnotes'
    } 
}));

// Register the inline footnote extension [^label: body] after marked-footnote.
// Later registrations get priority, so our start() (which requires a colon inside
// the brackets) is checked before marked-footnote's [^label] reference syntax.
registerExtension(inlineFootnote);

// The @endnotes / @endnotes(name) placement block extension. Like the footnote
// extensions it belongs to the main parser only (marked_copy renders script-block
// markdown, which never carries document-level endnote placement).
marked.use({ extensions: [endnotesPlacement] });


registerExtensions([
	jmarkdownSyntaxEnhancements.latex,
	jmarkdownSyntaxEnhancements.moustache
]);


if (options.normalSyntax != true) {
	// Wrap each inline extension's renderer to stamp data-source-line
	const inlineExts = [
		jmarkdownSyntaxModifications.italics, 
		jmarkdownSyntaxModifications.strong, 
		jmarkdownSyntaxModifications.underline,
		jmarkdownSyntaxModifications.subscript,
		jmarkdownSyntaxModifications.superscript,
		jmarkdownSyntaxModifications.highlight,
		jmarkdownSyntaxModifications.intense
	];
	inlineExts.forEach(ext => { if (!options.fragment && !isLatex) wrapRendererWithSourceLine(ext); });
	registerExtensions(inlineExts);
}

registerExtension(anchors);

registerExtension(editors);


//import extendedTables from "marked-extended-tables";
// [marked, marked_copy].map(m => {
// 	m.use(extendedTables());
// });
[marked, marked_copy].map(m => {
	m.use(markedExtendedTablesHeaderless());
});




[marked, marked_copy].map(m => {
	m.use(
		markedHighlight({
			emptyLangClass: 'hljs',
		    langPrefix: 'hljs language-',
		    highlight(code, lang, info) {
		      // On the LaTeX path, hand the original source through to
		      // the renderer unchanged so `\begin{minted}{lang}` receives
		      // raw code, not HTML-encoded hljs spans.
		      if (global.isLatex) return code;
		      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
		      return hljs.highlight(code, {tabReplace: '  ', language }).value;
		    }
		})
	);
});


[marked, marked_copy].map(m => {
	m.use(createDirectives([
		...presetDirectiveConfigs,
		{ level: 'container', marker: '::::' },
		{ level: 'container', marker: ':::::' },
		{ level: 'container', marker: '::::::' },
		{ level: 'container', marker: ':::::::' },
		{ level: 'container', marker: '::::::::' }
	]));
});

// There's a weird bug that I haven't yet figured out.
// If you install the titleBox directive here, you get an error whenever
// you try to use it in the markdown file.  However, if you install
// it later, after some other directives have been installed, it works.
marked.use(createDirectives(additionalDirectives));

marked.use(createDirectives( [ createMermaid(":::") ]));

createMultilevelOptionals('comment', false);

function createMultilevelDirectives(rendering_function) {
	const directives = [];
	[3,4,5,6,7,8].forEach(level => {
		directives.push(
			{
				'level': 'container',
				'marker': ':'.repeat(level),
				'renderer': rendering_function
			}
		);
	});

	marked.use(createDirectives(directives));
	marked_copy.use(createDirectives(directives));
}

createMultilevelDirectives(sources.renderer);
marked.use(createDirectives([targets]));
marked_copy.use(createDirectives([targets]));
registerExtension(inlineTarget);

marked.use({
  tokenizer: {
    code() {
      // return undefined to disable
    }
  }
});

marked.use({
  tokenizer: {
    br() {
      // return undefined to disable
    }
  }
});


const alert_options = {
  variants: [
    {
      type: 'question',
      icon: '<i class="fa-regular fa-circle-question"></i>',
      title: 'Question', // optional
      titleClassName: 'alert-question' // optional
    },
    {
      type: 'suggestion',
      icon: '<span class="fa-stack"><i class="fa-light fa-circle fa-stack-2x"></i><i class="fa fa-lightbulb fa-stack-1x"></i></span>',
      title: 'Suggestion', // optional
      titleClassName: 'alert-suggestion' // optional
    }
  ]
};
// Capture marked-alert's HTML renderer and wrap it so LaTeX output renders the
// callout as a tcolorbox (see alerts.js) instead of leaking its HTML. One
// extension object, shared by marked and marked_copy.
const alertExtension = markedAlert(alert_options);
const alertRenderer = alertExtension.extensions.find(e => e.name === 'alert');
const htmlAlertRenderer = alertRenderer.renderer;
alertRenderer.renderer = function(token) {
	return global.isLatex ? renderAlertLatex(this.parser, token) : htmlAlertRenderer.call(this, token);
};
marked.use(alertExtension);
marked_copy.use(alertExtension);


const markdownDemos = [
  createMarkdownDemo(':::'),
  createMarkdownDemo('::::'),
  createMarkdownDemo(':::::'),
  createMarkdownDemo('::::::'),
  createMarkdownDemo(':::::::'),
  createMarkdownDemo('::::::::')
];
marked.use( createDirectives( markdownDemos ) );

marked.use( createDirectives([ strategicFormGame ]) );
marked_copy.use( createDirectives([ strategicFormGame ]) );

registerExtensions([ 
	jmarkdownSyntaxEnhancements.descriptionLists 
]);

marked.use( createDirectives( [ createTiKZ(':::') ] ) );

marked.use( createDirectives( [ createMathematica(':::') ] ) );
registerExtension( inlineMathematica );

marked.use(markedMoreLists());
marked_copy.use(markedMoreLists());

// Protect display-math blocks ($$…$$, \[…\], \begin{env}…\end{env}) from the
// block tokenizers. Registered AFTER marked-more-lists so marked tries it first
// (last-registered wins), claiming the whole block before a line that starts
// with +/-/* inside an aligned equation can be mistaken for a list item.
registerExtension(jmarkdownSyntaxEnhancements.mathBlock);

// This extension has to be registered after the directives in order for it to work.
registerExtensions([
	jmarkdownSyntaxEnhancements.emojis
]);

// Smart typography (opt-in via `Smart typography: true`): a walkTokens hook on
// both instances. Registration is unconditional — the hook reads the config
// key lazily at walk time, AFTER the metadata header has been merged, so the
// per-document key works even though extensions register before it's parsed.
marked.use({ walkTokens: smartTypography });
marked_copy.use({ walkTokens: smartTypography });


marked.use({
	extensions: [
		jmarkdownScriptExtensions['javascript'],
		jmarkdownScriptExtensions['jmarkdown'],
	]
}) 

global.output = '';

global.marked = marked;

// This function needs to be available to code executed in runInThisContext,
// in order to be able to create extensions which execute JavaScript code.
global.export_to_jmarkdown = export_to_jmarkdown;

registerExtensions([ 
	jmarkdownSyntaxEnhancements.classAndId 
]);

registerExtensions([ 
	jmarkdownSyntaxEnhancements.rightAlign, 
	jmarkdownSyntaxEnhancements.centerAlign 
]);

registerExtension( mathjs );

registerExtensions([ inlineFunctions, blockFunctions ]);

// Compile-time citation support. Registered late so the inline \cite-family
// tokenizer is checked before the markdown inline rules (links, emphasis), and
// so the @bibliography block extension (and its ::Bibliography legacy alias)
// wins over the generic `::` directive.
registerExtensions([ citations, bibliography ]);

// (Back-of-book index registration moved below, after the @name directives —
// see the note there.)

// Load extensions and directives from the configuration file(s).
// This should happen before the metadata header is processed.
await configManager.loadExtensions();
await configManager.loadDirectives();
await configManager.loadEnvironments();

// No await is needed because this doesn't read from a file.
configManager.loadOptionals();

// For some reason, this has to be installed here or it doesn't work
marked.use(createDirectives([titleBox]));

// Stamp data-source-line on the @begin(...) environment wrappers and @name+ block
// wrappers, so inverse search resolves a click on an env's chrome (not just its
// inner prose). beginEnd's one renderer dispatches EVERY registered environment —
// theorems, floats, equations, generic and parity envs — so wrapping it covers
// them all; atBlock covers the @name+ block form. Done before registration (the
// wrap mutates the extension's renderer in place), and only in full HTML mode —
// fragment/LaTeX carry no source positions. atInline is intentionally left
// unwrapped: an inline @name already sits inside an already-stamped <p>, and
// stamping the cross-ref markers (@ref/@cref…) would diverge from their
// byte-identical :ref/:cref colon twins.
if (!options.fragment && !isLatex) {
	wrapRendererWithSourceLine(beginEnd);
	wrapRendererWithSourceLine(atBlock);
}

// Named-scope block environments: @begin(name) … @end(name) (see begin-end.js).
// `@` is an otherwise-unused sigil, so nothing else matches `@begin(...)` and the
// registration position doesn't matter; it lives here, after the directive set.
marked.use({ extensions: [beginEnd] });

// Single-shot @name[…] (inline) / @name+[…] (block) directives — the same registry
// as @begin/@end, parity with `:name` / `::name` (which stay live alongside). On
// both instances so markdown re-parsed inside script blocks supports them too.
marked.use({ extensions: [atBlock, atInline] });
marked_copy.use({ extensions: [atBlock, atInline] });

// Back-of-book index (indexing.js): the inline @index[…] mark + the @index
// placement block (legacy :index[…] / ::Index still accepted).
//
// Registered HERE — AFTER atInline — and the ordering is load-bearing: marked
// tries the last-registered extension first, and atInline claims ANY bracket
// form `@name[…]`, so registered earlier the generic tokenizer would win and
// `@index[Turing|see{…}]` would render as a visible <span class="index">
// instead of an invisible mark. indexMark has to win because it claims its
// bracket RAW with a balanced scan — atInline's `[^\]]*` would truncate a
// display form like [$f[x]$] at the first ] and mangle the makeindex grammar.
// (The same reason it already had to sit after the `:` directive framework.)
registerExtensions([ indexMark, indexPlacement ]);

// Float environments (@begin(figure) …) register into the block-environment
// registry at import time; the @begin extension consults it at render time.
// Theorem-like environments (@begin(theorem|lemma|proof|…)) — same pattern.
// Numbered display equations (@begin(equation)).

// Let users define their own @begin environments from a <script data-type="jmarkdown">
// block, the same way export_to_jmarkdown is exposed for inline functions. The
// callback receives the full ctx — including ctx.text ([label]) and ctx.attrs
// ({attributes}). Define an environment before the @begin that uses it.
// defineEnvironment (numbered-environments.js) honours `numbered: true` for
// auto-numbered, cross-referenceable environments and otherwise delegates to
// the core registry unchanged.
global.defineEnvironment = defineEnvironment;

// And let those user-defined handlers declare their LaTeX preamble needs the
// same way the built-in renderers do (floats → graphicx, game → sgame, …):
// usage-driven, so a `latex` renderer that emits \begin{tcolorbox} just calls
// requirePackage('tcolorbox') as it renders and the assembled full-document
// preamble stays minimal. All three are no-ops in HTML/fragment builds.
global.requirePackage = requirePackage;
global.addPreamble = addPreamble;
global.addLatePreamble = addLatePreamble;


// gfm-heading-id supplies the heading renderer that (a) assigns each heading a
// stable, slugged id (prefixed 'toc-') and (b) records the heading in the list
// that getHeadingList() returns — the list createTOC() walks to build {{TOC}}.
// We capture that renderer here because JMarkdown installs its OWN heading
// renderer further down (for {-} unnumbered handling and data-source-line
// stamping). A later renderer REPLACES an earlier one in marked, so if the
// JMarkdown heading renderer simply called Renderer.prototype.heading it would
// clobber gfm-heading-id: no ids would be emitted and the heading list would
// stay empty, leaving {{TOC}} to expand to nothing. Instead, the JMarkdown
// heading renderers delegate to this captured function so id assignment and
// list population still happen.
const gfmHeadingIdExtension = gfmHeadingId({ prefix: "toc-" });
const gfmHeadingRenderer = gfmHeadingIdExtension.renderer.heading;

marked.use(gfmHeadingIdExtension, {
	hooks: {
		postprocess(html) {
			if (global.isLatex) {
				// LaTeX has native contents lists and matter/appendix divisions;
				// emit the commands and let the engine do the work. (The
				// post-processor, which handles the HTML side, never runs for LaTeX.)
				html = html.replace(/\{\{TOC\}\}/g, '\\tableofcontents');
				html = html.replace(/\{\{LOF\}\}/g, '\\listoffigures');
				html = html.replace(/\{\{LOT\}\}/g, '\\listoftables');
				// \listoflistings is minted's command (the listing float's
				// package) — require it here too, so a {{LOL}} in a document
				// with no actual listings still compiles.
				if (/\{\{LOL\}\}/.test(html)) requirePackage('minted');
				html = html.replace(/\{\{LOL\}\}/g, '\\listoflistings');
				// Matter divisions (book/report) and appendix. \frontmatter and
				// friends require the book/report class; \appendix works anywhere.
				html = html.replace(/\{\{frontmatter\}\}/g, '\\frontmatter');
				html = html.replace(/\{\{mainmatter\}\}/g, '\\mainmatter');
				html = html.replace(/\{\{backmatter\}\}/g, '\\backmatter');
				html = html.replace(/\{\{appendix\}\}/g, '\\appendix');
				return html;
			}
			// HTML: build the table of contents here from the heading list.
			// {{LOF}}/{{LOT}}/{{LOL}} are built later in the post-processor,
			// once figures, tables, and listings have been numbered.
			const headings = getHeadingList();
			const toc = createTOC(headings);
			html = html.replace("{{TOC}}", toc);
			return html;
		}
	}
});


async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

const input = isStdin ? await readStdin() : fs.readFileSync(filename, 'utf8');
// In stdin mode without -o, write to stdout (outFile === null is the sentinel).
const outFile = options.output
	|| (isStdin ? null : filename.replace(/\.([^.]+)$/, isLatex ? '.tex' : '.html'));

function writeOutput(text) {
	if (outFile === null) {
		process.stdout.write(text);
	} else {
		fs.writeFileSync(outFile, text);
	}
}

// The inverse-search click handler embeds an absolute path to the source file,
// so it's only meaningful when we have a real input file and a full HTML
// document to inject the script into.
const skipInverseSearch = options.fragment || isLatex || isStdin;

const markdown_no_metadata = await processYAMLheader(input);

// Decide whether citations are resolved at compile time (this run) or left
// literal for the runtime Biblify client. Read after the metadata header has
// been merged, so a `Resolve citations:` key in the header takes effect.
global.resolveCitations = !!configManager.get('Biblify.resolve');

// `File inclusion: false` (config/metadata) skips the [[file.md]] pre-parse
// splice entirely — for hosts that give [[…]] other semantics (wikilinks).
const text_no_inclusions = configManager.get('File inclusion') === false
	? markdown_no_metadata
	: processFileInclusions(markdown_no_metadata, markdownFileDirectory);

// Collapse multi-paragraph inline footnotes so they stay within a single
// paragraph block for the inline tokenizer.
resetFootnotes();
const text = preprocessFootnotes(text_no_inclusions);


// Strip the {-} "unnumbered" marker from a heading token's inline text BEFORE
// gfm-heading-id slugs it, so the heading id and the {{TOC}} entry are clean
// (without the {-} marker we would otherwise get an id like 'toc-methods--' and
// a literal "Methods {-}" line in the table of contents). Returns true if the
// marker was present, so the caller can flag the heading as unnumbered.
function stripUnnumberedMarker(token) {
	const marker = /\s*\{-\}\s*/;
	if (typeof token.text === 'string' && marker.test(token.text)) {
		token.text = token.text.replace(marker, '');
		if (Array.isArray(token.tokens)) {
			for (const child of token.tokens) {
				if (typeof child.text === 'string') child.text = child.text.replace(marker, '');
				if (typeof child.raw === 'string') child.raw = child.raw.replace(marker, '');
			}
		}
		return true;
	}
	return false;
}

const renderer = {
  paragraph(token) {
    return addSourceLineAttr(Renderer.prototype.paragraph.call(this, token), token);
  },

  listitem(token) {
    return addSourceLineAttr(Renderer.prototype.listitem.call(this, token), token);
  },

  heading(token) {
    // Strip the {-} marker first so the id and {{TOC}} entry are clean, then
    // delegate to gfm-heading-id's renderer so the heading still gets its
    // 'toc-' id and is recorded for {{TOC}}.
    const unnumbered = stripUnnumberedMarker(token);
    let html = gfmHeadingRenderer.call(this, token);
    // Flag unnumbered headings for the numeric-headings post-processor.
    if (unnumbered) {
      html = html.replace(/^<h([1-6])/, '<h$1 class="unnumbered"');
    }
    return addSourceLineAttr(html, token);
  },

  table(token) {
    return addSourceLineAttr(Renderer.prototype.table.call(this, token), token);
  },

  blockquote(token) {
    return addSourceLineAttr(Renderer.prototype.blockquote.call(this, token), token);
  },

  code(token) {
    return addSourceLineAttr(Renderer.prototype.code.call(this, token), token);
  }
};


// Install the source position tracker and the renderer that stamps data-source-line attributes.
// In fragment / LaTeX / stdin modes, skip this — the attributes are only useful with the inverse search script.
if (!skipInverseSearch) {
	marked.use(sourcePositions(text, header_length), { renderer });
} else if (!isLatex) {
	// Fragment mode: still strip {-} from headings even though we skip source-position tracking.
	marked.use({
		renderer: {
			heading(token) {
				// Strip {-} first (clean id / TOC entry), then delegate to
				// gfm-heading-id (see note above) so headings keep their ids and
				// feed {{TOC}} even in fragment mode.
				const unnumbered = stripUnnumberedMarker(token);
				let html = gfmHeadingRenderer.call(this, token);
				if (unnumbered) {
					html = html.replace(/^<h([1-6])/, '<h$1 class="unnumbered"');
				}
				return html;
			}
		}
	});
}

// Install the LaTeX renderer for built-in tokens (paragraph, heading, etc.).
// This must come after all extensions are registered so it takes precedence.
if (isLatex) {
	marked.use({ renderer: latexRenderer });
}

const content = marked.parse(text);

// Index marks whose index never prints are silently lost in both outputs —
// collect the warning now that the whole document has been parsed.
checkIndexPlacements();


if (isLatex) {
	// LaTeX output: no cheerio post-processing or inverse-search injection. In
	// the default (non-fragment) mode the body is wrapped in a complete,
	// compilable document (\documentclass + assembled preamble + frontmatter +
	// body + \end{document}); --fragment emits the body alone, which is also
	// what the feature/compile test harnesses consume.
	// fillEndnotes resolves @endnotes placement markers (a no-op unless the
	// document uses grouping/placement — otherwise notes were plain \footnote{}s).
	const latexBody = fillEndnotes(content, 'latex');
	const latex = options.fragment ? latexBody : processLatexTemplate(latexBody);
	writeOutput(latex);
} else {
	// HTML output: full pipeline with post-processing, template, and inverse search.

	// Math macros (`Math macros` key): the same raw \newcommand lines the
	// LaTeX preamble gets are injected in a hidden inline-math block at the
	// TOP of the body. MathJax processes the document in order, so the macros
	// exist before any math that uses them; inline math is never numbered, so
	// tags:'ams' can't give the hidden block an equation number. Only HTML
	// text specials are escaped — MathJax reads the decoded text.
	const mathMacros = configManager.get('Math macros') || [];
	const macrosHTML = mathMacros.length
		? `<div class="math-macros" style="display:none">\\(\n${
			mathMacros.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')
		}\n\\)</div>\n`
		: '';

	// Resolve @endnotes placement markers and append any unplaced endnotes (or,
	// with no markers at all, the historical trailing "Endnotes" section). Done
	// on the parsed body BEFORE the template/post-processor so cross-references
	// inside note bodies still resolve.
	const contentWithFootnotes = macrosHTML + fillEndnotes(content, 'html');

	let html = options.fragment ? contentWithFootnotes : processTemplate(contentWithFootnotes);

	html = PostProcessor.postProcessHTML(html, { fragment: !!options.fragment, outBase: outFile });
	html = PostProcessor.runPostprocessScripts(html);

	// Inject the inverse-search click handler script. Clicking any element with
	// a data-source-line attribute (while holding Cmd) opens the source file at
	// that line in Sublime Text. Skipped in fragment / LaTeX / stdin modes.
	//
	// TEMPORARILY DISABLED (2026-06-28): the ⌘-click → kmtrigger:// navigation
	// (Keyboard Maestro "Open file in sublime") is off while the postMessage
	// preview-sync bridge is in development — it was firing alongside the bridge's
	// own ⌘-click handler. Flip ENABLE_SUBLIME_INVERSE_SEARCH back to true to
	// restore it. data-source-line stamping stays on, so the bridge (and a future
	// re-enable) still have their mapping data.
	const ENABLE_SUBLIME_INVERSE_SEARCH = false;
	if (ENABLE_SUBLIME_INVERSE_SEARCH && !skipInverseSearch) {
		const inverseSearchScript = `
<script>
  document.addEventListener('click', function(e) {
    if (!e.metaKey) return;
    const el = e.target.closest('[data-source-line]');
    if (el) {
      e.preventDefault();
      const line = el.dataset.sourceLine;
      const file = ${JSON.stringify(path.resolve(markdownFile))};
      const value = 'value=' + encodeURIComponent(file + ':' + line);
      window.location = 'kmtrigger://macro=Open%20file%20in%20sublime&' + value;
    }
  });
</script>
`;
		html = html.replace('</body>', inverseSearchScript + '</body>');
	}

	html = PostProcessor.beautifyHTML(html);
	writeOutput(html);
}

	// Build-quality warnings (unresolved :refs, duplicate labels, …) collected
	// during the run — a short stderr summary, like LaTeX's end-of-run nags.
	reportWarnings();

	return { outFile, isLatex };
}

// ===========================================================================
// CLI bootstrap — runs ONLY when this file is the entry point (`jmarkdown …`).
// Guarded so that importing index.js (e.g. from the watch worker, to warm up)
// loads the module graph WITHOUT parsing argv or building anything.
//
// process.argv[1] must be realpath-resolved before comparing: the global
// `jmarkdown` bin is a SYMLINK to this file, and Node reports the symlink path
// in argv[1] but the resolved real path in import.meta.url. Without realpathSync
// the guard is false for every symlinked invocation and the CLI silently does
// nothing.
// ===========================================================================
const isCliEntry = (() => {
	try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; }
	catch { return false; }
})();
if (isCliEntry) {
	const program = new Command();

	program
		.version('0.5')
		.description("A Markdown process with great customisation capabilities, plus JavaScript as a scripting language");

	program
		.command('init')
		.description('Initialise a new JMarkdown project')
		.option('-f, --file <filename>', 'Construct a skeleton file named "filename" from a template')
		.option('-t, --title [title]', 'Title for the newly created jmarkdown file (default: \'My title\')')
		.option('-m, --makefile [key]', 'Include a Makefile template (an optional key is required if adding to an existing Makefile, otherwise the first three letters of the filename will be used to differentiate the targets in the Makefile). This requires the -f option.')
		.option('-p, --print', 'Copy files for exporting jmarkdown to PDF using puppeteer')
		.action((options) => {
			if (options.title === true) {
				options.title = 'My title';
			}
			if (options.makefile !== undefined && options.file == undefined) {
				console.log('You need to specify a markdown file name for the Makefile template.');
				process.exit();
			}
			initialise(options, path.dirname(fileURLToPath(import.meta.url)));
			process.exit();
		});

	program
		.command('options')
		.description('Show the default configuration options')
		.action(() => {
			showOptions();
			process.exit();
		});

	program
		.command('process [filename]', { isDefault: true })
		.description("Process a JMarkdown file (use '-' or pipe to stdin to read from stdin)")
		.option('-n --normal-syntax', 'Disable JMarkdown syntax for /italics/ and *boldface*, etc., and revert to normal Markdown syntax')
		.option('--fragment', 'Output an HTML fragment without the template wrapper (no <html>, <head>, <body>)')
		.option('--to <format>', 'Output format: html (default) or latex', 'html')
		.option('-o, --output <file>', 'Output file path (default: input filename with .html or .tex extension; stdout in stdin mode)')
		.action(async (filename, options) => {
			await processFile(filename, { ...program.opts(), ...options });
		});

	program
		.command('watch <filename>')
		.description('Rebuild a JMarkdown file on every change and live-reload it in the browser')
		.option('--to <format>', 'Output format: html (default) or latex', 'html')
		.option('-o, --output <file>', 'Output file path (default: input filename with .html or .tex extension)')
		.option('--port <number>', 'Port for the live-preview server', '3000')
		.option('--open', 'Open the live preview in your browser on start')
		.option('--no-serve', 'Only rebuild on change; do not start the preview server')
		.option('--full-reload', 'Reload the whole page on change instead of morphdom DOM-diffing')
		.option('--css', 'Live-track CSS assets (fast inject, no reload). Omit BOTH --css/--js to track both kinds')
		.option('--js', 'Live-track JS assets (full page reload). Omit BOTH --css/--js to track both kinds')
		.option('--no-sync', 'Do not inject the editor preview-sync bridge (forward/inverse search when embedded)')
		.action(async (filename, options) => {
			const { startWatch } = await import('./watch.js');
			await startWatch(filename, options);
		});

	await program.parseAsync(process.argv);
}