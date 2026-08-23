import * as acorn from 'acorn';
import { runInThisContext } from './utils.js';

export const blockFunctions = {
    name: 'blockFunction',
    level: 'block',
    start(src) {
        // Block-level: only fire when a line itself starts with `function(`,
        // so a literal `function(` in prose does not trigger JS extraction.
        const match = src.match(/^function\(/m);
        return match ? match.index : -1;
    },
    tokenizer(src, tokens) {
        const match = /^function\(/.exec(src);
        if (match) {
            const exp = acorn.parseExpressionAt(src, 0, { ecmaVersion: 2022 });
            //console.log(exp);
            const expression = src.slice(0, exp.end);
            //console.log(expression);
            const output = runInThisContext("(" + expression + ")()");
            // const tex = math.parse(obj.toString()).toTex();
            // console.log(obj.toString());

            let token = {
                type: 'blockFunction',
                raw: expression,
                text: '',
                block: true,
                tokens: []
            };

            if (typeof output === "object" && output.hasOwnProperty('block')) {
                token.text = output['block'];
                this.lexer.blockTokens(token.text, token.tokens);
            }
            else {
                token.text = output;
            }
            return token;
        }

        return false;
    },
    renderer(token) {
        if (token.tokens.length > 0) {
            return this.parser.parse(token.tokens);
        }
        else {
            return token.text;
        }
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
    tokenizer(src, tokens) {
        const match = /^func\(/.exec(src);
        if (match) {
            const exp = acorn.parseExpressionAt(src, 0, { ecmaVersion: 2022 });
            //console.log(exp);
            const expression = src.slice(0, exp.end);
            //console.log(expression);
            const output = runInThisContext("(" + expression.replace(/^func/, 'function') + ")()");
            // const tex = math.parse(obj.toString()).toTex();
            // console.log(obj.toString());

            console.log("I'm going to print someting");
            console.log(output);

            const token = {
                type: 'inlineFunction',
                raw: expression,
                text: output,
                block: true
            };
            return token;
        }

        return false;
    },
    renderer(token) {
        return token.text;
    }       
};