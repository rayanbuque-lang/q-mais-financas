# Revisar → Confirmar em lote a importação do Extrato (com desfazer)

Status: aprovado, aguardando implementação.

## Contexto

Hoje, ao importar um arquivo no `/extrato` (OFX ou relatório Pix), o sistema
classifica e já lança tudo automaticamente — em Movimentações, baixa de Contas
a Pagar e (desde a mudança anterior, ver
`2026-08-17-pix-fechamento-caixa-e-mes-fechado.md` se existir, ou o commit
`9fab54a`) no Fechamento de Caixa — no mesmo instante do upload, sem nenhuma
etapa de revisão. Isso já causou um incidente real: um relatório Pix errado
foi importado (dia 15/08/2026) e os lançamentos já tinham virado movimentações
reais antes de o erro ser percebido, exigindo correção manual direta no banco
(via Supabase MCP).

O usuário quer inverter esse fluxo: **escolher o arquivo → revisar tudo →
só então confirmar** (um botão só) — e a confirmação é o que dispara, de uma
vez, os três destinos (Movimentações, baixa de Contas a Pagar, Fechamento de
Caixa quando for Pix). Também quer um botão de **desfazer/descartar o lote**
que funcione tanto antes de confirmar (simples: apaga o que foi importado)
quanto depois de já confirmado (reverte em lote tudo que aquele arquivo
gerou nos três destinos) — pra nunca mais precisar corrigir na mão como o
caso do dia 15.

Decisões já confirmadas com o usuário:
1. Escopo da pausa: **todo tipo de lançamento** do arquivo importado (Pix,
   baixa de conta a pagar, etc.) espera confirmação — não só Pix.
2. Gatilho: um **botão próprio "Confirmar e Lançar"** na tela de Extrato,
   independente do Fechamento de Caixa.
3. `Reprocessar regras` (botão de manutenção que reclassifica lançamentos
   antigos avulsos, usado também internamente por outros fluxos) **continua
   lançando na hora, sem mudança** — só o fluxo de importação de arquivo passa
   a exigir confirmação.
4. O botão de desfazer/descartar lote funciona **antes e depois** de
   confirmado, e fica disponível pra **qualquer usuário com permissão de
   escrita** (mesmo nível de acesso de quem já importa hoje, não é
   admin-only).
5. Confirmar um lote com alguns itens em mês/dia já fechado: **lança o que
   pode, pula os travados e avisa no resumo** — mesma filosofia já usada em
   todo `/extrato` hoje.

## Como o pipeline atual permite isso sem reescrever tudo

`classificarPorRegras` (sugere categoria, grava só no staging
`extrato_lancamento`) já é hoje uma etapa **separada e não-destrutiva** de
`processarLancamentosDiretos`/`processarBaixasAutomaticas` (que são as
funções que de fato escrevem em `movimentacoes`/`contas_pagar`/
`fechamento_caixa`). A mudança é só **quando** essas duas últimas rodam: hoje
rodam dentro de `handleImportar`/`handleImportarRelatorioPix`, logo após o
insert; passam a rodar dentro de uma nova `confirmarImportacao(importacaoId)`,
disparada só pelo clique do usuário — reaproveitando as duas funções
inalteradas, só re-buscando os lançamentos do lote pelo `importacao_id` em vez
de usar o array em memória do momento do upload.

## Task 1 — Migração: `extrato_importacao.status`

Rodar via Supabase MCP (`apply_migration`, projeto `q-mais-financas`,
id `nheyevdjomfphlzmsszk`) antes de qualquer mudança de código:

```sql
alter table public.extrato_importacao
  add column status text not null default 'pendente'
  check (status in ('pendente', 'confirmada', 'descartada'));
```

Sem essa coluna não dá pra saber, ao reabrir a tela depois, quais lotes ainda
esperam confirmação.

## Task 2 — Marcar `importacao_id` nos lançamentos (hoje não é feito)

Achado importante na investigação: **nenhum dos dois caminhos de import grava
`importacao_id` no `extrato_lancamento`**, apesar da coluna existir e ser
usada por FK — é por isso que não dá pra identificar hoje "quais lançamentos
vieram de qual arquivo" de forma confiável (foi por isso que o dia 15 precisou
ser isolado por `data_lancamento`, não por lote, na correção manual).

Em `src/app/(app)/extrato/page.tsx`, tanto em `handleImportar` (~linha
1164-1178) quanto em `handleImportarRelatorioPix`: logo depois do
`.from("extrato_importacao").insert(...).select("id").single()` que já
devolve `importacaoCriada.id`, adicionar:

