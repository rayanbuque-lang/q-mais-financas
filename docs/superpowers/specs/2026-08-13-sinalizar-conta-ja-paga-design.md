# Sinalizar conta a pagar já paga — evitar duplicação em Movimentações

Status: proposto.

## Contexto

A Capacidade B (baixa automática de contas a pagar, já em produção) casa lançamentos de saída do extrato contra `contas_pagar` **pendentes** — se achar uma correspondência confiante (valor idêntico + nome aproximado), dá baixa automaticamente. Se não achar nenhuma conta pendente correspondente, o lançamento segue pro fluxo normal: classificação por `extrato_regra` (texto→categoria) e, com a Capacidade A (lançamento direto, também já em produção), acaba virando uma movimentação nova.

**O buraco encontrado na revisão final da Capacidade A**: uma conta pode não estar mais pendente na hora do import por um motivo legítimo — foi paga por outro caminho (dar baixa manual direto na tela de Contas a Pagar, antes mesmo do extrato daquele período ser importado). Nesse caso, a Capacidade B não acha nada pra casar (procura só entre pendentes), o lançamento cai no fluxo normal, e a Capacidade A lança uma movimentação **nova e duplicada** — porque a baixa manual já tinha criado a movimentação de verdade pra aquele pagamento. Confirmado com dados reais: 5 de 5 lançamentos não-boleto já classificados no staging de teste já tinham uma movimentação gêmea vinda do lado de Contas a Pagar.

## Objetivo

Estender o mesmo motor de casamento da Capacidade B pra também procurar entre contas **já pagas** (`status='pago'`), não só pendentes. Confirmado pelo usuário como desenho geral:

> "Não consegue fazer todo esse checkup e ela sinalizar que essa conta já encontra-se paga? Aí ficaria para nós descartá-la. Seria um checkup total, quando não está paga, ela é dada como paga, quando a conta já está finalizada e paga, ela é um lançamento para ser descartado."

Ou seja: three-way agora, não mais two-way.

| Resultado do casamento | Ação |
|---|---|
| Conta **pendente** bate (único candidato) | Baixa automática — comportamento já existente, sem mudança |
| Conta **pendente** bate (2+ candidatos) | Ambíguo — comportamento já existente, sem mudança |
| Nenhuma pendente bate, mas conta(s) **já paga(s)** batem | **Novo**: sinaliza "provável duplicata", não deixa a Capacidade A lançar. Usuário decide: descartar (ignorar) ou classificar manualmente se achar que não é duplicata mesmo. |
| Nada bate (nem pendente, nem paga) | Segue fluxo normal — regra de classificação, Capacidade A pode lançar. Sem mudança. |

## Design

### 1. Motor de casamento (`src/lib/baixa-contas-pagar.ts`)

`calcularBaixasAutomaticas` ganha um terceiro parâmetro, `contasPagas`, e um terceiro resultado, `duplicatas`. Mesma regra de casamento já usada pra pendentes (valor idêntico + nome aproximado via `normalizarDescricao`/"contém") — só reaplicada contra o pool de contas pagas. A checagem de "já paga" só roda para um candidato que **não** teve nenhum match entre as pendentes — a prioridade continua sendo dar baixa de verdade quando possível.

Nunca decide sozinho, mesmo com um único candidato: mesmo achando só uma conta paga batendo, o resultado vai pra `duplicatas`, nunca é auto-descartado. Descartar uma transação real é uma ação alto-risco — sempre precisa de confirmação humana, diferente de dar baixa (que já é uma escrita reversível via "Desfazer pagamento").

```ts
export function calcularBaixasAutomaticas(
  candidatos: CandidatoBaixa[],
  contasPendentes: ContaPagarPendente[],
  contasPagas: ContaPagarPendente[]
): ResultadoBaixa

export interface ResultadoBaixa {
  baixados: { indice: number; contaPagarId: string }[];
  ambiguos: { indice: number; candidatosIds: string[] }[];
  duplicatas: { indice: number; candidatosIds: string[] }[]; // 1+ contas já pagas batendo
}
```

### 2. Novo campo de rastreamento

`extrato_lancamento.contas_pagar_duplicatas jsonb null` — campo novo e **separado** de `contas_pagar_candidatas` (que continua exclusivo do caso "ambíguo entre pendentes"). Misturar os dois sob o mesmo campo obrigaria a UI a adivinhar "isso é ambiguidade de baixa ou é duplicata?" a partir do mesmo dado — dois campos deixam a intenção explícita.

### 3. Wiring em `processarBaixasAutomaticas`

A consulta a `contas_pagar` passa a trazer `status in ('pendente', 'pago')` (uma única consulta, separada em dois pools no código) em vez de só `pendente`. Lançamentos que caem em `duplicatas` gravam `contas_pagar_duplicatas` (array de ids) e — igual ao caso ambíguo — são **excluídos** de `classificarPorRegras`/Capacidade A na mesma execução (novo `idsDuplicatas`, somado a `idsBaixados`/`idsAmbiguos` no filtro de `paraClassificar`).

Resumo pós-importação ganha mais uma contagem: "N lançamento(s) sinalizados como provável duplicata — revisar".

### 4. UI

Badge "Provável duplicata (N)" — mesmo padrão visual do badge "Baixa ambígua" já existente, cor distinta (âmbar/laranja pra sinalizar atenção). Clique abre um modal (mesma estrutura do modal de resolução de ambíguos) listando a(s) conta(s) já paga(s) que bateram (fornecedor, valor, data de pagamento) como contexto — sem precisar "escolher uma", já que a ação não cria vínculo nenhum. Dois botões: **Descartar este lançamento** (reaproveita o `handleIgnorar` já existente) e **Não é duplicata, classificar manualmente** (só fecha o modal — o usuário aí usa o dropdown de categoria normal, que já existe, e essa classificação manual segue o fluxo comum, inclusive podendo virar movimentação pela Capacidade A se fizer sentido).

## Fora de escopo

- Qualquer mudança na Capacidade B para contas pendentes — comportamento inalterado.
- Descartar automaticamente sem revisão humana, mesmo com match único e confiante.
- Vincular a duplicata sinalizada a uma conta específica (a UI só mostra contexto, não cria `conta_pagar_id`).

## Testes previstos

- Motor de casamento: candidato sem match pendente mas com 1 match pago → `duplicatas`. Sem match pendente e 2+ matches pagos → `duplicatas` também (lista completa, mesmo comportamento — não muda por causa da quantidade). Com match pendente → `baixados`/`ambiguos` como já é hoje, `duplicatas` nunca dispara nesse caso.
- Teste com os 5 casos reais já identificados na revisão (SABESP, Simples Nacional, DARF, FGTS, IPTU) confirmando que passam a ser sinalizados como duplicata em vez de caírem no fluxo normal.
- Wiring: lançamento sinalizado como duplicata não aparece em `paraClassificar`, não é tocado por `classificarPorRegras` nem pela Capacidade A.
