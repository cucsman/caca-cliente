import { Router } from 'express';
import { buscarEstabelecimentos } from '../data/osmProvider.js';
import { gerarEstabelecimentos } from '../data/mockPlaces.js';
import { geocodeCidade, ufDoEstado } from '../data/geocode.js';
import * as cnpjProvider from '../data/cnpjProvider.js';
import { getStatus as getCnpjStatus } from '../data/cnpjDownload.js';
import { createSearch, attachStream, prioritizeLead, getSearchLeads, updateLead, reopenSearch } from '../enrichment/enricher.js';
import { toCSV, toXLSX } from '../export/exporter.js';
import { listSearches, statsConversao, dbEnabled, dbKind, dbWarning } from '../db.js';
import { scoreLead } from '../utils/score.js';
import { assertPublicUrl } from '../utils/ssrf.js';
import { normalize } from '../utils/text.js';

const router = Router();
const slug = (s) =>
  (s || 'leads')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'leads';
const USE_MOCK = process.env.DATA_PROVIDER === 'mock'; // demo offline sem rede
const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || lo, lo), hi);

// ─── Fallback CNPJ: acionado só quando o OSM não achou nada (threshold
// conservador pra começar, ver plano) e a UF foi resolvida no front. Dedup é
// DENTRO desta busca (função pura, em memória) — não confundir com
// findDupLeads do db, que compara contra buscas ANTERIORES já persistidas.
const CNPJ_FALLBACK_THRESHOLD = 0;
const SUFIXO_SOCIETARIO = /\b(LTDA|ME|EIRELI|EPP|S\/?A|S\.A\.?)\b\.?/gi;
const normalizeNome = (s) =>
  normalize(s)
    .toUpperCase()
    .replace(SUFIXO_SOCIETARIO, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Mantém o lead do OSM em caso de empate (já vem com lat/lng reais, o CNPJ não).
function dedupContraOsm(osmLeads, cnpjLeads) {
  const vistos = new Set(osmLeads.map((l) => normalizeNome(l.name)));
  return cnpjLeads.filter((l) => {
    const key = normalizeNome(l.name);
    if (!key || vistos.has(key)) return false;
    vistos.add(key);
    return true;
  });
}

// ─── FASE 1 — síncrona: pinos no mapa em ~1–2s ──────────────────────────────
router.post('/api/search', async (req, res) => {
  const { niche, city = 'São Paulo', lat = -23.5505, lng = -46.6333, radiusKm = 5, uf } = req.body ?? {};
  if (!niche?.trim()) {
    return res.status(400).json({ error: 'Informe o nicho (ex: "salão de estética").' });
  }
  const radius = clamp(radiusKm, 0.5, 30);
  const params = { niche: niche.trim(), city, lat: +lat, lng: +lng, radiusKm: radius };

  let found = 0;
  let leads = [];
  let osmError = null; // guardado, não descartado — só é ignorado se o fallback CNPJ salvar a busca

  try {
    if (USE_MOCK) {
      const todos = gerarEstabelecimentos(params);
      leads = todos.filter((p) => !p.hasWebsite);
      found = todos.length;
    } else {
      // OpenStreetMap / Overpass — gratuito, filtra quem TEM a tag website.
      // Falha aqui NÃO aborta a rota: vira gatilho do fallback CNPJ (junto
      // com found===0) e só vira erro pro usuário lá embaixo se o CNPJ
      // também não resolver — nunca mascarada como "0 resultados" silencioso.
      ({ found, leads } = await buscarEstabelecimentos(params));
    }
  } catch (e) {
    console.warn('[search] Overpass falhou, tentando fallback CNPJ antes de desistir:', e.message);
    osmError = e;
  }

  try {
    // Fallback CNPJ: acionado quando o OSM não achou nada OU falhou de
    // verdade, e a UF foi resolvida — pelo front (SearchBar → geocodeCidade)
    // ou, na falta disso, a partir do nome do estado no fim de `city`
    // ("Cidade, Estado") validado contra a lista fechada de UFs (ufDoEstado),
    // não um regex solto que aceitaria qualquer 2 letras como sigla válida.
    let cnpjStatus, cnpjUf;
    let ufNormalizada = typeof uf === 'string' ? uf.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(ufNormalizada)) {
      const estado = city.split(',').pop()?.trim();
      ufNormalizada = (estado && ufDoEstado(estado)) || '';
    }

    if (!USE_MOCK && (found <= CNPJ_FALLBACK_THRESHOLD || osmError) && /^[A-Z]{2}$/.test(ufNormalizada)) {
      try {
        const cnpjResult = await cnpjProvider.buscarEstabelecimentos({ ...params, uf: ufNormalizada });
        cnpjStatus = cnpjResult.status;
        cnpjUf = ufNormalizada;
        if (cnpjResult.status === 'ready' && cnpjResult.leads.length) {
          const novos = dedupContraOsm(leads, cnpjResult.leads);
          leads = [...leads, ...novos];
          found += novos.length;
        }
      } catch (e) {
        console.error('[cnpj] fallback falhou (seguindo só com o que o OSM achou):', e.message);
      }
    }

    // Se o OSM falhou de verdade E o CNPJ não trouxe nada pra compensar,
    // propaga o erro real pro usuário — nunca devolve "0 resultados" de
    // sucesso quando na verdade a busca não rodou (mesmo princípio do fix
    // de partial/not_found no enriquecimento).
    if (osmError && leads.length === 0) throw osmError;

    const searchId = createSearch(leads, { city, niche: params.niche, lat: params.lat, lng: params.lng, radiusKm: params.radiusKm, found });
    res.json({
      searchId,
      query: params,
      stats: { found, withoutWebsite: leads.length },
      ...(cnpjStatus ? { cnpjStatus, cnpjUf } : {}),
      leads: leads.map((l) => ({
        ...l,
        enrichmentStatus: 'pending',
        enrichment: null,
        stage: 'novo',
        waInvalid: false,
        score: scoreLead(l, null),
      })),
    });
  } catch (e) {
    console.error('Falha na busca OSM:', e);
    const msg = e?.name === 'RetryError'
      ? `${e.message}. Tente novamente em instantes ou reduza o raio.`
      : 'Não consegui consultar o mapa agora (Overpass ocupado). Tente de novo em instantes ou reduza o raio.';
    res.status(502).json({ error: msg });
  }
});

