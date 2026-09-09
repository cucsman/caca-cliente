// Geocoding GRATUITO via Nominatim (OpenStreetMap) — converte "Campinas" em
// lat/lng. Sem chave, sem cartão. Política de uso do Nominatim exige:
//   - User-Agent identificando a app  (ok abaixo)
//   - no máx. 1 req/seg  (limitador serializado abaixo)
//   - cache dos resultados  (cache de 24h abaixo)
//   - nada de autocomplete por tecla  (o front faz debounce de 450ms)
import https from 'node:https';
import { withRetry, isTransientHttpError } from '../utils/retry.js';
import { normalize } from '../utils/text.js';

const UA = 'CacaCliente/0.1 (prospeccao de negocios sem site; curso Sites com IA do Zero)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Limitador: serializa as chamadas ao Nominatim com >= 1.1s entre elas ──
let lastCall = 0;
let chain = Promise.resolve();
function rateLimited(fn) {
  const run = chain.then(async () => {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  chain = run.then(() => {}, () => {}); // mantém a cadeia viva mesmo em erro
  return run;
}

// ── Cache (cidades não se movem) ──
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function nominatimGet(q) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      q,
      format: 'jsonv2',
      limit: '6',
      addressdetails: '1',
      'accept-language': 'pt-BR',
      countrycodes: 'br', // foco no Brasil; remova para buscar global
    });
    const req = https.request(
      {
        hostname: 'nominatim.openstreetmap.org',
        path: '/search?' + params.toString(),
        method: 'GET',
        agent: false,
        family: 4,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Nominatim HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('Nominatim timeout')));
    req.on('error', reject);
    req.end();
  });
}

function toLabel(item) {
  const a = item.address ?? {};
  const place = a.city || a.town || a.village || a.municipality || a.county || item.name || (item.display_name ?? '').split(',')[0];
  const state = a.state || a.region;
  return [place, state].filter(Boolean).join(', ') || item.display_name;
}

// Nome do estado (como o Nominatim devolve em address.state, ex: "Paraná")
// -> sigla de 2 letras. Usado pra resolver a UF da busca (fallback CNPJ
// precisa saber em qual estado baixar/consultar a base).
const UF_POR_ESTADO = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA',
  ceara: 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO',
  maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR',
  pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO',
  roraima: 'RR', 'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE',
  tocantins: 'TO',
};

// Exportada: search.js reaproveita como fallback pra resolver a UF a partir
// do nome do estado quando o front não manda `uf` explicitamente. Validar
// contra essa lista fechada (em vez de um regex tipo /[A-Za-z]{2}$/) evita
// aceitar lixo como UF válida e disparar download desnecessário do cache CNPJ.
export function ufDoEstado(nomeEstado) {
  return UF_POR_ESTADO[normalize(nomeEstado)] ?? null;
}

function nominatimReverseGet(lat, lng) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: 'jsonv2',
      addressdetails: '1',
      zoom: '18', // nível de "estabelecimento/rua", não bairro/cidade
      'accept-language': 'pt-BR',
    });
    const req = https.request(
      {
        hostname: 'nominatim.openstreetmap.org',
        path: '/reverse?' + params.toString(),
        method: 'GET',
        agent: false,
        family: 4,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Nominatim HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('Nominatim timeout')));
    req.on('error', reject);
    req.end();
  });
}

function assembleReverseAddress(item) {
  const a = item?.address ?? {};
  const parts = [];
  const street = a.road;
  const num = a.house_number;
  if (street) parts.push(num ? `${street}, ${num}` : street);
  const area = a.suburb || a.neighbourhood || a.district;
  if (area) parts.push(area);
  const city = a.city || a.town || a.municipality;
  if (city) parts.push(city);
  return parts.join(' – ') || null;
}

// ── Fallback de endereço via reverse geocoding ──────────────────────────────
// Usado quando o OSM (osmProvider.js) não tem as tags addr:street/housenumber
// pro estabelecimento — cobertura fraca no Brasil (ver assembleAddress lá).
// Reaproveita o mesmo limitador (1 req/seg) e cache do geocode direto, já que
// é o mesmo host/política do Nominatim.
const reverseCache = new Map();
export async function reverseGeocodeEndereco(lat, lng) {
  const key = `${(+lat).toFixed(5)},${(+lng).toFixed(5)}`;
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.address;

  const item = await rateLimited(() =>
    withRetry(() => nominatimReverseGet(lat, lng), {
      label: 'Nominatim (reverse)',
      retries: 2,
      baseMs: 1200,
      shouldRetry: isTransientHttpError,
    })
  );
  const address = assembleReverseAddress(item);
  reverseCache.set(key, { ts: Date.now(), address });
  return address;
}

export async function geocodeCidade(q) {
  const key = normalize(q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.results;

  // Nominatim: 1 req/seg + retry com backoff em erros transientes (rede/5xx/429).
  // 4xx (ex: query inválida) não vale retry — sobe direto.
  const raw = await rateLimited(() =>
    withRetry(() => nominatimGet(q), {
      label: 'Nominatim',
      retries: 2,
      baseMs: 1200, // acima do limite de 1 req/seg do Nominatim
      shouldRetry: isTransientHttpError,
    })
  );
  const seen = new Set();
  const results = [];
  for (const item of raw) {
    const label = toLabel(item);
    if (seen.has(label)) continue;
    seen.add(label);
    const a = item.address ?? {};
    results.push({ label, lat: +item.lat, lng: +item.lon, uf: ufDoEstado(a.state || a.region) });
    if (results.length >= 5) break;
  }
  cache.set(key, { ts: Date.now(), results });
  return results;
}

// ── Forward geocoding de um endereço específico (não uma cidade) ───────────
// Usado pelo fallback CNPJ: leads vindos da base da Receita têm endereço
// textual (logradouro/número/bairro/município/UF) mas nenhuma coordenada —
// diferente do OSM, que já vem com lat/lng do próprio elemento. Reaproveita
// nominatimGet() (mesmo endpoint /search já usado por geocodeCidade) e o
// limitador/cache já existentes; só pega o primeiro resultado (mais
// relevante) em vez de montar uma lista de opções pro usuário escolher.
const enderecoCache = new Map();
export async function geocodeEndereco(enderecoCompleto) {
  const key = normalize(enderecoCompleto);
  const hit = enderecoCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.coords;

  const raw = await rateLimited(() =>
    withRetry(() => nominatimGet(enderecoCompleto), {
      label: 'Nominatim (forward endereço)',
      retries: 2,
      baseMs: 1200,
      shouldRetry: isTransientHttpError,
    })
  );
  const first = raw[0];
  const coords = first ? { lat: +first.lat, lng: +first.lon } : null;
  enderecoCache.set(key, { ts: Date.now(), coords });
  return coords;
}
