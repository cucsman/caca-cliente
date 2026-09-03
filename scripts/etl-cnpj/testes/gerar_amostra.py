#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera uma amostra sintética no formato EXATO dos arquivos da Receita
(mesmas colunas/ordem/delimitador/encoding de *.ESTABELE, *.EMPRECSV,
*.MUNICCSV), pra testar processar.py sem precisar baixar os 17-25GB reais.

Não temos acesso ao home server (ZimaOS) nem aos ~17-25GB de dado real
nesta sessão — a amostra cobre deliberadamente os casos de borda que o
filtro/join/particionamento precisam acertar (ver comentários abaixo).
A rodada de produção de verdade fica pro dono do produto rodar depois.
"""
import csv
import os

PASTA = os.path.join(os.path.dirname(__file__), 'amostra')


def escrever_csv(caminho, linhas):
    with open(caminho, 'w', encoding='latin1', newline='') as f:
        w = csv.writer(f, delimiter=';')
        for linha in linhas:
            w.writerow(linha)


def gerar():
    os.makedirs(PASTA, exist_ok=True)

    # ── Municípios (código Receita -> nome) ──────────────────────────────
    escrever_csv(os.path.join(PASTA, 'F.K03200$Z.D60930.MUNICCSV'), [
        ['7855', 'UMUARAMA'],
        ['7107', 'SAO PAULO'],
    ])

    # ── Estabelecimentos ──────────────────────────────────────────────────
    # Colunas (30, ver processar.COLUNAS_ESTABELECIMENTO):
    # cnpj_basico;cnpj_ordem;cnpj_dv;matriz_filial;nome_fantasia;
    # situacao_cadastral;data_situacao_cadastral;motivo_situacao_cadastral;
    # nome_cidade_exterior;pais;data_inicio_atividades;cnae_fiscal;
    # cnae_fiscal_secundaria;tipo_logradouro;logradouro;numero;complemento;
    # bairro;cep;uf;municipio;ddd1;telefone1;ddd2;telefone2;ddd_fax;fax;
    # correio_eletronico;situacao_especial;data_situacao_especial
    estabelecimentos = [
        # 1) CASO FELIZ: advocacia (6911701), ATIVA, Umuarama-PR, com sócio-empresa
        # correspondente no arquivo de empresas (razão social deve ser preenchida).
        ['11111111', '0001', '11', '1', 'ADV SILVA E ASSOCIADOS',
         '2', '20200115', '00', '', '', '20200115', '6911701', '',
         'AVENIDA', 'PARANA', '4000', '', 'ZONA I', '87501000', 'PR', '7855',
         '44', '999998888', '', '', '', '', 'contato@advsilva.com.br', '', ''],
        # 2) BAIXADA (situacao_cadastral='08') mesmo CNAE/UF — deve ser EXCLUÍDO
        # mesmo tendo CNAE certo, pra provar que o filtro de situação funciona.
        ['22222222', '0001', '22', '1', 'ESCRITORIO FECHADO',
         '08', '20210101', '01', '', '', '20190101', '6911701', '',
         'RUA', 'DAS FLORES', '10', '', 'CENTRO', '87500000', 'PR', '7855',
         '', '', '', '', '', '', '', '', ''],
        # 3) ATIVA mas CNAE fora da lista (supermercado, 4711301) — deve ser EXCLUÍDO.
        ['33333333', '0001', '33', '1', 'MERCADO DO ZE',
         '2', '20180101', '00', '', '', '20180101', '4711301', '',
         'RUA', 'DO COMERCIO', '500', '', 'CENTRO', '87500000', 'PR', '7855',
         '44', '32551234', '', '', '', '', '', '', ''],
        # 4) ATIVA, CNAE certo (nutricionista, 8650006), em SP — testa
        # particionamento por UF (deve cair no arquivo separado SP.db) e o
        # fallback de telefone (ddd1/telefone1 vazios, usa ddd2/telefone2).
        ['44444444', '0001', '44', '1', 'NUTRI VIDA',
         '2', '20220301', '00', '', '', '20220301', '8650006', '',
         'RUA', 'AUGUSTA', '1500', 'SALA 2', 'CONSOLACAO', '01305000', 'SP', '7107',
         '', '', '11', '988887777', '', '', 'contato@nutrivida.com', '', ''],
        # 5) ATIVA, CNAE certo, mas SEM correspondência no arquivo de empresas
        # (cnpj_basico não existe lá) — razao_social deve ficar None, sem
        # travar o processamento.
        ['55555555', '0001', '55', '1', '',
         '2', '20230101', '00', '', '', '20230101', '6911701', '',
         'RUA', 'SEM EMPRESA CORRESPONDENTE', '1', '', 'CENTRO', '87500000', 'PR', '7855',
         '', '', '', '', '', '', '', '', ''],
        # 6) Linha corrompida (menos colunas que o esperado) — deve ser
        # descartada silenciosamente, sem travar o lote inteiro.
        ['66666666', '0001', '66', '1'],
    ]
    escrever_csv(os.path.join(PASTA, 'K3241.K03200Y0.D260731.ESTABELE'), estabelecimentos)

    # ── Empresas (razão social) ───────────────────────────────────────────
    # cnpj_basico;razao_social;natureza_juridica;qualificacao_responsavel;
    # capital_social_str;porte_empresa;ente_federativo_responsavel
    empresas = [
        ['11111111', 'ADVOCACIA SILVA E ASSOCIADOS LTDA', '2062', '49', '10000,00', '01', ''],
        ['22222222', 'ESCRITORIO FECHADO LTDA', '2062', '49', '5000,00', '01', ''],
        ['33333333', 'MERCADO DO ZE LTDA', '2062', '49', '20000,00', '01', ''],
        ['44444444', 'NUTRI VIDA CONSULTORIA NUTRICIONAL LTDA', '2062', '49', '1000,00', '01', ''],
        # nota: cnpj_basico 55555555 (caso 5) DELIBERADAMENTE ausente aqui.
        ['99999999', 'EMPRESA IRRELEVANTE SEM ESTABELECIMENTO FILTRADO LTDA', '2062', '49', '1,00', '01', ''],
    ]
    escrever_csv(os.path.join(PASTA, 'K3241.K03200Y0.D260731.EMPRECSV'), empresas)

    print(f'Amostra gerada em {PASTA}')


if __name__ == '__main__':
    gerar()
