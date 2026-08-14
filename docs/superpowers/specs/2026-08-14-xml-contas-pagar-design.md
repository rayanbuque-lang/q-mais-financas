# XML → Contas a Pagar (design)

## Objetivo

Fechar o elo que falta no fluxo de conciliação: hoje `/xml-notas` só guarda o que foi lido do XML de NF-e como staging, sem escrever nada em Contas a Pagar. Esta peça adiciona um passo manual, revisável, que lança em Contas a Pagar uma linha por duplicata/parcela de boleto extraída do XML — pronta pra ser pega pela baixa automática do extrato (já pronta e auditada) quando o pagamento real aparecer no OFX.

Fluxo completo depois desta peça: sobe XML → confere na tela → clica "Lançar em Contas a Pagar" → contas nascem com categoria já resolvida quando existir regra de fornecedor → sobe extrato bancário → baixa automática já existente casa o pagamento e fecha o ciclo.

## Não-objetivos (fora de escopo)

- Sem cadastro de fornecedor: `contas_pagar.fornecedor` continua texto livre, copiado direto do XML (`xNome`). Não existe (nem vai existir aqui) tabela de fornecedores.
- Sem lançamento automático no import — sempre passa pelo botão manual "Lançar em Contas a Pagar", depois de revisar.
- Sem chute de vencimento para nota sem duplicata — fica de fora, sinalizada, lançamento manual como sempre foi.
- Sem regex nem "match exato" na regra de fornecedor — só "contém" normalizado (mesma função `normalizarDescricao` já usada na baixa automática do extrato), por fornecedor NF-e ser nome legal completo e estável.
- Sem alterar `extrato_regra`, `baixa-contas-pagar.ts` ou qualquer coisa já auditada hoje no cluster do extrato — só consome o resultado (uma conta a pagar pendente é indistinguível de uma criada manualmente, então a baixa automática do extrato já funciona sem mudança nenhuma).

## Modelo de dados (aditivo, nenhuma coluna/tabela existente muda de tipo ou remove dado)

```sql
-- Rastreia a duplicata até a conta a pagar que ela gerou -- trava idempotência
-- (nunca lança a mesma duplicata duas vezes) e dá rastreabilidade. ON DELETE
-- SET NULL: se a conta a pagar for excluída depois, a duplicata só desvincula
-- (mesmo comportamento de movimentacoes.conta_pagar_id, não bloqueia o delete).
alter table xml_duplicata
  add column conta_pagar_id uuid references contas_pagar(id) on delete set null;

-- Quando o "Lançar em Contas a Pagar" encontra uma conta pendente parecida já
-- lançada manualmente antes do XML chegar, guarda os candidatos aqui em vez
-- de criar -- mesmo padrão de nunca decidir sozinho um empate, já usado em
-- extrato_lancamento.contas_pagar_candidatas.
alter table xml_duplicata
  add column contas_pagar_candidatas uuid[];

-- xml_duplicata.status (já existe, text, sem CHECK constraint) passa a usar,
-- além do valor atual "candidata", mais três: "lancada" (conta_pagar_id
-- setado), "duplicata_suspeita" (contas_pagar_candidatas setado, aguardando
-- humano) e "duplicata_confirmada" (humano confirmou que é duplicata mesmo,
-- não tenta de novo). Fonte única de verdade do estado -- evita duas colunas
-- que podem sair de sincronia.

-- Regra fornecedor -> categoria, motor separado do extrato_regra (domínios
-- diferentes: nome legal de NF-e vs. texto de extrato bancário).
create table xml_regra_fornecedor (
  id uuid primary key default gen_random_uuid(),
  fornecedor_padrao text not null,
  categoria_id uuid not null, -- convenção, aponta pra categorias_saida.id (mesmo padrão sem FK real que contas_pagar.categoria_id já usa)
  ativa boolean not null default true,
  criado_em timestamptz not null default now()
);

alter table xml_regra_fornecedor enable row level security;
-- Mesmas policies de xml_nota/xml_duplicata/xml_importacao:
-- select: auth.uid() is not null
-- insert/update/delete: is_write_allowed()
```

## Fluxo: "Lançar em Contas a Pagar" (botão em lote, aba Notas)

Processa toda duplicata com `status = 'candidata'` (nunca reprocessa `lancada`, `duplicata_suspeita` ou `duplicata_confirmada` — cada uma dessas só muda de estado por ação explícita do humano ou já foi resolvida). Para cada nota:

1. **Nota sem nenhuma duplicata** (`xml_duplicata` vazio pra essa nota) — não cria nada. É um estado derivado (calculado de `xml_duplicata.length === 0`), não uma coluna nova. Aparece na tela com selo visível "sem boleto no XML — lançar manualmente" e entra num contador à parte no resumo do lançamento, pra nunca sumir em silêncio.

2. **Para cada duplicata com `status = 'candidata'`:**
   - Busca em `contas_pagar` com `status = 'pendente'` e `valor` exatamente igual, filtrando por fornecedor: `normalizarDescricao(nota.fornecedor_nome).includes(normalizarDescricao(contaPagarExistente.fornecedor))` (mesmo sentido de comparação da baixa automática — o nome legal do XML, mais longo, contém o nome que a pessoa digitou manualmente), com o mesmo piso de tamanho mínimo (`TAMANHO_MINIMO_FORNECEDOR`) já usado lá.
   - **1+ candidatas encontradas** → `status = 'duplicata_suspeita'`, `contas_pagar_candidatas = [ids]`. Não cria nada ainda.
   - **Nenhuma candidata** → resolve categoria: busca em `xml_regra_fornecedor` (ativa=true) por `normalizarDescricao(regra.fornecedor_padrao)` contido em `normalizarDescricao(nota.fornecedor_nome)`; se achar, usa `categoria_id` da regra, senão `categoria_id: null` (fica pendente de categorizar, igual qualquer conta a pagar sem categoria hoje).
   - Cria a conta a pagar:
     ```
     fornecedor: nota.fornecedor_nome
     descricao: `NF-e ${nota.numero_nota} - parcela ${duplicata.numero ?? \`(sem número)\`}`
     valor: duplicata.valor
     data_vencimento: duplicata.vencimento
     status: 'pendente'
     categoria_id: <resolvida acima ou null>
     observacao: `Gerado a partir do XML da NF-e (chave ${nota.chave_acesso})`
     ```
   - Grava condicionalmente (`update ... where id = duplicata.id and status = 'candidata'`, claim-then-write, mesmo padrão usado a sessão inteira) o `conta_pagar_id` e `status = 'lancada'` — se 0 linhas mudarem (outra aba já processou essa duplicata), a conta a pagar recém-criada é órfã e deve ser desfeita (mesma defesa em profundidade de `lancarMovimentacaoDireta`).

3. **Resumo ao final**, mesmo padrão dos outros resumos desta sessão (Importar do extrato): quantas contas criadas, quantas suspeitas de duplicata (revisar), quantas notas sem boleto (lançar manualmente), quantas categoria não resolvida por regra.

## Resolução de duplicata suspeita

Modal simples (mesma UX das resoluções já existentes no extrato): mostra a duplicata do XML ao lado da(s) conta(s) a pagar candidata(s) (fornecedor, valor, vencimento de cada lado). Duas ações:
- **"Não é duplicata, lançar mesmo assim"** → limpa `contas_pagar_candidatas`, volta `status` pra `'candidata'` e roda o passo 2 de novo só pra essa duplicata (cria a conta).
- **"É duplicata, não lançar"** → `status = 'duplicata_confirmada'`, `contas_pagar_candidatas` mantido (auditoria de por que não foi lançada). Nunca mais reprocessada.

## Aba "Regras" (nova, dentro de `/xml-notas`)

CRUD simples de `xml_regra_fornecedor`: fornecedor padrão (texto), categoria (select de `categorias_saida` ativas), ativa (toggle). Mesmo visual da aba Regras do extrato, motor separado por baixo. Toda mutação chama `registrarLog` (mesmo padrão de auditoria já aplicado em todo o resto do sistema hoje).

## Tratamento de erro

Lição direta da auditoria de hoje no parser de zip: **nenhuma falha em uma duplicata pode abortar o lote inteiro**. Cada duplicata processada dentro do seu próprio try/catch; erro insere na lista de "falharam" do resumo e segue pras próximas, exatamente como já é feito em `processarBaixasAutomaticas` e `processarLancamentosDiretos` no extrato.

## Segurança

`xml_regra_fornecedor` usa a mesma dupla de policies das outras tabelas de `/xml-notas` (`auth.uid() is not null` pra leitura, `is_write_allowed()` pra escrita) — nenhuma superfície nova de risco além do que já existe.

## Testes / validação

Sem framework de testes automatizado neste repo (convenção já estabelecida) — validação por leitura cuidadosa de código + SQL real (somente leitura) contra o banco de produção pra confirmar constraints, RLS e ausência de dado inesperado, igual ao processo usado em toda a auditoria desta sessão. Rodada de revisão independente (subagent fresco) antes de considerar pronto, mesmo padrão usado nas duas rodadas de correção anteriores desta sessão.
