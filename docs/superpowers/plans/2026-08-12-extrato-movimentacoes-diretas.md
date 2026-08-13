# Extrato → Movimentações Direto (Capacidade A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Exceção de execução — Task 1:** altera schema em produção (Supabase). Executada pelo orquestrador diretamente via `mcp__claude_ai_Supabase__apply_migration`, não despachada como subagent. Tasks 2-4 seguem o fluxo normal de SDD.

**Goal:** Lançamentos do extrato bancário cuja categoria já é conhecida (por regra ativa, ou por classificação manual) passam a virar movimentações reais de produção — automaticamente quando a regra resolve, ou no mesmo clique do botão "Classificar" já existente quando é manual — exceto pagamentos de boleto sem match na Capacidade B, que continuam fora (domínio exclusivo dela).

**Architecture:** Duas funções novas de módulo em `src/app/extrato/page.tsx` (mesmo padrão de `baixarContaPagar`/`processarBaixasAutomaticas` da Capacidade B): `lancarMovimentacaoDireta` (escreve uma movimentação a partir de um lançamento+categoria já resolvidos) e `processarLancamentosDiretos` (roda em lote sobre o que `classificarPorRegras` acabou de classificar). O caminho manual (`handleClassificarManual`) chama a mesma `lancarMovimentacaoDireta` depois de gravar a categoria no staging. Um novo campo `extrato_lancamento.movimentacao_id` rastreia o vínculo, e a tela de Movimentações (produção, nunca tocada por este projeto) aprende a resetar esse vínculo quando alguém exclui a movimentação por lá.

**Tech Stack:** Next.js 16.2.6 App Router, React 19, Supabase JS v2, TypeScript. Sem framework de testes formal — validação por script Node descartável ou consulta SQL real via MCP (projeto Supabase `nheyevdjomfphlzmsszk`), documentada no relatório de cada task.

## Global Constraints

- **Pagamentos de boleto ficam fora desta capacidade, sempre.** Se `descricao_normalizada` contém "pagamento de boleto", nunca lança movimentação por aqui — nem automático, nem manual. Isso é domínio exclusivo da Capacidade B (já em produção).
- **`movimentacoes.data` sempre usa `lancamento.data_lancamento`** — nunca "hoje".
- **`movimentacoes.categoria_id` é `uuid not null`** — sem categoria real correspondente, não lança (fica só classificado no staging, exatamente como hoje). Não é erro, não bloqueia nada.
- **Checa mês contábil fechado** (`verificarMesFechado`, `src/lib/audit.ts`) antes de qualquer escrita em `movimentacoes` — mesma proteção que a Capacidade B já tem.
- **Nenhum backfill retroativo**: só lançamentos classificados (por regra ou manualmente) a partir de agora entram nessa lógica. Lançamentos que já estavam `classificado` no staging antes desta feature não são varridos e lançados em lote.
- **Sem framework de teste**: scripts Node descartáveis (imports relativos, nunca `@/...`), apagados depois de passar. Nenhum arquivo de teste é commitado.

---

## Contexto que todo implementador precisa

**Estado atual do arquivo principal** (`src/app/extrato/page.tsx`, ~1700 linhas): já tem a Capacidade B completa em produção — funções de módulo `baixarContaPagar`, `processarBaixasAutomaticas`, `limparCandidatasObsoletas` (linhas ~100-302, antes de `export default function ExtratoPage()`), e dentro do componente: `classificarPorRegras` (~482), `handleReprocessar` (~514), `handleImportar` (~586), `handleImportarRelatorioPix` (~745), `handleClassificarManual` (~830). Os números de linha exatos abaixo foram lidos do arquivo real nesta sessão — confira antes de aplicar, porque cada task anterior pode ter deslocado algumas linhas.

