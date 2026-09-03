import { useEffect, useRef, useState } from 'react';

// Cidade inicial para o app já funcionar sem digitar nada.
// Centro deslocado p/ o bairro Bom Jesus (leste de Porto Alegre).
const DEFAULT_CITY = { label: 'Porto Alegre, Rio Grande do Sul', lat: -30.0427211, lng: -51.1626625 };

// Lembra a última cidade escolhida/buscada (objeto completo, não só o nome)
// pra reabrir o app já com o campo pré-preenchido em vez de sempre cair no
// DEFAULT_CITY fixo.
const LAST_SEARCH_CITY_KEY = 'captacao.lastSearchCity';

function loadLastSearchCity() {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_CITY_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c && typeof c.label === 'string' && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return c;
  } catch { /* localStorage indisponível ou dado corrompido: ignora */ }
  return null;
}

function saveLastSearchCity(city) {
  try {
    if (city?.label && Number.isFinite(city.lat) && Number.isFinite(city.lng)) {
      localStorage.setItem(LAST_SEARCH_CITY_KEY, JSON.stringify({ label: city.label, lat: city.lat, lng: city.lng, uf: city.uf }));
    }
  } catch { /* ignora */ }
}

// Nichos pré-definidos (atalhos rápidos para os ramos que mais prospectam negócios sem site).
// "Outros" libera o input pra digitar livremente. Lista ordenada por bom encaixe
// no perfil de "negócio físico sem site" + cobertura no OpenStreetMap.
const NICHE_PRESETS = [
  { label: 'Advocacia', value: 'advocacia' },
  { label: 'Salão de beleza', value: 'salão de beleza' },
  { label: 'Manicure', value: 'manicure' },
  { label: 'Barbearia', value: 'barbearia' },
  { label: 'Estética', value: 'estética' },
  { label: 'Empreiteira', value: 'empreiteira' },
  { label: 'Construtora', value: 'construtora' },
  { label: 'Mecânica', value: 'mecânica' },
  { label: 'Dentista', value: 'dentista' },
  { label: 'Clínica médica', value: 'clínica médica' },
  { label: 'Psicologia', value: 'psicólogo' },
  { label: 'Nutricionista', value: 'nutricionista' },
  { label: 'Fisioterapia', value: 'fisioterapia' },
  { label: 'Academia', value: 'academia' },
  { label: 'Pet shop / Veterinária', value: 'pet shop' },
  { label: 'Restaurante', value: 'restaurante' },
  { label: 'Lanchonete', value: 'lanchonete' },
  { label: 'Pizzaria', value: 'pizzaria' },
  { label: 'Padaria', value: 'padaria' },
  { label: 'Imobiliária', value: 'imobiliária' },
  { label: 'Contabilidade', value: 'contabilidade' },
  { label: 'Arquitetura', value: 'arquitetura' },
  { label: 'Floricultura', value: 'floricultura' },
  { label: 'Ótica', value: 'ótica' },
];

