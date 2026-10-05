import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('../src/components/overview/ProviderUsagePanel.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/lib/hermes-api.ts', import.meta.url), 'utf8');

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
if (!component.includes('loadProviderUsageCatalog') || !component.includes('saveProviderUsageSelection')) {
  throw new Error('provider usage panel must load and persist the dynamic provider selection');
}
if (!component.includes('filteredCatalog.map')) {
  throw new Error('provider usage customization must render the searched catalog');
}
if (!api.includes("'/provider-usage/catalog'") || !api.includes("'/provider-usage/selection'")) {
  throw new Error('provider usage API client must use the local catalog and selection routes');
}

console.log('provider usage UI contract test passed');
