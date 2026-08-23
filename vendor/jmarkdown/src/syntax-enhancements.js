// These are syntax enhancements for jMarkdown.  That is, they don't
// modify the standard markdown syntax but they provide additional functionality.

import descriptionLists from './description-lists.js';
import { marked } from './utils.js';

export { descriptionLists };

// Scan the text for LaTeX code between the standard MathJax delimiters,
// and make sure the raw text is passed straight through to the output HTML.  The one exception
// is that '<' and '>' symbols need to be transformed to '&lt;' or '&gt;' as they
// can cause errors when the HTML is interpreted.
export const latex = {
    name: 'latex',
    level: 'inline',
    priority: 1,
    start(src) {
        const match = src.match(/\$\$|\$|\\\(|\\\[/);
        return match ? match.index : -1;
    },
    tokenizer(src, tokens) {
        // Match block LaTeX first (since it's more specific)
        const blockMatch = /^\$\$([^$]*?)\$\$|^\\\[(.*?)\\\]/s.exec(src);
        if (blockMatch && blockMatch.index === 0) {
            let math = blockMatch[1] ? blockMatch[1] : blockMatch[2];
            return {
                type: 'latex',
                raw: blockMatch[0],
                text: math,
                block: true
            };
        }

        // Match inline LaTeX
        const inlineMatch = /\$([^\$]+?)\$|\\\((.*)\\\)/.exec(src);
        if (inlineMatch && inlineMatch.index === 0) {
            let math = inlineMatch[1] ? inlineMatch[1] : inlineMatch[2];
            return {
                type: 'latex',
                raw: inlineMatch[0],
                text: math,
                block: false
            };
        }

        return false;
    },
    renderer(token) {
        let sanitised_text = token.text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        return token.block ? `$$${sanitised_text}$$` : `$${sanitised_text}$`;
    }
};

// Block-level math protector. The `latex` extension above is INLINE, so the
// markdown BLOCK tokenizers (lists, headings, blockquotes, …) run first — and a
// display-math block whose lines start with `+ `/`- `/`* ` (operators in an
// aligned equation) gets sliced into <ul>/<li> before any math handler sees it.
// This extension claims a whole display-math block — `$$…$$`, `\[…\]`, or a
// `\begin{env}…\end{env}` environment — as ONE token at the block level, so its
// content is protected verbatim and even a bare `\begin{align}` works without a
// `$$` wrapper. Register it AFTER the list extensions (marked tries the
// last-registered first) so it wins. Inline `$…$` / `\(…\)` stay with `latex`.
export const mathBlock = {
    name: 'mathBlock',
    level: 'block',
    start(src) {
        const m = src.match(/(?:^|\n)[ ]{0,3}(?:\$\$|\\\[|\\begin\{[A-Za-z*]+\})/);
        return m ? m.index : undefined;
    },
    tokenizer(src) {
        let m = /^[ ]{0,3}\$\$([\s\S]+?)\$\$/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1], math: 'dollar' };
        m = /^[ ]{0,3}\\\[([\s\S]+?)\\\]/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1], math: 'bracket' };
        // \begin{env} … \end{env}  (matched env name via the \2 backreference, so
        // nested environments like pmatrix inside align don't end it early).
        m = /^[ ]{0,3}(\\begin\{([A-Za-z*]+)\}[\s\S]*?\\end\{\2\})/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1], math: 'env' };
        return undefined;
    },
    renderer(token) {
        const text = token.text;
        if (global.isLatex) {
            // Pass straight through into the .tex (delimiters preserved; the
            // engine handles them — align needs amsmath in the user's preamble).
            if (token.math === 'dollar') return `$$${text}$$\n\n`;
            if (token.math === 'bracket') return `\\[${text}\\]\n\n`;
            return `${text}\n\n`;
        }
        // HTML: emit raw for MathJax, escaping only < and > (as the inline `latex`
        // renderer does). Bare \begin{env} relies on MathJax processEnvironments
        // (on by default; tex-svg bundles ams).
        const sane = String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        if (token.math === 'dollar') return `<p>$$${sane}$$</p>\n`;
        if (token.math === 'bracket') return `<p>\\[${sane}\\]</p>\n`;
        return `<p>${sane}</p>\n`;
    }
};

import { metadata } from './metadata-header.js';

