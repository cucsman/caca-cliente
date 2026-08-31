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

// Janela de texto bruto ao redor de um match no HTML (título+trecho do
// resultado de busca ficam fisicamente perto do link/e-mail na fonte, tanto
// no DDG quanto no Bing) — usada pra checar CIDADE, não só a URL/domínio.
// Ver nota grande em `relevante()` sobre por que isso passou a ser exigido.
// Ver `relevanteUrl()`/`relevanteContexto()` mais abaixo pra como isso é usado.
// Radius assimétrico calibrado contra HTML real do Bing: o <cite> geralmente
// vem ANTES do título/trecho do resultado (às vezes >500 chars depois, por
// causa do markup de favicon/ícone entre eles — testado com "Mocotó" São
// Paulo, onde a menção à cidade só aparecia ~530 chars depois do <cite>).
// Resultados consecutivos ficam ~1700-1900 chars separados, então até ~900
// pra frente ainda fica dentro do mesmo bloco, sem vazar pro próximo.
const CTX_RADIUS_ANTES = 300;
const CTX_RADIUS_DEPOIS = 900;
function contextoDoMatch(html, index, matchLen) {
  const ini = Math.max(0, index - CTX_RADIUS_ANTES);
  const fim = Math.min(html.length, index + matchLen + CTX_RADIUS_DEPOIS);
  return normalizarNome(html.slice(ini, fim).replace(/<[^>]+>/g, ' '));
}

function decodeLinks(html) {
  const links = [];
  for (const m of html.matchAll(HREF_RE)) {
    const url = unescapeHtml(m[1]);
    if (url.toLowerCase().includes('duckduckgo.com')) continue;
    links.push({ url, ctx: contextoDoMatch(html, m.index, m[0].length) });
  }
  return links;
}

// ── Bing HTML (fallback quando o DDG bloqueia) ───────────────────────────────
// GET simples, sem JS, sem cadastro, sem chave — mesma filosofia do DDG.
// Testado (ago/2026): não ficou bloqueado em nenhuma tentativa (status 200
// sempre), diferente do DDG.
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
    if (/^https?:\/\//i.test(texto)) {
      links.push({ url: texto, ctx: contextoDoMatch(html, m.index, m[0].length) });
    }
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

