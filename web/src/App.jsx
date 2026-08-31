import { useCallback, useEffect, useMemo, useState } from 'react';
import SearchBar from './components/SearchBar.jsx';
import MapPanel from './components/MapPanel.jsx';
import LeadList from './components/LeadList.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import StatsPanel from './components/StatsPanel.jsx';
import MessageSettings from './components/MessageSettings.jsx';
import DispatchMode from './components/DispatchMode.jsx';
import LeadDetails from './components/LeadDetails.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import Onboarding from './components/Onboarding.jsx';
import UpdateModal from './components/UpdateModal.jsx';
import ThemeToggle, { useTheme } from './components/ThemeToggle.jsx';
import Brand from './components/Brand.jsx';
import Welcome from './components/Welcome.jsx';
import { leadScore } from './lib/score.js';
import { lembrarCidade, waLink } from './lib/whatsapp.js';
import { useEnrichmentStream } from './hooks/useEnrichmentStream.js';
import { useLeadMessages } from './hooks/useLeadMessages.js';

const CENTRO_PADRAO = [-30.0427211, -51.1626625]; // Porto Alegre (bairro Bom Jesus)
const hoje = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [search, setSearch] = useState(null); // { searchId, query, stats }
  const [leads, setLeads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('map'); // 'map' | 'kanban' | 'stats'
  const [msgOpen, setMsgOpen] = useState(false); // modal de edição da mensagem do WhatsApp
  const [dispatchLeads, setDispatchLeads] = useState(null); // null = fechado; array = leads em disparo
  const [detailId, setDetailId] = useState(null); // lead aberto no modal de detalhes/CRM
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sortBy, setSortBy] = useState('score'); // 'score' | 'nome'
  // showWithSite começa FALSO: o produto é prospectar quem NÃO tem site,
  // então esconder por padrão quem o enriquecimento detectou que tem.
  const [filters, setFilters] = useState({ phone: false, instagram: false, email: false, showWithSite: false, showFollowUp: false });
  const toggleFilter = (k) => setFilters((f) => ({ ...f, [k]: !f[k] }));
  const [searchError, setSearchError] = useState(null); // erro inline (substitui alert)
  const [patchError, setPatchError] = useState(null); // PATCH falhou no back (ex: DB fora do ar) — a mudança otimista não foi salva
  const [dbWarning, setDbWarning] = useState(null); // aviso de persistência desativada (ver /api/status)
  const [dbWarningDismissed, setDbWarningDismissed] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile: sidebar off-canvas
  const [onboardingOpen, setOnboardingOpen] = useState(() => !localStorage.getItem('captacao.msgConfig'));

  // Persiste o searchId no navegador pra sobreviver a F5: ao montar, tenta
  // reabrir a última busca (ainda em memória do back OU no banco quando ativo).
  // Sem isso, F5 perde tudo — estágios do Kanban, notas, follow-ups, etc.
  useEffect(() => {
    const sid = localStorage.getItem('captacao.lastSearchId');
    if (!sid) return;
    (async () => {
      try {
        const r = await fetch(`/api/search/${encodeURIComponent(sid)}/leads`);
        if (!r.ok) { localStorage.removeItem('captacao.lastSearchId'); return; }
        const data = await r.json();
        setSearch(data);
        setLeads(data.leads);
      } catch {
        localStorage.removeItem('captacao.lastSearchId');
      }
    })();
  }, []);

  // Avisa proativamente (sem precisar abrir "Buscas anteriores") quando a
  // persistência local está desativada — dbKind === 'memory' hoje é sempre
  // uma anomalia (Node desatualizado ou driver que falhou ao abrir o banco),
  // não mais o padrão esperado desde que o SQLite local virou automático.
  useEffect(() => {
    let alive = true;
    fetch('/api/status')
      .then((r) => r.json())
      .then((d) => alive && d.dbEnabled === false && setDbWarning(d.warning ?? null))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Guarda a cidade da busca ativa pro template do WhatsApp ({cidade}).
  // Vale tanto pra busca nova quanto pra busca reaberta do histórico/F5.
  useEffect(() => {
    if (search?.query?.city) lembrarCidade(search.query.city);
  }, [search]);

  // Cinto de segurança: ao selecionar um lead, garante que o mapa fique visível
  // (mobile: sidebar e mapa empilhados). behavior:'auto' pelo mesmo motivo do
  // scroll da lista em LeadList.jsx — 'smooth' é cancelado pelo reflow do
  // stream de enriquecimento (SSE) e o scroll nunca chega a acontecer.
  useEffect(() => {
    if (!selectedId) return;
    document.querySelector('.map-wrap')?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [selectedId]);

  // FASE 1 — busca síncrona: pinos e cards aparecem de imediato
  const runSearch = useCallback(async (params) => {
    setLoading(true);
    setSelectedId(null);
    setSearchError(null);
    setDrawerOpen(false);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Falha na busca');
      const data = await r.json();
      setSearch(data);
      setLeads(data.leads);
      localStorage.setItem('captacao.lastSearchId', data.searchId);
    } catch (e) {
      setSearchError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // FASE 2 — eventos SSE atualizam cards e pinos conforme chegam
  useEnrichmentStream(
    search?.searchId,
    useCallback((evt) => {
      setLeads((prev) =>
        prev.map((l) =>
          l.id === evt.leadId
            ? {
                ...l,
                enrichmentStatus: evt.status,
                enrichment: evt.enrichment,
                // Fallback de endereço (Nominatim) chega best-effort, bem depois do
                // resto — só reaplica quando o evento realmente traz um endereço novo.
                ...(evt.addressSource === 'nominatim' ? { address: evt.address, addressSource: evt.addressSource } : {}),
              }
            : l
        )
      );
    }, [])
  );

  // Fonte única de verdade da seleção: mapa e lista chamam o MESMO handler
  const selectLead = useCallback(
    (id) => {
      setSelectedId(id);
      setDrawerOpen(false); // mobile: fecha o drawer ao selecionar
      const lead = leads.find((l) => l.id === id);
      if (lead?.enrichmentStatus === 'pending' && search) {
        // enriquecimento sob demanda: interagiu → fura a fila
        fetch(`/api/search/${encodeURIComponent(search.searchId)}/leads/${encodeURIComponent(id)}/prioritize`, { method: 'POST' }).catch(() => {});
      }
    },
    [leads, search]
  );

  // Kanban: move o lead de estágio (otimista no front + PATCH no back)
  // Atualiza um lead (estágio do Kanban OU campos de CRM): otimista no front + PATCH no back
  const patchLead = useCallback(
    (leadId, patch) => {
      setLeads((prev) =>
        prev.map((l) => {
          if (l.id !== leadId) return l;
          // instagram/email vão dentro de enrichment (merge, não replace)
          const { instagram, email, ...rest } = patch;
          const updated = { ...l, ...rest };
          if (instagram !== undefined || email !== undefined) {
            updated.enrichment = {
              ...(l.enrichment || {}),
              ...(instagram !== undefined ? { instagram } : {}),
              ...(email !== undefined ? { email } : {}),
            };
            // Se adicionou contato manual, marca como done pra reaparecer no card
            if (instagram || email) updated.enrichmentStatus = 'done';
          }
          return updated;
        })
      );
      if (search) {
        fetch(`/api/search/${encodeURIComponent(search.searchId)}/leads/${encodeURIComponent(leadId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((r) => r.json().catch(() => ({})).then((body) => {
            // fetch só rejeita em falha de rede — 4xx/5xx (ex: DB fora do ar,
            // busca expirada da memória) chegam aqui como "sucesso" e ficavam
            // mudos: o card mostrava a mudança otimista, mas nada era salvo.
            if (!r.ok || body?.ok === false) throw new Error();
          }))
          .catch(() => setPatchError('Não consegui salvar essa alteração agora. Ela pode se perder ao recarregar a página.'));
      }
    },
    [search]
  );
  // Pré-carrega e cacheia (por leadId) as mensagens de abordagem do motor real
  // pra TODA a busca — mesma engine e mesma estratégia de fallback do Modo
  // Disparo (useLeadMessages), só que sem tipo fixo (o motor infere pelo
  // estágio de cada lead) e cobrindo os botões rápidos de WhatsApp em
  // LeadCard/KanbanBoard/MapPanel via resolveWaLink. Só busca pra quem tem
  // WhatsApp válido — sem isso, gastaria requisição em lead que nunca mostra
  // o botão.
  const leadsComWhats = useMemo(
    () => leads.filter((l) => !l.waInvalid && waLink(l.phone, l.name, l.niche)),
    [leads]
  );
  const { getMensagem, invalidate: invalidateMensagem } = useLeadMessages({
    searchId: search?.searchId,
    leads: leadsComWhats,
  });

  // Mudar de estágio (Kanban) pode mudar a mensagem que o motor gera (quando
  // o tipo é inferido automaticamente pelo estágio) — invalida o cache desse
  // lead pra não continuar mostrando a mensagem antiga depois de mover.
  const moveLead = useCallback(
    (leadId, stage) => {
      patchLead(leadId, { stage });
      invalidateMensagem(leadId);
    },
    [patchLead, invalidateMensagem]
  );

  // Reabre uma busca salva (do histórico): re-hidrata do banco e popula a tela
  const openSearch = useCallback(async (searchId) => {
    try {
      const r = await fetch(`/api/search/${encodeURIComponent(searchId)}/leads`);
      if (!r.ok) throw new Error('Não consegui abrir essa busca.');
      const data = await r.json();
      setSearch(data);
      setLeads(data.leads);
      setSelectedId(null);
      setHistoryOpen(false);
      localStorage.setItem('captacao.lastSearchId', searchId);
    } catch (err) {
      alert(err.message);
    }
  }, []);

  const enriched = useMemo(() => leads.filter((l) => l.enrichmentStatus !== 'pending').length, [leads]);
  const overdueCount = useMemo(() => leads.filter((l) => l.followUpAt && l.followUpAt <= hoje()).length, [leads]);

  // Lista exibida = filtrada + ordenada (vale p/ mapa, lista e Kanban)
  const visibleLeads = useMemo(() => {
    let arr = leads.filter((l) => {
      // Esconde leads que o enriquecimento descobriu que TÊM site (falso "sem site" do OSM)
      if (!filters.showWithSite && l.enrichment?.discoveredWebsite) return false;
      // Filtro "só com WhatsApp": exclui sem telefone E waInvalid
      if (filters.phone && (!l.phone || l.waInvalid)) return false;
      // Enquanto o enriquecimento não terminou, não escondemos o lead: ele ainda
      // pode ganhar o contato. Só filtramos quando já existe um veredito.
      if (filters.instagram && l.enrichmentStatus !== 'pending' && !l.enrichment?.instagram) return false;
      if (filters.email && l.enrichmentStatus !== 'pending' && !l.enrichment?.email) return false;
      return true;
    });
    if (filters.showFollowUp) {
      arr = arr.filter((l) => l.followUpAt && l.followUpAt <= hoje());
      return [...arr].sort((a, b) => (a.followUpAt || '').localeCompare(b.followUpAt || ''));
    }
    if (sortBy === 'score') return [...arr].sort((a, b) => leadScore(b) - leadScore(a));
    if (sortBy === 'nome') return [...arr].sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [leads, filters, sortBy]);

  return (
    <>
      <UpdateModal />
      <div className="app">
      <aside className={`sidebar ${drawerOpen ? 'sidebar--open' : ''}`}>
        <header className="sidebar-header">
          <div className="sidebar-header-row">
            <div className="brand-mark">
              <img src="/brand/icon.png" alt="" className="brand-mascot-header" width={32} height={32} />
              <span className="brand-wordmark">
                <h1>Caça-Cliente</h1>
                <span>O radar de negócios sem site</span>
              </span>
            </div>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
          {dbWarning && !dbWarningDismissed && (
            <div className="db-warning db-warning--banner" role="alert">
              <strong>⚠️ Persistência local desativada.</strong>
              <p>{dbWarning}</p>
              <button type="button" className="link-btn" onClick={() => setDbWarningDismissed(true)}>ok, entendi</button>
            </div>
          )}
          <SearchBar onSearch={runSearch} loading={loading} activeSearchId={search?.searchId} activeQuery={search?.query} />
          {searchError && (
            <div className="search-error" role="alert">
              <strong>Não consegui buscar agora.</strong> {searchError}
              <button type="button" onClick={() => setSearchError(null)} aria-label="fechar">✕</button>
            </div>
          )}
          {patchError && (
            <div className="search-error" role="alert">
              <strong>⚠️ {patchError}</strong>
              <button type="button" onClick={() => setPatchError(null)} aria-label="fechar">✕</button>
            </div>
          )}
          <div className="view-toggle">
            <button type="button" className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
              🗺 Mapa
            </button>
            <button type="button" className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
              🗂 Kanban
            </button>
            <button type="button" className={view === 'stats' ? 'active' : ''} onClick={() => setView('stats')}>
              📊 Painel
            </button>
          </div>
          <button type="button" className="msg-edit-btn" onClick={() => setMsgOpen(true)}>
            ✏️ Editar mensagem do WhatsApp
          </button>
          <button type="button" className="msg-edit-btn" onClick={() => setHistoryOpen(true)}>
            🕑 Buscas anteriores
          </button>
          {search && search.stats.found === 0 && (
            // OSM tem cobertura desigual: alguns ramos têm zero cadastro no Brasil.
            // Empreiteira, construtora e contabilidade são os campeões de "0 found".
            <div className="empty-coverage" role="alert">
              <strong>Nenhum estabelecimento desse tipo no raio.</strong>
              <p>
                O OpenStreetMap depende de voluntários e a cobertura varia muito por ramo.
                Nichos com bom cadastro no Brasil: <em>restaurante, barbearia, padaria, dentista, salão de beleza, mecânica, pet shop</em>.
                Ramos como <em>empreiteira, construtora, contabilidade</em> geralmente têm cobertura quase zero.
              </p>
              <p className="muted">Sugestão: troque o nicho ou aumente o raio.</p>
            </div>
          )}
          {search && search.stats.found > 0 && (
            <>
              <p className="stats">
                <strong>{visibleLeads.length}</strong>
                {visibleLeads.length !== leads.length ? ` de ${leads.length}` : ''} sem site (de{' '}
                {search.stats.found} no raio) · <strong>{enriched}/{leads.length}</strong> enriquecidos
              </p>
              {leads.length > 0 && (
                <>
                  <div className="exports">
                    <span>Exportar:</span>
                    <a href={`/api/search/${encodeURIComponent(search.searchId)}/export?format=csv`} download>
                      CSV
                    </a>
                    <a href={`/api/search/${encodeURIComponent(search.searchId)}/export?format=xlsx`} download>
                      Excel
                    </a>
                  </div>
                  <div className="controls">
                    <label className="sort">
                      Ordenar
                      <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                        <option value="score">Relevância (score)</option>
                        <option value="nome">Nome</option>
                      </select>
                    </label>
                    <div className="filter-chips">
                      <button type="button" className={filters.phone ? 'on' : ''} onClick={() => toggleFilter('phone')}>
                        📞 WhatsApp
                      </button>
                      <button type="button" className={filters.instagram ? 'on' : ''} onClick={() => toggleFilter('instagram')}>
                        📷 Instagram
                      </button>
                      <button type="button" className={filters.email ? 'on' : ''} onClick={() => toggleFilter('email')}>
                        ✉️ E-mail
                      </button>
                      <button
                        type="button"
                        className={filters.showWithSite ? 'on' : ''}
                        onClick={() => toggleFilter('showWithSite')}
                        title="Por padrão escondemos quem o enriquecimento descobriu que TEM site. Marque pra ver todos."
                      >
                        ⚠️ Incluir quem tem site
                      </button>
                      {overdueCount > 0 && (
                        <button type="button" className={filters.showFollowUp ? 'on' : ''} onClick={() => toggleFilter('showFollowUp')}>
                          🔔 {overdueCount} retorno{overdueCount > 1 ? 's' : ''} pendente{overdueCount > 1 ? 's' : ''}
                        </button>
                      )}
                    </div>
                  </div>
                  <button type="button" className="dispatch-btn" onClick={() => setDispatchLeads(visibleLeads)}>
                    🚀 Modo disparo ({visibleLeads.filter((l) => l.phone).length})
                  </button>
                </>
              )}
            </>
          )}
        </header>
        {!search && !loading ? (
          <Welcome />
        ) : (
          <LeadList leads={visibleLeads} selectedId={selectedId} onSelect={selectLead} onOpenDetails={setDetailId} loading={loading} getMensagem={getMensagem} />
        )}
        <Brand />
      </aside>

      <main className="map-wrap">
        <div className="mobile-bar">
          <button type="button" className="menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Abrir menu">
            ☰
          </button>
        </div>
        {drawerOpen && <div className="backdrop" onClick={() => setDrawerOpen(false)} />}
        {view === 'map' && (
          <MapPanel
            center={search ? [search.query.lat, search.query.lng] : CENTRO_PADRAO}
            radiusKm={search?.query.radiusKm}
            leads={visibleLeads}
            selectedId={selectedId}
            onSelect={selectLead}
            searchId={search?.searchId}
            getMensagem={getMensagem}
          />
        )}
        {view === 'kanban' && (
          <KanbanBoard leads={visibleLeads} selectedId={selectedId} onSelect={selectLead} onMove={moveLead} onDispatch={setDispatchLeads} getMensagem={getMensagem} />
        )}
        {view === 'stats' && <StatsPanel leads={leads} />}
      </main>

      <MessageSettings open={msgOpen} onClose={() => setMsgOpen(false)} />
      {dispatchLeads && (
        <DispatchMode
          leads={dispatchLeads}
          searchId={search?.searchId}
          onContacted={(id) => moveLead(id, 'contatado')}
          onClose={() => setDispatchLeads(null)}
        />
      )}
      {detailId && (
        <LeadDetails
          lead={leads.find((l) => l.id === detailId)}
          searchId={search?.searchId}
          onSave={(patch) => patchLead(detailId, patch)}
          onClose={() => setDetailId(null)}
        />
      )}
      {historyOpen && <HistoryPanel onOpen={openSearch} onClose={() => setHistoryOpen(false)} />}
      {onboardingOpen && <Onboarding onDone={() => setOnboardingOpen(false)} />}
    </div></>
  );
}
