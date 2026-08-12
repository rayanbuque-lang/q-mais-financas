# Baixa Automática de Contas a Pagar via Extrato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Exceção de execução — Task 1:** essa task altera o schema do banco de produção (Supabase). Ela deve ser executada diretamente pelo orquestrador da sessão (quem está coordenando o SDD), usando a ferramenta `mcp__claude_ai_Supabase__apply_migration` — **não deve ser despachada como subagent**. Todas as outras tasks (2-5) seguem o fluxo normal de SDD.

**Goal:** Ao importar um extrato OFX (ou reprocessar lançamentos pendentes), todo lançamento de saída é testado contra `contas_pagar` pendentes por valor idêntico + nome de fornecedor aproximado; um casamento único gera baixa automática imediata (mesma escrita que o botão manual já faz), um empate fica marcado como ambíguo para resolução manual, e o resumo pós-importação mostra os números de forma auditável.

**Architecture:** Motor de casamento é uma função pura nova (`src/lib/baixa-contas-pagar.ts`, mesmo padrão de `src/lib/cobertura-pix.ts`) — recebe candidatos e contas pendentes já carregados, devolve quem baixa e quem fica ambíguo, sem tocar Supabase. Toda a integração com Supabase (consultas, a escrita da baixa, o wiring no fluxo de import) vive em `src/app/extrato/page.tsx`, reaproveitando literalmente a mesma escrita `contas_pagar`+`movimentacoes` que a baixa manual já usa em `src/app/(app)/contas-pagar/page.tsx`.

**Tech Stack:** Next.js 16.2.6 App Router, React 19, Supabase JS v2, TypeScript. Sem framework de testes formal — verificação via scripts Node descartáveis (`node --experimental-strip-types`), sempre apagados depois de passar.

## Global Constraints

- **Nunca perder dado silenciosamente**: um lançamento sem casamento claro fica como está hoje (nao_classificado), nunca é adivinhado.
- **Casamento exige valor idêntico E nome aproximado ao mesmo tempo** — nunca decide por um critério isolado.
- **Nome aproximado = "contém" (substring em qualquer posição)**, não prefixo fixo — comprovado necessário com dado real (`"P SEVERINI NETTO COMERCIA"` deve casar com fornecedor cadastrado `"Severini"`).
- **Empate (2+ candidatos) nunca é decidido automaticamente** — fica marcado, resolução é sempre manual.
- **Toda escrita usa `lancamento.data_lancamento`** (a data real do próprio lançamento do extrato) — nunca "hoje", nunca uma data agregada. Cada lançamento é resolvido individualmente, nunca em lote.
- **Reaproveitar a escrita de baixa manual exatamente como já existe** em `src/app/(app)/contas-pagar/page.tsx` (`confirmarPagamento`, linha 349-357) — nenhum caminho de escrita novo em `contas_pagar`/`movimentacoes`.
- **Sem framework de teste**: cada task com lógica pura usa um script Node descartável colocado ao lado do arquivo fonte, com imports relativos (nunca `@/...`, que exige resolução de alias), executado com `node --experimental-strip-types caminho/do/script.mjs`, e **apagado** depois de confirmar que passa. Nenhum arquivo de teste é commitado.
- Fora de escopo (não implementar nada disso aqui): Pix Enviado, lançar entrada em movimentações direto, XML→contas a pagar automático.

---

## Contexto que todo implementador precisa (não assumir leitura prévia)

**Esta é a primeira vez que `/extrato` escreve em tabelas de produção.** Até agora `/extrato` era 100% staging isolado (nunca tocava `movimentacoes`/`contas_pagar`). Trate qualquer escrita nova com o mesmo cuidado das features anteriores deste projeto: nunca perder lançamento, sempre reversível.

**Schema de produção relevante** (não há `supabase/migrations/` versionado neste repo — o schema vive só no banco remoto Supabase, projeto `nheyevdjomfphlzmsszk`, acessível via MCP):

`contas_pagar`: `id uuid`, `fornecedor text` (nome curto, ex. `"SDB"`, `"Severini"`, `"Compre Facil"`), `descricao text`, `valor numeric`, `data_vencimento date`, `data_pagamento date null`, `status text` (`'pendente'|'pago'|'cancelado'`), `categoria_id uuid null` (aponta para `categorias_saida.id`, sem FK declarada — é convenção de código, não do banco), `observacao text`, `comprovante_url text`, `created_at timestamptz`.

`movimentacoes`: `id uuid`, `tipo text` (`'entrada'|'saida'`), `data date`, `valor numeric`, `categoria_id uuid not null`, `observacao text`, `revisar boolean`, `forma_pagamento text null`, `comprovante_url text null`, `conta_pagar_id uuid null references contas_pagar(id)` (o vínculo que toda baixa usa).

`extrato_lancamento` (staging): `id uuid`, `conta_id uuid`, `importacao_id uuid`, `fitid text`, `data_lancamento date`, `valor numeric` (negativo para saída, positivo para entrada — mesmo sinal do `TRNAMT` do OFX), `tipo text null`, `descricao text`, `descricao_normalizada text`, `categoria text` (texto livre, **não** FK), `regra_id uuid null`, `status text` (`'nao_classificado'|'classificado'|'ignorado'`), `classificado_em timestamptz null`, `classificado_por uuid null`, `revisado boolean`, `ocorrencia int`.

