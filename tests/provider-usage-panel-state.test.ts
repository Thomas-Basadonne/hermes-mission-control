import assert from 'node:assert/strict';
import * as display from '../src/lib/provider-usage-display.ts';
assert.equal(typeof display.getProviderUsagePanelState, 'function');
assert.equal(display.getProviderUsagePanelState(null, false), 'loading');
assert.equal(display.getProviderUsagePanelState(null, true), 'unavailable', 'completed transport failure is not perpetual initial loading');
assert.equal(display.getProviderUsagePanelState({ available: true, providers: [] }, false), 'ready');
assert.equal(display.getProviderUsagePanelState({ available: false, providers: [{ provider: 'future', dataState: 'no_data' }] }, false), 'ready', 'valid no-data cards remain observable');
assert.equal(display.getProviderUsagePanelState({ available: false, providers: [] }, false), 'unavailable');
console.log('panel loading, failure and valid no-data state passed');
