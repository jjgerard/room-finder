'use strict';

// Minimal RFC4180 CSV reader. The class file has quoted fields containing
// commas (room names like "BC-04-001 Ceramics shared(45), spare"), so a
// split(',') would corrupt roughly 1 row in 40.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // Strip a UTF-8 BOM so the first header name doesn't carry it.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// → array of plain objects keyed by the header row.
function readCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === '') continue; // trailing newline
    const o = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = rows[r][c] === undefined ? '' : rows[r][c];
    out.push(o);
  }
  return out;
}

module.exports = { parseCsv, readCsv };