**Baixa manual hoje** (`src/app/(app)/contas-pagar/page.tsx:349-357`, função `confirmarPagamento`):
```js
const { error: err1 } = await supabase.from("contas_pagar").update({ status: "pago", data_pagamento: dataPag }).eq("id", conta.id);
if (err1) { setMensagem("Erro ao confirmar."); setLoading(false); return; }
await supabase.from("movimentacoes").insert({ tipo: "saida", data: dataPag, valor: conta.valor, categoria_id: conta.categoria_id, observacao: `Pagamento: ${conta.fornecedor}${conta.descricao ? ` - ${conta.descricao}` : ""}`, revisar: false, conta_pagar_id: conta.id });
await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: conta.id, detalhes: `${conta.fornecedor} - ${fmt(conta.valor)}` });
```
`registrarLog` vem de `@/lib/audit` — grava em `audit_log`, lê o usuário autenticado via `supabase.auth.getUser()`, não faz nada se não houver usuário logado (seguro chamar em qualquer contexto client-side).

**"Desfazer pagamento" já existe** (`src/app/(app)/contas-pagar/page.tsx:402-409`, `desfazerPagamento`) e já reverte esse tipo de escrita — é a rede de segurança para qualquer baixa automática errada. Nada novo precisa ser construído para isso.

**Dados reais que fundamentam o algoritmo de nome** (confirmados por consulta direta ao banco de produção e aos arquivos OFX reais do usuário):
```
Banco (extrato):  "PAGAMENTO DE BOLETO OUTROS BANCOS  P SEVERINI NETTO COMERCIA"
Cadastro:         fornecedor = "Severini "
```
Só casa se o teste for "contém" — o fornecedor cadastrado não é prefixo da descrição do banco (tem "P " antes). Outro par real:
```
Banco (extrato):  "PAGAMENTO DE BOLETO                COMPRE FACIL COMERCIO DE"
Cadastro:         fornecedor = "Compre Facil "  valor = 298.95, vencimento 2026-08-20
Cadastro:         fornecedor = "Compre Facil "  valor = 298.95, vencimento 2026-08-27
```
Este segundo par é o caso real de ambiguidade genuína — duas contas do mesmo fornecedor, mesmo valor, pendentes ao mesmo tempo.

**`normalizarDescricao`** já existe em `src/lib/ofx.ts:36-44` (lowercase, remove acentos, remove pontuação, colapsa espaços, trim) — reaproveitar para normalizar `contas_pagar.fornecedor` também, mesma função dos dois lados.

**Precedente de função pura para motor de casamento**: `src/lib/cobertura-pix.ts` — recebe candidatos + existentes já carregados do banco, devolve resultado de casamento, zero chamada a Supabase dentro do arquivo. Seguir esse mesmo padrão.

**Cuidado com `numeric` do Postgres**: colunas `numeric` podem eventualmente chegar como string via alguns caminhos de leitura. Para não depender de qual é o comportamento exato do supabase-js aqui, todo valor lido do banco que alimenta uma comparação numérica deve passar por `Number(...)` explicitamente no ponto de leitura (custo zero se já for número, remove qualquer ambiguidade).

---

### Task 1: Migração de schema — novas colunas em `extrato_lancamento`

**Executada pelo orquestrador diretamente, não por subagent.**

**Files:**
- Nenhum arquivo no repo (não há pasta de migrations versionada). A alteração é aplicada direto no banco via MCP.

**Interfaces:**
- Produces: duas colunas novas em `extrato_lancamento`, consumidas pelas Tasks 3, 4 e 5 — `conta_pagar_id uuid null` (vínculo de auditoria com a conta a pagar baixada) e `contas_pagar_candidatas jsonb null` (array de ids quando o casamento é ambíguo).

- [ ] **Step 1: Aplicar a migração**

Usar `mcp__claude_ai_Supabase__apply_migration` com `project_id: "nheyevdjomfphlzmsszk"` e o SQL:

```sql
alter table extrato_lancamento
  add column conta_pagar_id uuid references contas_pagar(id),
  add column contas_pagar_candidatas jsonb;
```

- [ ] **Step 2: Confirmar que as colunas existem**

Rodar via `mcp__claude_ai_Supabase__execute_sql` (mesmo `project_id`):
```sql
select column_name, data_type from information_schema.columns
where table_name = 'extrato_lancamento' and column_name in ('conta_pagar_id', 'contas_pagar_candidatas');
```
Esperado: duas linhas, `conta_pagar_id` tipo `uuid`, `contas_pagar_candidatas` tipo `jsonb`.

- [ ] **Step 3: Nenhum commit** — não há arquivo de código para commitar nesta task (é só schema remoto). Marcar como concluída no ledger do SDD e seguir para a Task 2.

---

### Task 2: Motor de casamento puro — `src/lib/baixa-contas-pagar.ts`

**Files:**
- Create: `src/lib/baixa-contas-pagar.ts`
- Test (descartável, apagar ao final): `src/lib/_test-baixa-contas-pagar.mjs`

**Interfaces:**
- Consumes: `normalizarDescricao` de `src/lib/ofx.ts` (já existe, assinatura `(texto: string) => string`).
- Produces (consumido pela Task 3):
  ```ts
  export interface ContaPagarPendente {
    id: string;
    fornecedor: string;
    valor: number;
  }

  export interface CandidatoBaixa {
    indice: number;
    valor: number; // valor absoluto (positivo) do lançamento de saída
    descricaoNormalizada: string;
  }

  export interface ResultadoBaixa {
    baixados: { indice: number; contaPagarId: string }[];
    ambiguos: { indice: number; candidatosIds: string[] }[];
  }

  export function calcularBaixasAutomaticas(
    candidatos: CandidatoBaixa[],
    contasPendentes: ContaPagarPendente[]
  ): ResultadoBaixa
  ```
  Um `indice` de `candidatos` que não aparece nem em `baixados` nem em `ambiguos` significa "zero candidatos" — segue o fluxo normal, sem ação nenhuma da Task 3.

