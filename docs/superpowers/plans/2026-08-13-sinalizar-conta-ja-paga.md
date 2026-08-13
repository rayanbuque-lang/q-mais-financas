# Sinalizar Conta a Pagar Já Paga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Exceção de execução — Task 1:** altera schema em produção (Supabase). Executada pelo orquestrador diretamente via `mcp__claude_ai_Supabase__apply_migration`, não despachada como subagent. Tasks 2-4 seguem o fluxo normal de SDD.

**Goal:** O motor de casamento da baixa automática (Capacidade B) passa a também procurar entre contas a pagar **já pagas**, não só pendentes. Se achar uma conta já paga batendo (valor + nome) e nenhuma pendente, o lançamento do extrato é sinalizado como "provável duplicata" em vez de cair no fluxo normal — evitando que a Capacidade A (lançamento direto em movimentações) poste uma segunda movimentação pra um pagamento que já foi registrado por outro caminho (ex.: baixa manual em Contas a Pagar antes do extrato daquele período ser importado).

**Architecture:** Extensão pontual do motor puro já existente (`src/lib/baixa-contas-pagar.ts`) — mesmo arquivo, mesma função, um parâmetro e um resultado a mais, reaproveitando 100% da lógica de casamento já testada. A integração (`src/app/extrato/page.tsx`) ganha um terceiro balde de resultado (ao lado de "baixados" e "ambíguos" que já existem), um campo novo de rastreamento, e um badge+modal na UI que reaproveita o botão "Ignorar" já existente pra descartar.

**Tech Stack:** Next.js 16.2.6 App Router, React 19, Supabase JS v2, TypeScript. Sem framework de testes formal — scripts Node descartáveis (`node --experimental-strip-types`), apagados depois de passar.

## Global Constraints

- **Nunca descarta sozinho**: mesmo com um único candidato pago batendo, o resultado vai pra "duplicatas" — nunca vira `status='ignorado'` automaticamente. Descartar é sempre uma decisão humana.
- **A checagem de "já paga" só roda quando NENHUMA pendente bateu** — dar baixa continua tendo prioridade sobre sinalizar duplicata.
- **Mesma regra de casamento de sempre**: valor idêntico + nome aproximado (`contaCasaComCandidato`, já existe, reaproveitado sem alteração) — sem filtro de data (decisão já confirmada: o motor nunca usou data de vencimento/pagamento pra casar, então pagamento de boleto que vence fim de semana e é pago na segunda não precisa de tratamento especial).
- **Sem framework de teste**: scripts Node descartáveis com imports relativos, apagados depois de passar. Nenhum arquivo de teste é commitado.

---

## Contexto que todo implementador precisa

**Por que isso existe**: a Capacidade B (baixa automática de contas a pagar) e a Capacidade A (lançamento direto em movimentações) já estão em produção. A revisão final da Capacidade A achou um problema real: quando uma conta a pagar já foi paga por outro caminho (baixa manual em `/contas-pagar`) ANTES do extrato daquele período ser importado, a Capacidade B não acha nada *pendente* pra casar (ela só procura entre pendentes), o lançamento do extrato cai no motor de regras de texto, e a Capacidade A lança uma movimentação nova — duplicando o pagamento que já tinha sido registrado quando a conta foi marcada como paga. Confirmado com dados reais: 5 de 5 lançamentos não-boleto já classificados no staging de teste tinham uma movimentação gêmea vinda do lado de Contas a Pagar (SABESP, Simples Nacional, DARF, FGTS, IPTU).

**Estado atual do motor puro** (`src/lib/baixa-contas-pagar.ts`, arquivo inteiro, 63 linhas):
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

// Tamanho mínimo do nome do fornecedor normalizado para que o casamento por
// nome valha alguma coisa. Existem contas_pagar reais com fornecedor de 2-3
// caracteres ("jj", "pp", "sdb", "arc", "yes"); um includes() com trecho tão
// curto bate com quase qualquer descrição de extrato, o que degradaria o
// critério "valor E nome" para "só valor" -- exatamente o que a spec diz que
// não é seguro o suficiente para baixar sozinho.
export const TAMANHO_MINIMO_FORNECEDOR = 4;

