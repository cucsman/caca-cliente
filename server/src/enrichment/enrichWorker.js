// Worker de enriquecimento — 100% gratuito, sem chaves de API e sem cobrança.
// Port JS fiel do workers/enrich.py (removido para facilitar empacotamento Electron).
//
// Entrada : enrichLead({name, city, phone}) -> {email,instagram,facebook,linkedin,
//           whatsapp,confidence,partial,discoveredWebsite,linkBroken}
// Saída   : sempre um objeto válido (nunca lança), mesmo em erro/bloqueio.
//
// Estratégia de performance (o usuário não espera demais):
//   1. UMA consulta SERP por lead no caminho quente: pega redes sociais E e-mails do
//      mesmo HTML (menos requests = mais rápido e menor risco de bloqueio).
//   2. 2ª consulta só dispara se o e-mail não apareceu na primeira.
//   3. Orçamento de tempo rígido (9s): estourou, devolve parcial — nunca trava.
//
// SERP: DuckDuckGo HTML (gratuito, sem JS, sem cadastro). Em escala troque por
// Brave Search API (free tier) ou Serper.dev.

// ── Constantes (espelham enrich.py) ──────────────────────────────────────────
// Pool de User-Agents reais (desktop) pra variar entre tentativas — reduz (mas
// NÃO elimina) a chance de bloqueio por fingerprint fixo. Ver nota em serp().
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/123.0 Safari/537.36 Edg/123.0',
];
const UA = UA_POOL[0]; // usado pelo fetch do link do Linktree (fora do serp())
const DDG = 'https://html.duckduckgo.com/html/';
const BING = 'https://www.bing.com/search';
const TIMEOUT_LEAD = 9000; // ms, orçamento total por lead
const REQ_TIMEOUT = 6000;  // ms, timeout individual SERP
const SERP_RETRIES = 0;    // sem retry no DDG — ver nota abaixo (fallback pro Bing é o retry real)
const SERP_BASE_MS = 500;  // backoff base
// Status que indicam bloqueio/anti-bot do DDG, não "sem resultado". Medido em
// produção (probe manual, ago/2026, repetido em condição de usuário real):
// html.duckduckgo.com bloqueia entre 80% e 100% dos requests com 202/403
// (challenge page), de forma PERSISTENTE — confirmado que reter/aumentar
// retry (3 tentativas, base 900ms) não muda a taxa de sucesso, só multiplica
// a latência (~2s -> ~20s+/lead). Confirmado também com relato de usuário
// real (rede doméstica comum, fora de qualquer sandbox): 31/31 leads
// bloqueados — não é artefato de IP de datacenter, é o DDG bloqueando de
// forma agressiva mesmo. Por isso: 1 tentativa só no DDG (retry contra um
// bloqueio persistente é desperdício de tempo) e fallback imediato pro Bing
// HTML (ver buscarComFallback), que nos testes NÃO ficou bloqueado nenhuma
// vez (ver decodeCitesBing) — poupa o orçamento de 9s/lead pra tentar uma
// fonte que de fato responde, em vez de insistir numa que não responde.
const SERP_BLOCK_STATUSES = [202, 403, 418, 429];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HREF_RE = /href="(https?:\/\/[^"]+)"/gi;
const EMAIL_BLOCK = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'];
const DOMAIN_BLOCK = ['duckduckgo.com', 'example.com', 'w3.org', 'sentry', 'wixpress.com', '@2x'];
const LINKTREE_DOMAINS = ['linktr.ee', 'bio.link', 'beacons.ai', 'lnk.bio'];

