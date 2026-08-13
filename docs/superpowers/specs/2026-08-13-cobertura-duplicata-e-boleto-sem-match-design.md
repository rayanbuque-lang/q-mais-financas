# Ampliar cobertura de duplicata e resolver boleto sem match

Status: proposto.

## Contexto

A feature "sinalizar conta já paga" (implementada e revisada) só casa por valor + nome do fornecedor. A revisão final encontrou, com dados reais, que isso só pega 2 dos 5 casos motivadores (SABESP, Simples Nacional) — DARF, FGTS e IPTU chegam no extrato sem o nome cadastrado aparecer no texto do banco (ex.: fornecedor "Receita Federal" cadastrado, banco escreve só "PAGAMENTO DARF"), então passam batido. A revisão também achou 3 bugs claros de implementação (sem ambiguidade de desenho, corrigidos aqui junto):

- `.limit(2000)` na consulta de contas a pagar agora cobre pendentes+pagas juntas (antes só pendentes) — com 1.258 contas hoje crescendo ~300/mês, estoura em 2-3 meses e arrisca derrubar contas pendentes da busca, quebrando a baixa automática que já funciona.
- Erro de consulta ao banco não é checado — se a consulta falhar, o código trata como "zero contas" e limpa sinalizações existentes, liberando tudo pro lançamento automático.
- Descartar ou classificar manualmente um lançamento sinalizado não limpa o campo de sinalização — o aviso continua aparecendo depois de resolvido.

Separado disso, o usuário trouxe um ajuste de desenho: lançamentos de boleto que não acham NENHUMA conta a pagar correspondente (nem pendente, nem paga) ficam presos hoje — mesmo classificados manualmente, nunca viram movimentação (decisão anterior: evitar lançar como despesa solta algo que devia estar vinculado a um fornecedor). O usuário quer que esses casos também cheguem em Movimentações, mas passando primeiro pelo cadastro em Contas a Pagar — preservando o rastro de fornecedor.

## Objetivo

1. Casamento de "provável duplicata" fica em dois estágios: nome+valor (como já é) e, se não achar, valor+mesma data de pagamento.
2. Lançamento de boleto sem nenhum match (nem por nome, nem por data+valor) ganha um caminho de resolução: classificar manualmente oferece cadastrar como Conta a Pagar na hora, e o sistema já dá baixa automaticamente nela (reaproveitando o mecanismo de baixa já existente e testado), porque o próprio lançamento do extrato já prova que foi pago.
3. Três correções de bug já especificadas acima.

## Design

### 1. Casamento em dois estágios para "provável duplicata"

Em `src/lib/baixa-contas-pagar.ts`: pro balde de duplicatas (só ele — a baixa automática continua exigindo nome, sem afrouxar), tenta primeiro `contaCasaComCandidato` (nome+valor, como já existe). Se nenhuma conta paga bater por nome, tenta uma segunda checagem: valor idêntico + `data_pagamento` da conta igual à `data_lancamento` do candidato (mesmo dia, sem janela — os casos reais confirmados são todos no mesmo dia). Isso exige duas coisas novas no motor: `CandidatoBaixa` ganha um campo `data`, e o pool de contas pagas passa a carregar `dataPagamento`.

Se a segunda checagem também achar 2+ candidatos, mesma regra de sempre — nunca decide sozinho, todos entram na lista de duplicatas pra revisão humana.

### 2. Boleto sem match nenhum — cadastrar como Conta a Pagar na hora

Quando um lançamento de saída bate no padrão de boleto (`ehPagamentoDeBoleto`) e **não** tem nenhuma conta pendente nem paga correspondente (nem por nome, nem por data+valor), a classificação manual (`handleClassificarManual`) muda de comportamento pra esse caso específico: em vez do fluxo normal (só grava categoria no staging, ou lança direto em movimentações), abre um pequeno formulário — fornecedor (sugestão pré-preenchida a partir do texto do banco, editável), categoria (mesmo dropdown já usado). Valor e data já vêm do próprio lançamento, não precisa digitar.

Ao confirmar: cria a `contas_pagar` nova com `status='pago'` e `data_pagamento = data_lancamento` (o próprio extrato já prova que foi pago nesse dia) e chama `baixarContaPagar` (já existe, já testado, mesmo caminho que toda baixa manual/automática já usa) pra fazer a escrita de verdade — contas_pagar, movimentações e o vínculo no extrato, tudo pelo mecanismo já auditado, `origem: "manual"`.

Lançamentos de boleto que SEGUEM tendo match (pendente, ambíguo, ou duplicata provável) não mudam nada — esse caminho novo só existe pro caso de "não achei nada".

### 3. Correções de bug (sem ambiguidade de desenho)

- **Consulta separada por status**: volta a ser duas consultas independentes (pendentes e pagas), cada uma com seu próprio `.limit(2000)` — a de pagas com um recorte de ~12 meses (`data_pagamento >= hoje - 1 ano`), já que conta paga muito antiga não é candidata realista de duplicata.
- **Erro de consulta tratado como erro, não como "zero contas"**: se a consulta falhar, a função retorna cedo sem chamar as rotinas de limpeza de sinalização (que hoje rodam mesmo em erro) — evita que uma falha passageira libere lançamentos sinalizados pro lançamento automático.
- **Limpar o campo de sinalização ao resolver**: `handleIgnorar` e `handleClassificarManual`, quando tocam um lançamento que tinha `contas_pagar_duplicatas` preenchido, gravam esse campo como `null` junto da atualização normal.

## Fora de escopo

- Ajustar nomes de fornecedor cadastrados pra bater melhor com o texto do banco (ideia mencionada, mas é ajuste de cadastro, não de código — fica a critério do usuário ao cadastrar contas futuras).
- Qualquer mudança na baixa automática (Capacidade B) em si — continua exigindo nome, sem o fallback de data.
- Excluir boleto da checagem de duplicata — continua sendo checado normalmente; o caminho novo só entra em ação quando não há candidato nenhum.

## Testes previstos

- Casamento em dois estágios: nome bate → usa nome (não tenta data). Nome não bate, data+valor bate → duplicata. Nenhum dos dois bate → nada (segue fluxo normal). Reteste os 5 casos reais (SABESP, Simples Nacional, DARF, FGTS, IPTU) confirmando que agora os 5 são sinalizados.
- Boleto sem match: formulário de cadastro cria a conta a pagar corretamente e a baixa acontece via `baixarContaPagar` sem duplicar lógica de escrita.
- Bugs: consulta separada não derruba pendentes quando pagas excedem o limite; erro de consulta não limpa sinalizações existentes; ignorar/classificar manualmente um lançamento com duplicata sinalizada limpa o campo.