// "Contém", não prefixo: o banco antepõe texto variável antes do nome do
// fornecedor (ex.: "P SEVERINI NETTO COMERCIA" para o fornecedor cadastrado
// como "Severini") -- confirmado com dado real de produção.
function contaCasaComCandidato(conta: ContaPagarPendente, candidato: CandidatoBaixa): boolean {
  if (conta.valor !== candidato.valor) return false;
  const fornecedorNormalizado = normalizarDescricao(conta.fornecedor);
  // Abaixo do mínimo o nome não é evidência: trata como "não bate" (nem baixa,
  // nem ambiguidade -- mesmo comportamento de zero candidatos).
  if (fornecedorNormalizado.length < TAMANHO_MINIMO_FORNECEDOR) return false;
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

**Estado atual da integração** (`src/app/extrato/page.tsx`) — trechos relevantes com números de linha da versão atual (confira o texto ao redor antes de aplicar, pode ter deslocado):

`processarBaixasAutomaticas` (linhas 212-288) — a função que este plano estende:
```ts
async function processarBaixasAutomaticas(
  lancamentosNovos: LancamentoParaBaixa[]
): Promise<{ baixados: number; ambiguos: number; mesFechado: number; idsBaixados: Set<string>; idsAmbiguos: Set<string> }> {
  const supabase = createClient();
  const idsBaixados = new Set<string>();
  const idsAmbiguos = new Set<string>();
  const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
  if (saidas.length === 0) return { baixados: 0, ambiguos: 0, mesFechado: 0, idsBaixados, idsAmbiguos };

  const { data: pendentes } = await supabase
    .from("contas_pagar")
    .select("id, fornecedor, valor, categoria_id")
    .eq("status", "pendente")
    .limit(2000);
  if (!pendentes || pendentes.length === 0) {
    await limparCandidatasObsoletas(saidas, new Set<number>());
    return { baixados: 0, ambiguos: 0, mesFechado: 0, idsBaixados, idsAmbiguos };
  }

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
  let mesFechado = 0;
  for (const b of resultado.baixados) {
    const lancamento = saidas[b.indice];
    const conta = pendentesPorId.get(b.contaPagarId);
    if (!conta) continue;
    const categoriaId = conta.categoria_id as string | null;
    const categoriaNome = categoriaId ? nomeCategoriaPorId.get(categoriaId) ?? "Contas a pagar" : "Contas a pagar";
    const resultadoEscrita = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: conta.id as string, fornecedor: conta.fornecedor as string, valor: Number(conta.valor), categoria_id: categoriaId },
      categoriaNome,
      "automatica"
    );
    if (resultadoEscrita === "ok") {
      idsBaixados.add(lancamento.id);
      baixados++;
    } else if (resultadoEscrita === "mes_fechado") {
      mesFechado++;
    }
  }

  let ambiguos = 0;
  for (const a of resultado.ambiguos) {
    const lancamento = saidas[a.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: a.candidatosIds }).eq("id", lancamento.id);
    idsAmbiguos.add(lancamento.id);
    ambiguos++;
  }

  const indicesComResultado = new Set<number>([
    ...resultado.baixados.map((b) => b.indice),
    ...resultado.ambiguos.map((a) => a.indice),
  ]);
  await limparCandidatasObsoletas(saidas, indicesComResultado);

  return { baixados, ambiguos, mesFechado, idsBaixados, idsAmbiguos };
}

async function limparCandidatasObsoletas(saidas: LancamentoParaBaixa[], indicesComResultado: Set<number>) {
  const idsObsoletos = saidas
    .filter((l, indice) => !indicesComResultado.has(indice) && (l.contas_pagar_candidatas?.length ?? 0) > 0)
    .map((l) => l.id);
  if (idsObsoletos.length === 0) return;
  const supabase = createClient();
  await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: null }).in("id", idsObsoletos);
}
```

`LancamentoParaBaixa` (linhas 86-94):
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

Os dois call sites (`handleImportar` linha ~843-846, `handleReprocessar` linha ~661-663) chamam `processarBaixasAutomaticas` e filtram `paraClassificar` excluindo `idsBaixados`/`idsAmbiguos` antes de `classificarPorRegras`.

`resumoImportacao` (estado, linha 450):
```ts
const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; mesFechado: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; movimentacoesFalharam: number; avisos: string[] } | null>(null);
```

O modal de resolução de ambíguos (linhas 1041-1107, handlers; 1780-1818, JSX) e o badge "Baixa ambígua" (linhas 1674-1682) são os precedentes visuais e de padrão de código a espelhar nesta task.

---

### Task 1: Migração de schema — nova coluna em `extrato_lancamento`

**Executada pelo orquestrador diretamente, não por subagent.**

**Files:**
- Nenhum arquivo no repo — alteração direta no banco via MCP.

**Interfaces:**
- Produces: `extrato_lancamento.contas_pagar_duplicatas jsonb null` — consumida pelas Tasks 3 e 4.

- [ ] **Step 1: Aplicar a migração**

`mcp__claude_ai_Supabase__apply_migration`, `project_id: "nheyevdjomfphlzmsszk"`, `name: "add_contas_pagar_duplicatas_extrato_lancamento"`:
```sql
alter table extrato_lancamento
  add column contas_pagar_duplicatas jsonb;
```

- [ ] **Step 2: Confirmar**

`mcp__claude_ai_Supabase__execute_sql`, mesmo `project_id`:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'extrato_lancamento' and column_name = 'contas_pagar_duplicatas';
```
Esperado: uma linha, tipo `jsonb`.

- [ ] **Step 3:** Marcar completa no ledger do SDD — sem commit de código nesta task.

---

### Task 2: Motor de casamento estendido — `src/lib/baixa-contas-pagar.ts`

**Files:**
- Modify: `src/lib/baixa-contas-pagar.ts`
- Test (descartável, apagar ao final): `src/lib/_test-baixa-contas-pagar-duplicatas.mjs`

**Interfaces:**
- Produces (consumido pela Task 3): `calcularBaixasAutomaticas` ganha um terceiro parâmetro (`contasPagas: ContaPagarPendente[]`) e `ResultadoBaixa` ganha um terceiro campo (`duplicatas: { indice: number; candidatosIds: string[] }[]`). Assinatura completa nova:
  ```ts
  export function calcularBaixasAutomaticas(
    candidatos: CandidatoBaixa[],
    contasPendentes: ContaPagarPendente[],
    contasPagas: ContaPagarPendente[]
  ): ResultadoBaixa
  ```
  Isso é uma mudança de assinatura que quebra compilação até a Task 3 atualizar o único call site do arquivo (`src/app/extrato/page.tsx`) — normal, será corrigido na próxima task.

- [ ] **Step 1: Escrever o script de teste descartável**

Criar `src/lib/_test-baixa-contas-pagar-duplicatas.mjs`:

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

// 1. Com match pendente, nem tenta olhar as pagas -- baixa normal, duplicatas vazio.
{
  const candidatos = [{ indice: 0, valor: 165.28, descricaoNormalizada: "conta de agua e esgoto em canais internet sabesp sao paulo" }];
  const pendentes = [{ id: "conta-sabesp-pendente", fornecedor: "Sabesp", valor: 165.28 }];
  const pagas = [{ id: "conta-sabesp-paga-antiga", fornecedor: "Sabesp", valor: 165.28 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes, pagas);
  assertEqual("pendente tem prioridade sobre paga", r, {
    baixados: [{ indice: 0, contaPagarId: "conta-sabesp-pendente" }],
    ambiguos: [],
    duplicatas: [],
  });
}

// 2. Sem match pendente, um match pago -- vira duplicata (caso real: conta paga
//    manualmente antes do extrato daquele período ser importado).
{
  const candidatos = [{ indice: 0, valor: 1104.19, descricaoNormalizada: "pagamento darf em canais internet tributos federai" }];
  const r = calcularBaixasAutomaticas(candidatos, [], [{ id: "conta-darf-paga", fornecedor: "Receita Federal", valor: 1104.19 }]);
  assertEqual("sem pendente, uma paga bate -- duplicata", r, {
    baixados: [],
    ambiguos: [],
    duplicatas: [{ indice: 0, candidatosIds: ["conta-darf-paga"] }],
  });
}

// 3. Sem match pendente, duas pagas batendo -- ainda assim duplicata (nunca
//    decide sozinho, mesmo entre pagas -- mas a lista inclui todas as candidatas).
{
  const candidatos = [{ indice: 0, valor: 849.26, descricaoNormalizada: "debito pagamento de salario fgts" }];
  const pagas = [
    { id: "conta-fgts-1", fornecedor: "Fgts", valor: 849.26 },
    { id: "conta-fgts-2", fornecedor: "Fgts", valor: 849.26 },
  ];
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("sem pendente, duas pagas batendo -- duplicata com as duas", r, {
    baixados: [],
    ambiguos: [],
    duplicatas: [{ indice: 0, candidatosIds: ["conta-fgts-1", "conta-fgts-2"] }],
  });
}

// 4. Nem pendente nem paga bate -- nada, segue fluxo normal.
{
  const candidatos = [{ indice: 0, valor: 999.99, descricaoNormalizada: "pagamento de boleto fornecedor desconhecido" }];
  const r = calcularBaixasAutomaticas(candidatos, [{ id: "x", fornecedor: "Sdb", valor: 233.57 }], [{ id: "y", fornecedor: "Sabesp", valor: 165.28 }]);
  assertEqual("nada bate -- segue fluxo normal", r, { baixados: [], ambiguos: [], duplicatas: [] });
}

// 5. Múltiplos candidatos no mesmo lote: um baixa, outro vira duplicata, índices corretos.
{
  const candidatos = [
    { indice: 0, valor: 233.57, descricaoNormalizada: "pagamento de boleto sdb comercio de alimentos" },
    { indice: 1, valor: 137.27, descricaoNormalizada: "pgto tributo estadual em canais internet iptu itu" },
  ];
  const pendentes = [{ id: "conta-sdb", fornecedor: "Sdb", valor: 233.57 }];
  const pagas = [{ id: "conta-iptu-paga", fornecedor: "Prefeitura", valor: 137.27 }];
  const r = calcularBaixasAutomaticas(candidatos, pendentes, pagas);
  assertEqual("lote misto: um baixa, outro vira duplicata", r, {
    baixados: [{ indice: 0, contaPagarId: "conta-sdb" }],
    ambiguos: [],
    duplicatas: [{ indice: 1, candidatosIds: ["conta-iptu-paga"] }],
  });
}

if (falhas > 0) {
  console.error(`\n${falhas} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
```

- [ ] **Step 2: Rodar o teste e confirmar que falha (assinatura ainda não mudou)**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar-duplicatas.mjs`
Expected: falha em algum `assertEqual` (a função atual ainda não devolve `duplicatas`, ou o terceiro parâmetro é ignorado silenciosamente pelo JS mas o resultado não bate com o esperado).

- [ ] **Step 3: Implementar a extensão**

Em `src/lib/baixa-contas-pagar.ts`, trocar:
```ts
export interface ResultadoBaixa {
  baixados: { indice: number; contaPagarId: string }[];
  ambiguos: { indice: number; candidatosIds: string[] }[];
}
```
por:
```ts
export interface ResultadoBaixa {
  baixados: { indice: number; contaPagarId: string }[];
  ambiguos: { indice: number; candidatosIds: string[] }[];
  // Nenhuma conta pendente bateu, mas 1+ conta(s) já paga(s) batem -- provável
  // duplicata (a conta foi paga por outro caminho antes deste extrato ser
  // importado). Nunca decide sozinho: mesmo um único match vai pra cá, nunca
  // é auto-descartado -- descartar uma transação real exige confirmação humana.
  duplicatas: { indice: number; candidatosIds: string[] }[];
}
```

E trocar a função inteira:
```ts
export function calcularBaixasAutomaticas(
  candidatos: CandidatoBaixa[],
  contasPendentes: ContaPagarPendente[],
  contasPagas: ContaPagarPendente[]
): ResultadoBaixa {
  const baixados: ResultadoBaixa["baixados"] = [];
  const ambiguos: ResultadoBaixa["ambiguos"] = [];
  const duplicatas: ResultadoBaixa["duplicatas"] = [];

  for (const candidato of candidatos) {
    const casadasPendentes = contasPendentes.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadasPendentes.length === 1) {
      baixados.push({ indice: candidato.indice, contaPagarId: casadasPendentes[0].id });
      continue;
    }
    if (casadasPendentes.length >= 2) {
      ambiguos.push({ indice: candidato.indice, candidatosIds: casadasPendentes.map((c) => c.id) });
      continue;
    }

    // Nenhuma pendente bateu -- só então procura entre as já pagas. Dar baixa
    // continua tendo prioridade sobre sinalizar duplicata.
    const casadasPagas = contasPagas.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadasPagas.length > 0) {
      duplicatas.push({ indice: candidato.indice, candidatosIds: casadasPagas.map((c) => c.id) });
    }
  }

  return { baixados, ambiguos, duplicatas };
}
```

Note que `contaCasaComCandidato` e `ContaPagarPendente` não mudam — o tipo `ContaPagarPendente` (`{id, fornecedor, valor}`) já serve tanto pra pendentes quanto pagas, é só o pool que muda de onde vem. Não precisa renomear o tipo.

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar-duplicatas.mjs`
Expected: `Todos os testes passaram.` (5 linhas `OK:`, exit code 0).

- [ ] **Step 5: Apagar o script de teste**

```bash
rm src/lib/_test-baixa-contas-pagar-duplicatas.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/baixa-contas-pagar.ts
git commit -m "feat(extrato): motor de casamento também sinaliza contas já pagas como provável duplicata"
```

---

### Task 3: Wiring — `processarBaixasAutomaticas`, limpeza e resumo

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `calcularBaixasAutomaticas` com a nova assinatura (Task 2). Coluna `extrato_lancamento.contas_pagar_duplicatas` (Task 1).
- Produces (consumido pela Task 4): campo `contas_pagar_duplicatas: string[] | null` na interface `Lancamento`; `processarBaixasAutomaticas` retorna também `duplicatas: number` e `idsDuplicatas: Set<string>`.

- [ ] **Step 1: Estender a interface `Lancamento`**

Linha 22-39, adicionar `contas_pagar_duplicatas: string[] | null;` ao final (depois de `movimentacao_id`).

- [ ] **Step 2: Estender `LancamentoParaBaixa`**

Linha 86-94, adicionar campo opcional:
```ts
interface LancamentoParaBaixa {
  id: string;
  conta_id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
  status: string;
  contas_pagar_candidatas?: string[] | null;
  contas_pagar_duplicatas?: string[] | null;
}
```

- [ ] **Step 3: Nova função de limpeza, ao lado de `limparCandidatasObsoletas`**

Logo depois de `limparCandidatasObsoletas` (linha ~302), adicionar:
```ts
// Mesma lógica de limparCandidatasObsoletas, mas pro campo de duplicatas: se
// um reprocessamento posterior não encontra mais nenhuma conta paga batendo
// (a duplicata era falsa, ou a conta paga foi excluída), o marcador vira
// lixo e o botão "Provável duplicata" ficaria preso pra sempre.
async function limparDuplicatasObsoletas(saidas: LancamentoParaBaixa[], indicesComResultado: Set<number>) {
  const idsObsoletos = saidas
    .filter((l, indice) => !indicesComResultado.has(indice) && (l.contas_pagar_duplicatas?.length ?? 0) > 0)
    .map((l) => l.id);
  if (idsObsoletos.length === 0) return;
  const supabase = createClient();
  await supabase.from("extrato_lancamento").update({ contas_pagar_duplicatas: null }).in("id", idsObsoletos);
}
```

- [ ] **Step 4: Reescrever `processarBaixasAutomaticas`**

Trocar a função inteira (linhas 212-288) por:
```ts
async function processarBaixasAutomaticas(
  lancamentosNovos: LancamentoParaBaixa[]
): Promise<{ baixados: number; ambiguos: number; duplicatas: number; mesFechado: number; idsBaixados: Set<string>; idsAmbiguos: Set<string>; idsDuplicatas: Set<string> }> {
  const supabase = createClient();
  const idsBaixados = new Set<string>();
  const idsAmbiguos = new Set<string>();
  const idsDuplicatas = new Set<string>();
  const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
  if (saidas.length === 0) return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };

  // .limit(2000) por precaução -- mesma classe de problema já corrigida antes
  // neste projeto (commit 693a921): PostgREST tem teto padrão de linhas.
  const { data: contasRelevantes } = await supabase
    .from("contas_pagar")
    .select("id, fornecedor, valor, categoria_id, status")
    .in("status", ["pendente", "pago"])
    .limit(2000);
  if (!contasRelevantes || contasRelevantes.length === 0) {
    await Promise.all([limparCandidatasObsoletas(saidas, new Set<number>()), limparDuplicatasObsoletas(saidas, new Set<number>())]);
    return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };
  }

  const pendentes = contasRelevantes.filter((c) => c.status === "pendente");
  const pagas = contasRelevantes.filter((c) => c.status === "pago");

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
  const contasPagas: ContaPagarPendente[] = pagas.map((c) => ({
    id: c.id as string,
    fornecedor: c.fornecedor as string,
    valor: Number(c.valor),
  }));

  const resultado = calcularBaixasAutomaticas(candidatos, contasPendentes, contasPagas);
  const pendentesPorId = new Map(pendentes.map((c) => [c.id as string, c]));

  let baixados = 0;
  let mesFechado = 0;
  for (const b of resultado.baixados) {
    const lancamento = saidas[b.indice];
    const conta = pendentesPorId.get(b.contaPagarId);
    if (!conta) continue;
    const categoriaId = conta.categoria_id as string | null;
    const categoriaNome = categoriaId ? nomeCategoriaPorId.get(categoriaId) ?? "Contas a pagar" : "Contas a pagar";
    const resultadoEscrita = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: conta.id as string, fornecedor: conta.fornecedor as string, valor: Number(conta.valor), categoria_id: categoriaId },
      categoriaNome,
      "automatica"
    );
    if (resultadoEscrita === "ok") {
      idsBaixados.add(lancamento.id);
      baixados++;
    } else if (resultadoEscrita === "mes_fechado") {
      mesFechado++;
    }
  }

  let ambiguos = 0;
  for (const a of resultado.ambiguos) {
    const lancamento = saidas[a.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: a.candidatosIds }).eq("id", lancamento.id);
    idsAmbiguos.add(lancamento.id);
    ambiguos++;
  }

  let duplicatas = 0;
  for (const d of resultado.duplicatas) {
    const lancamento = saidas[d.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_duplicatas: d.candidatosIds }).eq("id", lancamento.id);
    idsDuplicatas.add(lancamento.id);
    duplicatas++;
  }

  const indicesComResultado = new Set<number>([
    ...resultado.baixados.map((b) => b.indice),
    ...resultado.ambiguos.map((a) => a.indice),
  ]);
  const indicesComDuplicata = new Set<number>(resultado.duplicatas.map((d) => d.indice));
  await Promise.all([
    limparCandidatasObsoletas(saidas, indicesComResultado),
    limparDuplicatasObsoletas(saidas, indicesComDuplicata),
  ]);

  return { baixados, ambiguos, duplicatas, mesFechado, idsBaixados, idsAmbiguos, idsDuplicatas };
}
```

Nota: `indicesComResultado` (usado por `limparCandidatasObsoletas`) continua só com baixados+ambíguos, sem duplicatas — são campos diferentes (`contas_pagar_candidatas` vs `contas_pagar_duplicatas`), cada limpeza cuida do seu.

- [ ] **Step 5: Excluir duplicatas de `classificarPorRegras` em `handleReprocessar`**

Linha ~661-663, trocar:
```ts
      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