const NON_WEBSITE_HOSTS = [
  // Redes sociais e mensageiros
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com',
  'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
  'wa.me', 'api.whatsapp.com', 't.me', 'threads.net',
  // Mapas e listagens de negócios
  'google.com', 'google.com.br', 'goo.gl', 'maps.app.goo.gl', 'waze.com',
  'foursquare.com', 'yelp.com',
  // Agregadores BR
  'jusbrasil.com.br', 'oab.org.br', 'advogados.com.br',
  'doctoralia.com.br', 'consultaremedios.com.br', 'boaconsulta.com',
  'guiamais.com.br', 'telelistas.net', 'apontador.com.br', 'solutudo.com.br',
  'olx.com.br', 'mercadolivre.com.br', 'ifood.com.br', 'rappi.com.br',
  // Diretórios e plataformas
  'wikipedia.org', 'yellowpages.com', 'tripadvisor.com', 'booking.com',
  'reclameaqui.com.br', 'econodata.com.br', 'cnpj.biz',
  // Domínios genéricos
  'wixsite.com', 'wordpress.com', 'blogspot.com',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unescapeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

// ── SERP ─────────────────────────────────────────────────────────────────────
async function serp(query) {
  let lastErr;
  for (let attempt = 0; attempt <= SERP_RETRIES; attempt++) {
    if (attempt > 0) {
      const jitter = 1 + (Math.random() - 0.5) * 0.4; // ±20%
      await sleep(SERP_BASE_MS * Math.pow(2, attempt - 1) * jitter);
    }
    try {
      const res = await fetch(DDG, {
        method: 'POST',
        headers: {
          'User-Agent': UA_POOL[attempt % UA_POOL.length],
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: query }),
        signal: AbortSignal.timeout(REQ_TIMEOUT),
      });
      // 202/403/418/429 = rate limit / anti-bot. IMPORTANTE: 202 cai dentro do
      // range 200-299 (res.ok === true) — NUNCA tratar como sucesso, mesmo na
      // última tentativa, senão a página de challenge do DDG é parseada como
      // se fosse resultado real (bug anterior: mascarava bloqueio como
      // "not_found" genuíno em vez de `partial: true`).
      if (SERP_BLOCK_STATUSES.includes(res.status)) {
        lastErr = new Error(`DDG bloqueado (HTTP ${res.status})`);
        if (attempt < SERP_RETRIES) continue;
        throw lastErr;
      }
      if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < SERP_RETRIES) continue;
      throw lastErr;
    }
  }
  throw lastErr || new Error('DDG indisponível');
}

function decodeLinks(html) {
  const links = [];
  for (const m of html.matchAll(HREF_RE)) {
    const url = unescapeHtml(m[1]);
    if (!url.toLowerCase().includes('duckduckgo.com')) links.push(url);
  }
  return links;
}

// ── Bing HTML (fallback quando o DDG bloqueia) ───────────────────────────────
// GET simples, sem JS, sem cadastro, sem chave — mesma filosofia do DDG.
// Testado (ago/2026): não ficou bloqueado em nenhuma tentativa (status 200
// sempre), diferente do DDG. LIMITAÇÃO HONESTA: pra nomes de negócio pouco
// conhecidos (a maioria dos leads deste produto), o ranking do Bing às vezes
// erra o alvo — ex.: "Fatima Cabelereiros" retornou resultados sobre a cidade
// de Fátima em Portugal, "Studio Kona" sobre outro assunto qualquer — porque
// o termo mais "forte"/indexado da frase domina a busca. Isso não introduz
// falso positivo de rede social (o link errado raramente é instagram.com/
// facebook.com), só reduz a taxa de "achei" pra nomes ambíguos/pouco famosos
// — o resultado nesse caso é not_found honesto, não um dado errado.
const CITE_RE = /<cite[^>]*>(.*?)<\/cite>/gis;
const TAG_RE = /<[^>]+>/g;

