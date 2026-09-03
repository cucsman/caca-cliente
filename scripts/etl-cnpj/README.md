# ETL CNPJ — fallback de dados via Receita Federal

Gera as bases `{UF}.db.gz` que o `cnpjProvider.js` (`server/src/data/`) baixa
sob demanda quando o OpenStreetMap não tem cobertura suficiente pra um
nicho/cidade (ver plano do fallback CNPJ — arquitetura completa, contrato do
`cnpjProvider.js`, rota de status, dedup, etc.).

**Este script roda FORA do app, manualmente, no home server do dono do
produto — nunca no PC de um aluno nem em CI gratuito.** O dado bruto da
Receita descompactado (~17-25GB, cresce com o tempo — confirmado ao vivo em
set/2026: cada uma das 10 partes de Estabelecimentos já tem ~2GB sozinha) é
temporário: baixado, filtrado, e apagado depois de gerar a saída compacta
por UF. Só a saída filtrada (poucos nichos, poucos campos, situação ativa)
é publicada — ver seção "Publicar o release" abaixo.

## Adaptado de rictom/cnpj-sqlite

Este ETL é uma **adaptação**, não um port 1:1, de
[rictom/cnpj-sqlite](https://github.com/rictom/cnpj-sqlite) (mesma fonte de
dado, mesmo mecanismo de descoberta/download via WebDAV — confirmado
funcionando ao vivo em set/2026, depois da mudança de layout do portal em
fev/2026 que o próprio rictom já tinha corrigido). Diferenças deliberadas:

- **Filtra na leitura** (situação `ATIVA` + CNAE principal numa lista de
  ~25 códigos — ver `cnaes.json`/`nicheGroups.js`) em vez de carregar as
  ~60 milhões de linhas pra um banco único de 30GB. O volume sobrevivente é
  pequeno o bastante pra não precisar de pandas/dask — só biblioteca padrão
  do Python (`csv`, `sqlite3`, `zipfile`) + `requests` pro download.
- **Não baixa nem processa Sócios (10 arquivos grandes) nem Simples** — o
  app não usa esses dados. Só baixa Estabelecimentos (10 partes),
  Empresas (10 partes, só pra resolver razão social) e Municípios (1
  arquivo pequeno, tabela de referência).
- **Particiona por UF** (um `.db` por estado) em vez de um banco nacional
  único — o aluno baixa só o(s) estado(s) que pesquisa.
- Schema final enxuto — só os campos que o app consome (ver
  `processar.CREATE_TABLE_SQL`), não o dump bruto normalizado em 4 tabelas.

## O que este script NÃO faz (limitação conhecida, intencional)

Esta sessão não tem acesso ao home server (ZimaOS) do dono do produto nem
consegue baixar/processar os ~17-25GB de dado real da Receita. **A LÓGICA
foi escrita e validada** (ver seção "Como foi validado" abaixo) contra uma
amostra sintética no formato exato dos arquivos reais + contra a tabela de
referência de Municípios baixada de verdade (pequena, ~43KB). **A rodada de
produção completa (baixar os ~21GB reais, processar, publicar o primeiro
release) ainda precisa ser feita pelo dono do produto no home server dele**
— ver "Verificação" no plano original.

## Pré-requisitos

```
pip install -r requirements.txt
```

Só precisa de `requests` — nada de pandas/dask/parfive (ver seção acima).
Python 3.9+.

## Como rodar (produção real)

```bash
# 1. Gera cnaes.json a partir de server/src/data/nicheGroups.js (SEMPRE antes
#    de processar — nicheGroups.js é a fonte única da verdade pro mapeamento
#    nicho->CNAE; rode de novo se ele mudar).
node exportar_cnaes.mjs

# 2. Baixa da Receita só Estabelecimentos/Empresas/Municipios (pula
#    Sócios/Simples/outras referências não usadas). ~21GB, pode levar horas
#    dependendo da conexão. Roda no home server, não no seu PC.
python3 baixar.py --saida dados-brutos/

# 3. Filtra + junta + particiona por UF. Gera {UF}.db, {UF}.db.gz e
#    {UF}.manifest.json em saida/.
python3 processar.py --entrada dados-brutos/ --saida saida/
```

