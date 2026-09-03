import { useEffect, useRef } from 'react';

// Consome o stream SSE de uma busca. O EventSource reconecta sozinho se a
// conexão cair, e o servidor faz replay do que já foi enriquecido ao
// (re)conectar — nenhum evento se perde.
//
// NÃO fecha no evento 'done': ele só significa que o enriquecimento principal
// (telefone/email/instagram) settou pra todo mundo. O fallback de CNPJ tem um
// geocode assíncrono à parte (Nominatim, 1 req/seg compartilhado — de propósito
// desacoplado do await principal pra não travar a fila) que resolve lat/lng
// bem depois disso e manda seu próprio evento 'enrichment' — se a gente
// fechasse aqui, esse evento nunca chegaria e o pino ficaria preso pra sempre
// na posição aproximada (centro da cidade). O efeito já fecha a conexão
// sozinho na limpeza (troca de busca ou desmontagem).
export function useEnrichmentStream(searchId, onEvent) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!searchId) return;
    const es = new EventSource(`/api/search/${encodeURIComponent(searchId)}/stream`);
    es.addEventListener('enrichment', (e) => cb.current(JSON.parse(e.data)));
    return () => es.close();
  }, [searchId]);
}