// ─── Autocomplete de cidade (Nominatim/OSM, gratuito) ──────────────────────
router.get('/api/geocode', async (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    res.json({ results: await geocodeCidade(q) });
  } catch (e) {
    console.error('Falha no geocode:', e);
    const msg = e?.name === 'RetryError'
      ? `${e.message}. Tente novamente em instantes.`
      : 'Geocoding indisponível agora.';
    res.status(502).json({ error: msg });
  }
});

// ─── FASE 2 — stream SSE: o enriquecimento pinga aqui conforme fica pronto ──
router.get('/api/search/:searchId/stream', (req, res) => attachStream(req.params.searchId, req, res));

// Enriquecimento sob demanda: o usuário clicou no lead → fura a fila
router.post('/api/search/:searchId/leads/:leadId/prioritize', (req, res) => {
  const ok = prioritizeLead(req.params.searchId, req.params.leadId);
  res.status(ok ? 202 : 404).json({ accepted: ok });
});

// Atualiza um lead: estágio do Kanban + campos de CRM (notas, follow-up, tags, valor)
router.patch('/api/search/:searchId/leads/:leadId', (req, res) => {
  const ok = updateLead(req.params.searchId, req.params.leadId, req.body ?? {});
  res.status(ok ? 200 : 400).json({ ok });
});

// Reabre uma busca salva (re-hidrata do banco se já saiu da memória) — usado pelo histórico
router.get('/api/search/:searchId/leads', async (req, res) => {
  const data = await reopenSearch(req.params.searchId);
  if (!data) return res.status(404).json({ error: 'Busca não encontrada.' });
  res.json(data);
});

// ─── Exportação CSV / XLSX ──────────────────────────────────────────────────
router.get('/api/search/:searchId/export', async (req, res) => {
  const data = await getSearchLeads(req.params.searchId);
  if (!data) return res.status(404).json({ error: 'Busca não encontrada (sessão expirada?).' });

  const format = (req.query.format ?? 'csv').toString().toLowerCase();
  const base = `leads-${slug(data.niche)}-${new Date().toISOString().slice(0, 10)}`;
  try {
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(await toXLSX(data.leads));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(toCSV(data.leads));
  } catch (e) {
    console.error('Falha no export:', e);
    res.status(500).json({ error: 'Falha ao gerar o arquivo.' });
  }
});

// ─── Webhook: envia os leads (JSON) para um CRM/URL do usuário ──────────────
router.post('/api/search/:searchId/webhook', async (req, res) => {
  const data = await getSearchLeads(req.params.searchId);
  if (!data) return res.status(404).json({ error: 'Busca não encontrada (sessão expirada?).' });

  const url = (req.body?.url ?? '').toString().trim();
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'Informe uma URL http(s) válida.' });

  try {
    await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: `URL não permitida: ${e.message}` });
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { niche: data.niche, city: data.city }, count: data.leads.length, leads: data.leads }),
      signal: AbortSignal.timeout(10000),
    });
    res.json({ delivered: r.ok, status: r.status });
  } catch (e) {
    console.error('Webhook falhou:', e);
    res.status(502).json({ error: 'Não consegui entregar ao webhook (URL inacessível ou lenta).' });
  }
});

// Histórico de buscas persistidas (lista vazia se o banco estiver desligado).
// dbEnabled vai junto pra o front distinguir "banco off" de "banco on sem buscas".
// warning traz uma mensagem pronta pra exibir quando dbEnabled === false —
// nunca falha silenciosa (ver server/src/db/index.js).
router.get('/api/searches', async (_req, res) => {
  res.json({ dbEnabled, warning: dbWarning, searches: await listSearches() });
});

// Diz se a persistência está ativa e qual driver (postgres/sqlite/memory).
router.get('/api/status', (_req, res) => res.json({ dbEnabled, dbKind, warning: dbWarning, version: process.env.APP_VERSION ?? null }));

// Progresso do download do cache CNPJ de uma UF — front faz polling curto
// enquanto `downloading` e re-dispara a busca quando virar `ready`.
router.get('/api/cnpj/status/:uf', (req, res) => {
  const uf = (req.params.uf ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ error: 'UF inválida (use a sigla de 2 letras, ex: PR).' });
  res.json(getCnpjStatus(uf));
});

// Estatísticas de conversão para o dashboard (null se o banco estiver desligado).
router.get('/api/stats', async (_req, res) => {
  res.json({ stats: await statsConversao() });
});

export default router;
