import * as acorn from 'acorn';
import { runInThisContext } from './utils.js';
import { noteCodeAllowed, refuseNoteCode, noteCodeError } from './note-code.js';

/*
    Two ways to run an anonymous function where it stands, putting whatever
    it returns into the output:

        function() { return … }       a block of its own, at the start of a line
        … func() { return … } …       inline, inside a paragraph (`func` is
                                      shorthand for `function`)

    Both words are also ordinary prose — `function(x) is our notation`, `the
    func(x) notation` — so the one thing these extensions must never do is
    assume that what follows the trigger is a function. They claim only a
    complete function WITH A BODY; anything else is declined and stays text.
*/

// The source of the function expression at the start of `code` —
// `function(…) { … }`, body and all — or null when there isn't one.
//
// It is the SHORTEST prefix ending in `}` that acorn accepts as a
// FunctionExpression. Parsing all of `code` instead lets whatever follows
// attach itself: `function() { … } (see above)` reads as a call, `… } + 1`
// as a sum. Only the body's own closing `}` can succeed: a `}` inside a
// string, template, regex or comment leaves that literal unterminated in the
// prefix, and an inner block's `}` leaves the body open.
function functionSource(code) {
    const body = code.indexOf('{');
    if (body === -1) return null;
    for (let end = code.indexOf('}', body); end !== -1; end = code.indexOf('}', end + 1)) {
        const candidate = code.slice(0, end + 1);
        try {
            const exp = acorn.parseExpressionAt(candidate, 0, { ecmaVersion: 2022 });
            return exp.type === 'FunctionExpression' ? candidate.slice(0, exp.end) : null;
        }
        catch (error) {
            // An error before the body opens can't be cured by reading
            // further: `function(x) is our notation` is prose, not a function
            // waiting for its `}`. So prose costs one parse, not one per `}`
            // in the rest of the document.
            if (error.pos < body) return null;
        }
    }
    return null;
}

// Run the function and build its token. What it returns is treated the way
// an exported function's or a script block's result is: a string or number
// goes in as it stands; `{ inline: md }` / `{ block: md }` is lexed as
// markdown; null or undefined leaves nothing. A function that throws leaves
// an error marker in its place, and the build carries on.
function runFunction(lexer, { type, raw, source, name, block }) {
    const token = { type, raw, text: '', tokens: [] };

    let output;
    try {
        output = runInThisContext('(' + source + ')()');
    }
    catch (error) {
        token.text = noteCodeError(name, error, { block });
        return token;
    }

    if (output === null || output === undefined) {
        return token;
    }
    if (typeof output === 'object' && 'block' in output) {
        token.text = String(output.block);
        token.tokenize = 'block';
        lexer.blockTokens(token.text, token.tokens);
    }
    else if (typeof output === 'object' && 'inline' in output) {
        token.text = String(output.inline);
        token.tokenize = 'inline';
        lexer.inline(token.text, token.tokens);
    }
    else {
        token.text = String(output);
    }
    return token;
}

function render(token) {
    if (token.tokenize === 'block') return this.parser.parse(token.tokens);
    if (token.tokenize === 'inline') return this.parser.parseInline(token.tokens);
    return token.text;
}

export const blockFunctions = {
    name: 'blockFunction',
    level: 'block',
    start(src) {
        // Block-level: only a line that itself starts with a complete
        // `function(…) { … }`. Reporting a line the tokenizer would then
        // decline cuts the paragraph there (see CLAUDE.md on block `start()`).
        const trigger = /^function\(/gm;
        for (let match; (match = trigger.exec(src)); ) {
            if (functionSource(src.slice(match.index)) !== null) return match.index;
        }
        return -1;
    },
    tokenizer(src) {
        if (!src.startsWith('function(')) return false;
        const source = functionSource(src);
        if (source === null) return false;

        // `Run note code: false` (note-code.js): claimed whole, never run.
        if (!noteCodeAllowed()) {
            return {
                type: 'blockFunction',
                raw: source,
                text: refuseNoteCode('function(…) block', { block: true }),
                tokens: []
            };
        }
        return runFunction(this.lexer, {
            type: 'blockFunction',
            raw: source,
            source,
            name: 'function(…) block',
            block: true
        });
    },
    renderer(token) {
        if (token.tokenize) return render.call(this, token);
        // A plain return value is a block of its own: end it the way a
        // paragraph ends, or in LaTeX the next paragraph runs straight on.
        return token.text + (global.isLatex ? '\n\n' : '\n');
    }
};

export const inlineFunctions = {
    name: 'inlineFunction',
    level: 'inline',
    start(src) {
        // Require a word boundary so `func(` does not fire mid-identifier
        // (e.g. inside `funcResult(`).
        const match = src.match(/\bfunc\(/);
        return match ? match.index : -1;
    },
    tokenizer(src) {
        if (!src.startsWith('func(')) return false;

        // Parse it as the `function` it stands for. As written, `func(x)` is
        // already a complete CALL, so acorn would stop at the `)` and never
        // see the body.
        const source = functionSource('function' + src.slice('func'.length));
        if (source === null) return false;
        const raw = 'func' + source.slice('function'.length);

        // `Run note code: false` (note-code.js): claimed whole, body and all,
        // never run.
        if (!noteCodeAllowed()) {
            return {
                type: 'inlineFunction',
                raw,
                text: refuseNoteCode('func(…)'),
                tokens: []
            };
        }
        return runFunction(this.lexer, {
            type: 'inlineFunction',
            raw,
            source,
            name: 'func(…)',
            block: false
        });
    },
    renderer: render
};
