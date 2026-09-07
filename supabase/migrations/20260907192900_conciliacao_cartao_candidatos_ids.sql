-- Guarda os IDs candidatos quando o status é 'multiplos_candidatos', pra tela
-- oferecer a escolha manual sem precisar recalcular a janela de novo (e sem
-- risco da lista mudar entre o cálculo e a escolha do usuário).
alter table cartao_conciliacao add column if not exists candidatos_ids uuid[];