**`classificarPorRegras` hoje** (linha 482-512):
```ts
async function classificarPorRegras(candidatos: LancamentoClassificavel[]): Promise<number> {
  if (candidatos.length === 0) return 0;
  const { data: regrasAtivas, error } = await supabase.from("extrato_regra").select("*").eq("ativa", true);
  if (error || !regrasAtivas || regrasAtivas.length === 0) return 0;

  const resultados = aplicarRegras(candidatos, regrasAtivas as RegraMotor[]);
  if (resultados.length === 0) return 0;

  const agora = new Date().toISOString();
  await Promise.all(
    resultados.map((r) =>
      supabase
        .from("extrato_lancamento")
        .update({ categoria: r.categoria, regra_id: r.regraId, status: "classificado", classificado_em: agora })
        .eq("id", r.lancamentoId)
    )
  );

  const contagemPorRegra = new Map<string, number>();
  for (const r of resultados) contagemPorRegra.set(r.regraId, (contagemPorRegra.get(r.regraId) ?? 0) + 1);

  await Promise.all(
    Array.from(contagemPorRegra.entries()).map(([regraId, qtd]) => {
      const regraAtual = regrasAtivas.find((r: Regra) => r.id === regraId);
      const novoTotal = (regraAtual?.vezes_aplicada ?? 0) + qtd;
      return supabase.from("extrato_regra").update({ vezes_aplicada: novoTotal }).eq("id", regraId);
    })
  );

  return resultados.length;
}
```
Ela roda em TRÊS lugares: `handleReprocessar` (linha 533), `handleImportar` (linha 716), `handleImportarRelatorioPix` (linha 807) — cada um só usa o número de retorno pra mensagem. Esta task precisa que ela devolva também a LISTA de resultados (`{lancamentoId, categoria, regraId}[]`, tipo `ResultadoClassificacao` já existe em `@/lib/regras-extrato`), pra alimentar a lógica nova sem precisar reconsultar o banco.

**`LancamentoParaBaixa`** (já existe, linha 85-93):
```ts
interface LancamentoParaBaixa {
  id: string;
  conta_id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
  status: string;
  contas_pagar_candidatas?: string[] | null;
}
```
Os três call sites de `classificarPorRegras` já passam arrays desse shape (com cast `as LancamentoClassificavel[]` só pra bater com a assinatura) — ou seja, o objeto runtime já tem `data_lancamento`, é só reaproveitar sem novo cast.

**`calcularTipoMovimentacao`** já existe em `@/lib/preview-movimentacao` (já importado): `(valor: number) => "entrada" | "saida"`.

**`verificarMesFechado`** já existe em `@/lib/audit` (já importado): `async (data: string) => { fechado: boolean, ... }` — já usado dentro de `baixarContaPagar` linha 124.

**Schema**: `categorias_entrada`/`categorias_saida` têm `id uuid`, `nome text`, `ativo boolean` — mesmas tabelas já lidas hoje só por nome em `carregarCategoriasReais` (linha 376-391). `movimentacoes` tem `tipo, data, valor, categoria_id (not null), observacao, revisar, conta_pagar_id (nullable)` — sem coluna de "fornecedor".

**Tela de Movimentações** (`src/app/(app)/movimentacoes/page.tsx`): produção, nunca tocada por este projeto até agora. `excluirMov` (linha 334-342):
```ts
async function excluirMov(id: string) {
  if (!confirm("Excluir?")) return;
  await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", id);
  await supabase.from("movimentacoes").delete().eq("id", id);
  await registrarLog({ acao: "excluiu", tabela: "movimentacoes", registroId: id });
  setMensagem("Excluído!");
  carregarMovimentacoes();
  setTimeout(() => setMensagem(""), 3000);
}
```
`registrarLog` e `createClient`/`supabase` já estão disponíveis nesse arquivo (imports já existem).

---

### Task 1: Migração de schema — nova coluna em `extrato_lancamento`

**Executada pelo orquestrador diretamente, não por subagent.**

**Files:**
- Nenhum arquivo no repo — alteração direta no banco via MCP (não há pasta de migrations versionada neste projeto).

**Interfaces:**
- Produces: `extrato_lancamento.movimentacao_id uuid null` — consumida pelas Tasks 2, 3 e 4.

- [ ] **Step 1: Aplicar a migração**