- [ ] **Step 1: Escrever o script de teste descartável**

Criar `src/lib/_test-baixa-contas-pagar.mjs`:

```js
import { calcularBaixasAutomaticas } from "./baixa-contas-pagar.ts";

let falhas = 0;
function assertEqual(nome, obtido, esperado) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a !== b) {
    falhas++;
    console.error(`FALHOU: ${nome}\n  obtido:   ${a}\n  esperado: ${b}`);
  } else {
    console.log(`OK: ${nome}`);
  }
}

// 1. Candidato único, valor e nome batem -> baixa automática.
{
  const candidatos = [{ indice: 0, valor: 233.57, descricaoNormalizada: "pagamento de boleto sdb comercio de alimentos" }];
  const pendentes = [{ id: "conta-sdb", fornecedor: "SDB", valor: 233.57 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("candidato unico baixa", r, { baixados: [{ indice: 0, contaPagarId: "conta-sdb" }], ambiguos: [] });
}

// 2. Nome real truncado com prefixo variável do banco ("P SEVERINI NETTO COMERCIA")
//    precisa casar com o fornecedor cadastrado curto ("Severini") -- exige "contém",
//    não prefixo, porque "severini" não está no início da descrição do banco.
{
  const candidatos = [{ indice: 0, valor: 248.25, descricaoNormalizada: "pagamento de boleto outros bancos p severini netto comercia" }];
  const pendentes = [{ id: "conta-severini", fornecedor: "Severini ", valor: 248.25 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("nome com prefixo variavel do banco", r, { baixados: [{ indice: 0, contaPagarId: "conta-severini" }], ambiguos: [] });
}

// 3. Caso real de ambiguidade: duas contas pendentes do mesmo fornecedor, mesmo
//    valor exato, ao mesmo tempo -- nunca decide sozinho.
{
  const candidatos = [{ indice: 0, valor: 298.95, descricaoNormalizada: "pagamento de boleto compre facil comercio de" }];
  const pendentes = [
    { id: "conta-cf-1", fornecedor: "Compre Facil ", valor: 298.95 },
    { id: "conta-cf-2", fornecedor: "Compre Facil ", valor: 298.95 },
  ];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("ambiguidade real compre facil", r, { baixados: [], ambiguos: [{ indice: 0, candidatosIds: ["conta-cf-1", "conta-cf-2"] }] });
}

// 4. Zero candidatos -- nao aparece em nenhuma lista.
{
  const candidatos = [{ indice: 0, valor: 999.99, descricaoNormalizada: "pagamento de boleto fornecedor desconhecido" }];
  const pendentes = [{ id: "conta-sdb", fornecedor: "SDB", valor: 233.57 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("zero candidatos", r, { baixados: [], ambiguos: [] });
}

// 5. Nome bate mas valor diferente -- nao casa.
{
  const candidatos = [{ indice: 0, valor: 100.00, descricaoNormalizada: "pagamento de boleto sdb comercio de alimentos" }];
  const pendentes = [{ id: "conta-sdb", fornecedor: "SDB", valor: 233.57 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("nome bate valor diferente", r, { baixados: [], ambiguos: [] });
}

// 6. Valor bate mas nome nao corresponde a nenhum fornecedor pendente -- nao casa.
{
  const candidatos = [{ indice: 0, valor: 233.57, descricaoNormalizada: "pagamento de boleto outro fornecedor qualquer" }];
  const pendentes = [{ id: "conta-sdb", fornecedor: "SDB SA", valor: 233.57 }];
  // "sdb sa" normalizado NAO aparece dentro de "outro fornecedor qualquer".
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("valor bate nome nao corresponde", r, { baixados: [], ambiguos: [] });
}

// 7. Multiplos candidatos no mesmo lote, indices preservados corretamente.
{
  const candidatos = [
    { indice: 0, valor: 233.57, descricaoNormalizada: "pagamento de boleto sdb comercio de alimentos" },
    { indice: 1, valor: 165.28, descricaoNormalizada: "conta de agua e esgoto em canais internet sabesp sao paulo" },
  ];
  const pendentes = [
    { id: "conta-sdb", fornecedor: "SDB", valor: 233.57 },
    { id: "conta-sabesp", fornecedor: "Sabesp", valor: 165.28 },
  ];
  const r = calcularBaixasAutomaticas(candidatos, pendentes);
  assertEqual("multiplos candidatos indices corretos", r, {
    baixados: [
      { indice: 0, contaPagarId: "conta-sdb" },
      { indice: 1, contaPagarId: "conta-sabesp" },
    ],
    ambiguos: [],
  });
}

if (falhas > 0) {
  console.error(`\n${falhas} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
```

- [ ] **Step 2: Rodar o teste e confirmar que falha (arquivo ainda não existe)**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar.mjs`
Expected: erro de módulo não encontrado (`baixa-contas-pagar.ts` ainda não existe).

- [ ] **Step 3: Implementar `src/lib/baixa-contas-pagar.ts`**

