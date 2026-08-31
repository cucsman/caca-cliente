// Seletor da camada de persistência. Prioridade:
//   1. DATABASE_URL definida  -> Postgres (home server / avançado)
//   2. node:sqlite disponível -> SQLite local automático (Node >=22.5 e Electron)
//   3. senão                  -> memória (Node antigo; nada persiste, como antes)
//
// A API pública é idêntica nos três drivers; quem consome (enricher, rotas)
// não sabe qual está ativo. `dbKind` sai no GET /api/status pra debug/UI.

function memoryDriver() {
  const noop = async () => {};
  return {
    dbEnabled: false,
    initDb: async () => {
      console.log('[db] sem DATABASE_URL e sem node:sqlite (Node < 22.5) — rodando em memória. Atualize pro Node 22+ pra ter histórico salvo.');
      return false;
    },
    saveSearch: noop,
    saveEnrichment: noop,
    saveStage: noop,
    saveLeadFields: noop,
    loadSearch: async () => null,
    statsConversao: async () => null,
    findDupLeads: async () => new Map(),
    listSearches: async () => [],
  };
}

let impl;
let selectedKind;
if (process.env.DATABASE_URL) {
  impl = await import('./postgres.js');
  selectedKind = 'postgres';
} else if (typeof process.getBuiltinModule === 'function' && process.getBuiltinModule('node:sqlite')?.DatabaseSync) {
  impl = await import('./sqlite.js');
  selectedKind = 'sqlite';
} else {
  impl = memoryDriver();
  selectedKind = 'memory';
}

const SEM_DRIVER = 'Persistência local desativada: os dados não estão sendo salvos e serão perdidos ao fechar o app ou reiniciar o servidor. Isso costuma indicar Node.js desatualizado (é preciso 22.5+ pro SQLite embutido) — atualize o Node ou configure DATABASE_URL para usar um Postgres externo.';

// dbKind/dbEnabled/dbWarning começam otimistas (driver ESCOLHIDO pela versão
// do Node) e só refletem a realidade depois que initDb() roda: um driver real
// (postgres/sqlite) pode falhar ao ABRIR o banco (permissão, disco cheio,
// arquivo corrompido) mesmo tendo sido escolhido — nesse caso ele já vira
// no-op sozinho (saveX/loadX checam `if (!db) return`), e esses exports
// precisam contar a verdade, senão a API afirma pro front que os dados estão
// sendo salvos quando na real nada está. `let` (não `const`) pra permitir
// esse downgrade em runtime — quem importa vê o valor atualizado (live binding).
export let dbKind = selectedKind;
export let dbEnabled = selectedKind !== 'memory';
export let dbWarning = selectedKind === 'memory' ? SEM_DRIVER : null;

const implInitDb = impl.initDb;
export async function initDb() {
  const ok = await implInitDb();
  if (!ok && selectedKind !== 'memory') {
    dbKind = 'memory';
    dbEnabled = false;
    dbWarning = `Persistência local desativada: o driver "${selectedKind}" foi escolhido mas falhou ao abrir o banco (permissão, disco cheio ou arquivo corrompido) — os dados não estão sendo salvos. Veja o log do servidor pro erro exato.`;
  }
  return ok;
}

export const { saveSearch, saveEnrichment, saveStage, saveLeadFields, loadSearch, statsConversao, findDupLeads, listSearches } = impl;
