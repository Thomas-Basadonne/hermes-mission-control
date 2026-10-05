import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('../src/components/overview/ProviderUsagePanel.tsx', import.meta.url), 'utf8');

if (!component.includes('lg:grid-cols-3')) {
  throw new Error('provider usage desktop grid must use three columns');
}
if (component.includes('lg:grid-cols-4')) {
  throw new Error('provider usage desktop grid must not use four columns');
}
if (!component.includes('featuredMetrics')) {
  throw new Error('provider usage cards must support featured metrics');
}
if (!component.includes('resetCreditMetrics')) {
  throw new Error('Codex reset credits must be separated from featured metrics');
}
if (!component.includes('provider-reset-footer')) {
  throw new Error('Codex reset credits must render in a card footer');
}
if (!component.includes("metric.id === 'reset_credits_available'")) {
  throw new Error('Codex footer must target reset credits, not quota reset dates');
}

for (const preferenceApi of [
  'loadProviderUsagePreferences',
  'saveProviderUsagePreferences',
  'applyProviderUsagePreferences',
  'setProviderUsageProviderVisible',
  'setProviderUsageFieldVisible',
  'moveProviderUsagePreference',
]) {
  if (!component.includes(preferenceApi)) {
    throw new Error(`provider usage UI must support user preference API: ${preferenceApi}`);
  }
}
if (!component.includes('provider-usage-customize-dialog') || !component.includes('aria-haspopup="dialog"')) {
  throw new Error('provider usage preferences must use a viewport-safe accessible dialog');
}
if (component.includes('max-h-[70vh]')) {
  throw new Error('provider usage customize content must not be clipped by a viewport-relative dropdown');
}
if (!component.includes('provider.preferencesHelp')) {
  throw new Error('provider usage UI must explain the boundary between user preferences and admin config');
}
console.log('provider usage UI contract test passed');