// ── Filtro de relevância (nome+cidade do lead x resultado achado) ───────────
// QA (Faro) confirmou em teste real (31 leads, "salão de beleza" Curitiba)
// que a versão anterior deste filtro (só nome x URL) é PIOR que não ter
// filtro nenhum: 4/4 contatos "achados" eram falso-positivo E COM CONFIANÇA
// (enrichmentStatus 'done') — Facebook de uma página de turismo de SP,
// e-mail de uma imobiliária não relacionada, Instagram/Facebook de OUTRO
// negócio homônimo em outra cidade, Instagram de uma cantora famosa — e de
// quebra o Instagram real do lead (mesmo endereço) nem foi considerado
// porque o primeiro "match" fraco já tinha vencido a busca. Causa raiz:
// aceitar UMA palavra do nome batendo na URL, sem olhar cidade nenhuma, e
// (bug à parte) e-mails de provedor genérico (gmail etc.) puladores do
// filtro por completo — foi exatamente como "reiimobiliaria@gmail.com" foi
// aceito pro lead "Rei dos Cosméticos".
//
// Fix: agora exigimos NOME na própria URL/domínio (não só citado no texto ao
// redor — ver relevanteUrl) e, quando só 1 palavra bateu, CIDADE corroborando
// no texto ao redor também. Pra e-mail de provedor genérico, a identidade não
// tem URL própria, então a checagem é invertida: nome E cidade no texto ao
// redor (ver relevanteContexto). Tokens de nome curtos (<5 letras) não contam
// sozinhos — é sinal fraco demais pra um envio de mensagem no mundo real.
//
// A checagem de cidade sozinha NÃO basta quando a palavra que bateu é uma
// categoria de negócio (não uma marca): testando contra dados reais, "Padaria
// Bella Paulista" (São Paulo) bateu em "benjaminpadaria.com.br" — outra
// padaria, DIFERENTE, também genuinamente em São Paulo — porque "padaria" não
// tava na blacklist e sozinha já "bate nome" + "bate cidade" sem identificar
// negócio nenhum específico (existem centenas de padarias em São Paulo).
// Por isso a blacklist agora cobre também palavras de CATEGORIA de negócio
// (padaria, restaurante, ótica, imobiliária etc.), não só palavras de estilo
// de nome (studio/espaço/empório). Nomes formados SÓ por categoria + conector
// (ex.: "Empório da Beleza", sem nenhuma palavra própria) ficam sem token
// nenhum e o lead vira not_found honesto — aceitável e intencional: se nem um
// humano conseguiria distinguir esse negócio de outro do mesmo tipo na mesma
// cidade só pelo nome, o sistema também não deve arriscar.
const GENERIC_TOKENS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'e', '&', 'associados', 'advogados',
  'advocacia', 'studio', 'studío', 'estudio', 'estúdio', 'salao', 'salão',
  'clinica', 'clínica', 'consultorio', 'consultório', 'instituto', 'centro',
  'espaco', 'espaço', 'ateliê', 'atelie', 'casa', 'vila', 'ltda', 'eireli',
  'mei', 'cia',
  'cabeleireiro', 'cabeleireira', 'cabeleireiros', 'barbearia', 'barbeiro',
  'barbeira', 'estetica', 'estética', 'beleza', 'spa', 'academia',
  'emporio', 'empório', 'emporium', 'cosmeticos', 'cosméticos',
  'sobrancelha', 'maquiagem', 'maquiadora', 'manicure', 'pedicure',
  'depilacao', 'depilação',
  'restaurante', 'pizzaria', 'lanchonete', 'cafeteria', 'padaria',
  'confeitaria', 'doceria', 'sorveteria', 'hamburgueria', 'acai', 'açaí',
  'hotel', 'pousada', 'mercado', 'mercearia', 'supermercado', 'drogaria',
  'farmacia', 'farmácia', 'otica', 'ótica', 'petshop', 'pet', 'shop', 'loja',
  'boutique', 'oficina', 'auto', 'imobiliaria', 'imobiliária', 'escritorio',
  'escritório', 'agencia', 'agência', 'construtora', 'distribuidora',
  'representacoes', 'representações', 'comercio', 'comércio',
]);

// Tokens de nome com menos de 5 letras (ex.: "rei", "casa") são sinal fraco
// demais pra usar sozinhos — foi assim que "reiimobiliaria@gmail.com" quase
// colou pro lead "Rei dos Cosméticos" (ver nota acima).
const MIN_TOKEN_LEN = 5;
// Cidade é um sinal auxiliar, não o nome do negócio — mantém o limiar mais
// baixo (nomes de cidade curtos como "Foz" ainda devem contar).
const MIN_TOKEN_LEN_CIDADE = 3;

const normalizarNome = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9 ]/g, ' ');

function tokensSignificativos(leadName) {
  return normalizarNome(leadName)
    .split(/\s+/)
    .filter((t) => t && !GENERIC_TOKENS.has(t) && t.length >= MIN_TOKEN_LEN);
}

// A cidade normalmente chega como "Curitiba, PR" (geocode.js) — cada palavra
// vira um token candidato; a UF sozinha (2 letras) fica de fora por ser curta
// demais pra bater em texto livre com segurança.
function tokensCidade(cidade) {
  return normalizarNome(cidade)
    .split(/\s+/)
    .filter((t) => t && t.length >= MIN_TOKEN_LEN_CIDADE);
}

