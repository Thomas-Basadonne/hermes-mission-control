import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'silent',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
});

try {
  const [{ ProviderCard }, { I18nProvider }] = await Promise.all([
    server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx'),
    server.ssrLoadModule('/src/lib/i18n.tsx'),
  ]);
  const markup = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(ProviderCard, {
      provider: { provider: 'codex', available: false, error: 'CodexBar unavailable.' },
    }),
  ));
  assert.match(markup, /CodexBar unavailable/);
  console.log('provider card renders unavailable provider without contract arrays');
} finally {
  await server.close();
}