```
por:
```ts
      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter(
        (l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id) && !baixasAuto.idsDuplicatas.has(l.id)
      );
```

Também na linha ~652, ampliar o `.select(...)` da query de `handleReprocessar` pra incluir a coluna nova:
```ts
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento, contas_pagar_candidatas")
```
para:
```ts
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento, contas_pagar_candidatas, contas_pagar_duplicatas")
```

Um pouco abaixo (linha ~668-675), adicionar ao array `partes`:
```ts
      if (baixasAuto.duplicatas > 0) partes.push(`${baixasAuto.duplicatas} sinalizado(s) como provável duplicata (revisar)`);
```
(pode ir logo depois da linha de `baixasAuto.mesFechado`, antes de `qtd`.)

- [ ] **Step 6: Excluir duplicatas de `classificarPorRegras` em `handleImportar`**

Linha ~843-846, trocar:
```ts
      let baixasAuto = { baixados: 0, ambiguos: 0, mesFechado: 0, idsBaixados: new Set<string>(), idsAmbiguos: new Set<string>() };
      if (inseridos && inseridos.length > 0) {
        baixasAuto = await processarBaixasAutomaticas(inseridos as LancamentoParaBaixa[]);
      }
```
por:
```ts
      let baixasAuto = { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados: new Set<string>(), idsAmbiguos: new Set<string>(), idsDuplicatas: new Set<string>() };
      if (inseridos && inseridos.length > 0) {
        baixasAuto = await processarBaixasAutomaticas(inseridos as LancamentoParaBaixa[]);
      }
