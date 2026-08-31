import { fileURLToPath } from 'node:url';

// Handlers globais ANTES de qualquer outra coisa: sem eles, uma exceção ou
// promise rejeitada sem .catch derruba o processo sem stack trace nenhum no
// log — com `node --watch` (nosso `npm run dev`) o processo fica parado em
// "Waiting for file changes..." e ninguém descobre qual foi o erro real.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err?.stack ?? err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason?.stack ?? reason);
  process.exit(1);
});

// Carrega server/.env (se existir) ANTES de importar módulos que leem process.env.
try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const { startServer } = await import('./app.js');
await startServer();