```ts
// Motor de "esse pagamento no extrato bate com uma conta a pagar pendente" --
// usado pela automação de baixa em /extrato. Decide só QUEM baixa e QUEM fica
// ambíguo; nunca decide sozinho um empate (duas contas do mesmo fornecedor e
// mesmo valor pendentes ao mesmo tempo é um caso real, confirmado em produção).

import { normalizarDescricao } from "@/lib/ofx";

export interface ContaPagarPendente {
  id: string;
  fornecedor: string;
  valor: number;
}

export interface CandidatoBaixa {
  indice: number;
  valor: number; // valor absoluto (positivo) do lançamento de saída
  descricaoNormalizada: string;
}

export interface ResultadoBaixa {
  baixados: { indice: number; contaPagarId: string }[];
  ambiguos: { indice: number; candidatosIds: string[] }[];
}

// "Contém", não prefixo: o banco antepõe texto variável antes do nome do
// fornecedor (ex.: "P SEVERINI NETTO COMERCIA" para o fornecedor cadastrado
// como "Severini") -- confirmado com dado real de produção.
function contaCasaComCandidato(conta: ContaPagarPendente, candidato: CandidatoBaixa): boolean {
  if (conta.valor !== candidato.valor) return false;
  const fornecedorNormalizado = normalizarDescricao(conta.fornecedor);
  if (fornecedorNormalizado.length === 0) return false;
  return candidato.descricaoNormalizada.includes(fornecedorNormalizado);
}

export function calcularBaixasAutomaticas(
  candidatos: CandidatoBaixa[],
  contasPendentes: ContaPagarPendente[]
): ResultadoBaixa {
  const baixados: ResultadoBaixa["baixados"] = [];
  const ambiguos: ResultadoBaixa["ambiguos"] = [];

  for (const candidato of candidatos) {
    const casadas = contasPendentes.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadas.length === 1) {
      baixados.push({ indice: candidato.indice, contaPagarId: casadas[0].id });
    } else if (casadas.length >= 2) {
      ambiguos.push({ indice: candidato.indice, candidatosIds: casadas.map((c) => c.id) });
    }
  }

  return { baixados, ambiguos };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar.mjs`
Expected: `Todos os testes passaram.` (7 linhas `OK:`, saída limpa, exit code 0).

- [ ] **Step 5: Apagar o script de teste**

```bash
rm src/lib/_test-baixa-contas-pagar.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/baixa-contas-pagar.ts
git commit -m "feat(extrato): motor de casamento puro para baixa automática de contas a pagar"
```

---

### Task 3: Escrita da baixa automática + wiring no import e no reprocessar

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `calcularBaixasAutomaticas`, `type CandidatoBaixa`, `type ContaPagarPendente` de `src/lib/baixa-contas-pagar.ts` (Task 2). `registrarLog` de `@/lib/audit` (assinatura: `registrarLog({ acao: string, tabela: string, registroId: string, detalhes: string }) => Promise<void>`, já usada em `src/app/(app)/contas-pagar/page.tsx`). Colunas `conta_pagar_id`/`contas_pagar_candidatas` em `extrato_lancamento` (Task 1).
- Produces (consumido pelas Tasks 4 e 5): campos `conta_pagar_id: string | null` e `contas_pagar_candidatas: string[] | null` na interface `Lancamento`; função `baixarContaPagar` (não exportada, usada internamente no componente, reaproveitada pela Task 5).

- [ ] **Step 1: Adicionar o import de `baixa-contas-pagar` e `registrarLog`**

No topo de `src/app/extrato/page.tsx`, junto aos imports existentes (linha 5-9):

```ts
import { calcularBaixasAutomaticas, type CandidatoBaixa, type ContaPagarPendente } from "@/lib/baixa-contas-pagar";
import { registrarLog } from "@/lib/audit";
```

- [ ] **Step 2: Estender a interface `Lancamento`**

Em `src/app/extrato/page.tsx:20-34`, adicionar os dois campos novos ao final da interface:

```ts
interface Lancamento {
  id: string;
  conta_id: string;
  fitid: string;
  data_lancamento: string;
  valor: number;
  tipo: string | null;
  descricao: string;
  descricao_normalizada: string;
  categoria: string | null;
  regra_id: string | null;
  status: "nao_classificado" | "classificado" | "ignorado";
  classificado_em: string | null;
  revisado: boolean;
  conta_pagar_id: string | null;
  contas_pagar_candidatas: string[] | null;
}
```

Não precisa mudar `carregarLancamentos` (linha 164-185) — já faz `.select("*")`, então as colunas novas chegam sozinhas.

- [ ] **Step 3: Adicionar o tipo `LancamentoParaBaixa` e a função `baixarContaPagar`**

Logo antes de `classificarPorRegras` (antes da linha 250 atual, na seção "---------- Motor de regras ----------"), adicionar:

```ts
interface LancamentoParaBaixa {
  id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
  status: string;
}

// Reaproveita exatamente a mesma escrita que a baixa manual já faz em
// src/app/(app)/contas-pagar/page.tsx (confirmarPagamento) -- nenhum caminho
// de escrita novo em contas_pagar/movimentacoes. Usada tanto pela baixa
// automática (candidato único) quanto pela resolução manual de ambíguos.
async function baixarContaPagar(
  lancamento: { id: string; data_lancamento: string },
  conta: { id: string; fornecedor: string; valor: number; categoria_id: string | null },
  categoriaNome: string
): Promise<boolean> {
  const supabase = createClient();
  const { error: erroBaixa } = await supabase
    .from("contas_pagar")
    .update({ status: "pago", data_pagamento: lancamento.data_lancamento })
    .eq("id", conta.id)
    .eq("status", "pendente");
  if (erroBaixa) return false;

  await supabase.from("movimentacoes").insert({
    tipo: "saida",
    data: lancamento.data_lancamento,
    valor: conta.valor,
    categoria_id: conta.categoria_id,
    observacao: `Pagamento: ${conta.fornecedor}`,
    revisar: false,
    conta_pagar_id: conta.id,
  });

  await supabase
    .from("extrato_lancamento")
    .update({
      status: "classificado",
      categoria: categoriaNome,
      classificado_em: new Date().toISOString(),
      conta_pagar_id: conta.id,
      contas_pagar_candidatas: null,
    })
    .eq("id", lancamento.id);

  await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: conta.id, detalhes: `${conta.fornecedor} - baixa automática via extrato` });
  return true;
}
```