```

Linha ~850-851, trocar:
```ts
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
```
por:
```ts
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter(
          (l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id) && !baixasAuto.idsDuplicatas.has(l.id)
        );
```

- [ ] **Step 7: Estender `resumoImportacao` e a mensagem de sucesso em `handleImportar`**

Linha 450, trocar:
```ts
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; mesFechado: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; movimentacoesFalharam: number; avisos: string[] } | null>(null);
```
por:
```ts
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; duplicatas: number; mesFechado: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; movimentacoesFalharam: number; avisos: string[] } | null>(null);
```

Linha ~859, trocar:
```ts
      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, mesFechado: baixasAuto.mesFechado, movimentacoesLancadas: lancamentosDiretos.lancados, movimentacoesMesFechado: lancamentosDiretos.mesFechado, movimentacoesFalharam: lancamentosDiretos.falharam, avisos: parsed.avisos });
```
por:
```ts
      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, duplicatas: baixasAuto.duplicatas, mesFechado: baixasAuto.mesFechado, movimentacoesLancadas: lancamentosDiretos.lancados, movimentacoesMesFechado: lancamentosDiretos.mesFechado, movimentacoesFalharam: lancamentosDiretos.falharam, avisos: parsed.avisos });
```

Logo abaixo (linhas ~860-872), trocar a mensagem de sucesso:
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
          (lancamentosDiretos.mesFechado > 0 ? ` · ${lancamentosDiretos.mesFechado} não lançada(s): mês contábil fechado` : "") +
          (lancamentosDiretos.falharam > 0 ? ` · ${lancamentosDiretos.falharam} erro(s) ao lançar em movimentações` : ""),
      });
```
por (só a linha do `ambiguos` ganha uma vizinha nova, resto idêntico):
```ts
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (baixasAuto.baixados > 0 ? ` · ${baixasAuto.baixados} baixado(s) automaticamente` : "") +
          (baixasAuto.ambiguos > 0 ? ` · ${baixasAuto.ambiguos} ambígua(s) (revisar)` : "") +
          (baixasAuto.duplicatas > 0 ? ` · ${baixasAuto.duplicatas} provável(is) duplicata(s) (revisar)` : "") +
          (baixasAuto.mesFechado > 0 ? ` · ${baixasAuto.mesFechado} não baixada(s): mês contábil fechado` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : "") +
          (lancamentosDiretos.lancados > 0 ? ` · ${lancamentosDiretos.lancados} lançada(s) em movimentações` : "") +
          (lancamentosDiretos.mesFechado > 0 ? ` · ${lancamentosDiretos.mesFechado} não lançada(s): mês contábil fechado` : "") +
          (lancamentosDiretos.falharam > 0 ? ` · ${lancamentosDiretos.falharam} erro(s) ao lançar em movimentações` : ""),
      });
```

