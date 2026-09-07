-- Pix cujo QR Code nunca foi pago ("Qr Code Expirado" no arquivo da
-- adquirente) não é dinheiro perdido, mas precisa ficar visível na lista de
-- transações em vez de ser descartado no import -- confirmado com dado real
-- (84 ocorrências no período de teste de agosto/2026).
alter table cartao_transacao drop constraint cartao_transacao_status_transacao_check;
alter table cartao_transacao add constraint cartao_transacao_status_transacao_check
  check (status_transacao in ('aprovada', 'negada', 'estornada', 'paga', 'expirada'));
