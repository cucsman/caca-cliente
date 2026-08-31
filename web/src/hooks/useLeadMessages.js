import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mensagemFallbackManual } from '../lib/nome.js';
import { aplicarPerfil } from '../lib/whatsapp.js';

// Hook único que gera e cacheia mensagens de abordagem via o motor real
// (server/src/prospector/), usado tanto pelo Modo Disparo (tipo:'abordagem',
// fila selecionada) quanto pelos botões rápidos de WhatsApp no resto do app
// (tipo omitido — o motor infere pelo estágio do lead — cobrindo TODOS os
// leads da busca que têm telefone). Uma única implementação = uma única
// fonte de verdade; antes disso os botões rápidos geravam a mensagem
// localmente (template fixo em whatsapp.js), divergindo do que o motor real
// produzia (e carregando os mesmos bugs corrigidos só de um lado).
//
// Estratégia (em ordem de preferência), igual antes:
//   1) POST /api/search/:searchId/messages/batch  (lote — mais eficiente)
//   2) POST /api/leads/:leadId/message             (individual, com cache)
//   3) Fallback pro template legado (mensagemFallbackManual) com aviso visual
//
// Cache: Map<leadId, {mensagem, angulo, proximaAcao, fonte}> — persiste
// enquanto o hook estiver montado (não rebusca o mesmo lead à toa).
//
// fonte: 'motor' | 'fallback'
export function useLeadMessages({ searchId, leads, tipo }) {
  const cache = useRef(new Map());
  const leadsRef = useRef(leads);
  leadsRef.current = leads;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [usedFallback, setUsedFallback] = useState(false);
  // Só serve pra forçar re-render quando o cache (useRef, não observado pelo
  // React) muda — getMensagem lê direto do Map, não deste estado.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const fallbackPara = useCallback(
    (lead, motivo) => ({
      mensagem: aplicarPerfil(mensagemFallbackManual(lead.name, lead.niche, Boolean(lead.enrichment?.discoveredWebsite))),
      angulo: null,
      proximaAcao: null,
      fonte: 'fallback',
      motivo,
    }),
    []
  );

  // Busca e cacheia UM lead via endpoint individual (com fallback embutido).
  // Usado tanto pelo lote (quando um leadId falha dentro dele) quanto pra
  // invalidar/rebuscar um lead pontual (ex: mudou de estágio no Kanban).
  const fetchOne = useCallback(
    async (lead) => {
      try {
        const qs = new URLSearchParams();
        if (searchId) qs.set('searchId', searchId);
        if (tipo) qs.set('tipo', tipo);
        const q = qs.toString();
        const url = `/api/leads/${encodeURIComponent(lead.id)}/message${q ? `?${q}` : ''}`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        cache.current.set(lead.id, {
          mensagem: aplicarPerfil(data.mensagem),
          angulo: data.angulo,
          proximaAcao: data.proximaAcao,
          fonte: 'motor',
        });
      } catch (e) {
        cache.current.set(lead.id, fallbackPara(lead, e?.message));
        setUsedFallback(true);
      }
      bump();
    },
    [searchId, tipo, fallbackPara, bump]
  );

  // Descarta o cache de um lead e rebusca — usado quando um campo que afeta
  // a geração muda por fora (ex: estágio do Kanban, quando tipo é 'auto' e o
  // motor infere o ângulo pelo estágio: sem isso, um lead que virou
  // "contatado" continuaria mostrando a mensagem de 1ª abordagem em cache).
  const invalidate = useCallback(
    (leadId) => {
      cache.current.delete(leadId);
      const lead = leadsRef.current?.find((l) => l.id === leadId);
      if (lead) fetchOne(lead);
    },
    [fetchOne]
  );

  // Chave estável derivada só dos ids: evita reprocessar o efeito a cada
  // atualização de enriquecimento via SSE (leads é um array novo a cada
  // evento, mas o CONJUNTO de ids da busca não muda depois da FASE 1).
  const leadIdsKey = useMemo(() => (leads ?? []).map((l) => l.id).join(','), [leads]);

  useEffect(() => {
    const lista = leadsRef.current ?? [];
    const pendentes = lista.filter((l) => !cache.current.has(l.id));
    if (!pendentes.length) return;
    let cancelled = false;
    const idsMarcados = pendentes.map((l) => l.id);

    async function gerarLote() {
      setLoading(true);
      setError(null);
      for (const l of pendentes) cache.current.set(l.id, { loading: true });

      if (searchId) {
        try {
          const ids = pendentes.map((l) => l.id);
          const CHUNK = 50;
          const chunks = [];
          for (let k = 0; k < ids.length; k += CHUNK) chunks.push(ids.slice(k, k + CHUNK));

          for (const chunk of chunks) {
            if (cancelled) return;
            const r = await fetch(`/api/search/${encodeURIComponent(searchId)}/messages/batch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...(tipo ? { tipo } : {}), leadIds: chunk }),
            });
            if (r.ok) {
              const data = await r.json();
              if (cancelled) return;
              for (const g of data.geracoes || []) {
                cache.current.set(g.leadId, {
                  mensagem: aplicarPerfil(g.mensagem),
                  angulo: g.angulo,
                  proximaAcao: g.proximaAcao,
                  fonte: 'motor',
                });
              }
              for (const f of data.falhas || []) {
                const lead = pendentes.find((l) => l.id === f.leadId);
                if (lead) cache.current.set(lead.id, fallbackPara(lead, f.erro));
                if (lead) setUsedFallback(true);
              }
              bump(); // progressivo: cada chunk já resolvido aparece na hora
            } else if (r.status !== 404 && r.status !== 501) {
              throw new Error(`Lote falhou: ${r.status}`);
            } else {
              // 404/501 = endpoint de lote ainda não implementado pelo Turbina → individual
              break;
            }
          }
          if (!cancelled) {
            setLoading(false);
            return;
          }
        } catch {
          // cai para o endpoint individual abaixo
        }
      }

      // Fallback: endpoint individual com cache (só quem ainda ficou marcado 'loading')
      try {
        await Promise.all(
          pendentes.map(async (lead) => {
            if (cancelled) return;
            if (cache.current.has(lead.id) && !cache.current.get(lead.id).loading) return;
            await fetchOne(lead);
          })
        );
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      }
    }

    gerarLote();
    return () => {
      cancelled = true;
      // Se essa invocação foi cancelada ANTES do fetch resolver — acontece
      // sempre em dev por causa do double-invoke do StrictMode (mount→cleanup
      // →mount síncrono, bem mais rápido que qualquer rede) — os placeholders
      // {loading:true} que ela deixou não podem sobreviver: a invocação
      // seguinte veria esses ids como "já em cache" e nunca rebuscaria,
      // travando a mensagem em "gerando…" pra sempre. Reproduzido e confirmado.
      for (const id of idsMarcados) {
        if (cache.current.get(id)?.loading) cache.current.delete(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchId, leadIdsKey, tipo]);

  const getMensagem = useCallback((leadId) => cache.current.get(leadId), []);

  return { loading, error, usedFallback, getMensagem, invalidate };
}