Depois de rodar, **confirme o tamanho real de cada `{UF}.db.gz` gerado**
antes de travar qualquer timeout/UX no cliente (o plano é explícito sobre
isso — a estimativa de "dezenas a poucas centenas de MB por UF" ainda não
foi validada contra dado real).

## Publicar o release

Conforme o plano: publicar `{UF}.db.gz` + `{UF}.manifest.json` de cada UF
processada como assets de um release do GitHub com tag `cnpj-data-YYYY-MM`
(**nunca** `v*`, que já é usado pelos instaladores do app — o
`cnpjDownload.js` do Alicerce descobre o release certo filtrando por
prefixo de tag, não usando `/releases/latest`). Exemplo:

```bash
gh release create cnpj-data-2026-09 saida/PR.db.gz saida/PR.manifest.json \
  --title "Base CNPJ — 2026-09" \
  --notes "Estabelecimentos ativos, CNAEs mapeados em nicheGroups.js (versão $(node -e "console.log(require('./cnaes.json').geradoEm)"))."
```

## Como foi validado (sem acesso ao dado real completo)

```bash
python3 testes/teste_processar.py
```

Roda `exportar_cnaes.mjs`, gera uma amostra sintética
(`testes/gerar_amostra.py`) no formato EXATO dos arquivos da Receita
(mesmas colunas/ordem/delimitador `;`/encoding `latin1` de `*.ESTABELE` e
`*.EMPRECSV` — confirmado contra o dicionário de dados oficial
[cnpj-metadados.pdf](https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf)
e o [código-fonte de rictom/cnpj-sqlite](https://github.com/rictom/cnpj-sqlite/blob/main/dados_cnpj_para_sqlite.py)),
cobrindo os casos de borda que o filtro/join/particionamento precisam
acertar:

- estabelecimento ATIVO com CNAE alvo → entra;
- estabelecimento BAIXADO com CNAE alvo → **não** entra (situação erra o
  filtro mesmo com CNAE certo);
- estabelecimento ATIVO com CNAE fora da lista → **não** entra;
- dois estados diferentes → gera dois `.db` separados;
- telefone: usa ddd1/telefone1, cai pra ddd2/telefone2 se o primeiro estiver
  vazio;
- estabelecimento sem correspondência no arquivo de Empresas → não trava o
  join, `razao_social` fica `None`;
- linha CSV corrompida (menos colunas que o esperado) → descartada, não
  derruba o lote inteiro;
- schema da tabela gerada bate exatamente com o do plano;
- `.db.gz` descomprime pro mesmo conteúdo do `.db`;
- a query que o `cnpjProvider.js` vai rodar (`cnae IN (...) AND municipio =
  ?`) funciona contra o banco gerado.

Além da amostra sintética, `baixar.py` foi testado **ao vivo** contra o
endpoint real da Receita nesta sessão (sem baixar os arquivos grandes):
descoberta do último mês disponível (`2026-08` no momento deste commit),
listagem e filtro correto dos 21 arquivos necessários (exclui os 10 de
Sócios + Simples + 5 tabelas de referência não usadas), e download+
descompactação real do `Municipios.zip` (pequeno, ~43KB) — confirmando que
`processar.carregar_municipios()` lê o arquivo REAL da Receita
corretamente (5572 municípios, ex.: código 7107 → "SAO PAULO").

**Não testado nesta sessão** (fora do alcance, ~21GB): download completo
de Estabelecimentos/Empresas, processamento em escala, tamanho/tempo reais
da rodada de produção.

## Mapeamento CNAE — confiança e revisão

Ver comentários em `server/src/data/nicheGroups.js`. Validado código por
código contra a tabela oficial CONCLA/IBGE (o `cnpj-metadados.pdf` só
documenta o *layout* dos arquivos — confirma que CNAE é uma tabela de
domínio separada, mas não lista os códigos em si). Dois grupos com
confiança menor, sinalizados no próprio arquivo: "construção civil" (reúne
vários ofícios com CNAE próprio — eletricista, encanador, pintor — mapeado
só com construção geral + alvenaria) e "estética/beleza" (não cobre bem
spa/massagem terapêutica isolada). Revisar antes de confiar 100% no volume
desses nichos.