// QA (Faro) re-testou em produção (Curitiba, 31 leads) depois do fix acima e
// achou uma regressão nova: ~29% dos leads (9/31) têm nome formado só por
// palavras curtas/categoria que a blacklist remove (ex.: "Rei dos
// Cosméticos", "Ari Barbearia", "City's Cabeleireiros", "Salão J.R.") —
// tokensSignificativos fica vazio e o lead cai em not_found SEMPRE, mesmo
// quando o Bing tem o resultado certo. Isso troca falso-positivo por
// inelegibilidade permanente, o que também não serve.
//
// Fallback: quando não sobra token específico, usa o NOME INTEIRO (sem
// filtrar categoria/tamanho) como âncora. Uma frase de várias palavras
// batendo por completo é específica o bastante sozinha — é bem improvável um
// resultado errado repetir "rei dos cosmeticos" inteiro por coincidência,
// mesmo que cada palavra isolada seja genérica.
function nomeCompletoFallback(leadName) {
  const frase = normalizarNome(leadName).replace(/\s+/g, ' ').trim();
  return { frase, concatenado: frase.replace(/\s+/g, '') };
}

// Pra URL/domínio (site oficial, rede social): a IDENTIDADE é a própria URL,
// então o nome do lead precisa aparecer NELA — não basta o texto ao redor
// mencionar o lead de passagem. Sem essa exigência, uma galeria/diretório que
// só CITA o negócio (ex.: guiadasemana.com.br numa matéria "padarias em São
// Paulo" que lista várias padarias, entre elas a do lead) passava como se
// fosse o site oficial, só porque o nome aparecia no texto da matéria.
//
// 2+ tokens ESPECÍFICOS do nome batendo na própria URL é coincidência
// improvável o bastante pra aceitar sem checar cidade (palavras específicas
// de verdade, tipo "bella"+"paulista", não se repetem por acaso). Com só 1
// token específico, exige cidade corroborando no texto ao redor — sinal
// fraco demais sozinho (foi assim que "emporium"/"citys" colaram em negócios
// de OUTRA cidade nos 4 falso-positivo do Faro).
//
// Sem token específico nenhum (nome só de categoria+conector — ver
// nomeCompletoFallback), tenta o nome INTEIRO — mas aqui SEMPRE exige cidade,
// mesmo batendo na própria URL: um nome genérico de várias palavras ainda
// pode ser reaproveitado por outra unidade/filial/homônimo em cidade
// diferente, só com um sufixo mudando no handle (achado testando "Rei dos
// Cosméticos": o handle "reidoscosmeticossp" bate o nome inteiro por
// completo mas é doutra cidade — sem checar cidade aqui, colaria de novo).
function relevanteUrl(alvo, ctx, nomeTokens, nomeCompleto, cidadeTokens) {
  const alvoNorm = normalizarNome(alvo).replace(/\s+/g, '');
  const ctxNorm = ctx || '';

  const tokensNaUrl = nomeTokens.filter((t) => alvoNorm.includes(t));
  if (tokensNaUrl.length >= 2) return true;
  if (tokensNaUrl.length === 1) {
    return cidadeTokens.length > 0 && cidadeTokens.some((t) => ctxNorm.includes(t));
  }

  // Nenhum token específico bateu (ou não sobrou nenhum pra checar) — última
  // tentativa com o nome inteiro, sempre exigindo cidade.
  const bateNomeCompleto = (nomeCompleto.concatenado.length >= 6 && alvoNorm.includes(nomeCompleto.concatenado))
    || (nomeCompleto.frase && ctxNorm.includes(nomeCompleto.frase));
  if (!bateNomeCompleto || !cidadeTokens.length) return false;
  return cidadeTokens.some((t) => ctxNorm.includes(t));
}

// Pra e-mail de provedor genérico (gmail, hotmail etc.): o ENDEREÇO em si não
// diz nada — é comum e legítimo um negócio pequeno usar e-mail pessoal sem
// nenhuma relação com o nome fantasia. A evidência de que aquele e-mail é
// DESSE lead só pode vir do texto ao redor mencionar nome E cidade dele —
// sem isso, um e-mail de outro anúncio na mesma página de resultados (achado
// real de QA: "reiimobiliaria@gmail.com", de uma imobiliária, atribuído ao
// lead "Rei dos Cosméticos") cola no lead errado. Mesmo fallback de nome
// inteiro que relevanteUrl quando não sobra token específico.
function relevanteContexto(ctx, nomeTokens, nomeCompleto, cidadeTokens) {
  if (!cidadeTokens.length) return false;
  const ctxNorm = ctx || '';
  if (!cidadeTokens.some((t) => ctxNorm.includes(t))) return false;
  if (nomeTokens.length) return nomeTokens.some((t) => ctxNorm.includes(t));
  return Boolean(nomeCompleto.frase) && ctxNorm.includes(nomeCompleto.frase);
}

