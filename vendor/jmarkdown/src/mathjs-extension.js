import * as acorn from 'acorn';
import { runInThisContext } from './utils.js';
import { noteCodeAllowed, refuseNoteCode } from './note-code.js';
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
            // `Run note code: false` (note-code.js): the expression is claimed
            // and refused rather than run (with the switch on it runs, and the
            // text is left in place — which is why the renderer below is only
            // ever reached by a refusal).
            if (!noteCodeAllowed()) {
                let expression;
                try {
                    const exp = acorn.parseExpressionAt(src, 0, { ecmaVersion: 2022 });
                    expression = src.slice(0, exp.end);
                }
                catch {
                    return false;
                }
                return { type: 'mathjs', raw: expression, text: refuseNoteCode(match[0].slice(0, -1)) };
            }
            // Prose can mention these too (`the math.sqrt(x) function`), and
            // any of the parse, the run or the TeX conversion may then throw.
            // Nothing is rendered either way, so a failure simply leaves the
            // text as it is — rather than failing the build.
            try {
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
            catch {
                return false;
            }
        }

        return false;
    },
    renderer(token) {
        return token.text ?? '';
    }       
};