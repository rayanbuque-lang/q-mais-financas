-- Feedback do usuário depois de ver a tela real: faltava mostrar o valor
-- bruto (não só líquido) e o período de venda que compõe cada bucket, e
-- faltava uma forma de descartar uma linha revisada manualmente sem fingir
-- que foi "recebida".
alter table cartao_conciliacao add column if not exists valor_bruto_previsto numeric(14,2);
alter table cartao_conciliacao add column if not exists data_venda_inicio date;
alter table cartao_conciliacao add column if not exists data_venda_fim date;
alter table cartao_conciliacao drop constraint cartao_conciliacao_status_check;
alter table cartao_conciliacao add constraint cartao_conciliacao_status_check
  check (status in ('aguardando','conciliado','divergente','sem_deposito_encontrado','multiplos_candidatos','conciliado_manual','descartada'));
