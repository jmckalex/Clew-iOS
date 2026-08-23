/**
 * marked-extended-tables-headerless.js
 *
 * Extended Markdown table extension for marked.js with headerless table
 * support. Based on marked-extended-tables v2.0.1 by calculuschild (MIT),
 * with substantial additions for headerless table parsing.
 *
 * Features:
 *   - Column spanning       (trailing pipes: | cell ||)
 *   - Row spanning          (caret before pipe: | cell ^|)
 *   - Multi-row headers
 *   - Column widths         (|---30%---|)
 *   - Headerless tables     (two forms — see below)
 *
 * Three table syntaxes are supported:
 *
 *   1. Standard GFM (header + separator + body):
 *        | H1  | H2  |
 *        |-----|-----|
 *        | A   | B   |
 *
 *   2. Separator-first headerless (alignment & widths, no header):
 *        |:---|:---:|---:|
 *        | L  | C   | R  |
 *
 *   3. Pure pipe-delimited headerless (no separator at all):
 *        | Apples  | 12 |
 *        | Bananas | 8  |
 *
 * All three syntaxes support colspan, rowspan, and inline Markdown in cells.
 * Only forms 1 and 2 support alignment and column widths (via the separator).
 *
 * Usage:
 *
 *   // ESM
 *   import { markedExtendedTablesHeaderless } from './marked-extended-tables-headerless.js';
 *   marked.use(markedExtendedTablesHeaderless());
 *
 *   // Script tag
 *   <script src="marked-extended-tables-headerless.js"></script>
 *   <script>marked.use(markedExtendedTablesHeaderless());</script>
 *
 * Options:
 *   - interruptPatterns {string[]} — additional regex patterns that interrupt
 *     table body parsing (default: [])
 *   - skipEmptyRows {boolean} — skip rows where all cells merge into the row
 *     above via rowspan (default: true)
 *
 * LICENCE: MIT
 */

import { requirePackage } from './preamble.js';

// A table with more body rows than this is emitted as a `longtable` (which breaks
// across pages) instead of a fixed-height `tabular`. longtable accepts the same
// column spec, so the switch is silent — no author syntax, and harmless for
// shorter tables. Tuned to roughly "taller than one page".
const LONGTABLE_ROW_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

