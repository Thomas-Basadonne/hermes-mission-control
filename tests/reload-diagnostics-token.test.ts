import assert from 'node:assert/strict';
import { resolveReloadDiagnosticToken } from '../src/lib/reload-diagnostics.ts';

assert.equal(resolveReloadDiagnosticToken(null, 'env-test-token'), 'env-test-token');
assert.equal(resolveReloadDiagnosticToken('', 'env-test-token'), 'env-test-token');
assert.equal(resolveReloadDiagnosticToken('  ', 'env-test-token'), 'env-test-token');
assert.equal(resolveReloadDiagnosticToken('stored-test-token', 'env-test-token'), 'stored-test-token');

console.log('reload diagnostics token fallback tests passed');