- [ ] **Step 8: Card de resumo na aba Importar**

Logo depois do parágrafo `{resumoImportacao.ambiguos > 0 ...}` se existir separado, ou dentro do bloco que já mostra baixados/ambíguos (linhas ~1380-1420) — localize o parágrafo que reporta `mesFechado` da Capacidade B (`{resumoImportacao.mesFechado > 0 && (...)}`) e adicione um novo parágrafo logo antes dele:
```tsx
                {resumoImportacao.duplicatas > 0 && (
                  <p className="mt-1 font-semibold text-orange-700">
                    {resumoImportacao.duplicatas} lançamento(s) sinalizado(s) como provável duplicata — revisar na aba Lançamentos.
                  </p>
                )}
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 10: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos avisos pré-existentes de antes, nenhum novo.

- [ ] **Step 11: Teste manual com dados reais de teste no Supabase**

Via MCP (`mcp__claude_ai_Supabase__execute_sql`, projeto `nheyevdjomfphlzmsszk`):
1. Crie uma `contas_pagar` de teste com `status='pago'`, fornecedor e valor reconhecíveis.
2. Insira um `extrato_lancamento` de teste com `status='nao_classificado'`, `valor` negativo batendo nessa conta paga, e SEM nenhuma conta pendente correspondente.
3. Rode manualmente a sequência que `processarBaixasAutomaticas` faria (ou raciocínio cuidadoso sobre o código é aceitável, já que a lógica em si já foi validada pelo teste puro da Task 2) — confirme que o lançamento NÃO virou `classificado`, que `contas_pagar_duplicatas` foi preenchido com o id da conta paga, e que nenhuma `movimentacoes` nova foi criada.
4. Apague os dados de teste.

- [ ] **Step 12: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): sinalizar lançamentos que batem com conta a pagar já quitada"
```

