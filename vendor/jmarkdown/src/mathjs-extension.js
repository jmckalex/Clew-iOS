import * as acorn from 'acorn';
import { runInThisContext } from './utils.js';
import { create, all } from 'mathjs';
export const math = create(all, {});
global.math = math;

export const mathjs = {
    name: 'mathjs',
    level: 'inline',
    start(src) {
        const match = src.match(/math.[a-zA-Z]+\(/);
        return match ? match.index : -1;
    },
    tokenizer(src, tokens) {
        // Match block LaTeX first (since it's more specific)
        const match = /^math\.[a-zA-Z]+\(/.exec(src);
        if (match) {
            const exp = acorn.parseExpressionAt(src, 0, { ecmaVersion: 2022 });
            //console.log(exp);
            const expression = src.slice(0, exp.end);
            //console.log(expression);
            const obj = runInThisContext(expression);
            const tex = math.parse(obj.toString()).toTex();
            //console.log(obj.toString());

            const token = {
                type: 'latex',
                raw: match[0],
                text: '',
                block: true
            };
        }

        return false;
    },
    renderer(token) {
        return '';
    }       
};