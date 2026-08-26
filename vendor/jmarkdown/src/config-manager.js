// config-manager.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { marked } from './utils.js';
import { addExtension, loadExtensionsFromSpec, loadDirectivesFromSpec, loadEnvironmentsFromSpec, parseOptionals } from './metadata-header.js';

// Default configuration values
export const DEFAULT_CONFIG = {
	'Lang': 'en',
	'Highlight theme': 'default',
	'Body classes': '',
	"Biblify activate": false,
	"Biblify": {
		"add helper function": true,
		"add section heading": true,
		"add toc entry": true,
		"bibliography": "",
		"bibliography style": "",
		"defer": false,
		"resolve": false,
		"tooltips": false,
		"minimal": false,
		"latex bib style": ""
	},
	"Directives": [],
	"Extensions": [],
	"Environments": [],
	// Pre-parse [[file.md]] file-inclusion splicing (src/file-inclusion.js).
	// Hosts that give [[…]] other semantics (e.g. Clew's Obsidian-style
	// wikilinks) set this to false so the pre-parse pass can't swallow a
	// [[link]] that happens to sit alone on a line.
	"File inclusion": true,
	// 'bare' (default) recognises JMarkdown's native `Key: value` header at
	// the top of a file; 'fenced' recognises ONLY `---`-fenced headers, so
	// prose that happens to start with `word: …` stays body text (see
	// processYAMLheader in metadata-header.js). Hosts rendering arbitrary
	// notes (Clew) set 'fenced'.
	"Header style": "bare",
	// Extra local files for `jmarkdown watch` to live-track that aren't directly
	// linked via `CSS`/`Script` (e.g. an @imported CSS partial, or a module a
	// linked script imports). Classified by extension: .css → live CSS inject,
	// anything else → full reload. Has no effect outside watch mode.
	"Watch": [],
	'Fontawesome': 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/js/all.min.js',
	'Mermaid': 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js',
	'Highlight src': 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/{{Highlight_theme}}.min.css',
	"Highlight theme": "atom-one-light",
	'HTML header': [],
	'HTML footer': [],
	"LaTeX preamble": [],
	// LaTeX document assembly (see src/latex-template.js + src/preamble.js).
	// All user-overridable via metadata/config; nothing about the document class
	// or engine is baked in. `Class options` and `Packages` shape the preamble;
	// `LaTeX engine` only tunes font/encoding defaults (JMarkdown emits .tex, it
	// does not compile).
	"Document class": "article",
	"Class options": "",
	"LaTeX engine": "pdflatex",
	"Packages": [],
	'MathJax': {
		'configuration': String.raw`MathJax = {
			tex: {
			    inlineMath: [['$', '$'], ['\\(', '\\)']],
			    displayMath: [['$$', '$$'], ['\\[', '\\]']],
				tags: 'ams'
			}
		}`,
		'src': 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js' 
	},
	"Optionals": [],
	'Template': 'default',
	'TiKZ libgs': '/opt/homebrew/Cellar/ghostscript/10.05.0_1/lib/libgs.10.05.dylib',
	'TiKZ optimise': 'group-attributes,collapse-groups',
	'Code language': 'text',
	// How @video renders in LaTeX (src/media.js), since a PDF cannot play one:
	// 'link' (default) a hyperlinked poster frame — works in every viewer;
	// 'embed' a media9 RichMedia annotation carrying the H.264 stream (Acrobat
	// only, ~480KB of player per document); 'attach' the file as a PDF
	// attachment; 'poster' the still frame alone. Per-video: {tex-mode=…}.
	'Video mode': 'link',
	// Where a poster frame is needed and none was given, extract one from the
	// first frame with ffmpeg, cached under Video/. 'none' turns that off.
	'Video poster': 'auto',
	// Opt-in pandoc-style citations ([@key] / @key — see src/pandoc-citations.js),
	// translated into the \cite commands. Off by default because @ is the
	// directive sigil: with this on, a bare @word that isn't a registered
	// directive is read as a citation key. Like `File inclusion` and
	// `Header style` above, this exists for an embedding host rendering notes
	// written elsewhere (Obsidian-style), which is why it is settable from
	// config: such notes carry no JMarkdown metadata header of their own.
	'Pandoc citations': false,
	// Opt-in typographic educator (see src/smart-typography.js): straight
	// quotes → curly, ---/-- → em/en dash, ... → ellipsis, in both outputs.
	'Smart typography': false,
	// Raw LaTeX macro definitions (\newcommand, \DeclareMathOperator, …),
	// one per line, shared verbatim by BOTH outputs: preamble lines in LaTeX
	// (latex-template.js), a hidden MathJax block at the top of the body in
	// HTML (index.js). One source, no drift.
	'Math macros': [],
	// How a generic @begin(name) block renders in HTML (see src/begin-end.js):
	// 'hyphenated' → hyphenated names become custom elements, others div.class;
	// 'all' → always a custom element; 'none' → always a div.class.
	'Block elements': 'hyphenated'
};

