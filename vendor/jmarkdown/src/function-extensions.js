/*
	This file contains all the support code needed for defining 'function extensions'
	in jmarkdown.  That is, when the jmarkdown file contains a <script> element which defines
	a javascript function which is then exported to jmarkdown so it can be called from
	inline text being parsed.
*/

import { runInThisContext, marked, registerExtension } from './utils.js';

export default function export_to_jmarkdown(name, options = {}) {
	const defaultOptions ={
		simple: true,
		tokenize: false,
		type: 'Function'
	};

	const mergedOptions = { ...defaultOptions, ...options};

	//const {simple = true, tokenize = false, type = 'function'} = options;

	if (mergedOptions['simple'] == true) {
		construct_simple_function_extension(name, mergedOptions);
		return;
	}
	else {
		construct_complex_function_extension(name, mergedOptions);
		return;
	}
}


/*
	Here, we simply assume that the function syntax in markdown is
	of the form:

		function_name(...markdown text not containing ')'...)

	This allows a lot of transformations to be typed pretty simply
	in the text.
*/
function construct_simple_function_extension(name, options) {
	const {tokenize = false} = options;
	let start_regexp = new RegExp(name + "\\(");
	let tokenizer_regexp = new RegExp("^" + name + "\\((.*?)\\)", 's');

	let extension_level = (tokenize != false)? tokenize : 'inline';

	const new_function = {
		name: `${name}`,
		level: extension_level,
		start(src) {
			return src.match(start_regexp)?.index; 
		},
		tokenizer(src) {
			const match = tokenizer_regexp.exec(src);
			if (match) {
				let script = `${name}("${match[1]}")`;
				script = script.replaceAll('\n', '\\n'); 
				let output = runInThisContext(script);

				let token;
				if (typeof output === "object" && output !== null) {
					token = {
						type: `${name}`,
						raw: match[0],
						success: true,
						tokens: []
					};
					if ('block' in output) {
						token.text = output.block;
						token.tokenize = 'block';
						this.lexer.blockTokens(token.text, token.tokens);
					}
					else {
						token.text = output.inline;
						token.tokenize = 'inline';
						this.lexer.inline(token.text, token.tokens);
					}
				}
				else {
					token = {
						type: `${name}`,
						raw: match[0],
						success: true,
						text: output,
						tokens: []
					};
				}
				
				return token;
			}
		},
		renderer(token) {
			if (token?.tokenize == "inline") {
				let html = this.parser.parseInline(token.tokens);
				return html;
			}
			else if (token?.tokenize == 'block') {
				let html = this.parser.parse(token.tokens);
				return html;
			}
			else {
				return token.text;
			}
		}
	};

	// marked.use({
	// 	extensions: [new_function]
	// });
	registerExtension(new_function);
}


import * as acorn from 'acorn';

class AcornParseError extends Error {
	constructor(error) {
		super(error.message);
		this.name = 'AcornParseError';
		this.pos = error.pos;
		this.raisedAt = error.raisedAt;
		this.error = error;

		// This captures the proper stack trace in modern engines
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}	
}

class VMEvaluationError extends Error {
	constructor(error) {
		super(error.message);
		this.name = 'VMEvaluationError';
		this.token = error.token;
		this.error = error;

		// This captures the proper stack trace in modern engines
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}	
}


