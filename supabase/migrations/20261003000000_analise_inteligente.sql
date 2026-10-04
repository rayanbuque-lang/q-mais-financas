-- Análise Inteligente Financeira — Fase 1 (docs/superpowers/specs/2026-10-03-analise-inteligente-design.md)
-- Só aditivo: 2 tabelas novas + 1 coluna nova nullable em contas_pagar. Nenhuma
-- tabela existente é alterada estruturalmente além dessa coluna, nenhum dado
-- existente é tocado.

-- Normalização de fornecedor (seção 3 da spec): mapeia as grafias livres de
-- contas_pagar.fornecedor para uma identidade única, de preferência por CNPJ
-- (vindo de xml_nota.fornecedor_cnpj).
create table fornecedor_canonico (
  id uuid primary key default gen_random_uuid(),
  cnpj text unique,
  nome_exibicao text not null,
  criado_em timestamptz not null default now()
);

alter table contas_pagar add column fornecedor_canonico_id uuid references fornecedor_canonico(id);
create index idx_contas_pagar_fornecedor_canonico on contas_pagar (fornecedor_canonico_id, data_pagamento);

-- Histórico imutável de análises geradas (seção 7 da spec): regenerar cria
-- linha nova, nunca faz update numa análise já gerada.
create table analise_inteligente (
  id uuid primary key default gen_random_uuid(),
  periodo_inicio date not null,
  periodo_fim date not null,
  periodo_comparacao_inicio date,
  periodo_comparacao_fim date,
  versao_motor text not null,
  achados jsonb not null,
  texto_final text,
  gerado_por uuid references auth.users(id),
  gerado_em timestamptz not null default now()
);

alter table fornecedor_canonico enable row level security;
alter table analise_inteligente enable row level security;

-- Mesmo padrão de RLS já usado em maquinas/vendas_maquina/extrato_lancamento/
-- feriados/cartao_* (is_write_allowed(), já existente no schema): leitura
-- para qualquer usuário autenticado, escrita só para master/funcionario.
create policy "fornecedor_canonico_select" on fornecedor_canonico for select using (auth.uid() is not null);
create policy "fornecedor_canonico_insert" on fornecedor_canonico for insert with check (is_write_allowed());
create policy "fornecedor_canonico_update" on fornecedor_canonico for update using (is_write_allowed()) with check (is_write_allowed());
create policy "fornecedor_canonico_delete" on fornecedor_canonico for delete using (is_write_allowed());

create policy "analise_inteligente_select" on analise_inteligente for select using (auth.uid() is not null);
create policy "analise_inteligente_insert" on analise_inteligente for insert with check (is_write_allowed());
-- Sem policy de update/delete de propósito: histórico é imutável (seção 7 da spec).
