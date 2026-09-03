// Download do cache local de CNPJ (por UF) — descoberta do release GitHub,
// download do .db.gz, descompressão e troca atômica.
//
// O ETL roda no home server do dono do produto (fora deste repo, ver
// scripts/etl-cnpj/) e publica cada ciclo como um release GitHub próprio,
// tag `cnpj-data-YYYY-MM`. NUNCA usar `/releases/latest`: essa rota devolve
// o release mais recente do repo INTEIRO, que hoje é o instalador do app
// (tag `v*`) — pegaríamos o release errado. Por isso listamos releases e
// filtramos pelo prefixo da tag.
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';

const REPO_OWNER = 'd1g4odev';
const REPO_NAME = 'caca-cliente';
const TAG_PREFIX = 'cnpj-data-';
const UA = 'CacaCliente/0.1 (fallback CNPJ; curso Sites com IA do Zero)';

const dataDir = () => process.env.CACA_DATA_DIR ?? path.join(os.homedir(), '.caca-cliente');
export const cacheDir = () => path.join(dataDir(), 'cnpj-cache');
export const dbPathFor = (uf) => path.join(cacheDir(), `${uf.toUpperCase()}.db`);

// Estado de download por UF, consultável pela rota GET /api/cnpj/status/:uf.
// idle: nunca tentado nesta execução · downloading: em progresso ·
// ready: banco local presente e utilizável · unavailable: falhou ou a UF
// não tem cobertura no release mais recente.
const progress = new Map();

export function getStatus(uf) {
  const key = uf.toUpperCase();
  return progress.get(key) ?? { status: existsSync(dbPathFor(key)) ? 'ready' : 'idle', progressPct: 0 };
}

function setStatus(uf, patch) {
  const key = uf.toUpperCase();
  progress.set(key, { ...getStatus(key), ...patch });
}

function githubGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: pathname,
        method: 'GET',
        family: 4,
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub API HTTP ${res.statusCode} em ${pathname}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Ordena por tag (YYYY-MM cresce lexicograficamente) em vez de `published_at`
// — mais robusto a re-publicações/edições de release fora de ordem.
async function findLatestCnpjRelease() {
  const releases = await githubGet(`/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`);
  const candidates = releases.filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith(TAG_PREFIX));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.tag_name.localeCompare(a.tag_name));
  return candidates[0];
}

function downloadTo(url, destPath, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Excesso de redirects no download'));
    const req = https.get(url, { headers: { 'User-Agent': UA }, family: 4 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadTo(res.headers.location, destPath, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] ?? 0);
      let loaded = 0;
      if (total && onProgress) {
        res.on('data', (chunk) => {
          loaded += chunk.length;
          onProgress(loaded / total);
        });
      }
      pipeline(res, createWriteStream(destPath)).then(resolve, reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('Download timeout (2min)')));
    req.on('error', reject);
  });
}

// Dispara o download em BACKGROUND (não bloqueia quem chamou) — chamador
// consulta progresso via getStatus(uf). Não-op se já em andamento ou já pronto.
export function ensureUfDownloaded(uf) {
  const key = uf.toUpperCase();
  const current = getStatus(key);
  if (current.status === 'downloading' || current.status === 'ready') return;

  setStatus(key, { status: 'downloading', progressPct: 0, error: null });
  downloadFlow(key).then(
    () => setStatus(key, { status: 'ready', progressPct: 100, error: null }),
    (e) => {
      console.error(`[cnpj] download ${key} falhou:`, e.message);
      setStatus(key, { status: 'unavailable', progressPct: 0, error: e.message });
    }
  );
}

async function downloadFlow(uf) {
  const release = await findLatestCnpjRelease();
  if (!release) throw new Error(`Nenhum release ${TAG_PREFIX}* publicado ainda.`);

  const assetName = `${uf}.db.gz`;
  const dbAsset = release.assets.find((a) => a.name === assetName);
  if (!dbAsset) throw new Error(`Release ${release.tag_name} não cobre ${uf} ainda (sem ${assetName}).`);

  const finalDbPath = dbPathFor(uf);
  await mkdir(path.dirname(finalDbPath), { recursive: true });
  const gzTmp = `${finalDbPath}.gz.tmp`;
  const dbTmp = `${finalDbPath}.tmp`;

  await downloadTo(dbAsset.browser_download_url, gzTmp, (frac) => setStatus(uf, { progressPct: Math.round(frac * 90) }));

  setStatus(uf, { progressPct: 95 });
  await pipeline(createReadStream(gzTmp), createGunzip(), createWriteStream(dbTmp));
  await rm(gzTmp, { force: true });
  // rename() no mesmo filesystem é atômico — nunca fica um .db pela metade
  // se o processo morrer no meio da descompressão (o .tmp que ficaria órfão).
  await rename(dbTmp, finalDbPath);
}
