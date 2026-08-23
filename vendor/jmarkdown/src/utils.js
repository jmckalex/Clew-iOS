/*
	Several of the jmarkdown extensions need to evaluate code in a shared
	instance of runInThisContext.  This utility module makes that possible.
*/
import { runInThisContext } from 'vm';
import { marked, Marked } from 'marked';
import { configManager } from './config-manager.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { createDirectives } from './extended-directives.js';

let marked_copy = new Marked({
	indentedCode: false
});

marked.setOptions({
	gfm: true
})

/*
	When using inline JavaScript in jmarkdown files, functions which return 
	a string value can request that it be run through the lexer in block-mode
	or inline-mode by calling

		return string.block();
	or
		return string.inline();

	as desired.  This just wraps the string in an object with keys that indicate
	how it should be processed.  This is used in function-extensions.js
*/
const string_prototype_addition = `String.prototype.inline = function() {
    return {
      inline: this.toString()
    };
  };

  String.prototype.block = function() {
    return {
      block: this.toString()
    };
  };`;
runInThisContext(string_prototype_addition);

// This function takes a single extension, not in an array.
function registerExtension(extension_definition) {
	[marked, marked_copy].map(m => {
		m.use({ extensions: [ extension_definition ]});
	});
}

// This function takes multiple extensions, in an array.
function registerExtensions(extensions) {
	[marked, marked_copy].map(m => {
		m.use({ extensions: extensions });
	});
}

function createTOC(headings) {
	if (!headings.length) return '';

	let toc = "<div class='toc'><p id='toc'>Table of contents</p>";
	let current_level = 0;

	// The anchors have data-id set so that it's easy to overwrite
	// the content of the TOC, if the relevant section heading changes.
	// This happens, for example, if numeric headings are requested.
	for(const entry of headings) {
		if (entry['level'] == current_level) {
			toc += `</li>\n<li><a data-id='${entry['id']}' href='#${entry['id']}'>${entry['text']}</a>`;
		}
		else if (entry['level'] > current_level) {
			let diff = entry['level'] - current_level;
			toc += "<ul>".repeat(diff);
			toc += `<li><a data-id='${entry['id']}' href='#${entry['id']}'>${entry['text']}</a>`;
			current_level = entry['level'];
		}
		else {
			let diff = current_level - entry['level'];
			toc += "</li>\n" + "</ul>".repeat(diff) + "</li>";
			toc += `<li><a data-id='${entry['id']}' href='#${entry['id']}'>${entry['text']}</a>`;
			current_level = entry['level'];
		}
	}

	toc += "</li>\n</ul>\n</div>"
	return toc;
}

// Here, directives *must* be an array
function registerDirectives(directives) {
	marked.use(createDirectives(directives));
}

export { runInThisContext, marked, marked_copy, registerExtension, registerExtensions, registerDirectives, createTOC };