function decodeEntities(str) {
  return unescapeHtml(str).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

async function bingSearch(query) {
  const url = `${BING}?${new URLSearchParams({ q: query, setlang: 'pt-BR', cc: 'BR' })}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA_POOL[0],
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    signal: AbortSignal.timeout(REQ_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  return await res.text();
}

// Extrai as URLs de resultado a partir das tags <cite> do Bing — NÃO dos
// <a href>, que vêm embrulhados num redirect de rastreio (bing.com/ck/a?...)
// sem seguir um hop extra. O <cite> já mostra a URL "de exibição" limpa, no
// formato "https://dominio.com › caminho › quebrado" — reconstituímos pra
// "https://dominio.com/caminho/quebrado".
function decodeCitesBing(html) {
  const links = [];
  for (const m of html.matchAll(CITE_RE)) {
    const texto = decodeEntities(m[1].replace(TAG_RE, '')).replace(/\s*›\s*/g, '/').trim();
    if (/^https?:\/\//i.test(texto)) links.push(texto);
  }
  return links;
}

// Tenta o DDG primeiro (grátis, quando não bloqueado tem boa relevância);
// se falhar/bloquear, cai pro Bing imediatamente (ver nota em SERP_RETRIES).
// `partial` só fica true quando AMBOS falham — ver enrichLead().
async function buscarComFallback(query) {
  try {
    const html = await serp(query);
    return { html, links: decodeLinks(html) };
  } catch {
    const html = await bingSearch(query);
    return { html, links: decodeCitesBing(html) };
  }
}

// ── Filtro de relevância (nome do lead x URL/e-mail achado) ─────────────────
// Necessário desde que o Bing entrou como fallback: pra nomes de negócio
// pouco conhecidos/genéricos, o Bing às vezes retorna resultado de OUTRA
// empresa com nome parecido (ex.: lead "Studio Factory" -> facebook de um
// restaurante em Louisville, EUA; sem relação nenhuma). Exigimos que pelo
// menos uma palavra significativa do nome do lead apareça na URL/domínio
// antes de aceitar como resultado — reduz drasticamente os casos claramente
// errados. LIMITAÇÃO HONESTA: não pega colisão com nome genérico que TAMBÉM
// bate por substring (ex.: lead "Lush" vs a marca global Lush) — isso exigiria
// verificar o conteúdo do perfil/cidade, fora do escopo desta camada.
const GENERIC_TOKENS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'e', '&', 'associados', 'advogados',
  'advocacia', 'studio', 'studío', 'estudio', 'estúdio', 'salao', 'salão',
  'clinica', 'clínica', 'consultorio', 'consultório', 'instituto', 'centro',
  'espaco', 'espaço', 'ateliê', 'atelie', 'casa', 'vila', 'ltda',
  'cabeleireiro', 'cabeleireira', 'cabeleireiros', 'barbearia', 'barbeiro',
  'estetica', 'estética', 'beleza', 'spa', 'academia',
]);

const normalizarNome = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9 ]/g, ' ');

function tokensSignificativos(leadName) {
  return normalizarNome(leadName)
    .split(/\s+/)
    .filter((t) => t && !GENERIC_TOKENS.has(t) && t.length >= 3);
}

// alvo: URL, domínio ou e-mail já em minúsculas/sem acento — checa substring.
function pareceRelacionado(alvo, tokens) {
  if (!tokens.length) return false; // nome genérico demais pra validar com segurança
  const alvoNorm = normalizarNome(alvo).replace(/\s+/g, '');
  return tokens.some((t) => alvoNorm.includes(t));
}

function isOfficialWebsite(url, leadName) {
  const low = url.toLowerCase();
  if (NON_WEBSITE_HOSTS.some((h) => low.includes(h))) return false;

  let host = low.split('//')[1]?.split('/')[0]?.split('?')[0] || '';
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.')) return false;

  const hostClean = host.split('.')[0];
  return pareceRelacionado(hostClean, tokensSignificativos(leadName));
}

function firstSocial(links, domain, bad, tokens) {
  for (const url of links) {
    const low = url.toLowerCase();
    if (low.includes(domain) && !bad.some((b) => low.includes(b)) && pareceRelacionado(url, tokens)) {
      return url.split('?')[0].replace(/\/$/, '');
    }
  }
  return null;
}

// Provedores genéricos (gmail, hotmail etc.) ficam de fora do filtro de
// relevância: é muito comum um negócio pequeno usar e-mail pessoal sem
// relação nenhuma com o nome fantasia, e isso é um contato válido de verdade.
// O filtro de domínio só faz sentido pra domínio PRÓPRIO (aí sim, um domínio
// próprio sem nenhuma palavra do nome do lead é sinal forte de empresa errada).
const EMAIL_PROVIDERS_GENERICOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'icloud.com', 'live.com',
  'msn.com', 'globo.com', 'ig.com.br', 'oi.com.br', 'r7.com',
]);

function firstEmail(html, tokens) {
  if (!html) return null;
  const seen = new Set();
  for (const m of html.matchAll(EMAIL_RE)) {
    const email = m[0];
    const low = email.toLowerCase();
    if (EMAIL_BLOCK.some((ext) => low.endsWith(ext))) continue;
    if (DOMAIN_BLOCK.some((b) => low.includes(b))) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    const dominio = low.split('@')[1] ?? '';
    if (!EMAIL_PROVIDERS_GENERICOS.has(dominio) && !pareceRelacionado(dominio, tokens)) continue;
    return email;
  }
  return null;
}

// ── Lead principal ──────────────────────────────────────────────────────────
export async function enrichLead(input) {
  const { name, city, phone } = input ?? {};
  const start = performance.now();

  const out = {
    email: null, instagram: null, facebook: null, linkedin: null,
    whatsapp: phone || null, confidence: 0.0, partial: false,
    discoveredWebsite: null, linkBroken: null,
  };

  try {
    const budgetOk = () => performance.now() - start < TIMEOUT_LEAD - 1500;

    // ── 1ª SERP (DDG, fallback Bing) ────────────────────────────────────
    const { html, links } = await buscarComFallback(`"${name}" ${city}`);
    const tokens = tokensSignificativos(name);

    // Redes sociais (com bad-filters iguais ao Python + filtro de relevância)
    out.instagram = firstSocial(links, 'instagram.com', ['/p/', '/reel/', '/explore', '/accounts'], tokens);
    out.facebook = firstSocial(links, 'facebook.com', ['/sharer', '/tr?', '/events', '/groups'], tokens);
    out.linkedin = firstSocial(links, 'linkedin.com', ['/posts/', '/feed/'], tokens);

    // E-mail
    out.email = firstEmail(html, tokens);

    // Website oficial (1º que casar)
    for (const url of links) {
      if (isOfficialWebsite(url, name)) {
        out.discoveredWebsite = url.split('?')[0].replace(/\/$/, '');
        break;
      }
    }

    // ── 2ª SERP (só se faltou e-mail) ─────────────────────────────────
    if (!out.email && budgetOk()) {
      try {
        const { html: html2 } = await buscarComFallback(`"${name}" ${city} email contato`);
        out.email = firstEmail(html2, tokens);
      } catch {
        // Falha na 2ª (DDG e Bing) não quebra o resultado parcial
      }
    }

    // ── Link quebrado ─────────────────────────────────────────────────
    if (budgetOk()) {
      const linktreeUrl = links.find((url) =>
        LINKTREE_DOMAINS.some((d) => url.toLowerCase().includes(d))
      );
      if (linktreeUrl) {
        try {
          const r = await fetch(linktreeUrl, {
            method: 'GET',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(3000),
            redirect: 'follow',
          });
          out.linkBroken = r.status >= 400;
        } catch {
          // Erro de rede/timeout → desconhecido, nunca assume quebrado
          out.linkBroken = null;
        }
      }
    }

    const found = [out.email, out.instagram, out.facebook, out.linkedin].filter(Boolean).length;
    out.confidence = found ? Math.round(Math.min(1, 0.55 + 0.15 * found) * 100) / 100 : 0.0;
  } catch {
    out.partial = true;
  }

  return out;
}