function isOfficialWebsite({ url, ctx }, nomeTokens, nomeCompleto, cidadeTokens) {
  const low = url.split('?')[0].toLowerCase();
  if (NON_WEBSITE_HOSTS.some((h) => low.includes(h))) return false;

  let host = low.split('//')[1]?.split('/')[0] || '';
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.')) return false;

  const hostClean = host.split('.')[0];
  return relevanteUrl(hostClean, ctx, nomeTokens, nomeCompleto, cidadeTokens);
}

function firstSocial(links, domain, bad, nomeTokens, nomeCompleto, cidadeTokens) {
  for (const { url, ctx } of links) {
    const low = url.toLowerCase();
    if (!low.includes(domain)) continue;
    if (bad.some((b) => low.includes(b))) continue;
    // Corta a query string antes de checar relevância: parâmetros de
    // rastreio (utm_source=... etc.) podiam injetar texto e inflar match.
    if (!relevanteUrl(url.split('?')[0], ctx, nomeTokens, nomeCompleto, cidadeTokens)) continue;
    return url.split('?')[0].replace(/\/$/, '');
  }
  return null;
}

const EMAIL_PROVIDERS_GENERICOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'icloud.com', 'live.com',
  'msn.com', 'globo.com', 'ig.com.br', 'oi.com.br', 'r7.com',
]);

function firstEmail(html, nomeTokens, nomeCompleto, cidadeTokens) {
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
    const ctx = contextoDoMatch(html, m.index, m[0].length);
    // Domínio próprio (não gmail/hotmail/etc.): mesma lógica de URL — exige
    // nome do lead no domínio. Provedor genérico: exige nome+cidade no texto
    // ao redor (ver relevanteContexto).
    const ok = EMAIL_PROVIDERS_GENERICOS.has(dominio)
      ? relevanteContexto(ctx, nomeTokens, nomeCompleto, cidadeTokens)
      : relevanteUrl(dominio, ctx, nomeTokens, nomeCompleto, cidadeTokens);
    if (!ok) continue;
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
    const nomeCompleto = nomeCompletoFallback(name);
    const cidadeTokens = tokensCidade(city);

    // Redes sociais (com bad-filters iguais ao Python + filtro de relevância nome+cidade)
    out.instagram = firstSocial(links, 'instagram.com', ['/p/', '/reel/', '/explore', '/accounts'], tokens, nomeCompleto, cidadeTokens);
    out.facebook = firstSocial(links, 'facebook.com', ['/sharer', '/tr?', '/events', '/groups'], tokens, nomeCompleto, cidadeTokens);
    out.linkedin = firstSocial(links, 'linkedin.com', ['/posts/', '/feed/'], tokens, nomeCompleto, cidadeTokens);

    // E-mail
    out.email = firstEmail(html, tokens, nomeCompleto, cidadeTokens);

    // Website oficial (1º que casar)
    for (const item of links) {
      if (isOfficialWebsite(item, tokens, nomeCompleto, cidadeTokens)) {
        out.discoveredWebsite = item.url.split('?')[0].replace(/\/$/, '');
        break;
      }
    }

    // ── 2ª SERP (só se faltou e-mail) ─────────────────────────────────
    if (!out.email && budgetOk()) {
      try {
        const { html: html2 } = await buscarComFallback(`"${name}" ${city} email contato`);
        out.email = firstEmail(html2, tokens, nomeCompleto, cidadeTokens);
      } catch {
        // Falha na 2ª (DDG e Bing) não quebra o resultado parcial
      }
    }

    // ── Link quebrado ─────────────────────────────────────────────────
    if (budgetOk()) {
      const linktreeItem = links.find(({ url }) =>
        LINKTREE_DOMAINS.some((d) => url.toLowerCase().includes(d))
      );
      if (linktreeItem) {
        try {
          const r = await fetch(linktreeItem.url, {
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
