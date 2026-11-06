import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeHtmlEntities,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
} from './chatFormatting';

test('normalizeInlineCodeFences converts single-line triple backticks without corrupting adjacent multi-line code blocks', () => {
  const input = [
    'Use ```npm test``` to run tests.',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '### Next section',
    '',
    '```ts',
    'const b = 2;',
    '```',
  ].join('\n');

  const output = normalizeInlineCodeFences(input);
  assert.equal(
    output,
    [
      'Use `npm test` to run tests.',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '### Next section',
      '',
      '```ts',
      'const b = 2;',
      '```',
    ].join('\n'),
  );
});

test('unescapeWithMathProtection preserves escape sequences inside inline code and fenced code blocks', () => {
  const input = [
    'Line 1\\nLine 2',
    'Inline code: `\\n\\n[Images provided at the following paths:]\\n` and `line.split(/\\r?\\n/)`',
    '```js',
    'const text = "a\\nb\\tc";',
    '```',
    'Math: $\\nable + \\theta$',
  ].join('\n');

  const output = unescapeWithMathProtection(input);
  assert.ok(output.startsWith('Line 1\nLine 2\n'));
  assert.ok(output.includes('`\\n\\n[Images provided at the following paths:]\\n`'));
  assert.ok(output.includes('`line.split(/\\r?\\n/)`'));
  assert.ok(output.includes('const text = "a\\nb\\tc";'));
  assert.ok(output.includes('$\\nable + \\theta$'));
});

test('decodeHtmlEntities decodes entities in prose while preserving entities inside code spans', () => {
  const input = 'Prose &lt;div&gt; vs inline `&lt;USER_REQUEST&gt;` and block:\n```html\n&lt;span&gt;\n```';
  const output = decodeHtmlEntities(input);
  assert.equal(
    output,
    'Prose <div> vs inline `&lt;USER_REQUEST&gt;` and block:\n```html\n&lt;span&gt;\n```',
  );
});