`mcp__claude_ai_Supabase__apply_migration`, `project_id: "nheyevdjomfphlzmsszk"`, `name: "add_movimentacao_id_extrato_lancamento"`:
```sql
alter table extrato_lancamento
  add column movimentacao_id uuid references movimentacoes(id);
```

- [ ] **Step 2: Confirmar**

`mcp__claude_ai_Supabase__execute_sql`, mesmo `project_id`:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'extrato_lancamento' and column_name = 'movimentacao_id';
```
Esperado: uma linha, tipo `uuid`.

- [ ] **Step 3:** Marcar completa no ledger do SDD — sem commit de código nesta task.

---

### Task 2: Lançamento direto em Movimentações — funções, wiring e resumo

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `calcularTipoMovimentacao` (`@/lib/preview-movimentacao`, já importado), `verificarMesFechado` (`@/lib/audit`, já importado), `createClient` (`@/lib/supabase/client`, já importado). Coluna `extrato_lancamento.movimentacao_id` (Task 1).
- Produces (consumido pelas Tasks 3 e 4): campo `movimentacao_id: string | null` na interface `Lancamento`; função `lancarMovimentacaoDireta` (module-scope, reaproveitável).

- [ ] **Step 1: Adicionar `ResultadoClassificacao` ao import de `regras-extrato`**

Linha 8, trocar:
```ts
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel } from "@/lib/regras-extrato";
```
por:
```ts
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel, type ResultadoClassificacao } from "@/lib/regras-extrato";
```

- [ ] **Step 2: Estender a interface `Lancamento`**

Linha 22-38, adicionar `movimentacao_id: string | null;` ao final (depois de `contas_pagar_candidatas`).

- [ ] **Step 3: Mudar o retorno de `classificarPorRegras`**

Linha 482-512, trocar a assinatura e o `return` final:
```ts
async function classificarPorRegras(candidatos: LancamentoClassificavel[]): Promise<ResultadoClassificacao[]> {
  if (candidatos.length === 0) return [];
  const { data: regrasAtivas, error } = await supabase.from("extrato_regra").select("*").eq("ativa", true);
  if (error || !regrasAtivas || regrasAtivas.length === 0) return [];

  const resultados = aplicarRegras(candidatos, regrasAtivas as RegraMotor[]);
  if (resultados.length === 0) return [];

  const agora = new Date().toISOString();
  await Promise.all(
    resultados.map((r) =>
      supabase
        .from("extrato_lancamento")
        .update({ categoria: r.categoria, regra_id: r.regraId, status: "classificado", classificado_em: agora })
        .eq("id", r.lancamentoId)
    )
  );

  const contagemPorRegra = new Map<string, number>();
  for (const r of resultados) contagemPorRegra.set(r.regraId, (contagemPorRegra.get(r.regraId) ?? 0) + 1);

  await Promise.all(
    Array.from(contagemPorRegra.entries()).map(([regraId, qtd]) => {
      const regraAtual = regrasAtivas.find((r: Regra) => r.id === regraId);
      const novoTotal = (regraAtual?.vezes_aplicada ?? 0) + qtd;
      return supabase.from("extrato_regra").update({ vezes_aplicada: novoTotal }).eq("id", regraId);
    })
  );

  return resultados;
}
```
(Só a assinatura e os dois `return`s mudaram — o corpo é idêntico.)

- [ ] **Step 4: Adicionar as funções de módulo, depois de `limparCandidatasObsoletas` e antes de `export default function ExtratoPage()`**

```ts
// ---------- Lançamento direto em Movimentações (Capacidade A) ----------
// Todo lançamento de saída cuja descrição bate no padrão de boleto é domínio
// EXCLUSIVO da baixa automática de contas a pagar (Capacidade B) -- nunca vira
// movimentação genérica por aqui, mesmo sem ter achado conta correspondente.
// Mesmo texto que a extrato_regra "Pagamento de boletos" já usa hoje.
const PADRAO_BOLETO = "pagamento de boleto";

