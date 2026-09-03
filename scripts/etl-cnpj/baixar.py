#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
baixar.py — baixa da Receita Federal só os arquivos que processar.py
precisa (Estabelecimentos*.zip, Empresas*.zip, Municipios.zip), descompacta
e apaga os .zip.

Adaptado de rictom/cnpj-sqlite (dados_cnpj_baixa.py) — mesma descoberta via
WebDAV (endpoint/share_token confirmados funcionando ao vivo em set/2026,
depois da mudança de layout do portal em fev/2026), mas:
  - baixa só os arquivos usados por processar.py (Estabelecimentos, Empresas,
    Municipios) — pula Sócios (10 arquivos, tabela grande) e Simples (o app
    não usa esses dados) e as 5 tabelas de referência não usadas
    (Cnaes/Motivos/Naturezas/Paises/Qualificacoes);
  - usa só `requests` (biblioteca já instalada em qualquer ambiente com
    Python), em vez de parfive/wget — download sequencial com retry simples,
    sem paralelismo (roda uma vez a cada poucos meses num home server, não
    precisa da velocidade extra, e menos dependência = menos coisa pra dar
    errado numa máquina que não é CI).

ATENÇÃO — TAMANHO REAL: confirmado ao vivo em set/2026, cada arquivo
Estabelecimentos{0-9}.zip tem ~2GB (contentlength via HEAD), ~20GB só essa
tabela. Rode isto no home server (ZimaOS), nunca no PC de aluno.

Uso:
    python3 baixar.py --saida dados-brutos/
"""
import argparse
import os
import re
import sys
import time
import zipfile
from xml.etree import ElementTree

import requests

SHARE_TOKEN = 'YggdBLfdninEJX9'  # mesmo token usado por rictom/cnpj-sqlite; se a Receita girar o token, atualizar aqui
BASE_URL = 'https://arquivos.receitafederal.gov.br/public.php/webdav'
DAV_NS = {'d': 'DAV:'}

# Só o que processar.py precisa — ver módulo docstring pra justificativa de
# não baixar Sócios/Simples/outras tabelas de referência.
PREFIXOS_DESEJADOS = ('Estabelecimentos', 'Empresas', 'Municipios')


def descobrir_ultimo_mes():
    """PROPFIND na raiz do WebDAV, acha o último diretório YYYY-MM."""
    r = requests.request('PROPFIND', BASE_URL + '/', auth=(SHARE_TOKEN, ''), headers={'Depth': '1'}, timeout=30)
    r.raise_for_status()
    root = ElementTree.fromstring(r.content)
    meses = []
    for resp in root.findall('d:response', DAV_NS):
        href = resp.find('d:href', DAV_NS).text
        m = re.search(r'(\d{4}-\d{2})/?$', href)
        if m:
            meses.append(m.group(1))
    if not meses:
        raise RuntimeError('Não achei nenhum diretório YYYY-MM no WebDAV da Receita — layout do portal pode ter mudado de novo.')
    return sorted(meses)[-1]


def listar_arquivos(ano_mes):
    """PROPFIND no diretório do mês, filtra só os prefixos desejados."""
    r = requests.request('PROPFIND', f'{BASE_URL}/{ano_mes}/', auth=(SHARE_TOKEN, ''), headers={'Depth': '1'}, timeout=30)
    r.raise_for_status()
    root = ElementTree.fromstring(r.content)
    arquivos = []
    for resp in root.findall('d:response', DAV_NS):
        href = resp.find('d:href', DAV_NS).text
        m = re.search(r'/([^/]+\.zip)$', href, re.IGNORECASE)
        if m and m.group(1).startswith(PREFIXOS_DESEJADOS):
            arquivos.append(m.group(1))
    return sorted(arquivos)


def baixar_arquivo(ano_mes, nome_arquivo, pasta_destino, tentativas=3):
    url = f'{BASE_URL}/{ano_mes}/{nome_arquivo}'
    caminho = os.path.join(pasta_destino, nome_arquivo)
    for tentativa in range(1, tentativas + 1):
        try:
            with requests.get(url, auth=(SHARE_TOKEN, ''), timeout=(30, 300), stream=True) as r:
                r.raise_for_status()
                total = int(r.headers.get('Content-Length', 0))
                baixado = 0
                with open(caminho + '.tmp', 'wb') as f:
                    for chunk in r.iter_content(1 << 20):  # 1MB
                        f.write(chunk)
                        baixado += len(chunk)
                        if total:
                            pct = baixado / total * 100
                            print(f'\r  {nome_arquivo}: {pct:5.1f}% ({baixado / 1024 / 1024:.0f}MB / {total / 1024 / 1024:.0f}MB)', end='')
                print()
            os.replace(caminho + '.tmp', caminho)  # atômico — evita zip truncado se cair no meio
            return caminho
        except requests.RequestException as e:
            print(f'\n  Tentativa {tentativa}/{tentativas} falhou pra {nome_arquivo}: {e}')
            if tentativa == tentativas:
                raise
            time.sleep(5 * tentativa)


def descompactar(caminho_zip, pasta_destino):
    with zipfile.ZipFile(caminho_zip, 'r') as z:
        z.extractall(pasta_destino)
    os.remove(caminho_zip)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--saida', required=True, help='Pasta onde baixar e descompactar (ficará com os CSVs, sem os .zip ao final)')
    ap.add_argument('--manter-zips', action='store_true', help='Não apaga os .zip após descompactar (debug)')
    args = ap.parse_args()

    os.makedirs(args.saida, exist_ok=True)

    print(time.asctime(), 'Descobrindo última base disponível...')
    ano_mes = descobrir_ultimo_mes()
    print(f'  Última base: {ano_mes}')

    arquivos = listar_arquivos(ano_mes)
    if not arquivos:
        sys.exit('Nenhum arquivo Estabelecimentos/Empresas/Municipios encontrado — layout do portal mudou?')
    print(f'  {len(arquivos)} arquivo(s) a baixar: {", ".join(arquivos)}')

    for nome in arquivos:
        print(time.asctime(), f'Baixando {nome}...')
        caminho = baixar_arquivo(ano_mes, nome, args.saida)
        print(time.asctime(), f'Descompactando {nome}...')
        if args.manter_zips:
            with zipfile.ZipFile(caminho, 'r') as z:
                z.extractall(args.saida)
        else:
            descompactar(caminho, args.saida)

    print(time.asctime(), f'Concluído. Arquivos prontos em {args.saida} — rode processar.py em seguida.')


if __name__ == '__main__':
    main()
