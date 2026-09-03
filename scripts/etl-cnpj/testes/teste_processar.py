#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Valida a LÓGICA de processar.py (filtro + join + particionamento por UF +
manifest) contra a amostra sintética gerada por gerar_amostra.py — não
contra o dado real da Receita (~17-25GB, fora do alcance desta sessão).

Roda:
    node ../exportar_cnaes.mjs   (gera cnaes.json a partir de nicheGroups.js)
    python3 gerar_amostra.py     (gera os CSVs sintéticos)
    python3 teste_processar.py   (este arquivo)

Sem framework de teste (unittest/pytest) de propósito — script simples,
sem dependência externa, fácil de rodar em qualquer máquina com só o
Python padrão instalado.
"""
import gzip
import json
import os
import sqlite3
import sys
import shutil
import subprocess

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
import processar  # noqa: E402

PASTA_TESTE = os.path.dirname(os.path.abspath(__file__))
PASTA_AMOSTRA = os.path.join(PASTA_TESTE, 'amostra')
PASTA_SAIDA = os.path.join(PASTA_TESTE, 'saida_teste')

falhas = []


def checar(descricao, condicao):
    status = 'OK  ' if condicao else 'FALHOU'
    print(f'[{status}] {descricao}')
    if not condicao:
        falhas.append(descricao)


def main():
    # Limpa execuções anteriores.
    if os.path.exists(PASTA_SAIDA):
        shutil.rmtree(PASTA_SAIDA)

    print('== Gerando cnaes.json a partir de nicheGroups.js ==')
    subprocess.run(
        ['node', os.path.join(RAIZ, 'exportar_cnaes.mjs')],
        check=True, cwd=RAIZ,
    )
    caminho_cnaes = os.path.join(RAIZ, 'cnaes.json')

    print('\n== Gerando amostra sintética ==')
    sys.path.insert(0, PASTA_TESTE)
    import gerar_amostra  # noqa: E402
    gerar_amostra.gerar()

    print('\n== Testando funções isoladas ==')
    cnaes_alvo, versao = processar.carregar_cnaes(caminho_cnaes)
    checar('carregar_cnaes: CNAE de advocacia (6911701) está na lista alvo', '6911701' in cnaes_alvo)
    checar('carregar_cnaes: versão veio do JSON', bool(versao))
    checar(
        'normalizar_cnae: formato oficial pontuado vira só-dígitos',
        processar.normalizar_cnae('6911-7/01') == '6911701',
    )

    caminho_municipios = os.path.join(PASTA_AMOSTRA, 'F.K03200$Z.D60930.MUNICCSV')
    municipios = processar.carregar_municipios(caminho_municipios)
    checar('carregar_municipios: resolve código 7855 -> UMUARAMA', municipios.get('7855') == 'UMUARAMA')

    caminho_estabele = os.path.join(PASTA_AMOSTRA, 'K3241.K03200Y0.D260731.ESTABELE')
    registros = processar.ler_estabelecimentos([caminho_estabele], cnaes_alvo, municipios)

    checar('filtro: exatamente 3 registros sobrevivem (casos 1, 4, 5)', len(registros) == 3)
    checar('filtro: caso BAIXADA (2) foi excluído mesmo com CNAE certo', '22222222000122' not in registros)
    checar('filtro: caso CNAE fora da lista (3) foi excluído', '33333333000133' not in registros)
    checar('filtro: linha corrompida (6) não travou o processamento', True)  # se chegou até aqui, não travou

    reg1 = registros.get('11111111000111')  # cnpj_basico(11111111) + cnpj_ordem(0001) + cnpj_dv(11)
    checar('caso feliz: registro do escritório de advocacia foi encontrado', reg1 is not None)
    if reg1:
        checar('caso feliz: município resolvido pra nome (não código)', reg1['municipio'] == 'UMUARAMA')
        checar('caso feliz: UF correta', reg1['uf'] == 'PR')
        checar('caso feliz: logradouro monta tipo+nome', reg1['logradouro'] == 'AVENIDA PARANA')
        checar('caso feliz: telefone monta (ddd) numero a partir de ddd1/telefone1', reg1['telefone'] == '(44) 999998888')
        checar('caso feliz: razao_social ainda None antes do passo 2', reg1['razao_social'] is None)

    caminho_empresas = os.path.join(PASTA_AMOSTRA, 'K3241.K03200Y0.D260731.EMPRECSV')
    processar.enriquecer_razao_social([caminho_empresas], registros)

    if reg1:
        checar('join razão social: preenchida corretamente pro caso feliz', reg1['razao_social'] == 'ADVOCACIA SILVA E ASSOCIADOS LTDA')

    reg_sp = next((r for r in registros.values() if r['uf'] == 'SP'), None)
    checar('caso SP: existe (nutricionista)', reg_sp is not None)
    if reg_sp:
        checar('caso SP: fallback de telefone usa ddd2/telefone2 quando ddd1/telefone1 vazios', reg_sp['telefone'] == '(11) 988887777')
        checar('caso SP: município resolvido', reg_sp['municipio'] == 'SAO PAULO')

    reg5 = next((r for r in registros.values() if r['bairro'] == 'CENTRO' and r['numero'] == '1' and r['cnae'] == '6911701'), None)
    checar('caso sem empresa correspondente: registro existe (não quebrou o join)', reg5 is not None)
    if reg5:
        checar('caso sem empresa correspondente: razao_social fica None (não IndexError/crash)', reg5['razao_social'] is None)

    print('\n== Testando particionamento por UF + manifest ==')
    manifests = processar.gravar_bancos_por_uf(registros, PASTA_SAIDA, versao)
    ufs_geradas = sorted(m['uf'] for m in manifests)
    checar('particionamento: gera exatamente PR e SP', ufs_geradas == ['PR', 'SP'])

    manifest_pr = next(m for m in manifests if m['uf'] == 'PR')
    checar('manifest PR: rows == 2 (caso feliz + caso sem empresa)', manifest_pr['rows'] == 2)
    checar('manifest PR: sizeBytes > 0', manifest_pr['sizeBytes'] > 0)
    checar('manifest PR: cnaeVersion preenchida', bool(manifest_pr['cnaeVersion']))

    checar('arquivo PR.db existe', os.path.exists(os.path.join(PASTA_SAIDA, 'PR.db')))
    checar('arquivo PR.db.gz existe (formato de distribuição)', os.path.exists(os.path.join(PASTA_SAIDA, 'PR.db.gz')))
    checar('arquivo PR.manifest.json existe', os.path.exists(os.path.join(PASTA_SAIDA, 'PR.manifest.json')))

    # Valida o schema exato do plano E que o .db.gz descomprime pro mesmo conteúdo.
    with gzip.open(os.path.join(PASTA_SAIDA, 'PR.db.gz'), 'rb') as f_in:
        conteudo_gz = f_in.read()
    with open(os.path.join(PASTA_SAIDA, 'PR.db'), 'rb') as f:
        conteudo_db = f.read()
    checar('PR.db.gz descomprime exatamente pro mesmo conteúdo do PR.db', conteudo_gz == conteudo_db)

    conn = sqlite3.connect(os.path.join(PASTA_SAIDA, 'PR.db'))
    try:
        cols = [row[1] for row in conn.execute('PRAGMA table_info(estabelecimentos)')]
        esperado = ['cnpj', 'razao_social', 'nome_fantasia', 'cnae', 'logradouro', 'numero',
                    'complemento', 'bairro', 'cep', 'municipio', 'uf', 'telefone', 'email',
                    'situacao_cadastral', 'data_situacao']
        checar('schema: colunas da tabela batem exatamente com o plano', cols == esperado)

        indices = [row[1] for row in conn.execute('PRAGMA index_list(estabelecimentos)')]
        checar('schema: índice idx_cnae_municipio existe', 'idx_cnae_municipio' in indices)

        rows = conn.execute(
            "SELECT cnpj, razao_social, nome_fantasia, cnae, municipio, uf FROM estabelecimentos WHERE cnae = '6911701'"
        ).fetchall()
        checar('query real: SELECT por CNAE devolve os 2 registros de advocacia em PR', len(rows) == 2)

        # A query real que o cnpjProvider.js vai fazer (ver plano): cnae IN (...) AND municipio = ?
        rows_umuarama = conn.execute(
            "SELECT cnpj FROM estabelecimentos WHERE cnae IN ('6911701') AND municipio = 'UMUARAMA'"
        ).fetchall()
        checar('query real (formato do cnpjProvider.js): cnae IN (...) AND municipio = ? funciona', len(rows_umuarama) == 2)

        pj_nula = conn.execute("SELECT * FROM estabelecimentos WHERE cnpj IS NULL OR cnpj = ''").fetchall()
        checar('sanidade: nenhum registro com cnpj vazio/nulo (é PRIMARY KEY)', len(pj_nula) == 0)
    finally:
        conn.close()

    print('\n' + '=' * 60)
    if falhas:
        print(f'{len(falhas)} verificação(ões) FALHARAM:')
        for f in falhas:
            print(f'  - {f}')
        sys.exit(1)
    print('Todas as verificações passaram.')


if __name__ == '__main__':
    main()