// Look for text of the form {{variable_name}} which will be defined either in a file
// or in the metadata header, for inclusion in the output HTML
export const moustache = {
    name: 'moustache',
    level: 'inline',
    start(src) { return src.match(/{{/)?.index },
    tokenizer(src) {
        const rule = /^{{([^}]+)}}/;
        const match = rule.exec(src);
        if (match) {
            const token = {
                type: 'moustache',
                raw: match[0],
                text: match[1],
                tokens: []
            };
            return token;
        }
    },
    renderer(token) {
        if (token.text in metadata) {
            let contents = metadata[token.text];
            return Array.isArray(contents) ? contents.join('') : String(contents);
        }
        else {
            return `{{${token.text}}}`;
        }
    }
};

// Emojis!
// This code is mostly taken from the marked-emojis package, but I've tweaked it to provide
// support for FontAwesome as well.

import emoji_data from './emoji-data.json' with { type: 'json'};

const emojiNames = Object.keys(emoji_data).map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + "|fa-[^:]+";
const emojiRegex = new RegExp(`:(${emojiNames}):`);
const tokenizerRule = new RegExp(`^${emojiRegex.source}`);

function emoji_renderer(token) {
    let token_text = token.text;

    if (token_text.includes('fa-')) {
        let classes = token_text.split(" ").map(text => (text.includes("fa-")) ? text : "fa-" + text ).join(" ");
        return `<i class='fa-solid ${classes}'></i>`;
    }
    else {
        let url = emoji_data[token_text];
        return `<img alt="${token.name}" src="${url}" class="marked-emoji-img">`;
    }
}

/*
    Provide support for inserting octocat or fontawesome emojis via the syntax :beer: or :fa-thumbs-up:
*/
export const emojis = {
    name: 'emoji',
    level: 'inline',
    start(src) { return src.match(emojiRegex)?.index; },
    tokenizer(src) {
        //const rule = /^:([^:]+):/;
        const match = tokenizerRule.exec(src);
        if (match) {
            const token = {
                type: 'emoji',
                raw: match[0],
                text: match[1],
                tokens: []
            };
            return token;
        }
    },
    renderer(token) {
        return emoji_renderer(token);
    }
};

/*
    Provide support for right-aligned text with syntax as follows:

    >> I'm right-aligned
    >> text!
*/
export const rightAlign = {
    name: 'rightAlign',
    level: 'block',
    start(src) {
        return src.match(/^>>/)?.index;
    },
    tokenizer(src) {
        const rule = /^(>> ?.*(?!<<\s*\n)(?:\n|$))+/;
        const match = rule.exec(src);
        if (match) {
            const raw = match[0];
            // Remove the >> markers
            const text = raw.split('\n')
                .map(line => line.replace(/^>> ?/, ''))
                .join('\n');

            let token = {
                type: 'rightAlign',
                raw: raw,
                text: text,
                tokens: []
            };

            this.lexer.blockTokens(text, token.tokens);
            return token;
        }
        return false;
    },
    renderer(token) {
        return `<div class='jmarkdown-right'>${marked.parser(token.tokens)}</div>`;
    }
};


/*
    Provide support for center-aligned text with syntax as follows:

    >> I'm center-aligned <<
    >> text!              <<
*/
export const centerAlign = {
    name: 'centerAlign',
    level: 'block',
    start(src) {
        return src.match(/^>> .* <</)?.index;
    },
    tokenizer(src) {
        const rule = /^(>> .*<<\s*(?:\n|$))+/;
        const match = rule.exec(src);
        if (match) {
            const raw = match[0];
            // Remove the >> markers and trim each line
            const text = raw.split('\n')
                .map(line => line.replace(/^>> ?/, ''))
                .map(line => line.replace(/<<\s*(?:\n|$)/, ''))
                //.filter(line => line.length > 0)
                .join('\n');

            let token = {
                type: 'centerAlign',
                raw: raw,
                text: text,
                tokens: []
            };
            this.lexer.blockTokens(text, token.tokens);
            return token;
        }
        return false;
    },
    renderer(token) {
        return `<div class='jmarkdown-center'>${marked.parser(token.tokens)}</div>`;
    }
};


/*
    This extension detects syntax of the following form:

    {.class1 .class2 #id }

    which specifies classes or an id to add to the parent element
    containing the text where that syntax occurs.  This is not handled by jmarkdown directly.
    Instead, jmarkdown creates an empty span element with the classes and id contained
    in data- attributes.  Cheerio is used once the provisional HTML output has been
    generated to iterate over all such classes and attach the classes and id to the
    parent element, and then removing the span.
*/
export const classAndId = {
    name: 'classAndId',
    level: 'inline',
    start(src) {
        return src.match(/\{[.#]/)?.index;
    },
    tokenizer(src) {
        const rule = /^\{([.#][^}]+)\}/;  // Matches {.class} or {#id}
        const match = rule.exec(src);
        if (match) {
            return {
                type: 'classAndId',
                raw: match[0],
                selector: match[1],
                tokens: []
            };
        }
    },
    renderer(token) {
        // In LaTeX mode, emit nothing. There's no generic HTML-class-to-LaTeX
        // mapping that makes sense, so any LaTeX-specific content (e.g. a
        // \noindent that corresponds to a {.noindent} class in the HTML path)
        // should be supplied explicitly via the :tex[...] inline directive.
        if (global.isLatex) return '';

        // Create an empty span with data attributes
        const attributes = [];
        const selectors = token.selector.split(/(?=[.#])/);

        const classes = [];
        let id = null;

        selectors.forEach(selector => {
            if (selector.startsWith('.')) {
                classes.push(selector.slice(1));
            } 
            else if (selector.startsWith('#')) {
                id = selector.slice(1);
            }
        });

        return `<span data-add-classes="${classes.join(' ')}" data-add-id="${id || ''}" class="marker-to-remove"></span>`;
    }
};