function markedExtendedTablesHeaderless({ interruptPatterns = [], skipEmptyRows = true } = {}) {

  /* ── helpers ─────────────────────────────────────────────────────── */

  const getTableCell = (text, cell, type, align, width) => {
    if (!cell.rowspan) return '';
    var styles = '';
    if (align) styles += 'text-align:' + align + ';';
    if (width) styles += 'width:' + width + ';';
    const tag = '<' + type
      + (cell.colspan > 1 ? ' colspan="' + cell.colspan + '"' : '')
      + (cell.rowspan > 1 ? ' rowspan="' + cell.rowspan + '"' : '')
      + (styles ? ' style="' + styles + '"' : '')
      + '>';
    return tag + text + '</' + type + '>\n';
  };

  const splitCells = (tableRow, count, prevRow, skipEmpty) => {
    prevRow = prevRow || [];
    const cells = [];
    const matches = tableRow.trim().matchAll(/(?:[^|\\]|\\.?)+(?:\|+|$)/g);
    for (const m of matches) cells.push(m[0]);

    if (!cells[0] || !cells[0].trim()) cells.shift();
    if (cells.length && (!cells[cells.length - 1] || !cells[cells.length - 1].trim())) cells.pop();

    var numCols = 0;
    var i, j, trimmedCell, prevCell, prevCols;

    for (i = 0; i < cells.length; i++) {
      trimmedCell = cells[i].split(/\|+$/)[0];
      cells[i] = {
        rowspan: 1,
        colspan: Math.max(cells[i].length - trimmedCell.length, 1),
        text: trimmedCell.trim().replace(/\\\|/g, '|')
      };

      // Rowspan (^)
      if (trimmedCell.slice(-1) === '^' && prevRow.length) {
        prevCols = 0;
        for (j = 0; j < prevRow.length; j++) {
          prevCell = prevRow[j];
          if ((prevCols === numCols) && (prevCell.colspan === cells[i].colspan)) {
            cells[i].rowSpanTarget = prevCell.rowSpanTarget || prevCell;
            cells[i].rowSpanTarget.text += ' ' + cells[i].text.slice(0, -1);
            cells[i].rowSpanTarget.rowspan += 1;
            cells[i].rowspan = 0;
            break;
          }
          prevCols += prevCell.colspan;
          if (prevCols > numCols) break;
        }
      }

      numCols += cells[i].colspan;
    }

    // Empty-row detection for skipEmptyRows
    if (cells.length > 0 && skipEmpty) {
      var allMerged = true;
      for (i = 0; i < cells.length; i++) {
        if (cells[i].rowspan !== 0) { allMerged = false; break; }
      }
      if (allMerged) {
        cells[0].emptyRow = true;
        for (i = 0; i < cells.length; i++) {
          if (cells[i].rowSpanTarget) cells[i].rowSpanTarget.rowspan -= 1;
        }
      }
    }

    // Force column count
    if (numCols > count) {
      cells.splice(count);
    } else {
      while (numCols < count) {
        cells.push({ rowspan: 1, colspan: 1, text: '' });
        numCols += 1;
      }
    }
    return cells;
  };

  /* ── shared regex string pieces ─────────────────────────────────── */

  var widthRegex = / *(?:100|[1-9][0-9]?%) */g;

  // Align row
  var ALIGN = ' {0,3}(?:\\| *)?(:?-+(?: *(?:100|[1-9][0-9]?%) *-+)?:? *(?:\\| *:?-+(?: *(?:100|[1-9][0-9]?%) *-+)?:? *)*)(?:\\| *)?';

  // Body rows (with endRegex placeholder for interrupt patterns)
  var BODY = '(?:\\n((?:(?! *\\n| {0,3}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {4}[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n| {0,3}(?:[*+-]|1[.)]) |<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:script|pre|style|textarea|!--)endRegex).*(?:\\n|$))*)\\n*|$)';

  // Header rows
  var HEADER = '^ *([^\\n ].*\\|.*\\n(?: *[^\\s].*\\n)*?)';

  function applyInterrupt(s) {
    return s.replace('endRegex', interruptPatterns.map(function(p) { return '|(?:' + p + ')'; }).join(''));
  }

  function parseAlign(raw) {
    var stripped = raw.replace(widthRegex, '').replace(/^ *|\| *$/g, '');
    return stripped.split(/ *\| */).map(function(a) {
      if (/^ *-+: *$/.test(a)) return 'right';
      if (/^ *:-+: *$/.test(a)) return 'center';
      if (/^ *:-+ *$/.test(a)) return 'left';
      return null;
    });
  }

  function parseWidths(raw) {
    return raw.replace(/:/g, '').replace(/-+| /g, '').split('|');
  }

  /* ── LaTeX rendering helpers ─────────────────────────────────────── */
  /*
   * Map the extension's token shape to a `tabular` environment. Widths are
   * percentage strings (e.g. '30%') and translate to `p{0.30\textwidth}`.
   * Colspan uses \multicolumn; rowspan uses \multirow (requires
   * \usepackage{multirow}). The two-cell-empty placeholder for rowspan
   * targets keeps the `&` count aligned with the column count.
   */

  const buildColSpec = (align, width) => {
    if (width) {
      const pct = parseInt(width, 10) / 100;
      return `p{${pct.toFixed(2)}\\textwidth}`;
    }
    if (align === 'center') return 'c';
    if (align === 'right')  return 'r';
    return 'l';
  };

  const formatLatexCell = (text, cell, align, width, col) => {
    let inner = text;
    if (cell.rowspan && cell.rowspan > 1) {
      requirePackage('multirow');
      inner = `\\multirow{${cell.rowspan}}{*}{${inner}}`;
    }
    if (cell.colspan > 1) {
      const spec = buildColSpec(align[col], width[col]);
      return `\\multicolumn{${cell.colspan}}{${spec}}{${inner}}`;
    }
    return inner;
  };

  const renderLatexRow = (parser, row, align, width) => {
    const cells = [];
    let col = 0;
    for (const cell of row) {
      if (cell.rowspan === 0) {
        // Rowspan target from above: emit an empty placeholder so the
        // column count (& separators) still matches the colspec.
        if (cell.colspan > 1) {
          cells.push(`\\multicolumn{${cell.colspan}}{c}{}`);
        } else {
          cells.push('');
        }
      } else {
        const text = parser.parseInline(cell.tokens);
        cells.push(formatLatexCell(text, cell, align, width, col));
      }
      col += cell.colspan || 1;
    }
    return cells.join(' & ');
  };

  const renderTableLatex = (parser, token, hasHeader) => {
    const colspec = token.align.map((a, i) => buildColSpec(a, token.width[i])).join('');
    const bodyRows = token.rows.filter(r => !r[0].emptyRow);
    const long = bodyRows.length > LONGTABLE_ROW_THRESHOLD;
    const env = long ? 'longtable' : 'tabular';
    if (long) requirePackage('longtable');

    // booktabs rules (\toprule/\midrule/\bottomrule) — the publication look,
    // not \hline's spreadsheet look. A headerless table gets just top/bottom.
    // booktabs rules work inside longtable too. Same rules in the fallback
    // table() renderer in latex-renderer.js.
    requirePackage('booktabs');
    let tex = `\\begin{${env}}{${colspec}}\n\\toprule\n`;

    if (hasHeader) {
      for (const hrow of token.header) {
        tex += renderLatexRow(parser, hrow, token.align, token.width) + ' \\\\\n';
      }
      tex += '\\midrule\n';
    }
    // longtable: repeat the head (rule + any header row) at the top of each page.
    if (long) tex += '\\endhead\n';

    for (const brow of bodyRows) {
      tex += renderLatexRow(parser, brow, token.align, token.width) + ' \\\\\n';
    }

    tex += `\\bottomrule\n\\end{${env}}\n\n`;
    return tex;
  };

  /* ── Extension 1: Standard table with header (spanTable) ────────── */

  var spanTable = {
    name: 'spanTable',
    level: 'block',
    start: function(src) { return (src.match(/\n *([^\n ].*\|.*)\n/m) || {}).index; },
    tokenizer: function(src) {
      var regexString = applyInterrupt(HEADER + ALIGN + BODY);
      var regex = new RegExp(regexString);
      var cap = regex.exec(src);

      if (cap) {
        var item = {
          type: 'spanTable',
          header: cap[1].replace(/\n$/, '').split('\n'),
          align: cap[2].replace(widthRegex, '').replace(/^ *|\| *$/g, '').split(/ *\| */),
          rows: (cap[3] && cap[3].trim()) ? cap[3].replace(/\n[ \t]*$/, '').split('\n') : [],
          width: cap[2].replace(/:/g, '').replace(/-+| /g, '').split('|')
        };

        item.header[0] = splitCells(item.header[0]);
        var colCount = item.header[0].reduce(function(n, h) { return n + h.colspan; }, 0);

        if (colCount === item.align.length) {
          item.raw = cap[0];

          var i, j, k, row, l;

          // Parse alignment
          l = item.align.length;
          for (i = 0; i < l; i++) {
            if (/^ *-+: *$/.test(item.align[i])) {
              item.align[i] = 'right';
            } else if (/^ *:-+: *$/.test(item.align[i])) {
              item.align[i] = 'center';
            } else if (/^ *:-+ *$/.test(item.align[i])) {
              item.align[i] = 'left';
            } else {
              item.align[i] = null;
            }
          }

          // Remaining header rows
          for (i = 1; i < item.header.length; i++) {
            item.header[i] = splitCells(
              item.header[i], colCount, item.header[i - 1], skipEmptyRows);
          }

          // Body rows
          for (i = 0; i < item.rows.length; i++) {
            item.rows[i] = splitCells(
              item.rows[i], colCount, item.rows[i - 1], skipEmptyRows);
          }

          // Inline-lex header tokens
          for (j = 0; j < item.header.length; j++) {
            row = item.header[j];
            for (k = 0; k < row.length; k++) {
              row[k].tokens = [];
              this.lexer.inline(row[k].text, row[k].tokens);
            }
          }

          // Inline-lex body tokens
          for (j = 0; j < item.rows.length; j++) {
            row = item.rows[j];
            for (k = 0; k < row.length; k++) {
              row[k].tokens = [];
              this.lexer.inline(row[k].text, row[k].tokens);
            }
          }

          return item;
        }
      }
    },
    renderer: function(token) {
      if (global.isLatex) return renderTableLatex(this.parser, token, true);

      var i, j, row, cell, col, text;
      var output = '<table>';

      // thead
      output += '<thead>';
      for (i = 0; i < token.header.length; i++) {
        row = token.header[i];
        col = 0;
        output += '<tr>';
        for (j = 0; j < row.length; j++) {
          cell = row[j];
          text = this.parser.parseInline(cell.tokens);
          output += getTableCell(text, cell, 'th', token.align[col], token.width[col]);
          col += cell.colspan;
        }
        output += '</tr>';
      }
      output += '</thead>';

      // tbody
      if (token.rows.length) {
        output += '<tbody>';
        for (i = 0; i < token.rows.length; i++) {
          row = token.rows[i];
          col = 0;
          if (!row[0].emptyRow) {
            output += '<tr>';
            for (j = 0; j < row.length; j++) {
              cell = row[j];
              text = this.parser.parseInline(cell.tokens);
              output += getTableCell(text, cell, 'td', token.align[col], token.width[col]);
              col += cell.colspan;
            }
            output += '</tr>';
          }
        }
        output += '</tbody>';
      }

      output += '</table>';
      return output;
    }
  };

  /* ── Extension 2: Headerless table (headerlessTable) ────────────── */
  /*
   * Matches two forms of headerless table:
   *
   * Form A — separator-first (gives alignment & column widths):
   *   |:---|:---:|---:|
   *   | L  | C   | R  |
   *
   * Form B — pure pipe-delimited lines (no separator at all):
   *   | cell | cell | cell |
   *   | more | data | here |
   *
   * Form B constraints to prevent false triggers:
   *   - Each line must have only whitespace before the opening |
   *   - Each line must end with | (optional trailing whitespace)
   *   - At least one row is required
   *   - Column count is inferred from the first row
   *
   * Both forms support colspan (trailing ||) and rowspan (^).
   * Only Form A supports alignment and column widths.
   */

  var PIPE_ROW = / *\|.+\| *$/;

  var headerlessTable = {
    name: 'headerlessTable',
    level: 'block',
    start: function(src) {
      // Form A: separator row at the start of a line
      var mA = src.match(/\n {0,3}(?:\| *)?:?-+(?: *(?:100|[1-9][0-9]?%) *-+)?:? *(?:\| *:?-+(?: *(?:100|[1-9][0-9]?%) *-+)?:? *)*(?:\| *)? *\n/m);
      // Form B: a pipe-delimited line (| ... |)
      var mB = src.match(/\n *\|.+\| *\n/m);
      var a = mA ? mA.index : Infinity;
      var b = mB ? mB.index : Infinity;
      var best = Math.min(a, b);
      return best === Infinity ? undefined : best;
    },
    tokenizer: function(src) {
      // ── Try Form A first: separator-first ──
      var regexStringA = applyInterrupt('^' + ALIGN + BODY);
      var regexA = new RegExp(regexStringA);
      var capA = regexA.exec(src);

      if (capA) {
        var alignRaw = capA[1];
        var align = parseAlign(alignRaw);
        var width = parseWidths(alignRaw);
        var colCount = align.length;

        var bodyRaw = capA[2] ? capA[2].trim() : '';
        if (bodyRaw && colCount >= 1) {
          var rowStrings = bodyRaw.replace(/\n[ \t]*$/, '').split('\n');
          var parsedRows = [];
          for (var i = 0; i < rowStrings.length; i++) {
            parsedRows[i] = splitCells(
              rowStrings[i], colCount, parsedRows[i - 1], skipEmptyRows);
          }

          var firstRowCols = parsedRows[0].reduce(function(n, c) { return n + c.colspan; }, 0);
          if (firstRowCols === colCount) {
            for (var r = 0; r < parsedRows.length; r++) {
              var row = parsedRows[r];
              for (var k = 0; k < row.length; k++) {
                row[k].tokens = [];
                this.lexer.inline(row[k].text, row[k].tokens);
              }
            }

            return {
              type: 'headerlessTable',
              raw: capA[0],
              align: align,
              width: width,
              rows: parsedRows
            };
          }
        }
      }

      // ── Try Form B: pure pipe-delimited lines ──
      var regexB = /^( *\|.+\| *(?:\n|$))+/;
      var capB = regexB.exec(src);

      if (capB) {
        var rawMatch = capB[0];
        var lines = rawMatch.replace(/\n$/, '').split('\n');

        // Validate every line matches the pipe pattern
        var allValid = true;
        for (var v = 0; v < lines.length; v++) {
          if (!PIPE_ROW.test(lines[v])) { allValid = false; break; }
        }
        if (!allValid || lines.length < 1) return;

        // Check whether any line in the block is a separator row.
        // If so, this is a standard table (or separator-first headerless)
        // and spanTable / Form A should handle it instead.
        var sepRowRegex = /^ *\|?( *:?-+(?:[ ]*(?:100|[1-9][0-9]?)%[ ]*-+)?:? *\|)*( *:?-+(?:[ ]*(?:100|[1-9][0-9]?)%[ ]*-+)?:? *)\|? *$/;
        var hasSep = false;
        for (var s = 0; s < lines.length; s++) {
          if (sepRowRegex.test(lines[s])) { hasSep = true; break; }
        }
        if (hasSep) return;

        // Also check if the line immediately after our match is a
        // separator row — if so let spanTable handle header + sep + body.
        var afterMatch = src.slice(rawMatch.length);
        var sepTest = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)? *(?:\n|$)/;
        if (sepTest.test(afterMatch)) return;

        // Parse using first row to determine column count
        var firstParsed = splitCells(lines[0]);
        var cols = firstParsed.reduce(function(n, c) { return n + c.colspan; }, 0);
        if (cols < 1) return;

        // Re-parse all rows with the column count enforced
        var rows = [];
        for (var p = 0; p < lines.length; p++) {
          rows[p] = splitCells(lines[p], cols, rows[p - 1], skipEmptyRows);
        }

        // Build null align/width arrays (no alignment in Form B)
        var nullAlign = [];
        var nullWidth = [];
        for (var a = 0; a < cols; a++) {
          nullAlign.push(null);
          nullWidth.push('');
        }

        // Inline-lex tokens
        for (var r2 = 0; r2 < rows.length; r2++) {
          var row2 = rows[r2];
          for (var k2 = 0; k2 < row2.length; k2++) {
            row2[k2].tokens = [];
            this.lexer.inline(row2[k2].text, row2[k2].tokens);
          }
        }

        return {
          type: 'headerlessTable',
          raw: rawMatch,
          align: nullAlign,
          width: nullWidth,
          rows: rows
        };
      }
    },
    renderer: function(token) {
      if (global.isLatex) return renderTableLatex(this.parser, token, false);

      var output = '<table>';
      output += '<tbody>';
      for (var i = 0; i < token.rows.length; i++) {
        var row = token.rows[i];
        if (row[0].emptyRow) continue;
        var col = 0;
        output += '<tr>';
        for (var j = 0; j < row.length; j++) {
          var cell = row[j];
          var text = this.parser.parseInline(cell.tokens);
          output += getTableCell(text, cell, 'td', token.align[col], token.width[col]);
          col += cell.colspan;
        }
        output += '</tr>';
      }
      output += '</tbody>';
      output += '</table>';
      return output;
    }
  };

  /* ── Return marked extension object ─────────────────────────────── */

  return {
    extensions: [spanTable, headerlessTable]
  };
}

// ---------------------------------------------------------------------------
// ESM export
// ---------------------------------------------------------------------------

export { markedExtendedTablesHeaderless };
export default markedExtendedTablesHeaderless;