function construct_complex_function_extension(name, options) {
	let delimiter;
	// There are two types, 'function' or 'object'. The default is 'function'.
	if (options['type'] == 'Function') {
		delimiter = "\\(";
	}
	else {
		delimiter = "(\\.|\\[)";
	}

	let start_regexp = new RegExp(name + delimiter);

	const new_function = {
		name: `${name}`,
		level: 'inline',
		start(src) {
			return src.match(start_regexp)?.index; 
		},
		tokenizer(src) {
			const regexp = new RegExp("^" + name + delimiter)
			if (src.match(regexp)) {
				try {
					let exp;
					try {
						exp = acorn.parseExpressionAt(src, 0, { ecmaVersion: 2022 });
					}
					catch (error) {
						throw new AcornParseError(error);
					}

					let token;
					if (exp.type == "CallExpression") {
						token = handleCallExpression(exp, src, name);
					}
					else if (exp.type == "SequenceExpression") {
						token = handleSequenceExpression(exp, src, name);
					}
					else if (exp.type == "MemberExpression") {
						token = handleMemberExpression(exp, src, name);
					}
					else {
						console.log(exp);
					}

					if (token?.tokenize == 'block') {
						this.lexer.blockTokens(token.text, token.tokens);
					}
					else if (token?.tokenize == 'inline') {
						this.lexer.inline(token.text, token.tokens);
					}
					return token;
				}
				catch (error) {
					if (error instanceof AcornParseError) {
						const last_attempt = handlePossibleIrrelevantEndCharacter(error, src, name);
						if (last_attempt !== false) {
							// It finally worked, and last_attempt is a valid token, so return it
							if (last_attempt?.tokenize == 'block') {
								this.lexer.blockTokens(last_attempt.text, last_attempt.tokens);
							}
							else if (last_attempt?.tokenize == 'inline') {
								this.lexer.inline(last_attempt.text, last_attempt.tokens);
							}
							return last_attempt;
						}

						// If the last attempt failed, then we need to return an error message.
						const token = {
							type: `${name}`,
							raw: src.slice(0, error.raisedAt),
							success: false,
							errorType: 'AcornParseError',
							error: error.message,
							pos: error.pos,
							raisedAt: error.raisedAt
						};
						return token;
					}
					else if (error instanceof VMEvaluationError) {
						return error.token;
					}
				}
			}
		},
		renderer(token) {
			if (token.success) {
				if (token?.tokenize == 'block') {
					return this.parser.parse(token.tokens);
				}
				else if (token?.tokenize == 'inline') {
					return this.parser.parseInline(token.tokens);
				}
				return token.text;	
			}
			else {
				if (token.errorType == 'AcornParseError') {
					let error = "<span class='jmarkdown-error-string'>" + token.raw.slice(0, token.pos);
					error += "<span class='jmarkdown-error-bad'>" + token.raw.slice(token.pos, token.raisedAt) + "</span></span>";
					return `<span class='jmarkdown-inline-error'>Parse error</span><span class='jmarkdown-error'>${token.error}: ${error}</span>`;
				}
				else {
					let error = "<span class='jmarkdown-inline-error'>Evaluation error</span>";
					error += `<span class='jmarkdown-error'>${token.error}. </span>`;
					error += "<span class='jmarkdown-error-string'>" + token.raw + "</span>";
					return error + createErrorPopupButton(token.error);
				}
			}
		}
	};

	registerExtension(new_function);
}


function handleCallExpression(exp, src, name) {
	// Since we have a valid JavaScript function call, pass it
	// to runInThisContext and collect the output for insertion
	const start = exp.start;
	const end = exp.end;
	const func = src.slice(start, end);
	let output;
	try {
		output = runInThisContext(func);
	}
	catch (error) {
		const token = {
			type: `${name}`,
			raw: func,
			success: false,
			error: error
		}
		error.token = token;
		throw new VMEvaluationError(error);
	}

	let token;
	if (typeof output === "object" && output !== null) {
		token = {
			type: `${name}`,
			raw: func,
			success: true,
			tokens: []
		};
		if ('block' in output) {
			token.text = output.block;
			token.tokenize = 'block';
		}
		else {
			token.text = output.inline;
			token.tokenize = 'inline';
		}
	}
	else {
		token = {
			type: `${name}`,
			raw: func,
			success: true,
			text: output,
			tokens: []
		};
	}
	
	return token;
}


// Here we assume that a sequence expression results from a
// comma - which is supposed to be punctuation - following an otherwise
// valid CallExpression or MemberExpression.  So we have to
// identify the trailing comma which is the issue and find the appropriate
// subexpression.
function handleSequenceExpression(exp, src, name) {
	const start = exp.start;
	const end = exp.end;
	const sequence = src.slice(start, end);
	// But we don't want the sequence, just the part up to the last comma.
	const last_comma_index = sequence.lastIndexOf(',');
	const code_to_check = sequence.substring(0, last_comma_index);

	let exp2;
	try {
		exp2 = acorn.parseExpressionAt(code_to_check, 0, { ecmaVersion: 2022 });
	}
	catch(error) {
		throw new AcornParseError(error);
	}

	// If we get here we found a valid subexpression
	let output;
	let code_to_run;
	if (exp2.type == "CallExpression" || exp2.type == "MemberExpression") {
		code_to_run = code_to_check.slice(exp2.start, exp2.end);
		try {
			output = runInThisContext(code_to_run);
		}
		catch(error) {
			const token = {
						type: `${name}`,
						raw: code_to_run,
						success: false,
						error: error
					};
			error.token = token;
			throw new VMEvaluationError(error)
		}
	}

	const token = {
		type: `${name}`,
		raw: code_to_run,
		success: true,
		text: output,
		tokens: []
	};
	return token;
}