---

### Task 4: UI — badge e modal de "provável duplicata"

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `l.contas_pagar_duplicatas` (Task 3), `handleIgnorar` (já existe, reaproveitado sem alteração).

- [ ] **Step 1: Novo estado**

Ao lado de `resolvendoAmbiguo`/`carregandoCandidatos`/`resolvendoBaixaId` (linha ~480), adicionar:
```ts
  const [resolvendoDuplicata, setResolvendoDuplicata] = useState<{
    lancamento: Lancamento;
    candidatos: { id: string; fornecedor: string; valor: number; data_pagamento: string | null }[];
  } | null>(null);
  const [carregandoDuplicata, setCarregandoDuplicata] = useState(false);
```

- [ ] **Step 2: Handlers, ao lado de `handleAbrirResolucaoAmbigua`/`fecharResolucaoAmbigua`**

Logo depois de `fecharResolucaoAmbigua` (linha ~1107), adicionar:
```ts
  async function handleAbrirDuplicata(lancamento: Lancamento) {
    if (!lancamento.contas_pagar_duplicatas || lancamento.contas_pagar_duplicatas.length === 0) return;
    setCarregandoDuplicata(true);
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_pagamento")
      .in("id", lancamento.contas_pagar_duplicatas)
      .eq("status", "pago");
    setCarregandoDuplicata(false);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas já pagas: " + (error?.message ?? "") });
      return;
    }
    if (data.length === 0) {
      setMensagem({ tipo: "erro", texto: "Nenhuma das contas sinalizadas continua com status pago — use 'Reprocessar regras' para reavaliar este lançamento." });
      return;
    }
    setResolvendoDuplicata({
      lancamento,
      candidatos: data as { id: string; fornecedor: string; valor: number; data_pagamento: string | null }[],
    });
  }

  async function handleDescartarDuplicata() {
    if (!resolvendoDuplicata) return;
    setResolvendoDuplicata(null);
    await handleIgnorar(resolvendoDuplicata.lancamento);
  }

  function fecharDuplicata() {
    setResolvendoDuplicata(null);
  }
```

