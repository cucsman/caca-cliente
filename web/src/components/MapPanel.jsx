import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import { resolveWaLink } from '../lib/whatsapp.js';

// Pino via divIcon (CSS puro): a cor reflete o status do enriquecimento em
// tempo real E evita o problema clássico dos assets do ícone padrão do
// Leaflet em bundlers (Vite/Webpack).
function pinIcon(status, selected) {
  const cls = ['pin', `pin--${status}`, selected ? 'pin--selected' : ''].join(' ');
  return L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

// MapContainer ignora mudanças de `center` após montar (props imutáveis).
// Recentralizar é responsabilidade destes dois componentes imperativos:

function FitToResults({ leads, center, searchId }) {
  const map = useMap();
  useEffect(() => {
    // Leads do fallback CNPJ chegam com lat/lng null (latMissing: true) até o
    // geocode assíncrono resolver — [null,null] vira (0,0) pro Leaflet (não
    // lança erro), o que faria o mapa dar zoom out até incluir a Ilha Null
    // (0°N 0°E), no meio do Atlântico. Filtra antes de calcular os limites.
    const comCoordenada = leads.filter((l) => l.lat != null && l.lng != null);
    if (!comCoordenada.length) {
      map.setView(center, 13);
      return;
    }
    map.fitBounds(L.latLngBounds(comCoordenada.map((l) => [l.lat, l.lng])), { padding: [48, 48] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchId]); // roda 1x por busca, não a cada update de lead
  return null;
}

function FlyToSelected({ leads, center, selectedId }) {
  const map = useMap();
  useEffect(() => {
    const lead = leads.find((l) => l.id === selectedId);
    if (!lead) return;
    // Mesmo caso de latMissing do FitToResults/LeadMarker: sem coordenada
    // própria ainda, voa pro centro da cidade em vez da Ilha Null (0,0).
    const position = lead.lat != null && lead.lng != null ? [lead.lat, lead.lng] : center;
    map.flyTo(position, Math.max(map.getZoom(), 15), { duration: 0.8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]); // só dispara quando a seleção muda, busca o lead no array completo
  return null;
}

function LeadMarker({ lead, center, selected, onSelect, getMensagem }) {
  const ref = useRef(null);
  const icon = useMemo(() => pinIcon(lead.enrichmentStatus, selected), [lead.enrichmentStatus, selected]);
  const wa = resolveWaLink(lead, getMensagem);
  // Lead do fallback CNPJ sem coordenada própria ainda (latMissing) — usa o
  // centro da cidade buscada como posição provisória, pra o pino não sumir
  // do mapa (o geocode assíncrono corrige isso via SSE quando resolver).
  const aproximado = lead.lat == null || lead.lng == null;
  const position = aproximado ? center : [lead.lat, lead.lng];

  useEffect(() => {
    if (selected) ref.current?.openPopup();
  }, [selected]);

  return (
    <Marker
      ref={ref}
      position={position}
      icon={icon}
      opacity={aproximado ? 0.6 : 1}
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(lead.id) }}
    >
      <Popup autoPan={false}>
        <strong>{lead.name}</strong>
        <br />
        {lead.phone ?? 'telefone não informado'}
        {aproximado && (
          <>
            <br />
            <em>📍 localização aproximada (centro da cidade) — endereço exato ainda sendo localizado</em>
          </>
        )}
        {lead.rating != null && (
          <>
            <br />⭐ {lead.rating} ({lead.reviewsCount} avaliações)
          </>
        )}
        {wa && (
          <>
            <br />
            <a href={wa} target="_blank" rel="noreferrer">
              💬 Chamar no WhatsApp
            </a>
          </>
        )}
      </Popup>
    </Marker>
  );
}

export default function MapPanel({ center, radiusKm, leads, selectedId, onSelect, searchId, getMensagem }) {
  return (
    <MapContainer center={center} zoom={13} className="map" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {radiusKm && (
        <Circle center={center} radius={radiusKm * 1000} pathOptions={{ color: '#1f6feb', weight: 1, fillOpacity: 0.04 }} />
      )}
      {leads.map((l) => (
        <LeadMarker key={l.id} lead={l} center={center} selected={l.id === selectedId} onSelect={onSelect} getMensagem={getMensagem} />
      ))}
      <FitToResults leads={leads} center={center} searchId={searchId} />
      <FlyToSelected leads={leads} center={center} selectedId={selectedId} />
    </MapContainer>
  );
}
