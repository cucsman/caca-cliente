// Taxonomia de nichos compartilhada entre osmProvider.js (tags OSM/Overpass)
// e cnpjProvider.js (fallback via base pública de CNPJ da Receita Federal).
// Extraído de osmProvider.js pra evitar duas listas de radicais de nicho
// divergindo (ver docs/plano do fallback CNPJ).
//
// `kw` são radicais SEM acento (casamos por substring contra o nicho
// normalizado, ver server/src/utils/text.js). Vários grupos podem casar e
// somar tags/cnae.
//
// `cnae`: mapeamento nicho -> CNAE (Classificação Nacional de Atividades
// Econômicas), formato oficial "0000-0/00". Validado em set/2026 por busca
// contra a tabela oficial CONCLA/IBGE (concla.ibge.gov.br) — o PDF
// https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf documenta só o
// LAYOUT dos arquivos (confirma que CNAE vem como tabela de domínio
// separada, código+descrição; não lista os códigos em si), então a validação
// real foi feita contra o cadastro CONCLA, código por código. Ainda assim é
// um PRIMEIRO mapeamento — cada grupo cobre vários CNAEs próximos, mas a
// Receita permite só 1 CNAE principal por estabelecimento, então negócios
// reais podem estar classificados num CNAE vizinho não listado aqui. Grupos
// que cobrem várias OCUPAÇÕES/OFÍCIOS distintos por natureza (ex.: construção
// civil reúne pedreiro/eletricista/encanador/pintor, cada um com CNAE
// próprio) têm confiança menor — marcados abaixo. Revalidar antes do ETL de
// produção, especialmente esses.
export const NICHE_GROUPS = [
  {
    kw: ['estetic', 'beleza', 'salao', 'manicure', 'depila', 'sobrancelha', 'cabelei', 'barbear', 'barbeiro', 'spa', 'maquia', 'unha'],
    tags: ['shop=beauty', 'shop=hairdresser', 'shop=massage', 'leisure=spa', 'shop=cosmetics'],
    // 9602-5/01 cabeleireiros/manicure/pedicure; 9602-5/02 estética/depilação/maquiagem.
    // Não cobre bem "spa"/massagem terapêutica isolada nem venda de cosméticos
    // (shop=cosmetics é comércio varejista, não serviço) — confiança média.
    cnae: ['9602-5/01', '9602-5/02'],
  },
  {
    kw: ['advog', 'advocacia', 'jurid'],
    tags: ['office=lawyer'],
    cnae: ['6911-7/01'], // Serviços advocatícios — validado (caso motivador do plano)
  },
  {
    kw: ['nutri'],
    tags: ['healthcare=nutrition', 'amenity=doctors'],
    cnae: ['8650-0/06'], // Atividades de nutricionistas
  },
  {
    kw: ['dent', 'odonto'],
    tags: ['amenity=dentist', 'healthcare=dentist'],
    cnae: ['8630-5/04'], // Atividade odontológica
  },
  {
    kw: ['clinic', 'consultor', 'medic', 'saude'],
    tags: ['amenity=clinic', 'healthcare=clinic', 'amenity=doctors'],
    // 8630-5/01 ambulatorial com cirurgia; /02 com exames complementares; /03 só consultas.
    cnae: ['8630-5/01', '8630-5/02', '8630-5/03'],
  },
  {
    kw: ['academia', 'fitness', 'crossfit', 'pilates', 'muscula'],
    tags: ['leisure=fitness_centre', 'leisure=sports_centre'],
    cnae: ['9313-1/00'], // Atividades de condicionamento físico
  },
  {
    kw: ['restaurante', 'lanchonete', 'pizz', 'hamburg', 'cafe', 'bistro', 'padaria', 'comida'],
    tags: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe', 'shop=bakery'],
    cnae: ['5611-2/01', '5611-2/03', '4721-1/02'], // restaurantes; lanchonetes; padaria (varejo)
  },
  {
    kw: ['pet', 'veterin'],
    tags: ['amenity=veterinary', 'shop=pet'],
    cnae: ['7500-1/00', '4789-0/06'], // atividades veterinárias; comércio varejista de animais/pet shop
  },
  {
    kw: ['contab', 'contador'],
    tags: ['office=accountant'],
    cnae: ['6920-6/01'], // Atividades de contabilidade
  },
  {
    kw: ['imobili', 'corretor', 'imovel'],
    tags: ['office=estate_agent'],
    cnae: ['6821-8/01', '6821-8/02'], // corretagem compra/venda; corretagem aluguel
  },
  {
    kw: ['arquitet'],
    tags: ['office=architect'],
    cnae: ['7111-1/00'], // Serviços de arquitetura
  },
  {
    kw: ['psicol', 'terapeut', 'terapia'],
    tags: ['healthcare=psychotherapist', 'office=therapist'],
    cnae: ['8650-0/03'], // Atividades de psicologia e psicanálise
  },
  {
    kw: ['fisio'],
    tags: ['healthcare=physiotherapist'],
    cnae: ['8650-0/05'], // Atividades de fisioterapia
  },
  {
    kw: ['otica', 'oculos'],
    tags: ['shop=optician'],
    cnae: ['4774-1/00'], // Comércio varejista de artigos de óptica
  },
  {
    kw: ['mecanic', 'funilaria', 'oficina', 'autocenter'],
    tags: ['shop=car_repair', 'craft=car_repair'],
    cnae: ['4520-0/01'], // Manutenção e reparação mecânica de veículos
  },
  {
    // Construção civil: empreiteiras, construtoras, reformas — reúne vários
    // ofícios com CNAE próprio (eletricista, encanador, pintor...). Confiança
    // BAIXA: mapeamento cobre só construção geral + alvenaria; validar contra
    // CONCLA antes do ETL de produção, principalmente se o volume de leads
    // desse nicho for relevante.
    kw: ['empreit', 'construt', 'reform', 'pedreir', 'engenh'],
    tags: [
      'office=construction_company', 'craft=builder', 'craft=carpenter',
      'craft=electrician', 'craft=plumber', 'craft=painter',
      'craft=tiler', 'craft=roofer', 'shop=trade',
    ],
    cnae: ['4120-4/00', '4399-1/03'], // construção de edifícios; obras de alvenaria
  },
  {
    kw: ['floricult', 'flor'],
    tags: ['shop=florist'],
    cnae: ['4789-0/02'], // Comércio varejista de plantas e flores naturais
  },
];