Nota: `handleIgnorar` já existe (linhas ~1109-1119 antes desta task) e já faz `update({ status: "ignorado" })` + refresh — reaproveitado sem nenhuma alteração. `handleDescartarDuplicata` só fecha o modal e delega pra ele.

- [ ] **Step 3: Badge na célula de Categoria**

Localize o bloco (procure `Baixa ambígua` — linhas ~1674-1682 antes desta task) e adicione um novo ramo no `? :` logo depois dele, antes do `l.status === "ignorado"`:
```tsx
                                    ) : podeEscrever && l.contas_pagar_candidatas && l.contas_pagar_candidatas.length > 0 ? (
                                      <button
                                        type="button"
                                        disabled={carregandoCandidatos}
                                        onClick={() => handleAbrirResolucaoAmbigua(l)}
                                        className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap hover:bg-amber-100 disabled:opacity-50"
                                      >
                                        {carregandoCandidatos ? "..." : `Baixa ambígua (${l.contas_pagar_candidatas.length})`}
                                      </button>
                                    ) : podeEscrever && l.contas_pagar_duplicatas && l.contas_pagar_duplicatas.length > 0 ? (
                                      <button
                                        type="button"
                                        disabled={carregandoDuplicata}
                                        onClick={() => handleAbrirDuplicata(l)}
                                        className="px-2 py-1 rounded-full bg-orange-50 text-orange-700 border border-orange-200 text-[10px] font-semibold whitespace-nowrap hover:bg-orange-100 disabled:opacity-50"
                                      >
                                        {carregandoDuplicata ? "..." : `Provável duplicata (${l.contas_pagar_duplicatas.length})`}
                                      </button>
                                    ) : l.status === "ignorado" ? (
```
(O trecho de `l.status === "ignorado"` em diante continua exatamente igual — só está repetido aqui pra deixar claro onde o novo `? :` se encaixa.)

