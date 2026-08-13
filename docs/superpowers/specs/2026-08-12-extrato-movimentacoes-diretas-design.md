# Extrato → Movimentações direto (Capacidade A)

Status: proposto.

## Contexto

`/extrato` já classifica lançamentos por categoria (regra automática ou manual), mas até hoje isso nunca sai do staging — `extrato_lancamento.categoria` é só um rótulo de texto, nada é escrito em `movimentacoes`. A Capacidade B (já em produção) resolveu a metade "pagamento de boleto/conta cadastrada" desse problema, dando baixa em `contas_pagar` quando o valor+fornecedor batem. Esta capacidade resolve a outra metade: tudo que **não** passa por `contas_pagar` — Pix recebido, vendas de cartão (GETNET), tributos (DARF, SEFAZ), concessionárias (SABESP), Pix enviado — vira lançamento real em `movimentacoes`.

Padrões reais já confirmados nesta sessão (arquivos OFX do usuário + `extrato_regra` de produção):
```
PIX RECEBIDO <cpf>                          → regra existente, "Pix Santander", 229 aplicações
PAGAMENTO CARTAO DE CREDITO/DEBITO GETNET-*  → regra existente, "Cartão", 31 aplicações
CONTA DE AGUA E ESGOTO ... SABESP            → regra existente, "Água SABESP"
PAGAMENTO DARF / PGTO TRIBUTO ESTADUAL       → sem regra ainda
PIX ENVIADO <nome variável>                  → sem regra (destino muda a cada vez: Catuay, CEF, Prefeitura...)
```

## Objetivo

Dois níveis, mesmo espírito da Capacidade B (confiante = automático, incerto = revisão):

1. **Automático**: lançamento cuja descrição já bate com uma `extrato_regra` ativa → assim que a regra classifica (no import ou no Reprocessar), já lança em `movimentacoes` também, na mesma hora.
2. **Revisão manual**: lançamento sem regra confiável (Pix Enviado é o caso principal hoje) → continua aparecendo pendente de classificação, na mesma tela/mesmo dropdown que já existe. A diferença: ao clicar "Classificar", além de gravar a categoria no staging (como já faz), agora também lança a movimentação de verdade.

**Fora do escopo desta capacidade, por decisão explícita**: qualquer saída cuja descrição bata no padrão "pagamento de boleto" (mesmo texto que a Capacidade B usa como sinal) e que a Capacidade B não conseguiu baixar (nem automática nem ambiguamente) fica de fora — nem automático, nem pelo botão de classificar manual. Continua exatamente como está hoje, esperando a Capacidade B resolver quando a conta a pagar correspondente existir. Isso evita lançar como "saída genérica" algo que devia ficar vinculado a um fornecedor específico.

## Design

### 1. Tradução categoria (texto) → categoria_id (uuid)

`movimentacoes.categoria_id` é `uuid not null`. `extrato_lancamento.categoria` é texto livre. Resolve com um mapa nome→id, montado com uma consulta simples em `categorias_entrada`/`categorias_saida` (mesmo padrão já usado na Capacidade B para o sentido inverso, id→nome). Se o nome não bater com nenhuma categoria real (caso raro — hoje toda regra nasce de uma categoria escolhida na lista real, e o dropdown manual só oferece nomes reais), o lançamento **não é lançado em movimentações** — fica classificado no staging exatamente como hoje, sem erro, contado à parte no resumo.

### 2. Exclusão de padrão-boleto

Antes de lançar qualquer saída (automático ou manual), verifica se `descricao_normalizada` contém "pagamento de boleto". Se sim, pula o lançamento em movimentações — só grava a categoria no staging, sem tocar `movimentacoes`. Essa checagem é a mesma nos dois caminhos (automático e manual), pra não ter comportamento diferente dependendo de quem/quando classificou.

### 3. Caminho automático

Roda logo depois de `classificarPorRegras`, no mesmo fluxo que já existe (import de OFX e botão Reprocessar) — sobre os lançamentos que a própria `classificarPorRegras` acabou de classificar nesta execução (tem `regra_id` preenchido). Para cada um:
- Se for saída e bater no padrão boleto → pula (ver seção 2).
- Resolve `categoria_id` pelo nome (ver seção 1). Sem match → pula.
- Insere em `movimentacoes`: `tipo` (via `calcularTipoMovimentacao`, já existe), `data: lancamento.data_lancamento` (nunca "hoje"), `valor: Math.abs(lancamento.valor)`, `categoria_id`, `observacao` com a descrição original do lançamento, `revisar: false`.
- Grava `extrato_lancamento.movimentacao_id` apontando pro novo registro — o vínculo de auditoria/rastreabilidade, mesmo padrão do `conta_pagar_id` da Capacidade B.

### 4. Caminho manual

Em `handleClassificarManual` (já existe): depois de gravar a categoria no staging como já faz hoje, roda a mesma lógica da seção 3 (checagem de boleto, resolução de categoria_id, insert, grava `movimentacao_id`) pra esse lançamento específico. Como a categoria vem do dropdown (sempre populado com nomes reais de `categorias_entrada`/`categorias_saida`), a resolução de `categoria_id` nunca falha nesse caminho.

### 5. Rastreabilidade e reversão

Novo campo `extrato_lancamento.movimentacao_id uuid null references movimentacoes(id)`. A tela `/extrato` passa a mostrar, por lançamento, se ele já virou movimentação (badge, mesmo padrão visual do badge "Baixa automática" da Capacidade B).

`excluirMov` (`src/app/(app)/movimentacoes/page.tsx`, exclusão de movimentação na tela de produção) passa a, antes de apagar a movimentação, resetar o `extrato_lancamento` vinculado (`where movimentacao_id = id`): `status='nao_classificado', categoria=null, classificado_em=null, movimentacao_id=null`. Isso é a primeira vez que a tela de Movimentações (produção, nunca tocada por este projeto até agora) precisa saber que `/extrato` existe — mudança pequena e isolada (só dentro de `excluirMov`), mas é uma tela nova sendo tocada.

### 6. Resumo pós-importação

Estende o mesmo card/mensagem já usado nas Capacidades anteriores: "N classificados automaticamente · M lançados em movimentações · P sem categoria correspondente (revisar manualmente)".

## Fora de escopo

- Pagamentos de boleto sem match na Capacidade B (seção "Objetivo" acima).
- Backfill retroativo: lançamentos que já estavam `classificado` no staging **antes** desta capacidade existir não são lançados em movimentações automaticamente quando a feature for ligada — só lançamentos classificados (por regra ou manualmente) a partir de agora. Reprocessar continua só pegando `nao_classificado`, não reabre classificados antigos.
- Edição de uma movimentação já existente (só a exclusão passa a sincronizar com o extrato).
- XML → Contas a Pagar automático (próxima capacidade, ainda por vir).

## Testes previstos

- Resolução de categoria: nome que bate com categoria real → id certo; nome que não bate com nada → não lança, sem erro.
- Exclusão de padrão-boleto: descrição com "pagamento de boleto" nunca gera movimentação, mesmo classificada manualmente.
- Caminho automático: lançamento com regra ativa gera movimentação com data/valor/tipo corretos e `movimentacao_id` gravado.
- Caminho manual: mesmo resultado, disparado pelo botão Classificar.
- Reversão: excluir a movimentação pela tela de Movimentações reseta o `extrato_lancamento` vinculado de volta pra `nao_classificado`.
