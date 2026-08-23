import alea from 'seedrandom/lib/alea.js';
//import { createToken } from './tokenizer.js';
//import { directiveRenderer } from './renderer.js';
//import { getDirectivePattern, isVoidElements } from './utils.js';

const presetDirectiveConfigs = [
    { level: 'container', marker: ':::' },
    { level: 'block', marker: '::' },
    { level: 'inline', marker: ':' }
];

/**
 * A marked extension to support directives syntax
 */
function createDirectives(configs = presetDirectiveConfigs) {
    return {
        extensions: configs.map(({ level, marker, label, tag, renderer: customRenderer, tokenizer: customTokenizer }) => {
            const id = alea(marker).int32();
            const type = `directive${ucFirst(level)}${id}`;

            const defn = {
                name: type,
                level: level === 'inline' ? 'inline' : 'block',
                // Where might this directive begin? For block/container levels
                // the answer must be A LINE START: the tokenizer's pattern is
                // ^-anchored, so a marker in mid-line (e.g. `::Note` inside a
                // code span in prose) can never tokenize as a directive — but
                // reporting its index here made marked truncate the paragraph
                // at that spot, where OTHER tokenizers then mis-claimed the
                // remainder (the "`::X` in a code span shreds the paragraph"
                // bug). Inline directives genuinely can begin anywhere, and
                // inline code spans are claimed before text is cut, so the
                // unanchored match stays correct for them.
                start: level === 'inline'
                    ? (src) => src.match(new RegExp(`${marker}${label || ''}`))?.index
                    : (src) => {
                        const m = src.match(new RegExp(`(?:^|\\n)${marker}${label || ''}`));
                        return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : undefined;
                    },

                tokenizer: function(src) {
                    const pattern = getDirectivePattern(level, marker, label);
                    const match = src.match(new RegExp(pattern));

                    if (match) {
                        let [raw, content = ''] = match;

                        if (label != undefined) {
                            content = label + content;
                        }

                        return createToken.call(this, {
                            type,
                            level,
                            raw,
                            label,
                            content,
                            marker,
                            tag: tag || (level === 'inline' ? 'span' : 'div'),
                            customTokenizer
                        });
                    }
                },

                renderer: customRenderer || directiveRenderer
            };

            return defn;
        })
    };
}

// Convert the first character of a string to uppercase.
function ucFirst(str) {
    return str[0].toUpperCase() + str.slice(1).toLowerCase();
}

function getDirectivePattern(level, marker, label='') {
    switch (level) {
        case 'container':
            return `^${marker}${label}([\\s\\S]*?)\\n${marker}`;
        case 'block':
            return `^${marker}${label}((?:[a-zA-Z][\\w-]*|[\\{\\[].*?(?:\\n.*?)*[\\}\\]])+)`;
        case 'inline':
            return `^${marker}${label}((?:[a-zA-Z][\\w-]*|[\\{].*?(?:\\n.*?)*[\\}]+|[\\[].*?(?:\\n.*?)*[\\]])+)`;
    }
}
// Check if a given HTML tag is a void element.
function isVoidElement(str) {
    return ['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command', 
            'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 
            'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(str);
}



// Default renderer for directive tokens.
// @param {Object} token - The directive token to render.
// @returns {string} Rendered HTML string.
function directiveRenderer(token) {
    const { meta, attrs, tokens = [] } = token;
    const tagname = meta.name || meta.tag;
    
    let elem = `<${tagname}`;
    
    if (attrs) {
        elem += ' ' + attrs.toString();
    }
    
    if (isVoidElement(tagname)) {
        elem += ' />';
        return elem + (meta.level === 'inline' ? '' : '\n');
    }
    
    elem += '>';
    
    if (meta.level === 'container') {
        elem += '\n';
        elem += this.parser.parse(tokens);
    } 
    else if (meta.level === 'block') {
        elem += '\n';
        elem += this.parser.parse(tokens);
    }
    else {
        elem += this.parser.parseInline(tokens);
    }
    
    elem += `</${tagname}>`;
    elem += meta.level === 'inline' ? '' : '\n';
    
    return elem;
}

import attributesParser from 'attributes-parser';
import moo from 'moo';

// Lexer for parsing directive content
const lexer = moo.compile({
    spaces: /[\t\v\f\ufeff ]+/,
    name: /[a-zA-Z][\w-]*/,
    attrs: {
        match: /\{[\s\S]*?\}/,  // Changed to handle multiline
        value: x => {
            const cleaned = x.slice(1, -1).replace(/\s*\n\s*/g, ' ');
            return attributesParser(cleaned);
        }
    },
    text: {
        match: /\[[\s\S]*?\]/,  // Changed to handle multiline
        value: x => x.slice(1, -1)
    },
    blockText: { 
        match: /[\s\S]+/, 
        lineBreaks: true 
    }
});

/**
 * Create a directive token from a directive string.
 * @param {Object} config - Configuration object containing type, level, raw, content, marker, and tag
 * @returns {Object} The created token
 */
function createToken(config) {
    const { type, level, raw, content, marker, tag, customTokenizer, label } = config;

    const lex = lexer.reset(content);

    let name, attrs, text = '';
    let tokens = [];

    let tok = {};
    tok.tokens = [];
    tok['type'] = type;
    tok['raw'] = raw;

    for (const token of lex) {
        const { type: tokenType, value } = token;
        
        switch (tokenType) {
            case 'name':
                name = value;
                break;
            case 'attrs':
                attrs = value;
                tok['attrs'] = value;
                break;
            case 'text':
                if (level === 'container') {
                    tok['header text'] = value;
                    break;
                }
            case 'blockText':
                text = value;
                tok['text'] = value;
                if (level === 'container') {
                    if (customTokenizer == undefined) {
                        tok['tokens'] = this.lexer.blockTokens(value);
                    }
                    else {
                        customTokenizer.call(this, text, tok);
                    }
                }
                else if (level === 'block') {
                    if (customTokenizer == undefined) {
                        this.lexer.inline(value, tok['tokens']);
                    }
                    else {
                        customTokenizer.call(this, text, tok);
                    }
                }
                else {
                    if (customTokenizer == undefined) {
                        tok['tokens'] = this.lexer.inlineTokens(value);
                    }
                    else {
                        customTokenizer.call(this, text, tok);
                    }
                }
                break;
        }
    }

    tok['meta'] = { level, marker, tag, name };
    return tok;
}

export {
    createDirectives,
    presetDirectiveConfigs
    //isVoidElements
};