- [ ] **Step 4: Modal, ao lado do modal de resolução de ambíguos**

Logo depois do bloco `{resolvendoAmbiguo && (...)}` (linhas ~1780-1818 antes desta task, procure `Decidir depois` pra achar o fim dele), adicione:
```tsx
          {resolvendoDuplicata && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={fecharDuplicata}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Provável duplicata</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  Este lançamento de {formatarData(resolvendoDuplicata.lancamento.data_lancamento)} ({formatarMoeda(Math.abs(resolvendoDuplicata.lancamento.valor))})
                  bate com {resolvendoDuplicata.candidatos.length === 1 ? "uma conta a pagar que já consta como paga" : "contas a pagar que já constam como pagas"}:
                </p>
                <div className="space-y-2 mb-4">
                  {resolvendoDuplicata.candidatos.map((c) => (
                    <div key={c.id} className="flex justify-between items-center px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs">
                      <span>
                        <span className="font-semibold">{c.fornecedor}</span>
                        <br />
                        <span className="text-[var(--color-text-muted)]">
                          {c.data_pagamento ? `Pago em ${formatarData(c.data_pagamento)}` : "Pago"}
                        </span>
                      </span>
                      <span className="font-semibold">{formatarMoeda(c.valor)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--color-text-muted)] mb-3">
                  Se este pagamento já foi registrado quando a conta acima foi dada como paga, descarte este lançamento do extrato. Se não for o mesmo pagamento, feche e classifique normalmente.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={fecharDuplicata}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    Não é duplicata
                  </button>
                  <button
                    type="button"
                    onClick={handleDescartarDuplicata}
                    className="flex-1 px-3 py-2 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 6: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos avisos pré-existentes, nenhum novo.

- [ ] **Step 7: Teste manual**

Repetindo o cenário da Task 3 Step 11 (conta paga + lançamento sem pendente correspondente), confirme visualmente ou por raciocínio sobre o código: o badge "Provável duplicata (1)" aparece; clicar abre o modal listando a conta paga; "Descartar" chama `handleIgnorar` e o lançamento vira `status='ignorado'`; "Não é duplicata" só fecha o modal sem mudar nada. Apague os dados de teste.

- [ ] **Step 8: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): badge e modal para revisar lançamentos sinalizados como provável duplicata"
```

---

## Self-Review

**Cobertura da spec** (`docs/superpowers/specs/2026-08-13-sinalizar-conta-ja-paga-design.md`):
- Tabela de 4 resultados (pendente único/ambíguo, pago→duplicata, nada→normal): Task 2, `calcularBaixasAutomaticas` estendida, testada com os 4 casos + 1 caso misto. ✅
- Seção 1 (motor puro, nunca decide sozinho mesmo com match único pago): Task 2. ✅
- Seção 2 (campo novo separado): Task 1 (`contas_pagar_duplicatas`), distinto de `contas_pagar_candidatas`. ✅
- Seção 3 (wiring, exclusão de `classificarPorRegras`, resumo): Task 3. ✅
- Seção 4 (UI — badge, modal, reaproveitar `handleIgnorar`): Task 4. ✅
- Fora de escopo (Capacidade B pendente inalterada, sem auto-descarte, sem vínculo criado): nenhuma task viola isso. ✅

**Checagem de placeholders**: nenhuma neste plano.

**Consistência de tipos entre tasks**: `ResultadoBaixa.duplicatas`, `contas_pagar_duplicatas`, `idsDuplicatas` nomeados de forma idêntica em todas as tasks (lib, wiring, UI). `ContaPagarPendente` reaproveitado sem mudança de forma pros dois pools (pendentes e pagas) — decisão documentada explicitamente no Step 3 da Task 2 pra não gerar confusão.

---

## Execução

Plano salvo em `docs/superpowers/plans/2026-08-13-sinalizar-conta-ja-paga.md`.

**1. Subagent-Driven (recomendado)** — dispatch de subagent fresco por task, revisão entre tasks. Task 1 é exceção: executada pelo orquestrador diretamente.

**2. Execução inline** — executar as tasks nesta sessão via executing-plans, em lote com checkpoints.

Qual abordagem?