// This can get called erroneously if we have something like this:
// 
//		end of a sentence with Math.pow(3,4).  Start of next sentence
//
// This will trigger with the member expression being "Math.pow(3,4).  Start"
// so we have to clean it up in this case.
function handleMemberExpression(exp, src, name) {
	const start = exp.start;
	const end = exp.end;
	const member_expression = src.slice(start, end);
	const last_dot_index = member_expression.lastIndexOf('.');

	let code_to_check;
	if (last_dot_index !== -1) {
		if (last_dot_index < member_expression.length - 1) {
			const charAfterDot = member_expression.charAt(last_dot_index + 1);
			if (/\s/.test(charAfterDot)) {
				code_to_check = src.slice(start, last_dot_index);
			}
			else {
				code_to_check= member_expression;
			}
		}
	}
	else {
		code_to_check = member_expression;
	}

	let exp2;
	try {
		exp2 = acorn.parseExpressionAt(code_to_check, 0, { ecmaVersion: 2022 });
	}
	catch(error) {
		throw new AcornParseError(error);
	}

	// If we get here we found a valid subexpression
	let output;
	let code_to_run;
	if (exp2.type == "CallExpression" || exp2.type == "MemberExpression") {
		code_to_run = code_to_check.slice(exp2.start, exp2.end);
		try {
			output = runInThisContext(code_to_run);
		}
		catch(error) {
			const token = {
						type: `${name}`,
						raw: code_to_run,
						success: false,
						error: error
					};
			error.token = token;
			throw new VMEvaluationError(error)
		}
	}

	let token;
	if (typeof output === "object" && output !== null) {
		token = {
			type: `${name}`,
			raw: code_to_run,
			success: true,
			tokens: []
		};
		if ('block' in output) {
			token.text = output.block;
			token.tokenize = 'block';
		}
		else {
			token.text = output.inline;
			token.tokenize = 'inline';
		}
	}
	else {
		token = {
			type: `${name}`,
			raw: code_to_run,
			success: true,
			text: output,
			tokens: []
		};
	}
	
	return token;
}

// When acorn.js is parsing inline JavaScript, sometimes an error is generated when
// a valid expression is followed by an irrelevant character which should be ignored because
// it is part of the surrounding text.  For example, both of the following can generate
// errors:
//
//		"Object.function()"		<-- will often generate error because the second " is parsed as opening an unclosed string
//		function().				<-- will generate an error if the . (a punction mark) is followed by the end of paragraph
//
// (Note that the last case above, where the . is followed by one or more spaces and a word is handled
// in the handleMemberExpression() function.)
//
// In all these cases, the solution is to find the character which generates the error, extract the substring up to
// but not including that character, and then checking to see if that is a valid JavaScript expression.
function handlePossibleIrrelevantEndCharacter(error, src, name) {
	const substring = src.slice(0, error.raisedAt).trimRight();
	// Now handle three cases based on the message...
	let substring_to_check = '';
	if (error.message.startsWith("Unexpected token")) {
		// This is typically triggered by the inline JavaScript occuring right before a final . indicating
		// a sentence end - so try removing that.
		const i = substring.lastIndexOf('.');
		substring_to_check = substring.slice(0, i);
	}
	else if (error.message.startsWith("Unexpected character")) {
		// In this case, the raisedAt index correctly indicates the end of the possible valid
		// expression, so the string to check is just the original substring extracted
		substring_to_check = substring;

	}
	else if (error.message.startsWith("Unterminated string constant")) {
		const match = error.message.match(/\(\d+:(\d+)\)/);
		substring_to_check = substring.slice(0, match[1]);
	}
	else {
		// We've exhausted all the possible cases I can think of...
		return false;
	}

	let exp;
	let code_to_run;
	try {
		exp = acorn.parseExpressionAt(substring_to_check, 0, { ecmaVersion: 2022 });
		code_to_run = substring_to_check.slice(exp.start, exp.end);
	}
	catch (error) {
		return false
	}

	// If we get here we have found a valid subexpression
	let output = '';
	try {
		output = runInThisContext(code_to_run);
	}
	catch(error) {
		const token = {
					type: `${name}`,
					raw: code_to_run,
					success: false,
					error: error
				};
		error.token = token;
		throw new VMEvaluationError(error)
	}

	let token;
	if (typeof output === "object" && output !== null) {
		token = {
			type: `${name}`,
			raw: code_to_run,
			success: true,
			tokens: []
		};
		if ('block' in output) {
			token.text = output.block;
			token.tokenize = 'block';
		}
		else {
			token.text = output.inline;
			token.tokenize = 'inline';
		}
	}
	else {
		token = {
			type: `${name}`,
			raw: code_to_run,
			success: true,
			text: output,
			tokens: []
		};
	}

	return token;
}