class ConfigManager {
	constructor() {
		this.config = { ...DEFAULT_CONFIG };
		this.loaded = false;
	}

	// Load configuration from files
	load() {
		if (this.loaded) return this.config;

		// Define config file locations in order of precedence (highest last)
		const configLocations = [
			// User config in home directory
			path.join(os.homedir(), '.jmarkdown', 'config.json'),
			// Project config (current directory)
			path.join(process.cwd(), '.jmarkdown', 'config.json')
		];

		// Load from each location if it exists
		for (const location of configLocations) {
			//console.log(`Merging information from ${location}`);
			if (fs.existsSync(location)) {
				try {
					const fileConfig = JSON.parse(fs.readFileSync(location, 'utf8'));
					//console.log(fileConfig);
					this.config = this._mergeConfigs(this.config, fileConfig, location);
				} catch (error) {
					console.warn(`Error loading config from ${location}: ${error.message}`);
				}
			}
		}

		this.loaded = true;

		return this.config;
	}

	// Get full configuration
	getConfig() {
		return this.config;
	}

	// Get configuration value
	get(key, defaultValue = null) {
		if (!this.loaded) this.load();

		if (key.includes('.')) {
			// Handle nested properties
			const parts = key.split('.');
			let value = this.config;
			for (const part of parts) {
				if (value === undefined || value === null) return defaultValue;
				value = value[part];
			}
			return value !== undefined ? value : defaultValue;
		}

		return this.config[key] !== undefined ? this.config[key] : defaultValue;
	}

	_replaceSpacesInKeys(obj) {
		// Base case: if not an object or is null, return as is
		if (typeof obj !== 'object' || obj === null) {
			return obj;
		}

		// If it's an array, process each element
		if (Array.isArray(obj)) {
			return obj.map(item => this._replaceSpacesInKeys(item));
		}

		// Create a new object with transformed keys
		const newObj = {};

		Object.keys(obj).forEach(key => {
			// Replace spaces with underscores in the key
			const newKey = key.replace(/\s+/g, '_');

			// Recursively process the value
			newObj[newKey] = this._replaceSpacesInKeys(obj[key]);
		});

		return newObj;
	}

	getConfigForMustache() {
		return this._replaceSpacesInKeys(this.config);
	}

	// Read a key that may have been overridden by the metadata header. The
	// header merges overrides under the underscore spelling (e.g. `Document_class`
	// from `Document class:`), while DEFAULT_CONFIG defaults live under the spaced
	// spelling (`Document class`). Prefer the override, then the spaced default.
	getMeta(spacedKey, defaultValue = null) {
		const underscored = spacedKey.replace(/\s+/g, '_');
		const override = this.get(underscored);
		if (override != null) return override;
		const spaced = this.get(spacedKey);
		return spaced != null ? spaced : defaultValue;
	}

