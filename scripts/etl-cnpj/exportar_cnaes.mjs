// Ponte Node -> Python: o ETL do CNPJ roda em Python (adaptado de
// rictom/cnpj-sqlite), mas a lista de CNAEs por nicho vive em
// server/src/data/nicheGroups.js (mesma fonte usada pelo osmProvider.js e
// pelo cnpjProvider.js) — pra não ter duas listas de CNAE divergindo, este
// script gera um snapshot em JSON que o processar.py lê.
//
// Rodar sempre que nicheGroups.js mudar, antes de processar.py:
//   node scripts/etl-cnpj/exportar_cnaes.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NICHE_GROUPS } from '../../server/src/data/nicheGroups.js';

const saida = fileURLToPath(new URL('./cnaes.json', import.meta.url));

const mapeamento = NICHE_GROUPS.map((g) => ({
  nicho: g.kw[0], // radical mais representativo, só pra leitura humana no JSON
  cnae: g.cnae,
}));

const todosCnaes = [...new Set(NICHE_GROUPS.flatMap((g) => g.cnae))].sort();

writeFileSync(
  saida,
  JSON.stringify({ geradoEm: new Date().toISOString(), mapeamento, todosCnaes }, null, 2) + '\n'
);

console.log(`cnaes.json gerado com ${todosCnaes.length} códigos CNAE únicos de ${NICHE_GROUPS.length} grupos de nicho.`);
