-- Módulo de Conciliação de Cartão/Maquininha.
-- 4 tabelas novas, isoladas: nenhuma FK de integridade cruzada aponta para
-- extrato_lancamento/movimentacoes/contas_pagar (só uma referência solta,
-- lida via select). Nenhuma tabela existente é alterada.

create table if not exists cartao_importacao (
  id uuid primary key default gen_random_uuid(),
  tipo_arquivo text not null check (tipo_arquivo in ('detalhado', 'consolidado')),
  nome_arquivo text not null,
  periodo_inicio date,
  periodo_fim date,
  total_linhas_lidas integer not null default 0,
  total_linhas_importadas integer not null default 0,
  total_avisos integer not null default 0,
  avisos jsonb,
  importado_por uuid references auth.users(id),
  importado_em timestamptz not null default now()
);

create table if not exists cartao_transacao (
  id uuid primary key default gen_random_uuid(),
  importacao_id uuid not null references cartao_importacao(id) on delete cascade,
  origem_planilha text not null check (origem_planilha in ('cartoes', 'pix', 'voucher')),
  bandeira text not null,
  modalidade text not null check (modalidade in ('credito', 'debito', 'pix', 'voucher')),
  forma_pagamento text,
  data_hora_venda timestamptz not null,
  status_transacao text not null check (status_transacao in ('aprovada', 'negada', 'estornada', 'paga')),
  parcelas integer not null default 1,
  numero_cartao_mascarado text,
  numero_autorizacao text,
  numero_comprovante text,
  numero_terminal text,
  valor_bruto numeric(14, 2) not null,
  valor_taxa numeric(14, 2),
  valor_liquido numeric(14, 2),
  data_prevista_pagamento date,
  data_prevista_calculada date,
  dados_brutos jsonb,
  criado_em timestamptz not null default now(),
  unique (numero_comprovante, numero_terminal, data_hora_venda)
);

create index if not exists cartao_transacao_data_prevista_idx
  on cartao_transacao (data_prevista_pagamento, bandeira, modalidade);
create index if not exists cartao_transacao_importacao_idx
  on cartao_transacao (importacao_id);

create table if not exists cartao_taxa_contratada (
  id uuid primary key default gen_random_uuid(),
  bandeira text not null,
  modalidade text not null check (modalidade in ('credito', 'debito', 'pix', 'voucher')),
  taxa_percentual numeric(6, 3),
  prazo_dias integer,
  prazo_tipo text check (prazo_tipo in ('uteis', 'corridos')),
  ativo boolean not null default true,
  observacao text,
  atualizado_em timestamptz not null default now(),
  unique (bandeira, modalidade)
);

create table if not exists cartao_conciliacao (
  id uuid primary key default gen_random_uuid(),
  data_prevista date not null,
  bandeira text not null,
  modalidade text not null check (modalidade in ('credito', 'debito', 'pix', 'voucher')),
  valor_previsto numeric(14, 2) not null,
  extrato_lancamento_id uuid,
  valor_recebido numeric(14, 2),
  diferenca numeric(14, 2),
  status text not null check (
    status in ('aguardando', 'conciliado', 'divergente', 'sem_deposito_encontrado', 'multiplos_candidatos', 'conciliado_manual')
  ),
  observacao text,
  calculado_em timestamptz not null default now(),
  unique (data_prevista, bandeira, modalidade)
);

create index if not exists cartao_conciliacao_status_idx on cartao_conciliacao (status);

alter table cartao_importacao enable row level security;
alter table cartao_transacao enable row level security;
alter table cartao_taxa_contratada enable row level security;
alter table cartao_conciliacao enable row level security;

-- Mesmo padrão de RLS já usado em maquinas/vendas_maquina/extrato_lancamento/
-- feriados: leitura para qualquer usuário autenticado, escrita só para
-- master/funcionario (is_write_allowed(), já existente no schema) -- perfil
-- "leitura" fica travado a nível de banco, não só na UI.
create policy "cartao_importacao_select" on cartao_importacao for select using (auth.uid() is not null);
create policy "cartao_importacao_insert" on cartao_importacao for insert with check (is_write_allowed());
create policy "cartao_importacao_update" on cartao_importacao for update using (is_write_allowed()) with check (is_write_allowed());
create policy "cartao_importacao_delete" on cartao_importacao for delete using (is_write_allowed());

create policy "cartao_transacao_select" on cartao_transacao for select using (auth.uid() is not null);
create policy "cartao_transacao_insert" on cartao_transacao for insert with check (is_write_allowed());
create policy "cartao_transacao_update" on cartao_transacao for update using (is_write_allowed()) with check (is_write_allowed());
create policy "cartao_transacao_delete" on cartao_transacao for delete using (is_write_allowed());

create policy "cartao_taxa_contratada_select" on cartao_taxa_contratada for select using (auth.uid() is not null);
create policy "cartao_taxa_contratada_insert" on cartao_taxa_contratada for insert with check (is_write_allowed());
create policy "cartao_taxa_contratada_update" on cartao_taxa_contratada for update using (is_write_allowed()) with check (is_write_allowed());
create policy "cartao_taxa_contratada_delete" on cartao_taxa_contratada for delete using (is_write_allowed());

create policy "cartao_conciliacao_select" on cartao_conciliacao for select using (auth.uid() is not null);
create policy "cartao_conciliacao_insert" on cartao_conciliacao for insert with check (is_write_allowed());
create policy "cartao_conciliacao_update" on cartao_conciliacao for update using (is_write_allowed()) with check (is_write_allowed());
create policy "cartao_conciliacao_delete" on cartao_conciliacao for delete using (is_write_allowed());
