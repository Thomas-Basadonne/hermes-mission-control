import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
assert.match(css, /\.chat-status-line-separator\s*\{[^}]*color: var\(--color-text-muted\)/, 'status separators use a readable text color rather than a dim border token');
assert.match(css, /\.chat-status-line\s*\{[^}]*padding: 0\.2rem 1rem;/, 'desktop statusline remains compact');
assert.doesNotMatch(css, /\.chat-status-line \.chat-status-control\s*\{[^}]*min-height: 44px/, 'touch controls must not inflate the statusline to 44px');
assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.chat-status-line\s*\{[^}]*min-height: 2rem;[^}]*padding: 0 0\.75rem;/, 'mobile statusline keeps compact 32px geometry');
console.log('chat statusline geometry tests passed');
