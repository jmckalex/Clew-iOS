/*
	This defines an extension for handling description lists with the following syntax:

	Definition tag:: Possible first line of the definition.
		An indent level greater than the start of the
		tag indicates the <dd> content.

		Multiple paragraphs can be included as well.

	Another definition:: 
		The first line of the <dd> need not be on the same
		line as the <dt> content.
	
	Some $\alpha$ math::
		And the <dt> tag can contain any inline markdown, too.

	And block text of the same indent level as the description list,
	but with no double-colon on the first line, indicates the end of the
	description list.
*/
import { marked } from './utils.js';

const descriptionList = {
	name: 'descriptionList',
	level: 'block',                                     // Is this a block-level or inline-level tokenizer?
	start(src) {
		// Fast pre-check: bail out if '::' doesn't appear at all. Avoids the
		// catastrophic backtracking the old unanchored regex was prone to on
		// large documents with no description lists.
		if (src.indexOf('::') < 0) return undefined;
		// Only report a line the tokenizer could actually match: a non-empty
		// term, then '::', then whitespace or end-of-line (dt_rule's shape).
		// Reporting the line of ANY '::' — e.g. `::Note` inside a code span —
		// made marked shred the enclosing paragraph one character at a time
		// and hand the remainder to tokenizers that mis-claimed it.
		const m = /^[ \t]*(?:[^:\n]|:(?!:))+?::(?=\s|$)/m.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src, tokens) {
		const dt_rule = /^([ \t]*(?:[^:\n]|(?<!:):(?!:))+?)::(\s+(?:.*)|$)/;
		//const dt_rule = /^([ \t]*[^:\n]+?)::(\s+(?:.*)|$)/;
		const first_match = dt_rule.exec(src);
		if (first_match != null) { // Found the start of a description list.
			let output = find_description_list(src);
			const token = {                                 // Token to generate
				type: 'descriptionList',                      // Should match "name" above
				raw: output['raw'],                                // Text to consume from the source
				text: "",                        // Additional custom properties
				pairs: [],
				tokens: [],                                    // Array where child inline tokens will be generated
				childTokens: []
			};

			for (let pair of output['pairs']) {
				let tok = {};
				tok['dt'] = [];
				this.lexer.inline(pair['dt'], tok['dt']);
				//this.lexer.inline(pair['dt'], token.tokens);
				tok['dd'] = [];
				this.lexer.blockTokens(pair['dd'], tok['dd']);
				//this.lexer.blockTokens(pair['dd'], token.tokens);
				token.tokens.push(...tok['dt'], ...tok['dd']);
				token.pairs.push(tok);
			}

			return token;
		}
		else {
			return false;
		}
	},
	renderer(token) {
		if (global.isLatex) {
			// LaTeX's description environment: \item[term] definition.
			let tex = '\\begin{description}\n';
			for (let t of token.pairs) {
				const dt = this.parser.parseInline(t['dt']);
				const dd = marked.parser(t['dd']).trim();
				tex += `\\item[${dt}] ${dd}\n`;
			}
			tex += '\\end{description}\n\n';
			return tex;
		}
		let html = '<dl>';
		for (let t of token.pairs ) {
			let dt_html = this.parser.parseInline(t['dt']);
			let dd_html = marked.parser(t['dd']);
			html += `<dt>${dt_html}</dt><dd>${dd_html}</dd>`;
		}
		html += '</dl>';
		return html;
	}
};

export default descriptionList;

function get_indent_level(str) {
	return str.length - str.trimLeft().length;
}


// This is called at the start of a description list.
function find_description_list(src) {
    const dt_rule = /^([ \t]*(?:[^:\n]|(?<!:):(?!:))+?)::(\s+(?:.*)|$)/;
    //const dt_rule = /^([ \t]*[^:\n]+?)::(\s+(?:.*)|$)/;
    let lines = src.split('\n');
    let pairs = [];
    let raw = [];
    let base_indent = lines[0].length - lines[0].trimLeft().length;
    let dt_dd = null;

    let PARSE_FIRST_LINE = 1;
    let GOBBLE_LINE = 2;
    let ABORT = 3;
    let STATE = -1;

    for (let current_line of lines) {

        if (current_line.match(dt_rule) && get_indent_level(current_line) == base_indent) {
            // Start of another DT+DD pair
            STATE = PARSE_FIRST_LINE;
        }
        else if (current_line.match(dt_rule) && get_indent_level(current_line) > base_indent) {
            // In this case, we have a DL contained within the DD of the current DL
            STATE = GOBBLE_LINE;
        }
        else if (current_line.match(dt_rule) && get_indent_level(current_line) < base_indent) {
            // In this case, another DL follows the end of a nested DL.  Need to stop
            // and make sure this line is NOT included in raw so that the parser can start here.
            STATE = ABORT;
        }
        else if (current_line.match(dt_rule) == null && get_indent_level(current_line) > base_indent) {
            // Normal case of grabbing content for the current DD element.
            STATE = GOBBLE_LINE;
        }
        else if (current_line.trim() == '') {
            STATE = GOBBLE_LINE;
        }
        else if (current_line.match(dt_rule) == null && get_indent_level(current_line) <= base_indent) {
            // DL ends here. Stop parsing and make sure that this line is NOT included in raw so that the
            // parser can state here.
            STATE = ABORT;
        }


        switch(STATE) {
        case PARSE_FIRST_LINE:
            let match = current_line.match(dt_rule);
            dt_dd = {};
            dt_dd['dt'] = match[1];
            dt_dd['dd'] = match[2] + '\n';
            pairs.push(dt_dd);
            raw.push( current_line );
            break;

        case GOBBLE_LINE:
            dt_dd['dd'] += current_line.slice(base_indent) + '\n';
            raw.push( current_line );
            break;

        case ABORT:
            return {
                'raw': raw.join("\n"),
                'pairs': pairs
            };

        default:
            throw new Error("This shouldn't happen!");
        }
    }

    // If we got here, the file ended with the last dd element.
    return {
        'raw': raw.join('\n'),
        'pairs': pairs
    };
}






