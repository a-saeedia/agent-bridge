const fs = require('fs');
const { parse, printParseErrorCode } = require('jsonc-parser');
const p = 'C:/Users/user/.config/opencode/opencode.jsonc';
const text = fs.readFileSync(p, 'utf8');
const errors = [];
parse(text, errors, { allowTrailingComma: true });
if (errors.length) {
  console.log('JSONC ERRORS:');
  for (const e of errors) console.log('  offset ' + e.offset + ': ' + printParseErrorCode(e.error));
  process.exit(1);
} else {
  console.log('opencode.jsonc: VALID (trailing commas + comments OK)');
}