Nota: `baixarContaPagar` cria seu próprio `createClient()` porque é uma função de módulo (fora do componente), não tem acesso ao `supabase` já instanciado dentro de `ExtratoPage`. `createClient()` de `@/lib/supabase/client` é seguro de chamar múltiplas vezes (mesmo padrão usado em outros lugares do projeto).

- [ ] **Step 4: Adicionar `processarBaixasAutomaticas`**

Logo depois de `baixarContaPagar`:

```ts
// Roda sobre lançamentos de saída recém-chegados (import de OFX ou
// reprocessamento). Nunca decide um empate sozinho -- ver calcularBaixasAutomaticas.
async function processarBaixasAutomaticas(
  lancamentosNovos: LancamentoParaBaixa[]
): Promise<{ baixados: number; ambiguos: number; idsBaixados: Set<string> }> {
  const supabase = createClient();
  const idsBaixados = new Set<string>();
  const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
  if (saidas.length === 0) return { baixados: 0, ambiguos: 0, idsBaixados };

  // .limit(2000) por precaução -- mesma classe de problema já corrigida antes
  // neste projeto (commit 693a921): PostgREST tem teto padrão de linhas.
  // contas_pagar pendentes reais nunca chegaram perto disso, mas não custa nada.
  const { data: pendentes } = await supabase
    .from("contas_pagar")
    .select("id, fornecedor, valor, categoria_id")
    .eq("status", "pendente")
    .limit(2000);
  if (!pendentes || pendentes.length === 0) return { baixados: 0, ambiguos: 0, idsBaixados };

  const { data: categoriasSaidaTodas } = await supabase.from("categorias_saida").select("id, nome");
  const nomeCategoriaPorId = new Map((categoriasSaidaTodas ?? []).map((c) => [c.id as string, c.nome as string]));

  const candidatos: CandidatoBaixa[] = saidas.map((l, indice) => ({
    indice,
    valor: Math.abs(Number(l.valor)),
    descricaoNormalizada: l.descricao_normalizada,
  }));
  const contasPendentes: ContaPagarPendente[] = pendentes.map((c) => ({
    id: c.id as string,
    fornecedor: c.fornecedor as string,
    valor: Number(c.valor),
  }));

  const resultado = calcularBaixasAutomaticas(candidatos, contasPendentes);
  const pendentesPorId = new Map(pendentes.map((c) => [c.id as string, c]));

  let baixados = 0;
  for (const b of resultado.baixados) {
    const lancamento = saidas[b.indice];
    const conta = pendentesPorId.get(b.contaPagarId);
    if (!conta) continue;
    const categoriaId = conta.categoria_id as string | null;
    const categoriaNome = categoriaId ? nomeCategoriaPorId.get(categoriaId) ?? "Contas a pagar" : "Contas a pagar";
    const ok = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: conta.id as string, fornecedor: conta.fornecedor as string, valor: Number(conta.valor), categoria_id: categoriaId },
      categoriaNome
    );
    if (ok) {
      idsBaixados.add(lancamento.id);
      baixados++;
    }
  }

  let ambiguos = 0;
  for (const a of resultado.ambiguos) {
    const lancamento = saidas[a.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: a.candidatosIds }).eq("id", lancamento.id);
    ambiguos++;
  }

  return { baixados, ambiguos, idsBaixados };
}
```

- [ ] **Step 5: Estender o estado `resumoImportacao`**

Em `src/app/extrato/page.tsx:96`, trocar:

```ts
const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; avisos: string[] } | null>(null);
```

por:

```ts
const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; avisos: string[] } | null>(null);
```

- [ ] **Step 6: Ligar tudo em `handleImportar`**

Em `src/app/extrato/page.tsx`, dentro de `handleImportar` (a partir da linha 440):

Trocar o `.select(...)` do upsert (linha 443) de:
```ts
.select("id, conta_id, descricao_normalizada, valor, status");
```
para:
```ts
.select("id, conta_id, descricao_normalizada, valor, status, data_lancamento");
```

Trocar o bloco (linhas 462-465):
```ts
      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }
```
por:
```ts
      let baixasAuto = { baixados: 0, ambiguos: 0, idsBaixados: new Set<string>() };
      if (inseridos && inseridos.length > 0) {
        baixasAuto = await processarBaixasAutomaticas(inseridos as LancamentoParaBaixa[]);
      }

      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter((l) => !baixasAuto.idsBaixados.has(l.id));
        if (paraClassificar.length > 0) {
          classificadosAuto = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
        }
      }
```

Trocar a chamada `setResumoImportacao` (linha 467) de:
```ts
      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, avisos: parsed.avisos });
```
para:
```ts
      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, avisos: parsed.avisos });
```

Trocar o texto da mensagem de sucesso (linhas 468-474) de:
```ts
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
      });
```
para:
```ts
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (baixasAuto.baixados > 0 ? ` · ${baixasAuto.baixados} baixado(s) automaticamente` : "") +
          (baixasAuto.ambiguos > 0 ? ` · ${baixasAuto.ambiguos} ambígua(s) (revisar)` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
      });
```