function ehPagamentoDeBoleto(descricaoNormalizada: string): boolean {
  return descricaoNormalizada.includes(PADRAO_BOLETO);
}

interface LancamentoParaMovimentacao {
  id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
}

// "ok" lançou; "mes_fechado" recusou de propósito (mesma proteção da
// Capacidade B); "nao_lancado" cobre os dois casos silenciosos -- padrão de
// boleto, ou categoria sem correspondência real -- nenhum dos dois é erro,
// o lançamento simplesmente continua só classificado no staging.
type ResultadoLancamentoDireto = "ok" | "mes_fechado" | "nao_lancado";

async function carregarMapasCategoria(): Promise<{ entrada: Map<string, string>; saida: Map<string, string> }> {
  const supabase = createClient();
  const [{ data: catsEntrada }, { data: catsSaida }] = await Promise.all([
    supabase.from("categorias_entrada").select("id, nome"),
    supabase.from("categorias_saida").select("id, nome"),
  ]);
  return {
    entrada: new Map((catsEntrada ?? []).map((c) => [c.nome as string, c.id as string])),
    saida: new Map((catsSaida ?? []).map((c) => [c.nome as string, c.id as string])),
  };
}

// Reaproveitada tanto pelo caminho automático (processarLancamentosDiretos,
// logo depois de classificarPorRegras) quanto pelo manual
// (handleClassificarManual, depois de gravar a categoria no staging).
async function lancarMovimentacaoDireta(
  lancamento: LancamentoParaMovimentacao,
  categoriaNome: string,
  mapaCategoriaEntrada: Map<string, string>,
  mapaCategoriaSaida: Map<string, string>
): Promise<ResultadoLancamentoDireto> {
  if (lancamento.valor < 0 && ehPagamentoDeBoleto(lancamento.descricao_normalizada)) return "nao_lancado";

  const tipo = calcularTipoMovimentacao(lancamento.valor);
  const mapa = tipo === "entrada" ? mapaCategoriaEntrada : mapaCategoriaSaida;
  const categoriaId = mapa.get(categoriaNome);
  if (!categoriaId) return "nao_lancado";

  const supabase = createClient();

  const { fechado } = await verificarMesFechado(lancamento.data_lancamento);
  if (fechado) return "mes_fechado";

  const { data: movimentacaoInserida, error: erroInsert } = await supabase
    .from("movimentacoes")
    .insert({
      tipo,
      data: lancamento.data_lancamento,
      valor: Math.abs(Number(lancamento.valor)),
      categoria_id: categoriaId,
      observacao: lancamento.descricao_normalizada,
      revisar: false,
    })
    .select("id")
    .single();
  if (erroInsert || !movimentacaoInserida) return "nao_lancado";

  const { error: erroLancamento } = await supabase
    .from("extrato_lancamento")
    .update({ movimentacao_id: movimentacaoInserida.id })
    .eq("id", lancamento.id);
  if (erroLancamento) return "nao_lancado";

  return "ok";
}

// Roda sobre o que classificarPorRegras acabou de classificar nesta execução
// -- não sobre "tudo que está classificado hoje" (sem backfill retroativo).
async function processarLancamentosDiretos(
  candidatos: LancamentoParaBaixa[],
  resultadosRegra: ResultadoClassificacao[]
): Promise<{ lancados: number; mesFechado: number }> {
  if (resultadosRegra.length === 0) return { lancados: 0, mesFechado: 0 };

  const { entrada, saida } = await carregarMapasCategoria();
  const porId = new Map(candidatos.map((c) => [c.id, c]));

  let lancados = 0;
  let mesFechado = 0;
  for (const r of resultadosRegra) {
    const lancamento = porId.get(r.lancamentoId);
    if (!lancamento) continue;
    const resultado = await lancarMovimentacaoDireta(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento, valor: lancamento.valor, descricao_normalizada: lancamento.descricao_normalizada },
      r.categoria,
      entrada,
      saida
    );
    if (resultado === "ok") lancados++;
    else if (resultado === "mes_fechado") mesFechado++;
  }
  return { lancados, mesFechado };
}
```

- [ ] **Step 5: Wiring em `handleReprocessar`**

Linha 530-533, trocar:
```ts
      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
      const qtd = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
