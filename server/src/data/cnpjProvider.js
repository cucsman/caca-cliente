// Fallback CNPJ (Receita Federal) — mesmo contrato de osmProvider.js, acionado
// quando o OSM não tem cobertura suficiente pro nicho/cidade buscados (ver
// server/src/routes/search.js). Lê um cache LOCAL read-only por UF, baixado
// sob demanda via cnpjDownload.js — nunca escreve no banco de leads do
// usuário (caca-cliente.db), são bancos completamente separados.
import { existsSync } from 'node:fs';
import { NICHE_GROUPS } from './nicheGroups.js';
import { dbPathFor, getStatus, ensureUfDownloaded } from './cnpjDownload.js';
import { normalize } from '../utils/text.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

function resolveCnaes(niche) {
  const n = normalize(niche);
  const cnaes = new Set();
  for (const g of NICHE_GROUPS) {
    if (g.kw.some((k) => n.includes(k))) g.cnae.forEach((c) => cnaes.add(c));
  }
  return [...cnaes];
}

// Inclui a UF no fim (ex: "... – Cruzeiro do Oeste – PR"): sem ela, nomes de
// rua comuns ("Rua São Paulo", "Rua das Flores") são ambíguos pro forward
// geocoding e o Nominatim pode resolver pra outra cidade do Brasil inteiro
// com o mesmo nome de rua/bairro. Mesmo estilo de separador do osmProvider.js
// (" – "), só pra exibição.
function assembleAddress(row) {
  const parts = [];
  if (row.logradouro) parts.push(row.numero ? `${row.logradouro}, ${row.numero}` : row.logradouro);
  if (row.bairro) parts.push(row.bairro);
  if (row.municipio) parts.push(row.uf ? `${row.municipio} – ${row.uf}` : row.municipio);
  return parts.join(' – ') || row.municipio || null;
}

// Versão SEPARADA por vírgula do mesmo endereço, só pra consultar o
// Nominatim (geocodeEndereco, em enricher.js). Testado empiricamente: o
// travessão " – " usado em assembleAddress (bom pra leitura humana) confunde
// o parser de query do Nominatim e derruba a taxa de acerto — mesmo endereço,
// só trocando "–" por "," muda de "não encontrado" pra resolver certo.
function assembleGeocodeQuery(row) {
  const parts = [];
  if (row.logradouro) parts.push(row.numero ? `${row.logradouro}, ${row.numero}` : row.logradouro);
  if (row.bairro) parts.push(row.bairro);
  if (row.municipio) parts.push(row.municipio);
  if (row.uf) parts.push(row.uf);
  return parts.join(', ') || row.municipio || null;
}

function mapRow(row, niche) {
  return {
    id: `cnpj:${row.cnpj}`,
    source: 'cnpj', // rastreabilidade da origem — LeadCard mostra badge quando != 'osm'
    name: row.nome_fantasia || row.razao_social,
    address: assembleAddress(row),
    addressMissing: false,
    phone: row.telefone || null,
    rating: null,
    reviewsCount: null,
    // A base CNPJ não informa se a empresa tem site — diferente de `false`
    // (que afirmaria "sem site", coisa que a fonte não garante). A fase de
    // enriquecimento decide depois, igual já faz pros leads do OSM.
    hasWebsite: null,
    // Endereço textual, sem coordenada nativa — sai com o centro da cidade
    // buscada (o pino não some do mapa) + a flag que dispara o geocode
    // assíncrono em enricher.js/runOne().
    lat: null,
    lng: null,
    latMissing: true,
    // Consumido só por enricher.js/runOne() (branch de geocode assíncrono) —
    // não é pra exibir; ver assembleGeocodeQuery acima pro motivo de existir
    // separado de `address`.
    geocodeQuery: assembleGeocodeQuery(row),
    niche,
  };
}

// Bancos read-only cacheados por UF (evita reabrir a cada busca).
const openDbs = new Map();

function openReadOnly(uf) {
  const cached = openDbs.get(uf);
  if (cached) return cached;
  const p = dbPathFor(uf);
  if (!existsSync(p)) return null;
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    openDbs.set(uf, db);
    return db;
  } catch (e) {
    // node:sqlite é EXPERIMENTAL — banco corrompido/parcialmente escrito não
    // pode derrubar a busca inteira. Nunca cacheia um handle que falhou.
    console.error(`[cnpj] falha ao abrir ${uf}.db (seguindo sem CNPJ):`, e.message);
    return null;
  }
}

export async function buscarEstabelecimentos({ niche, city, lat, lng, radiusKm, uf }) {
  if (!uf) return { found: 0, leads: [], status: 'unavailable' };
  const ufU = uf.toUpperCase();

  let db = openReadOnly(ufU);
  if (!db) {
    ensureUfDownloaded(ufU); // dispara download em background — não bloqueia a Fase 1
    return { found: 0, leads: [], status: getStatus(ufU).status };
  }

  const cnaes = resolveCnaes(niche);
  if (!cnaes.length) return { found: 0, leads: [], status: 'ready' };

  try {
    const placeholders = cnaes.map(() => '?').join(',');
    // Filtra por cnae no SQL (usa idx_cnae_municipio) e por município em JS:
    // o texto de `municipio` na base processada pode divergir em acentuação
    // ou caixa do nome devolvido pelo Nominatim (geocodeCidade) — comparar
    // normalizado evita depender de convenção exata do ETL nesse campo. `city`
    // chega como "Cidade, Estado" (label montado em geocodeCidade/toLabel) —
    // pega só a parte antes da vírgula, senão nunca bate com `municipio`
    // (que só tem o nome da cidade).
    const rows = db.prepare(`SELECT * FROM estabelecimentos WHERE cnae IN (${placeholders})`).all(...cnaes);
    const cityNorm = normalize(String(city ?? '').split(',')[0]);
    const matched = rows.filter((r) => normalize(r.municipio) === cityNorm).slice(0, 150);

    const leads = matched.map((r) => mapRow(r, niche));
    return { found: leads.length, leads, status: 'ready' };
  } catch (e) {
    // Erro na CONSULTA (não na abertura) — ex: banco corrompido no meio da
    // leitura, schema inesperado. Descarta o handle cacheado pra próxima
    // chamada tentar reabrir do zero, em vez de repetir o mesmo erro sempre.
    console.error(`[cnpj] consulta em ${ufU}.db falhou (seguindo sem CNPJ):`, e.message);
    openDbs.delete(ufU);
    try { db.close(); } catch {}
    return { found: 0, leads: [], status: 'unavailable' };
  }
}