export default function SearchBar({ onSearch, loading, activeSearchId, activeQuery }) {
  const [niche, setNiche] = useState('salão de beleza');
  // 'preset' = um dos atalhos selecionado · 'outros' = input livre · '' = indefinido
  const [preset, setPreset] = useState('salão de beleza');
  const initialCity = loadLastSearchCity() || DEFAULT_CITY;
  const [cityQuery, setCityQuery] = useState(initialCity.label);
  const [selectedCity, setSelectedCity] = useState(initialCity);
  const [suggestions, setSuggestions] = useState([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [radiusKm, setRadiusKm] = useState(5);
  const blurTimer = useRef(null);

  // Autocomplete via Nominatim/OSM (grátis). Debounce de 450ms para respeitar a
  // política de uso (nada de request a cada tecla) e poupar a rede.
  useEffect(() => {
    if (selectedCity && selectedCity.label === cityQuery) return; // já escolhida
    const q = cityQuery.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    setGeoLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const { results } = await r.json();
        setSuggestions(results ?? []);
        setOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setGeoLoading(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [cityQuery, selectedCity]);

  // Reabrir uma busca do histórico (ou restaurá-la ao dar F5) troca o `search`
  // ativo no App sem passar pelo submit() daqui — sem isso o formulário ficava
  // "preso" nos últimos valores digitados, divergindo da busca realmente aberta
  // (ex: reabre Recife, mas o campo de cidade continua mostrando a última
  // cidade buscada por este componente).
  useEffect(() => {
    if (!activeQuery) return;
    const isPreset = NICHE_PRESETS.some((p) => p.value === activeQuery.niche);
    setPreset(isPreset ? activeQuery.niche : 'outros');
    setNiche(activeQuery.niche ?? '');
    setCityQuery(activeQuery.city ?? '');
    setSelectedCity({ label: activeQuery.city, lat: activeQuery.lat, lng: activeQuery.lng, uf: activeQuery.uf });
    if (activeQuery.radiusKm) setRadiusKm(activeQuery.radiusKm);
    saveLastSearchCity({ label: activeQuery.city, lat: activeQuery.lat, lng: activeQuery.lng, uf: activeQuery.uf });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSearchId]);

  function chooseCity(s) {
    setSelectedCity(s);
    setCityQuery(s.label);
    setSuggestions([]);
    setOpen(false);
    saveLastSearchCity(s);
  }

  async function submit(e) {
    e.preventDefault();
    let city = selectedCity;
    // Não escolheu na lista? Geocodifica o texto digitado e usa o 1º resultado.
    if (!city || city.label !== cityQuery) {
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(cityQuery)}`);
        const { results } = await r.json();
        if (!results?.length) return alert('Cidade não encontrada. Tente outro nome.');
        city = results[0];
      } catch {
        return alert('Não consegui localizar a cidade agora. Tente de novo.');
      }
    }
    saveLastSearchCity(city);
    // uf vem do geocode (2 letras) — opcional: alimenta o fallback de CNPJ no
    // back quando o OSM não tem cobertura. Ausente = back degrada sem CNPJ.
    onSearch({ niche, city: city.label, lat: city.lat, lng: city.lng, radiusKm, uf: city.uf });
  }

  function chooseNiche(v) {
    setPreset(v);
    if (v !== 'outros') setNiche(v); // preset escolhido = nicho definido
    else setNiche(''); // "Outros" -> limpa pra ele digitar
  }

  return (
    <form className="search-bar" onSubmit={submit} autoComplete="off">
      <select className="niche-select" value={preset} onChange={(e) => chooseNiche(e.target.value)} required>
        {NICHE_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        <option value="outros">Outros (digite)</option>
      </select>
      {preset === 'outros' && (
        <input
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          placeholder='Digite o nicho (ex: "dentista", "academia")'
          autoFocus
          required
        />
      )}

      <div className="city-field">
        <input
          value={cityQuery}
          onChange={(e) => {
            setCityQuery(e.target.value);
            setSelectedCity(null);
          }}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => (blurTimer.current = setTimeout(() => setOpen(false), 150))}
          placeholder="Cidade ou região"
          required
        />
        {open && (suggestions.length > 0 || geoLoading) && (
          <ul className="suggestions">
            {geoLoading && <li className="suggestion muted">buscando cidades…</li>}
            {suggestions.map((s, i) => (
              <li key={`${s.label}-${i}`} className="suggestion" onMouseDown={() => chooseCity(s)}>
                📍 {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="radius">
        Raio: <strong>{radiusKm} km</strong>
        <input type="range" min="1" max="30" value={radiusKm} onChange={(e) => setRadiusKm(+e.target.value)} />
      </label>

      <button disabled={loading}>{loading ? 'Buscando…' : 'Buscar leads sem site'}</button>
    </form>
  );
}