```
por:
```ts
      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
      const resultadosRegra = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
      const qtd = resultadosRegra.length;
      const lancamentosDiretos = await processarLancamentosDiretos(paraClassificar, resultadosRegra);
```

Logo abaixo (linha ~535-539), trocar o bloco de `partes`:
```ts
      const partes: string[] = [];
      if (baixasAuto.baixados > 0) partes.push(`${baixasAuto.baixados} baixado(s) automaticamente`);
      if (baixasAuto.ambiguos > 0) partes.push(`${baixasAuto.ambiguos} ambíguo(s) (revisar)`);
      if (baixasAuto.mesFechado > 0) partes.push(`${baixasAuto.mesFechado} não baixado(s): mês contábil fechado`);
      if (qtd > 0) partes.push(`${qtd} classificado(s) por regra`);
```
por:
```ts
      const partes: string[] = [];
      if (baixasAuto.baixados > 0) partes.push(`${baixasAuto.baixados} baixado(s) automaticamente`);
      if (baixasAuto.ambiguos > 0) partes.push(`${baixasAuto.ambiguos} ambíguo(s) (revisar)`);
      if (baixasAuto.mesFechado > 0) partes.push(`${baixasAuto.mesFechado} não baixado(s): mês contábil fechado`);
      if (qtd > 0) partes.push(`${qtd} classificado(s) por regra`);
      if (lancamentosDiretos.lancados > 0) partes.push(`${lancamentosDiretos.lancados} lançado(s) em movimentações`);
      if (lancamentosDiretos.mesFechado > 0) partes.push(`${lancamentosDiretos.mesFechado} não lançado(s) em movimentações: mês contábil fechado`);
```

- [ ] **Step 6: Wiring em `handleImportar`**

Linha 712-718, trocar:
```ts
      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
        if (paraClassificar.length > 0) {
          classificadosAuto = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
        }
      }
```
por:
```ts
      let classificadosAuto = 0;
      let lancamentosDiretos = { lancados: 0, mesFechado: 0 };
      if (inseridos && inseridos.length > 0) {
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
        if (paraClassificar.length > 0) {
          const resultadosRegra = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
          classificadosAuto = resultadosRegra.length;
          lancamentosDiretos = await processarLancamentosDiretos(paraClassificar, resultadosRegra);
        }
      }
```

Linha 319, estender o estado `resumoImportacao`:
```ts
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; mesFechado: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; avisos: string[] } | null>(null);
```

Linha 720, trocar o `setResumoImportacao`:
```ts
      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, mesFechado: baixasAuto.mesFechado, movimentacoesLancadas: lancamentosDiretos.lancados, movimentacoesMesFechado: lancamentosDiretos.mesFechado, avisos: parsed.avisos });
```

Linha 721-730, trocar a mensagem de sucesso:
```ts
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (baixasAuto.baixados > 0 ? ` · ${baixasAuto.baixados} baixado(s) automaticamente` : "") +
          (baixasAuto.ambiguos > 0 ? ` · ${baixasAuto.ambiguos} ambígua(s) (revisar)` : "") +
          (baixasAuto.mesFechado > 0 ? ` · ${baixasAuto.mesFechado} não baixada(s): mês contábil fechado` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : "") +
          (lancamentosDiretos.lancados > 0 ? ` · ${lancamentosDiretos.lancados} lançada(s) em movimentações` : "") +
          (lancamentosDiretos.mesFechado > 0 ? ` · ${lancamentosDiretos.mesFechado} não lançada(s): mês contábil fechado` : ""),
      });