function createErrorPopupButton(error) {
  // Get the full error stack
  const errorStack = error.stack || error.toString();
  // Escape HTML characters to prevent XSS
  const escapedErrorStack = errorStack
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    // Convert line breaks to <br> tags
    .replace(/\n/g, '<br>')
    // Add extra styling to file paths
    .replace(/(file:\/\/[^)]+)/g, '<span style="color:#0066cc;">$1</span>')
    // Highlight error type
    .replace(/^([A-Za-z]+Error:)/g, '<strong style="color:#d32f2f;">$1</strong>');

  // Generate a unique ID for this error popup
  const popupId = 'error-popup-' + Math.random().toString(36).substr(2, 9);

  // Create the HTML for the button and a separate popup script
  const html = `
    <span class="error-popup-container" style="display: inline-block;">
      <button class="error-popup-button" onclick="showErrorPopup('${popupId}')">
        Show Error Details
      </button>
    </span>

    <script>
      // Create the popup function
      function showErrorPopup(popupId) {
        // Create the modal popup dynamically
        const modal = document.createElement('div');
        modal.id = popupId;
        modal.className = 'error-popup';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
        modal.style.zIndex = '1000';
        modal.style.display = 'flex';
        modal.style.justifyContent = 'center';
        modal.style.alignItems = 'center';
        
        // Create the content container
        const content = document.createElement('div');
        content.className = 'error-popup-content';
        content.style.backgroundColor = 'white';
        content.style.width = '80%';
        content.style.maxWidth = '800px';
        content.style.maxHeight = '80%';
        content.style.borderRadius = '6px';
        content.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.overflow = 'hidden';
        
        // Create the header
        const header = document.createElement('div');
        header.className = 'error-popup-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '12px 16px';
        header.style.backgroundColor = '#f5f5f5';
        header.style.borderBottom = '1px solid #ddd';
        
        // Add the title
        const title = document.createElement('h3');
        title.style.margin = '0';
        title.style.color = '#333';
        title.textContent = 'Error Stack Trace';
        
        // Add the close button
        const closeBtn = document.createElement('span');
        closeBtn.style.fontSize = '24px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.color = '#666';
        closeBtn.textContent = '×';
        closeBtn.onclick = function() {
          document.body.removeChild(modal);
          document.body.style.overflow = '';
        };
        
        // Add the body with error stack
        const body = document.createElement('div');
        body.className = 'error-popup-body';
        body.style.padding = '16px';
        body.style.overflowY = 'auto';
        body.style.flexGrow = '1';
        
        // Add the pre element with stack trace
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.style.fontFamily = 'Consolas, Monaco, Courier New, monospace';
        pre.style.fontSize = '14px';
        pre.style.lineHeight = '1.5';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.color = '#333';
        pre.style.textAlign = 'left';
        pre.innerHTML = \`${escapedErrorStack}\`;
        
        // Assemble the modal
        header.appendChild(title);
        header.appendChild(closeBtn);
        body.appendChild(pre);
        content.appendChild(header);
        content.appendChild(body);
        modal.appendChild(content);
        
        // Add the modal to the document and prevent background scrolling
        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';
        
        // Add click event to close when clicking outside
        modal.addEventListener('click', function(event) {
          if (event.target === modal) {
            document.body.removeChild(modal);
            document.body.style.overflow = '';
          }
        });
      }
    </script>
    
    <style>
      .error-popup-container {
        display: inline-block;
      }
      
      .error-popup-button {
        background-color: #f44336;
        color: white;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      
      .error-popup-button:hover {
        background-color: #d32f2f;
      }
    </style>
  `;
  
  return html;
}

import { create, all } from 'mathjs';
import * as test from 'mathjs';
const MathJS = create(all, {});
global.MathJS = MathJS;
String.prototype.surround = function(prefix, suffix = false) {
	if (suffix == false) {
		suffix = prefix;
	}
	return prefix + this + suffix;
}

function calc(expr) {
	return MathJS.evaluate(expr);
}
global.calc = calc;

import * as Algebra from 'algebra.js';
global.Algebra = Algebra;

export_to_jmarkdown("Math", {simple: false, type: "Object"});
export_to_jmarkdown("Date", {simple: false, type: "Object"});
export_to_jmarkdown("String", {simple: false});
export_to_jmarkdown("MathJS", {simple: false, type: "Object"});
export_to_jmarkdown("Algebra", {simple: false, type: "Object"});
export_to_jmarkdown("calc", {simple: false, type: "Function"});