- [ ] **Step 7: Estender o card de resumo na aba Importar**

Em `src/app/extrato/page.tsx:875-889`, trocar:

```tsx
            {resumoImportacao && (
              <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                <p className="font-semibold">
                  {resumoImportacao.lidas} lidas · {resumoImportacao.novas} novas · {resumoImportacao.duplicadas} já existentes
                  {resumoImportacao.cobertos > 0 && ` · ${resumoImportacao.cobertos} já cobertas pelo relatório Pix`}
                </p>
                {resumoImportacao.avisos.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-amber-700">
                    {resumoImportacao.avisos.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
```

por:

```tsx
            {resumoImportacao && (
              <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                <p className="font-semibold">
                  {resumoImportacao.lidas} lidas · {resumoImportacao.novas} novas · {resumoImportacao.duplicadas} já existentes
                  {resumoImportacao.cobertos > 0 && ` · ${resumoImportacao.cobertos} já cobertas pelo relatório Pix`}
                </p>
                {(resumoImportacao.baixados > 0 || resumoImportacao.ambiguos > 0) && (
                  <p className="mt-1 font-semibold">
                    {resumoImportacao.baixados} lançamento(s) de saída baixados automaticamente em Contas a Pagar
                    {resumoImportacao.ambiguos > 0 && ` · ${resumoImportacao.ambiguos} ambíguo(s) — revisar na aba Lançamentos`}
                  </p>
                )}
                {resumoImportacao.avisos.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-amber-700">
                    {resumoImportacao.avisos.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
```

- [ ] **Step 8: Ligar tudo em `handleReprocessar`**

Em `src/app/extrato/page.tsx:282-306`, trocar a função inteira:

```ts
  async function handleReprocessar() {
    if (!podeEscrever) return;
    setMensagem(null);
    setReprocessando(true);
    try {
      let query = supabase
        .from("extrato_lancamento")
        .select("id, conta_id, descricao_normalizada, valor, status")
        .eq("status", "nao_classificado");
      if (filtroContaId) query = query.eq("conta_id", filtroContaId);
      const { data: candidatos, error } = await query;
      if (error) throw new Error(error.message);

      const qtd = await classificarPorRegras((candidatos ?? []) as LancamentoClassificavel[]);
      setMensagem({
        tipo: "sucesso",
        texto: qtd > 0 ? `${qtd} lançamento(s) classificado(s) automaticamente.` : "Nenhum lançamento pendente casou com as regras ativas.",
      });
      await refrescarTudo();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao reprocessar regras." });
    } finally {
      setReprocessando(false);
    }
  }
```

por:

```ts
  async function handleReprocessar() {
    if (!podeEscrever) return;
    setMensagem(null);
    setReprocessando(true);
    try {
      let query = supabase
        .from("extrato_lancamento")
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento")
        .eq("status", "nao_classificado");
      if (filtroContaId) query = query.eq("conta_id", filtroContaId);
      const { data: candidatos, error } = await query;
      if (error) throw new Error(error.message);

      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter((l) => !baixasAuto.idsBaixados.has(l.id));
      const qtd = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);

      const partes: string[] = [];
      if (baixasAuto.baixados > 0) partes.push(`${baixasAuto.baixados} baixado(s) automaticamente`);
      if (baixasAuto.ambiguos > 0) partes.push(`${baixasAuto.ambiguos} ambíguo(s) (revisar)`);
      if (qtd > 0) partes.push(`${qtd} classificado(s) por regra`);

      setMensagem({
        tipo: "sucesso",
        texto: partes.length > 0 ? partes.join(" · ") : "Nenhum lançamento pendente casou com baixa automática ou regras ativas.",
      });
      await refrescarTudo();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao reprocessar." });
    } finally {
      setReprocessando(false);
    }
  }
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos relacionados a este arquivo (o projeto já tem 2 avisos de lint pré-existentes, não relacionados, em outro trecho do mesmo arquivo — não é preciso mexer neles).

- [ ] **Step 10: Teste manual com dados reais de teste no banco**

Sem framework de teste automatizado para fluxo E2E de Supabase neste projeto — validar manualmente:
1. No banco de teste/produção, criar uma `contas_pagar` de teste com `fornecedor` curto reconhecível (ex. `"Teste Baixa Automatica"`), `valor` específico (ex. `123.45`), `status='pendente'`.
2. Montar (ou usar um real) `.ofx` de teste com um `<STMTTRN>` cujo `MEMO` contenha esse nome e `TRNAMT` igual a `-123.45`.
3. Importar via `/extrato`.
4. Confirmar: a conta de teste virou `status='pago'`, existe uma `movimentacoes` nova com `conta_pagar_id` apontando pra ela, e o `extrato_lancamento` correspondente tem `conta_pagar_id` preenchido e `status='classificado'`.
5. Apagar os dados de teste criados (conta a pagar, movimentação, importação, lançamento) depois de confirmar.

- [ ] **Step 11: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): baixa automática de contas a pagar ao importar/reprocessar extrato"
```

---

### Task 4: UI — indicadores de baixa automática e de ambiguidade na lista de lançamentos

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `l.conta_pagar_id` e `l.contas_pagar_candidatas` da interface `Lancamento` (Task 3).
- Produces (consumido pela Task 5): a chamada `onClick={() => handleAbrirResolucaoAmbigua(l)}` no botão de "Baixa ambígua" — a Task 5 implementa essa função.