```

- [ ] **Step 7: Card de resumo na aba Importar**

Linha 1200-1226 (bloco `{resumoImportacao && (...)}`), adicionar dois parágrafos novos logo depois do parágrafo de `mesFechado` da Capacidade B (depois da linha 1217, antes de `{resumoImportacao.avisos.length > 0 && (...)}`):
```tsx
                {resumoImportacao.movimentacoesLancadas > 0 && (
                  <p className="mt-1 font-semibold">
                    {resumoImportacao.movimentacoesLancadas} lançamento(s) lançados em Movimentações
                  </p>
                )}
                {resumoImportacao.movimentacoesMesFechado > 0 && (
                  <p className="mt-1 font-semibold text-amber-700">
                    {resumoImportacao.movimentacoesMesFechado} lançamento(s) classificados mas NÃO lançados em Movimentações: mês contábil já fechado.
                  </p>
                )}
```

- [ ] **Step 8: Wiring em `handleImportarRelatorioPix`**

Linha 785, ampliar o `.select(...)` do upsert (falta `data_lancamento`):
```ts
        .select("id, conta_id, descricao_normalizada, valor, status");
```
para:
```ts
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento");
```

Linha 805-808, trocar:
```ts
      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }
```
por:
```ts
      let classificadosAuto = 0;
      let lancamentosDiretosPix = { lancados: 0, mesFechado: 0 };
      if (inseridos && inseridos.length > 0) {
        const resultadosRegra = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
        classificadosAuto = resultadosRegra.length;
        lancamentosDiretosPix = await processarLancamentosDiretos(inseridos as LancamentoParaBaixa[], resultadosRegra);
      }
```

Linha 106, estender o estado `resumoImportacaoPix`:
```ts
  const [resumoImportacaoPix, setResumoImportacaoPix] = useState<{ lidas: number; novas: number; duplicadas: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; avisos: string[] } | null>(null);
```

Linha 810, trocar o `setResumoImportacaoPix`:
```ts
      setResumoImportacaoPix({ lidas: linhas.length, novas, duplicadas, movimentacoesLancadas: lancamentosDiretosPix.lancados, movimentacoesMesFechado: lancamentosDiretosPix.mesFechado, avisos: parsed.avisos });
```

Linha 811-816, trocar a mensagem de sucesso:
```ts
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : "") +
          (lancamentosDiretosPix.lancados > 0 ? ` · ${lancamentosDiretosPix.lancados} lançada(s) em movimentações` : "") +
          (lancamentosDiretosPix.mesFechado > 0 ? ` · ${lancamentosDiretosPix.mesFechado} não lançada(s): mês contábil fechado` : ""),
      });
```

O card de resumo do relatório Pix (procure `{resumoImportacaoPix && (...)}` logo depois do card do OFX) recebe os mesmos dois parágrafos do Step 7, adaptados pra `resumoImportacaoPix` em vez de `resumoImportacao`.

- [ ] **Step 9: Wiring em `handleClassificarManual`**

Linha 830-859, trocar a função inteira:
```ts
  async function handleClassificarManual(lancamento: Lancamento, categoria: string) {
    if (!categoria.trim()) return;
    setAcaoLancamentoId(lancamento.id);
    setMensagem(null);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("extrato_lancamento")
      .update({
        categoria: categoria.trim(),
        status: "classificado",
        classificado_em: new Date().toISOString(),
        classificado_por: user?.id ?? null,
        regra_id: null,
      })
      .eq("id", lancamento.id);
    setAcaoLancamentoId(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao classificar: " + error.message });
      return;
    }

    const { entrada, saida } = await carregarMapasCategoria();
    const resultadoLancamento = await lancarMovimentacaoDireta(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento, valor: lancamento.valor, descricao_normalizada: lancamento.descricao_normalizada },
      categoria.trim(),
      entrada,
      saida
    );
    if (resultadoLancamento === "mes_fechado") {
      setMensagem({
        tipo: "erro",
        texto: `Classificado, mas não lançado em Movimentações: ${formatarData(lancamento.data_lancamento)} está num mês contábil já fechado.`,
      });
    }

    setCategoriaEmEdicao((prev) => {
      const cp = { ...prev };
      delete cp[lancamento.id];
      return cp;
    });
    await Promise.all([carregarLancamentos(), carregarResumo()]);
    setTrechoRegra(lancamento.descricao_normalizada);
    setEscopoContaRegra(true);
    setSugerirRegraPara({ lancamento, categoria: categoria.trim() });
  }
