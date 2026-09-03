#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
processar.py — núcleo do ETL do fallback CNPJ (Caça-Cliente).

Adaptado de rictom/cnpj-sqlite (https://github.com/rictom/cnpj-sqlite), que
converte os dumps públicos da Receita Federal pra SQLite. Diferenças
deliberadas da adaptação (não é o mesmo script com find&replace):

1. Filtra NA LEITURA (situação ATIVA + CNAE principal numa lista pequena de
   ~25 códigos, ver cnaes.json) em vez de carregar as ~60 milhões de linhas
   pra depois filtrar — o volume sobrevivente é pequeno o bastante pra não
   precisar de pandas/dask (rictom usa as duas por causa do volume total).
   Só dependência: biblioteca padrão do Python (csv, sqlite3, zipfile) +
   `requests` pro download (ver baixar.py).
2. NÃO carrega as tabelas Sócios/Simples (o app não usa esses dados) — só
   Estabelecimentos (endereço/contato/CNAE) e Empresas (razão social, via
   join em 2 passos por cnpj_basico, já que razão social só existe no
   arquivo Empresas, não no de Estabelecimentos).
3. Particiona a saída por UF (um .db por estado) em vez de um cnpj.db único
   — o app baixa só o(s) estado(s) que o aluno pesquisa.
4. Schema final enxuto (só os campos que o app consome), não o dump bruto.

Uso:
    python3 processar.py --entrada dados-brutos/ --saida saida/ --cnaes cnaes.json

Espera em --entrada arquivos *.ESTABELE e *.EMPRECSV já descompactados (ver
baixar.py) mais um *.MUNICCSV (tabela de referência de município). Layout de
colunas confirmado contra o dicionário de dados oficial
(cnpj-metadados.pdf) e o código-fonte de rictom/cnpj-sqlite.
"""
import argparse
import csv
import gzip
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

# ── Layout das colunas (confirmado contra cnpj-metadados.pdf + rictom/cnpj-sqlite) ──
COLUNAS_ESTABELECIMENTO = [
    'cnpj_basico', 'cnpj_ordem', 'cnpj_dv', 'matriz_filial',
    'nome_fantasia', 'situacao_cadastral', 'data_situacao_cadastral',
    'motivo_situacao_cadastral', 'nome_cidade_exterior', 'pais',
    'data_inicio_atividades', 'cnae_fiscal', 'cnae_fiscal_secundaria',
    'tipo_logradouro', 'logradouro', 'numero', 'complemento', 'bairro',
    'cep', 'uf', 'municipio',
    'ddd1', 'telefone1', 'ddd2', 'telefone2', 'ddd_fax', 'fax',
    'correio_eletronico', 'situacao_especial', 'data_situacao_especial',
]
COLUNAS_EMPRESA = [
    'cnpj_basico', 'razao_social', 'natureza_juridica',
    'qualificacao_responsavel', 'capital_social_str', 'porte_empresa',
    'ente_federativo_responsavel',
]

SITUACAO_ATIVA = '2'  # ver cnpj-metadados.pdf: 01-NULA, 2-ATIVA, 3-SUSPENSA, 4-INAPTA, 08-BAIXADA

CREATE_TABLE_SQL = """
CREATE TABLE estabelecimentos (
  cnpj TEXT PRIMARY KEY, razao_social TEXT, nome_fantasia TEXT, cnae TEXT NOT NULL,
  logradouro TEXT, numero TEXT, complemento TEXT, bairro TEXT, cep TEXT,
  municipio TEXT NOT NULL, uf TEXT NOT NULL,
  telefone TEXT, email TEXT, situacao_cadastral TEXT, data_situacao TEXT
);
"""
CREATE_INDEX_SQL = "CREATE INDEX idx_cnae_municipio ON estabelecimentos(cnae, municipio);"


def normalizar_cnae(valor):
    """'6911-7/01' ou '6911701' -> '6911701' (só dígitos). O csv da Receita
    grava o CNAE sem pontuação; nicheGroups.js usa o formato oficial
    pontuado — comparamos sempre pela forma só-dígitos."""
    return re.sub(r'\D', '', valor or '')


def carregar_cnaes(caminho_json):
    """Lê o snapshot gerado por exportar_cnaes.mjs a partir de
    server/src/data/nicheGroups.js. Devolve (set_de_cnaes_normalizados, versao)."""
    with open(caminho_json, encoding='utf-8') as f:
        dados = json.load(f)
    cnaes = {normalizar_cnae(c) for c in dados['todosCnaes']}
    return cnaes, dados['geradoEm']


def carregar_municipios(caminho_csv):
    """MUNICCSV: codigo;descricao, sem cabeçalho, latin1. Devolve dict
    codigo(str) -> nome do município (só o nome — a UF já vem em coluna
    própria no arquivo de estabelecimentos, não precisa resolver aqui)."""
    municipios = {}
    with open(caminho_csv, encoding='latin1', newline='') as f:
        for linha in csv.reader(f, delimiter=';'):
            if len(linha) < 2:
                continue
            municipios[linha[0].strip()] = linha[1].strip()
    return municipios


def _monta_logradouro(tipo, nome):
    partes = [p.strip() for p in (tipo, nome) if p and p.strip()]
    return ' '.join(partes)


def _monta_telefone(ddd1, tel1, ddd2, tel2):
    if ddd1 and tel1:
        return f'({ddd1}) {tel1}'
    if ddd2 and tel2:
        return f'({ddd2}) {tel2}'
    return None


def ler_estabelecimentos(caminhos_csv, cnaes_alvo, municipios):
    """Lê um ou mais arquivos *.ESTABELE, filtra situação ATIVA + CNAE
    principal na lista alvo, devolve dict cnpj(14 dígitos) -> registro
    parcial (falta razao_social, resolvido depois via Empresas).
    """
    registros = {}
    for caminho in caminhos_csv:
        with open(caminho, encoding='latin1', newline='') as f:
            for linha in csv.reader(f, delimiter=';'):
                if len(linha) < len(COLUNAS_ESTABELECIMENTO):
                    continue  # linha corrompida/incompleta — descarta, não trava o lote
                campo = dict(zip(COLUNAS_ESTABELECIMENTO, linha))

                if campo['situacao_cadastral'].strip() != SITUACAO_ATIVA:
                    continue
                cnae = normalizar_cnae(campo['cnae_fiscal'])
                if cnae not in cnaes_alvo:
                    continue

                cnpj = f"{campo['cnpj_basico']}{campo['cnpj_ordem']}{campo['cnpj_dv']}"
                municipio_nome = municipios.get(campo['municipio'].strip(), campo['municipio'].strip())
                registros[cnpj] = {
                    'cnpj': cnpj,
                    'cnpj_basico': campo['cnpj_basico'],
                    'razao_social': None,  # resolvido no passo 2 (arquivo Empresas)
                    'nome_fantasia': campo['nome_fantasia'].strip() or None,
                    'cnae': cnae,
                    'logradouro': _monta_logradouro(campo['tipo_logradouro'], campo['logradouro']) or None,
                    'numero': campo['numero'].strip() or None,
                    'complemento': campo['complemento'].strip() or None,
                    'bairro': campo['bairro'].strip() or None,
                    'cep': campo['cep'].strip() or None,
                    'municipio': municipio_nome,
                    'uf': campo['uf'].strip(),
                    'telefone': _monta_telefone(
                        campo['ddd1'].strip(), campo['telefone1'].strip(),
                        campo['ddd2'].strip(), campo['telefone2'].strip(),
                    ),
                    'email': campo['correio_eletronico'].strip().lower() or None,
                    'situacao_cadastral': 'ATIVA',
                    'data_situacao': campo['data_situacao_cadastral'].strip() or None,
                }
    return registros


def enriquecer_razao_social(caminhos_csv, registros):
    """Segunda passada: lê Empresas (razão social só existe lá) e preenche
    só os registros que sobreviveram ao filtro do passo 1 — nunca carrega
    a tabela Empresas inteira em memória, só o que precisa. `registros` é
    mutado in-place."""
    por_basico = {}
    for cnpj, reg in registros.items():
        por_basico.setdefault(reg['cnpj_basico'], []).append(cnpj)

    pendentes = set(por_basico.keys())
    for caminho in caminhos_csv:
        if not pendentes:
            break
        with open(caminho, encoding='latin1', newline='') as f:
            for linha in csv.reader(f, delimiter=';'):
                if len(linha) < len(COLUNAS_EMPRESA):
                    continue
                basico = linha[0].strip()
                if basico not in pendentes:
                    continue
                razao_social = linha[1].strip() or None
                for cnpj in por_basico[basico]:
                    registros[cnpj]['razao_social'] = razao_social
                pendentes.discard(basico)


def gravar_bancos_por_uf(registros, pasta_saida, cnae_version):
    """Agrupa por UF, grava um .db SQLite por estado (schema exato do
    plano) + manifest.json. Devolve lista de manifests gerados."""
    os.makedirs(pasta_saida, exist_ok=True)
    por_uf = {}
    for reg in registros.values():
        por_uf.setdefault(reg['uf'], []).append(reg)

    manifests = []
    for uf, linhas in sorted(por_uf.items()):
        if not uf or len(uf) != 2:
            continue  # UF ausente/inválida na fonte — não sabemos particionar, descarta
        caminho_db = os.path.join(pasta_saida, f'{uf}.db')
        if os.path.exists(caminho_db):
            os.remove(caminho_db)  # rodada limpa — não acumula de execuções anteriores

        conn = sqlite3.connect(caminho_db)
        try:
            conn.execute(CREATE_TABLE_SQL)
            conn.executemany(
                """INSERT INTO estabelecimentos
                   (cnpj, razao_social, nome_fantasia, cnae, logradouro, numero,
                    complemento, bairro, cep, municipio, uf, telefone, email,
                    situacao_cadastral, data_situacao)
                   VALUES (:cnpj, :razao_social, :nome_fantasia, :cnae, :logradouro,
                           :numero, :complemento, :bairro, :cep, :municipio, :uf,
                           :telefone, :email, :situacao_cadastral, :data_situacao)""",
                linhas,
            )
            conn.execute(CREATE_INDEX_SQL)
            conn.commit()
        finally:
            conn.close()

        tamanho_bytes = os.path.getsize(caminho_db)
        manifest = {
            'uf': uf,
            'rows': len(linhas),
            'sizeBytes': tamanho_bytes,
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'cnaeVersion': cnae_version,
        }
        with open(os.path.join(pasta_saida, f'{uf}.manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        manifests.append(manifest)

        # Comprime pro formato de distribuição (ver plano: {UF}.db.gz nos assets do release).
        with open(caminho_db, 'rb') as f_in, gzip.open(f'{caminho_db}.gz', 'wb') as f_out:
            f_out.writelines(f_in)

    return manifests


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--entrada', required=True, help='Pasta com os CSVs já descompactados (*.ESTABELE, *.EMPRECSV, *.MUNICCSV)')
    ap.add_argument('--saida', required=True, help='Pasta onde gravar {UF}.db, {UF}.db.gz e {UF}.manifest.json')
    ap.add_argument('--cnaes', default=os.path.join(os.path.dirname(__file__), 'cnaes.json'),
                     help='JSON gerado por exportar_cnaes.mjs (default: cnaes.json ao lado deste script)')
    args = ap.parse_args()

    def achar(padrao):
        import glob
        return sorted(glob.glob(os.path.join(args.entrada, padrao)))

    print(time.asctime(), 'Carregando lista de CNAEs alvo...')
    cnaes_alvo, cnae_version = carregar_cnaes(args.cnaes)
    print(f'  {len(cnaes_alvo)} códigos CNAE alvo (versão {cnae_version}).')

    arquivos_municipio = achar('*MUNICCSV*') + achar('*MUNIC*.csv')
    if not arquivos_municipio:
        sys.exit(f'Nenhum arquivo de referência de município encontrado em {args.entrada} (esperado *MUNICCSV*).')
    print(time.asctime(), 'Carregando tabela de municípios...')
    municipios = carregar_municipios(arquivos_municipio[0])
    print(f'  {len(municipios)} municípios carregados.')

    arquivos_estabele = achar('*ESTABELE*') + achar('*.estabelecimentos*.csv')
    if not arquivos_estabele:
        sys.exit(f'Nenhum arquivo de Estabelecimentos encontrado em {args.entrada} (esperado *ESTABELE*).')
    print(time.asctime(), f'Lendo {len(arquivos_estabele)} arquivo(s) de Estabelecimentos (passo 1/2: filtro)...')
    registros = ler_estabelecimentos(arquivos_estabele, cnaes_alvo, municipios)
    print(f'  {len(registros)} estabelecimentos sobreviveram ao filtro (ATIVA + CNAE alvo).')

    arquivos_empresas = achar('*EMPRECSV*') + achar('*.empresas*.csv')
    if not arquivos_empresas:
        sys.exit(f'Nenhum arquivo de Empresas encontrado em {args.entrada} (esperado *EMPRECSV*).')
    print(time.asctime(), f'Lendo {len(arquivos_empresas)} arquivo(s) de Empresas (passo 2/2: razão social)...')
    enriquecer_razao_social(arquivos_empresas, registros)

    print(time.asctime(), 'Particionando por UF e gravando bancos...')
    manifests = gravar_bancos_por_uf(registros, args.saida, cnae_version)
    for m in manifests:
        print(f"  {m['uf']}: {m['rows']} linhas, {m['sizeBytes'] / 1024:.1f} KB")
    print(time.asctime(), f'Concluído. {len(manifests)} UF(s) geradas em {args.saida}.')


if __name__ == '__main__':
    main()