	// Set configuration value
	set(key, value) {
		if (!this.loaded) this.load();

		if (key.includes('.')) {
			// Handle nested properties
			const parts = key.split('.');
			let target = this.config;
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				if (!(part in target)) target[part] = {};
				target = target[part];
			}
			target[parts[parts.length - 1]] = value;
		} else {
			this.config[key] = value;
		}
	}

	// Merge metadata with configuration (metadata takes precedence)
	mergeMetadata(metadata) {
		if (!this.loaded) this.load();

		// Convert metadata to proper format
		const formattedMetadata = {};
		for (const [key, value] of Object.entries(metadata)) {
			const formattedKey = key.replace(/\s+/g, '_');

			// Clean up a few special cases from the metadata header
			let str = '';
			switch (formattedKey) {
			case 'Biblify_activate':
				str = value[0].trim().toLowerCase();
				if (str == "true") {
					formattedMetadata[formattedKey] = true;
				}
				else {
					formattedMetadata[formattedKey] = false;
				}
				break;
			case "Biblify_defer":
				str = value[0].trim().toLowerCase();
				if (str == "true") {
					this.config["Biblify"]["defer"] = true;
					this.config["Biblify"]["add helper function"] = false;
				}
				else {
					this.config["Biblify"]["defer"] = false;
				}
				break;
			case "Bibliography":
				str = value[0].trim();
				this.config["Biblify"]["bibliography"] = str;
				break;
			case "Resolve_citations":
				// Switch on compile-time citation resolution (vs. the runtime
				// Biblify client). See src/biblify-compile.js.
				str = value[0].trim().toLowerCase();
				this.config["Biblify"]["resolve"] = (str == "true");
				break;
			case "Citation_tooltips":
				str = value[0].trim().toLowerCase();
				this.config["Biblify"]["tooltips"] = (str == "true");
				break;
			case "Minimal_bibliography":
				str = value[0].trim().toLowerCase();
				this.config["Biblify"]["minimal"] = (str == "true");
				break;
			case "LaTeX_bib_style":
				// natbib .bst name used for \bibliographystyle in LaTeX output.
				this.config["Biblify"]["latex bib style"] = value[0].trim();
				break;
			case "Bibliography_style":
				str = value[0].trim();
				if ( ["apa", "harvard1", "vancouver", "bjps", "chicago"].includes(str) ) {
					this.config["Biblify"]["bibliography style"] = str;
				}
				else {
					const template_name = path.basename(str, ".csl");
					this.config["Biblify"]["bibliography style"] = template_name;
					// DEFAULT_CONFIG.Biblify has no `template` key, so create it
					// on first use of a custom CSL style before assigning into it.
					this.config["Biblify"]["template"] ??= {};
					this.config["Biblify"]["template"]["name"] = template_name;
					this.config["Biblify"]["template"]["file"] = str;
				}
				break;
			case "Body_classes":
				str = value.join(" ").trim();
				formattedMetadata[formattedKey] = str;
				break;
			case "Block_elements":
				// Written to the space-keyed config so begin-end.js can read it
				// directly via configManager.get('Block elements').
				this.config["Block elements"] = value[0].trim().toLowerCase();
				break;
			case "Pandoc_citations":
				// Space-keyed, like Block_elements: pandoc-citations.js reads
				// configManager.get('Pandoc citations') lazily while tokenizing.
				str = value[0].trim().toLowerCase();
				this.config["Pandoc citations"] = (str == "true");
				break;
			case "Smart_typography":
				// Space-keyed for the same reason: smart-typography.js reads
				// configManager.get('Smart typography') lazily at walk time.
				str = value[0].trim().toLowerCase();
				this.config["Smart typography"] = (str == "true");
				break;
			case "Video_mode":
			case "Video_poster":
				// Space-keyed for the same reason as Block_elements: media.js
				// reads configManager.get('Video mode' / 'Video poster') at
				// render time.
				this.config[formattedKey.replace(/_/g, ' ')] = value[0].trim().toLowerCase();
				break;
			case "Math_macros":
				// A multi-line metadata value arrives as one newline-joined
				// string with the source indentation intact; normalise to
				// trimmed, non-empty lines (one definition per line). Replaces
				// any config-file value, like the other array keys.
				this.config["Math macros"] = value
					.flatMap(v => String(v).split('\n'))
					.map(s => s.trim())
					.filter(Boolean);
				break;
			default:
				formattedMetadata[formattedKey] = value;
			}
		}

		this.config = this._mergeConfigs(this.config, formattedMetadata);
	}


	// Helper method to get app config path
	_getAppConfigPath() {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		return path.join(__dirname, 'default-config.json');
	}

	// Helper method to merge configs
	_mergeConfigs(target, source, location = '') {
	    const result = { ...target };
	    
	    for (const [key, value] of Object.entries(source)) {
	        // Special case: if the source value is an array, replace target value completely
	        if (Array.isArray(value)) {
	            result[key] = [...value]; // Create a new array (shallow copy)
	        }
	        // If property exists and both are objects (but not arrays), merge recursively
	        else if (
	            key in result && 
	            typeof result[key] === 'object' && typeof value === 'object' &&
	            !Array.isArray(result[key]) && value !== null
	        ) {
	            result[key] = this._mergeConfigs(result[key], value);
	        } 
	        // Otherwise, simply overwrite with the source value
	        else {
	            result[key] = value;
	        }
	    }
	    
	    //console.log(`after merging: with ${location}`, result);
	    return result;
	}

	loadOptionals() {
		let optionals = this.get("Optionals");
		parseOptionals(optionals);
	}

	async loadDirectives() {
		let directives = this.get("Directives");
		for (const directive of directives) {
			await loadDirectivesFromSpec(directive);
		}
	}

	async loadExtensions() {
		let extensions = this.get("Extensions");
		//console.log(`Extensions found to load: ${extensions}`);
		for (const extension of extensions) {
			// There are two forms extensions can be given in: (1) the simple format used by
			// the metadata header, or (2) the syntax of "Load extensions" from the metadata header.
			if (typeof extension === 'object' && extension !== null) {
				// Need to convert this into the string format expected by addExtension from metadata-header.js
				// the spec and definition need to be joined into a single string with "\n" at the end
				// of each line, and put into an array.
				const name = "Extention" + extension['name'].replaceAll(' ', '');
				let spec = [ extension['spec'], ...extension['definition']];
				spec = [ spec.join("\n") ];
				addExtension(spec, name);	
			}
			else {
				// Assume the file path is absolute
				await loadExtensionsFromSpec(extension);
			}
		}
	}

	async loadEnvironments() {
		let environments = this.get("Environments");
		for (const environment of environments) {
			// Config-supplied paths are absolute (loadEnvironmentsFromSpec uses them as-is).
			await loadEnvironmentsFromSpec(environment);
		}
	}
}

export const configManager = new ConfigManager();