```
(Único acréscimo real: o bloco de `carregarMapasCategoria`/`lancarMovimentacaoDireta`/checagem de `mes_fechado`, logo depois de confirmar que o update no staging não deu erro. O resto da função é idêntico ao que já existe.)

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 11: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos 2 avisos pré-existentes (linhas dos `useEffect` de carga inicial), nenhum novo.

- [ ] **Step 12: Teste manual com dados reais de teste no Supabase**

Via MCP (`mcp__claude_ai_Supabase__execute_sql`, projeto `nheyevdjomfphlzmsszk`):
1. Confirme que existe (ou crie de teste) uma `extrato_regra` ativa mapeando algum texto pra uma categoria real de `categorias_saida` (ex.: reaproveite a regra "sabesp"→"Água SABESP" já existente).
2. Insira um `extrato_lancamento` de teste com `status='nao_classificado'`, `valor` negativo, `descricao_normalizada` batendo nessa regra, `data_lancamento` num mês aberto.
3. Rode manualmente a sequência que `classificarPorRegras`+`processarLancamentosDiretos` fariam (ou, se praticável, chame a lógica via `npx tsx` com um script que importe as funções — considerando que elas usam `createClient()` real, um script Node com as env vars corretas deve funcionar) — confirme que uma `movimentacoes` nova foi criada com `data`/`valor`/`categoria_id` corretos, e que o `extrato_lancamento` de teste ficou com `movimentacao_id` preenchido.
4. Repita com uma descrição contendo "pagamento de boleto" — confirme que NENHUMA movimentação é criada, mesmo que a categoria resolvida seja válida.
5. Repita com uma data dentro do mês fechado (verifique qual mês está `fechado` hoje antes de escolher a data) — confirme que nenhuma movimentação é criada.
6. Apague todos os dados de teste (lançamento, regra se criada, movimentações geradas) e confirme zerado.

- [ ] **Step 13: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): lançar movimentações direto a partir de lançamentos classificados"
```

---

### Task 3: UI — badge "Lançado em Movimentações"

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `l.movimentacao_id` (Task 2).

- [ ] **Step 1: Badge na célula de Categoria**

Localize o bloco (procure `Baixa automática` no arquivo — está dentro do `<div className="flex flex-col gap-1 items-start">` da célula de Categoria, junto do badge de mesmo estilo da Capacidade B):
```tsx
                                        {l.conta_pagar_id && (
                                          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[9px] font-semibold whitespace-nowrap">
                                            Baixa automática
                                          </span>
                                        )}
```
Adicionar logo abaixo, mesmo nível (dentro do mesmo `<div>`):
```tsx
                                        {l.movimentacao_id && (
                                          <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[9px] font-semibold whitespace-nowrap">
                                            Lançado em Movimentações
                                          </span>
                                        )}
```
(Cor diferente da Capacidade B — `purple` em vez de `blue` — pra distinguir visualmente as duas origens de escrita automática.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): badge de lançamento direto em movimentações na lista"
```

---

### Task 4: Reversão — tela de Movimentações reseta o vínculo do extrato

**Files:**
- Modify: `src/app/(app)/movimentacoes/page.tsx`

**Interfaces:**
- Consumes: `extrato_lancamento.movimentacao_id` (Task 1).

- [ ] **Step 1: Estender `excluirMov`**

Linha 334-342, trocar:
```ts
  async function excluirMov(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", id);
    await supabase.from("movimentacoes").delete().eq("id", id);
    await registrarLog({ acao: "excluiu", tabela: "movimentacoes", registroId: id });
    setMensagem("Excluído!");
    carregarMovimentacoes();
    setTimeout(() => setMensagem(""), 3000);
  }