- [ ] **Step 1: Badge de "baixa automática" na célula de Categoria**

Em `src/app/extrato/page.tsx`, dentro do bloco `{l.categoria ? (...)}` da célula de categoria (linhas 1104-1116 antes desta task), adicionar o badge condicional logo depois do badge de categoria:

```tsx
                                  <td className="px-3 py-2">
                                    {l.categoria ? (
                                      <div className="flex flex-col gap-1 items-start">
                                        <span
                                          className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                            calcularTipoMovimentacao(l.valor) === "entrada" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                                          }`}
                                        >
                                          {calcularTipoMovimentacao(l.valor) === "entrada" ? "Entrada" : "Saída"}
                                        </span>
                                        <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold whitespace-nowrap">
                                          {l.categoria}
                                        </span>
                                        {l.conta_pagar_id && (
                                          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[9px] font-semibold whitespace-nowrap">
                                            Baixa automática
                                          </span>
                                        )}
                                      </div>
                                    ) : l.contas_pagar_candidatas && l.contas_pagar_candidatas.length > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => handleAbrirResolucaoAmbigua(l)}
                                        className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap hover:bg-amber-100"
                                      >
                                        Baixa ambígua ({l.contas_pagar_candidatas.length})
                                      </button>
                                    ) : l.status === "ignorado" ? (
                                      <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                                    ) : (
                                      <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                                    )}
                                  </td>
```

Note que este `<td>` é EXATAMENTE o mesmo bloco já existente — a única mudança real é o `{l.conta_pagar_id && (...)}` novo dentro do primeiro `if`, e o novo ramo `l.contas_pagar_candidatas && l.contas_pagar_candidatas.length > 0 ? (...)` inserido entre o `if` de categoria e o `else if` de `ignorado` que já existia.

- [ ] **Step 2: Typecheck (vai falhar de propósito — `handleAbrirResolucaoAmbigua` ainda não existe)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: erro `Cannot find name 'handleAbrirResolucaoAmbigua'`. Isso é esperado — a Task 5 implementa essa função no mesmo arquivo. Se esta task for revisada isoladamente antes da Task 5 rodar, esse erro é aceitável e esperado; não é um bug desta task.

- [ ] **Step 3: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): indicadores visuais de baixa automática e de ambiguidade na lista de lançamentos"
```

---

### Task 5: UI — resolução manual de ambíguos

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `baixarContaPagar` (Task 3, função de módulo já definida no mesmo arquivo). `l.contas_pagar_candidatas` (Task 3/4).
- Produces: função `handleAbrirResolucaoAmbigua(lancamento: Lancamento)` referenciada pela Task 4.

- [ ] **Step 1: Novo estado para o modal de resolução**

Junto aos outros estados de "Lançamentos" (perto da linha 122, ao lado de `sugerirRegraPara`):

```ts
  const [resolvendoAmbiguo, setResolvendoAmbiguo] = useState<{
    lancamento: Lancamento;
    candidatos: { id: string; fornecedor: string; valor: number; data_vencimento: string; categoria_id: string | null }[];
  } | null>(null);
  const [carregandoCandidatos, setCarregandoCandidatos] = useState(false);
  const [resolvendoBaixaId, setResolvendoBaixaId] = useState<string | null>(null);
```

- [ ] **Step 2: Handlers `handleAbrirResolucaoAmbigua` e `handleResolverBaixaAmbigua`**

Perto de `handleClassificarManual` (depois da seção "---------- Classificação manual ----------", por volta da linha 574 atual), adicionar:

```ts
  async function handleAbrirResolucaoAmbigua(lancamento: Lancamento) {
    if (!lancamento.contas_pagar_candidatas || lancamento.contas_pagar_candidatas.length === 0) return;
    setCarregandoCandidatos(true);
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_vencimento, categoria_id")
      .in("id", lancamento.contas_pagar_candidatas);
    setCarregandoCandidatos(false);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas candidatas: " + (error?.message ?? "") });
      return;
    }
    setResolvendoAmbiguo({
      lancamento,
      candidatos: data as { id: string; fornecedor: string; valor: number; data_vencimento: string; categoria_id: string | null }[],
    });
  }

  async function handleResolverBaixaAmbigua(contaPagarId: string) {
    if (!resolvendoAmbiguo) return;
    const conta = resolvendoAmbiguo.candidatos.find((c) => c.id === contaPagarId);
    if (!conta) return;
    setResolvendoBaixaId(contaPagarId);

    let categoriaNome = "Contas a pagar";
    if (conta.categoria_id) {
      const { data: categoria } = await supabase.from("categorias_saida").select("nome").eq("id", conta.categoria_id).single();
      if (categoria?.nome) categoriaNome = categoria.nome as string;
    }

    const ok = await baixarContaPagar(
      { id: resolvendoAmbiguo.lancamento.id, data_lancamento: resolvendoAmbiguo.lancamento.data_lancamento },
      { id: conta.id, fornecedor: conta.fornecedor, valor: conta.valor, categoria_id: conta.categoria_id },
      categoriaNome
    );

    setResolvendoBaixaId(null);
    if (!ok) {
      setMensagem({ tipo: "erro", texto: "Não foi possível confirmar a baixa — a conta pode já ter sido paga." });
      return;
    }
    setResolvendoAmbiguo(null);
    setMensagem({ tipo: "sucesso", texto: `Baixa confirmada: ${conta.fornecedor}.` });
    await Promise.all([carregarLancamentos(), carregarResumo()]);
  }

  function fecharResolucaoAmbigua() {
    setResolvendoAmbiguo(null);
  }
```