```ts
if (inseridos && inseridos.length > 0) {
  await supabase
    .from("extrato_lancamento")
    .update({ importacao_id: importacaoCriada.id })
    .in("id", inseridos.map((i) => i.id));
}
```

## Task 3 — Adiar o commit: `handleImportar`/`handleImportarRelatorioPix` só preparam

Em ambas as funções, **remover** as chamadas a `processarBaixasAutomaticas`
(~linha 1187-1190) e a `classificarPorRegras` + `processarLancamentosDiretos`
(~linha 1192-1203) — e nas duas message deixa de dizer "X lançada(s) em
movimentações" (isso só acontece na confirmação). **Manter** só
`classificarPorRegras` rodando ali (sugestão de categoria, não-destrutivo) —
é o que dá conteúdo pra revisar antes de confirmar.

Ajuste necessário em `processarBaixasAutomaticas` (linha 249): o filtro de
elegibilidade hoje é
```ts
const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
```
Como `classificarPorRegras` agora roda ANTES da baixa automática (não depois,
como hoje), uma saída pode já estar com `status: "classificado"` sem nunca ter
sido baixada de verdade. Trocar o filtro pra refletir o que já é dito em
comentário no próprio arquivo ("categoria preenchida NÃO significa
resolvido"): elegível é quem não tem `conta_pagar_id` nem `movimentacao_id`
ainda, independente do `status`/`categoria`:
```ts
const saidas = lancamentosNovos.filter((l) => l.valor < 0 && !l.conta_pagar_id && !l.movimentacao_id);
```
(precisa incluir `conta_pagar_id`/`movimentacao_id` no tipo `LancamentoParaBaixa`
usado aqui, se ainda não vier populado na consulta que alimenta essa função).

Resumo pós-upload passa a ser algo como: *"48 lidas · 44 novas · 4 já
existentes · 39 classificadas automaticamente — revise na aba Lançamentos e
confirme quando estiver tudo certo."* com dois botões logo abaixo:
**Confirmar e Lançar** / **Descartar esta importação**.

## Task 4 — `confirmarImportacao(importacaoId)`

Nova função em `extrato/page.tsx`, reaproveitando 100% das funções já
existentes:

```ts
async function confirmarImportacao(importacaoId: string) {
  const { data: lote, error } = await supabase
    .from("extrato_lancamento")
    .select("*")
    .eq("importacao_id", importacaoId)
    .is("conta_pagar_id", null)
    .is("movimentacao_id", null)
    .neq("status", "ignorado");
  if (error) { /* mensagem de erro, return */ }

  const baixasAuto = await processarBaixasAutomaticas(lote as LancamentoParaBaixa[]);
  const paraLancar = (lote as LancamentoParaBaixa[]).filter(
    (l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id) && !baixasAuto.idsDuplicatas.has(l.id) && l.status === "classificado"
  );
  // reconstrói ResultadoClassificacao a partir da `categoria` já gravada em cada linha
  const resultadosRegra = paraLancar.map((l) => ({ lancamentoId: l.id, categoria: l.categoria! }));
  const lancamentosDiretos = await processarLancamentosDiretos(paraLancar, resultadosRegra);

  await supabase.from("extrato_importacao").update({ status: "confirmada" }).eq("id", importacaoId);
  await registrarLog({ acao: "importou", tabela: "extrato_importacao", registroId: importacaoId, detalhes: "Importação confirmada e lançada" });
  // monta e mostra o mesmo tipo de resumo que hoje aparece logo após o upload
  await refrescarTudo();
}
```

## Task 5 — `desfazerImportacao(importacaoId)`: um botão só, antes ou depois de confirmar

Nova função, reaproveitando **sem duplicar** a lógica de desfazer já
construída: `bloquearSeMesFechado` (`@/lib/audit`), `ehPixRecebido` +
`bancoParaCampoPix` + `aplicarPixNoFechamentoCaixa` (`@/lib/fechamento-caixa-pix`,
já importados no arquivo), e o mesmo padrão de reversão que já existe em
`movimentacoes/page.tsx excluirMov` (Pix→caixa) e
`contas-pagar/page.tsx desfazerPagamento` (baixa→pendente):

```ts
async function desfazerImportacao(importacaoId: string) {
  const { data: linhas } = await supabase.from("extrato_lancamento").select("*").eq("importacao_id", importacaoId);
  let revertidos = 0, pulados = 0;

  for (const l of linhas ?? []) {
    if (l.movimentacao_id) {
      // Capacidade A (inclui Pix) -- mesma trava e mesma sincronia de excluirMov
      const erroMes = await bloquearSeMesFechado(l.data_lancamento);
      if (erroMes) { pulados++; continue; }
      if (ehPixRecebido(l.descricao_normalizada)) {
        const { data: conta } = await supabase.from("extrato_conta").select("banco").eq("id", l.conta_id).single();
        const campo = bancoParaCampoPix(conta?.banco ?? "");
        if (campo) {
          const r = await aplicarPixNoFechamentoCaixa(l.data_lancamento, campo, -l.valor);
          if (r !== "ok") { pulados++; continue; }
        }
      }
      await supabase.from("movimentacoes").delete().eq("id", l.movimentacao_id);
      await supabase.from("extrato_lancamento").delete().eq("id", l.id);
      revertidos++;
    } else if (l.conta_pagar_id) {
      // Capacidade B -- mesma reversão de desfazerPagamento em contas-pagar
      const { data: conta } = await supabase.from("contas_pagar").select("data_pagamento").eq("id", l.conta_pagar_id).single();
      const erroMes = await bloquearSeMesFechado(conta?.data_pagamento ?? l.data_lancamento);
      if (erroMes) { pulados++; continue; }
      const { data: mov } = await supabase.from("movimentacoes").select("id").eq("conta_pagar_id", l.conta_pagar_id).limit(1).maybeSingle();
      if (mov) await supabase.from("movimentacoes").delete().eq("id", mov.id);
      await supabase.from("contas_pagar").update({ status: "pendente", data_pagamento: null }).eq("id", l.conta_pagar_id);
      await supabase.from("extrato_lancamento").delete().eq("id", l.id);
      revertidos++;
    } else {
      // nunca comitado (lote ainda pendente, ou sobra não classificada) -- só descarta o staging
      await supabase.from("extrato_lancamento").delete().eq("id", l.id);
      revertidos++;
    }
  }

  await supabase.from("extrato_importacao").update({ status: "descartada" }).eq("id", importacaoId);
  await registrarLog({ acao: "excluiu", tabela: "extrato_importacao", registroId: importacaoId, detalhes: `Importação descartada: ${revertidos} revertido(s), ${pulados} não puderam ser desfeitos (mês/dia fechado)` });
  // mensagem: "X revertido(s) · Y não puderam ser desfeitos: mês/dia fechado" quando pulados > 0
  await refrescarTudo();
}
```

Importante: `extrato_lancamento` é **excluído**, não resetado pra
`nao_classificado` — resetar deixaria a linha presa pela constraint única
natural (`conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia`),
impedindo um reimport corrigido do mesmo período de entrar como linha nova
(mesmo raciocínio já aplicado na correção manual do dia 15).

Botão "Descartar/Desfazer esta importação" visível pra qualquer
`podeEscrever`, tanto no card de resumo logo após o upload quanto na lista de
importações recentes (Task 6) — texto muda conforme o status ("Descartar" se
`pendente`, "Desfazer lançamentos" se `confirmada`).

## Task 6 — UI: lista de importações + revisão antes de confirmar

Na aba **Importar**, abaixo dos cards de upload, uma tabela simples lendo
`extrato_importacao` (ordenada por `importado_em` desc, últimas ~20): arquivo,
data, qtd linhas, status (badge pendente/confirmada/descartada), e os botões
de ação (Confirmar/Descartar conforme o status) — assim um lote de ontem
também pode ser confirmado ou desfeito depois, não só o que acabou de subir.

Na aba **Lançamentos**, adicionar um filtro por importação (mesmo padrão do
`filtroContaId`/`filtroStatus` já existentes, linha ~753-754): selecionar uma
importação pendente filtra a lista só pros lançamentos daquele lote, pra
revisar antes de clicar Confirmar.

## Verificação

1. Rodar a migração da Task 1 primeiro (Supabase MCP `apply_migration`).
2. `npx tsc --noEmit -p tsconfig.json` e `npx eslint "src/app/(app)/extrato/page.tsx"` —
   sem erros novos além do padrão pré-existente já documentado
   (`react-hooks/set-state-in-effect`, fora de qualquer trecho tocado aqui).
3. `npm run build`.
4. Smoke test manual: importar um arquivo pequeno de teste → conferir que
   **nada** aparece em Movimentações/Contas a Pagar/Fechamento de Caixa antes
   de confirmar → clicar Confirmar e Lançar → conferir que aparece nos três
   destinos corretos → em outro teste, importar e clicar Descartar antes de
   confirmar (staging some, nada nos três destinos) → em outro, confirmar e
   depois clicar Desfazer (tudo reverte nos três destinos, staging some).
5. Testar o caso de mês fechado: confirmar um lote com uma data de mês
   fechado misturada com datas livres — confere que só os itens do mês aberto
   são lançados, e o resumo avisa quantos ficaram de fora.