```
por:
```ts
  async function excluirMov(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", id);
    await supabase.from("movimentacoes").delete().eq("id", id);
    // Reseta o lançamento do extrato SÓ depois de confirmar a exclusão da
    // movimentação -- se a exclusão falhasse e o reset rodasse antes, um
    // reprocessamento futuro poderia classificar e lançar de novo o mesmo
    // débito bancário, duplicando a movimentação que na verdade nunca saiu
    // do banco.
    await supabase
      .from("extrato_lancamento")
      .update({ status: "nao_classificado", categoria: null, classificado_em: null, movimentacao_id: null })
      .eq("movimentacao_id", id);
    await registrarLog({ acao: "excluiu", tabela: "movimentacoes", registroId: id });
    setMensagem("Excluído!");
    carregarMovimentacoes();
    setTimeout(() => setMensagem(""), 3000);
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 3: Lint**

Run: `npx eslint src/app/(app)/movimentacoes/page.tsx`
Expected: sem erros novos (confira o baseline antes da mudança, igual às tasks anteriores, com `git stash`).

- [ ] **Step 4: Teste manual**

Via MCP: crie um `extrato_lancamento` de teste com `movimentacao_id` apontando pra uma `movimentacoes` de teste real. Exclua a movimentação (SQL direto simulando o que `excluirMov` faz, ou raciocínio sobre o código é aceitável já que é uma mudança pequena e direta). Confirme: a movimentação some, o lançamento do extrato volta pra `status='nao_classificado'` com `categoria`/`classificado_em`/`movimentacao_id` nulos. Apague os dados de teste.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/movimentacoes/page.tsx"
git commit -m "fix(movimentacoes): resetar lançamento do extrato ao excluir movimentação vinculada"
```

---

## Self-Review

**Cobertura da spec** (`docs/superpowers/specs/2026-08-12-extrato-movimentacoes-diretas-design.md`):
- Seção 1 (tradução categoria→id): Task 2, `carregarMapasCategoria` + checagem `if (!categoriaId) return "nao_lancado"`. ✅
- Seção 2 (exclusão padrão-boleto): Task 2, `ehPagamentoDeBoleto` no topo de `lancarMovimentacaoDireta`, aplicado nos dois caminhos (automático e manual, já que ambos passam pela mesma função). ✅
- Seção 3 (caminho automático): Task 2, `processarLancamentosDiretos` rodando logo após `classificarPorRegras` nos três call sites (`handleImportar`, `handleReprocessar`, `handleImportarRelatorioPix`). ✅
- Seção 4 (caminho manual): Task 2, Step 9. ✅
- Seção 5 (rastreabilidade e reversão): Task 1 (coluna), Task 3 (badge), Task 4 (reset no excluir). ✅
- Seção 6 (resumo pós-importação): Task 2, Steps 5-8. ✅
- Fora de escopo (boletos sem match, backfill retroativo, edição de movimentação, XML): nenhuma task toca nisso. ✅

**Checagem de placeholders**: nenhuma neste plano — todo código está completo, inclusive os três call sites de `classificarPorRegras` que precisavam de wiring (achado ao ler o arquivo real: existe um terceiro call site em `handleImportarRelatorioPix` que a spec não mencionou explicitamente, mas cai dentro do mesmo requisito "Pix recebido vira entrada automaticamente" — coberto no Step 8).

**Consistência de tipos entre tasks**: `LancamentoParaMovimentacao`, `ResultadoLancamentoDireto`, `lancarMovimentacaoDireta`, `processarLancamentosDiretos`, `carregarMapasCategoria` todos definidos na Task 2 e usados sem redefinição nas tasks seguintes. `movimentacao_id` nomeado de forma idêntica em todas as tasks (schema, interface `Lancamento`, JSX, `excluirMov`).

---

## Execução

Plano salvo em `docs/superpowers/plans/2026-08-12-extrato-movimentacoes-diretas.md`.

**1. Subagent-Driven (recomendado)** — dispatch de subagent fresco por task, revisão entre tasks, iteração rápida. Task 1 é exceção: executada pelo orquestrador diretamente (alteração de schema em produção).

**2. Execução inline** — executar as tasks nesta sessão via executing-plans, em lote com checkpoints.

Qual abordagem?