- [ ] **Step 3: JSX do modal**

Logo depois do modal existente `{sugerirRegraPara && (...)}` (linhas 1177-1212 antes desta task, dentro do mesmo `{aba === "lancamentos" && (...)}`), adicionar, mesmo padrão visual:

```tsx
          {resolvendoAmbiguo && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={fecharResolucaoAmbigua}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Qual conta foi paga?</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  {resolvendoAmbiguo.candidatos.length} contas a pagar têm o mesmo fornecedor e o mesmo valor
                  ({formatarMoeda(Math.abs(resolvendoAmbiguo.lancamento.valor))}) — escolha qual foi paga em{" "}
                  {formatarData(resolvendoAmbiguo.lancamento.data_lancamento)}.
                </p>
                <div className="space-y-2 mb-4">
                  {resolvendoAmbiguo.candidatos.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={resolvendoBaixaId !== null}
                      onClick={() => handleResolverBaixaAmbigua(c.id)}
                      className="w-full flex justify-between items-center px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs hover:bg-[var(--hover-bg)] disabled:opacity-50 text-left"
                    >
                      <span>
                        <span className="font-semibold">{c.fornecedor}</span>
                        <br />
                        <span className="text-[var(--color-text-muted)]">Vencimento: {formatarData(c.data_vencimento)}</span>
                      </span>
                      <span className="font-semibold">
                        {resolvendoBaixaId === c.id ? "..." : formatarMoeda(c.valor)}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={fecharResolucaoAmbigua}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                >
                  Decidir depois
                </button>
              </div>
            </div>
          )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos (o erro de `handleAbrirResolucaoAmbigua` não encontrado, esperado ao final da Task 4, some agora que esta task o implementa).

- [ ] **Step 5: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos 2 avisos pré-existentes de antes desta feature (linhas ~238/244, `useEffect`/`set-state-in-effect`, não relacionados a este trabalho) — nenhum erro novo introduzido pelas Tasks 3-5.

- [ ] **Step 6: Teste manual — fluxo de ambiguidade completo**

1. Criar duas `contas_pagar` de teste com o mesmo `fornecedor` e o mesmo `valor` (reproduzindo o caso real "Compre Facil" R$298,95).
2. Importar um `.ofx` de teste com um lançamento de saída que bata com esse fornecedor e valor.
3. Confirmar: nenhuma das duas foi baixada automaticamente, o lançamento do extrato mostra o botão "Baixa ambígua (2)".
4. Clicar no botão, confirmar que o modal lista as duas contas com vencimentos diferentes.
5. Escolher uma, confirmar que ela (e só ela) vira `status='pago'`, a `movimentacoes` correspondente é criada, e o modal fecha.
6. Apagar os dados de teste.

- [ ] **Step 7: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): resolução manual de baixa ambígua em contas a pagar"
```

---

## Self-Review

**Cobertura da spec** (`docs/superpowers/specs/2026-08-12-baixa-automatica-contas-pagar-design.md`):
- Seção 1 (escopo — todo lançamento de saída, sem restrição de categoria): Task 3, `processarBaixasAutomaticas` filtra só por `valor < 0`, sem filtro de categoria. ✅
- Seção 2 (algoritmo — valor idêntico + nome "contém", sem filtro de data): Task 2, `contaCasaComCandidato`. ✅ Testado com os dois pares reais (Severini, Compre Facil). ✅
- Seção 3 (baixa automática, novo campo `conta_pagar_id`, reaproveitar escrita manual): Task 1 (coluna), Task 3 (`baixarContaPagar` espelha `confirmarPagamento` linha a linha). ✅
- Seção 4 (ambíguos, novo campo `contas_pagar_candidatas`, nunca decide sozinho, UI de escolha manual): Task 1 (coluna), Task 3 (`processarBaixasAutomaticas` grava candidatos sem baixar), Task 4 (badge), Task 5 (modal de escolha). ✅
- Seção 5 (resumo pós-importação auditável): Task 3, Step 5-7 (estado + card + mensagem). ✅
- Seção 6 (roda no import e no botão Reprocessar): Task 3, Step 6 e Step 8. ✅
- Fora de escopo (Pix Enviado, entrada direta, XML→contas a pagar): nenhuma task toca nisso. ✅

**Checagem de placeholders**: nenhum "TBD"/"adicionar validação apropriada" neste plano — todo código está completo.

**Consistência de tipos entre tasks**: `ContaPagarPendente`/`CandidatoBaixa`/`ResultadoBaixa` (Task 2) usados exatamente com os mesmos nomes de campo na Task 3. `LancamentoParaBaixa` definido na Task 3 e reaproveitado na Task 3 (handleReprocessar) sem redefinição. `baixarContaPagar` definida na Task 3, chamada sem alteração de assinatura na Task 5. Campos `conta_pagar_id`/`contas_pagar_candidatas` nomeados de forma idêntica em todas as tasks (schema, interface `Lancamento`, JSX).

---

## Execução

Plano completo e salvo em `docs/superpowers/plans/2026-08-12-baixa-automatica-contas-pagar.md`. Duas opções de execução:

**1. Subagent-Driven (recomendado)** — dispatch de um subagent fresco por task, revisão entre tasks, iteração rápida. Task 1 é exceção: executada pelo orquestrador diretamente (é alteração de schema em produção).

**2. Execução inline** — executar as tasks nesta sessão via executing-plans, em lote com checkpoints de revisão.

Qual abordagem?
