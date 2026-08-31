// Proteção SSRF pro webhook (POST /api/search/:id/webhook): o usuário informa
// uma URL arbitrária e o servidor faz o fetch — sem essa checagem, dá pra usar
// o Caça-Cliente como proxy pra bater em serviços internos (localhost, rede
// privada, endpoint de metadata de cloud 169.254.169.254 etc).
//
// Cobre o caso comum (URL/host literal apontando pra dentro) resolvendo o DNS
// antes do fetch. Não protege contra DNS rebinding (resolver outro IP entre a
// checagem e o fetch de fato) — mitigação suficiente pro escopo deste projeto
// (ferramenta de curso, não SaaS multi-tenant de alta exposição).

import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true; // formato estranho -> bloqueia
  const [a, b] = parts;
  if (a === 0) return true; // "esta rede"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (inclui metadata de cloud)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  return false;
}

function isPrivateIPv6(ip) {
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true; // loopback / unspecified
  if (low.startsWith('fe80:')) return true; // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local (fc00::/7)
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIPv4(ip);
  if (type === 6) return isPrivateIPv6(ip);
  return true; // não é um IP reconhecível -> bloqueia por segurança
}

// Lança se a URL apontar (literalmente ou via DNS) pra um endereço interno/privado.
export async function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('URL inválida.');
  }
  const hostname = u.hostname;
  if (hostname.toLowerCase() === 'localhost') throw new Error('destino interno bloqueado');

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('destino interno bloqueado');
    return;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error('não foi possível resolver o host.');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('destino interno bloqueado');
  }
}
