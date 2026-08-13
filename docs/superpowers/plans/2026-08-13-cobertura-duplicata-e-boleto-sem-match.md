# Cobertura de Duplicata Ampliada e Boleto Sem Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O aviso de "provável duplicata" passa a também casar por valor+data de pagamento quando o nome não bate (cobrindo DARF/FGTS/IPTU, que hoje escapam). Lançamentos de boleto sem NENHUM match ganham um caminho de resolução: cadastrar a conta a pagar na hora, com baixa automática reaproveitando o mecanismo já existente. Três bugs de implementação já identificados (consulta com limite compartilhado, erro engolido, sinalização não limpa ao resolver) são corrigidos junto.

**Architecture:** Extensão pontual do motor puro (`src/lib/baixa-contas-pagar.ts`) — um segundo critério de casamento, só usado como fallback pro balde de duplicatas. Na integração (`src/app/extrato/page.tsx`), a consulta de contas a pagar volta a ser duas consultas separadas (bug fix), os dois pontos de "resolver" um lançamento (ignorar, classificar manual) passam a limpar a sinalização de duplicata, e uma função nova (`handleConfirmarCadastroContaPagar`) cria uma `contas_pagar` e imediatamente chama `baixarContaPagar` (já existe, já testado, sem escrita nova).

**Tech Stack:** Next.js 16.2.6 App Router, React 19, Supabase JS v2, TypeScript. Sem framework de testes formal — scripts Node descartáveis (`node --experimental-strip-types`), apagados depois de passar.

## Global Constraints

- **O critério de valor+data só vale pro balde de duplicatas** — a baixa automática (contas pendentes) continua exigindo nome, sem afrouxar.
- **Nunca decide sozinho, mesmo por data+valor**: 2+ candidatos batendo por data+valor também vai pra lista de duplicatas pra revisão humana, igual já acontece por nome.
- **O cadastro de conta a pagar só aparece quando NÃO há nenhum candidato** (nem `contas_pagar_candidatas`, nem `contas_pagar_duplicatas`) — se já existe qualquer sinalização, o caminho é resolver aquela sinalização primeiro, não criar uma conta nova por cima.
- **Reaproveitar `baixarContaPagar` sem alteração** — nenhuma escrita nova em `contas_pagar`/`movimentacoes` além do insert inicial da conta (que nasce `pendente`, pra `baixarContaPagar` conseguir reivindicá-la do jeito que já reivindica qualquer outra).
- **Sem framework de teste**: scripts Node descartáveis com imports relativos, apagados depois de passar. Nenhum arquivo de teste é commitado.

---

## Contexto que todo implementador precisa

**Estado atual do motor puro** (`src/lib/baixa-contas-pagar.ts`, arquivo inteiro — a Task 1 modifica este arquivo):
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
  // Nenhuma conta pendente bateu, mas 1+ conta(s) já paga(s) batem -- provável
  // duplicata (a conta foi paga por outro caminho antes deste extrato ser
  // importado). Nunca decide sozinho: mesmo um único match vai pra cá, nunca
  // é auto-descartado -- descartar uma transação real exige confirmação humana.
  duplicatas: { indice: number; candidatosIds: string[] }[];
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

**Por que o casamento por nome não é suficiente** — dados reais confirmados na revisão final: fornecedor cadastrado `"Receita Federal"` (referente a DARF), banco escreve só `"PAGAMENTO DARF EM CANAIS INTERNET TRIBUTOS FEDERAI"` — a palavra "Receita"/"Federal" não aparece em lugar nenhum desse texto. Mesma coisa pra FGTS (`fornecedor: "Fgts"`, banco escreve `"PIX ENVIADO CEF MATRIZ"`) e IPTU (`fornecedor: "Iptu"`, banco escreve `"PIX ENVIADO PREFEITURA DA ESTANCIA TU..."`). Em todos os três casos reais, a data de pagamento registrada em `contas_pagar` bate exatamente com a data do lançamento no extrato.

**Estado atual da integração** (`src/app/extrato/page.tsx`) — trechos relevantes, com números de linha da versão atual (confira o texto ao redor antes de aplicar):

`processarBaixasAutomaticas` (linhas 214-310) — a Task 2 reescreve o trecho de consulta:
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
  // ... (resto do corpo — loops de baixados/ambiguos/duplicatas — não muda nesta task, ver Task 2 abaixo pra saber exatamente o que muda)
```

`handleIgnorar` (linhas 1188-1198) e `handleClassificarManual` (linhas 1024-1085) — a Task 3 estende os dois. `baixarContaPagar` (linhas 116-210) — reaproveitado sem alteração pela Task 4. `ehPagamentoDeBoleto` (linha 347) e `LIMITE_LANCAMENTOS`/`formatarData`/`formatarMoeda` (topo do arquivo) já existem, reaproveitados sem mudança.

`contas_pagar` (schema, sem mudança nesta feature): `id uuid`, `fornecedor text not null`, `descricao text`, `valor numeric not null`, `data_vencimento date not null`, `data_pagamento date null`, `status text` (`pendente|pago|cancelado`), `categoria_id uuid null`, `observacao text`, `comprovante_url text`, `created_at timestamptz`. Nenhuma coluna nova precisa ser criada nesta feature — tudo que as Tasks abaixo usam já existe.

---

### Task 1: Casamento em dois estágios — `src/lib/baixa-contas-pagar.ts`

**Files:**
- Modify: `src/lib/baixa-contas-pagar.ts`
- Test (descartável, apagar ao final): `src/lib/_test-baixa-contas-pagar-fallback-data.mjs`

**Interfaces:**
- Produces (consumido pela Task 2): `CandidatoBaixa` ganha um campo `data: string` (yyyy-mm-dd, a `data_lancamento` do lançamento do extrato). `ContaPagarPendente` ganha um campo opcional `dataPagamento?: string | null` (só relevante pro pool de contas pagas — no pool de pendentes, sempre `undefined`/`null`, ignorado).

- [ ] **Step 1: Escrever o script de teste descartável**

Criar `src/lib/_test-baixa-contas-pagar-fallback-data.mjs`:

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

// 1. Nome bate -- usa o resultado por nome, nem tenta olhar a data.
{
  const candidatos = [{ indice: 0, valor: 165.28, descricaoNormalizada: "conta de agua e esgoto ... sabesp sao paulo", data: "2026-06-22" }];
  const pagas = [{ id: "conta-sabesp", fornecedor: "Sabesp", valor: 165.28, dataPagamento: "2026-06-01" }]; // data bem diferente, não importa: nome já bateu
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("nome bate, ignora data", r, { baixados: [], ambiguos: [], duplicatas: [{ indice: 0, candidatosIds: ["conta-sabesp"] }] });
}

// 2. Nome NÃO bate, mas valor+data batem -- caso real do DARF.
{
  const candidatos = [{ indice: 0, valor: 1104.19, descricaoNormalizada: "pagamento darf em canais internet tributos federai", data: "2026-06-19" }];
  const pagas = [{ id: "conta-darf", fornecedor: "Receita Federal", valor: 1104.19, dataPagamento: "2026-06-19" }];
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("darf: nome nao bate, data+valor batem", r, { baixados: [], ambiguos: [], duplicatas: [{ indice: 0, candidatosIds: ["conta-darf"] }] });
}

// 3. Caso real do FGTS -- mesma lógica, fornecedor totalmente ausente do texto.
{
  const candidatos = [{ indice: 0, valor: 849.26, descricaoNormalizada: "pix enviado cef matriz", data: "2026-06-19" }];
  const pagas = [{ id: "conta-fgts", fornecedor: "Fgts", valor: 849.26, dataPagamento: "2026-06-19" }];
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("fgts: nome nao bate, data+valor batem", r, { baixados: [], ambiguos: [], duplicatas: [{ indice: 0, candidatosIds: ["conta-fgts"] }] });
}

// 4. Nem nome, nem data+valor batem -- nada, segue fluxo normal.
{
  const candidatos = [{ indice: 0, valor: 300.00, descricaoNormalizada: "pix enviado fornecedor qualquer", data: "2026-06-19" }];
  const pagas = [{ id: "conta-x", fornecedor: "Outra Empresa", valor: 300.00, dataPagamento: "2026-05-01" }]; // valor bate, data não
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("nem nome nem data+valor batem", r, { baixados: [], ambiguos: [], duplicatas: [] });
}

// 5. Duas contas pagas batendo por data+valor -- ainda assim duplicata com as duas, nunca decide sozinho.
{
  const candidatos = [{ indice: 0, valor: 137.27, descricaoNormalizada: "pix enviado prefeitura da estancia tu", data: "2026-06-19" }];
  const pagas = [
    { id: "conta-iptu-1", fornecedor: "Iptu", valor: 137.27, dataPagamento: "2026-06-19" },
    { id: "conta-iptu-2", fornecedor: "Taxa Fiscalizacao", valor: 137.27, dataPagamento: "2026-06-19" },
  ];
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("duas pagas por data+valor -- duplicata com as duas", r, {
    baixados: [],
    ambiguos: [],
    duplicatas: [{ indice: 0, candidatosIds: ["conta-iptu-1", "conta-iptu-2"] }],
  });
}

// 6. Conta paga sem dataPagamento (null) nunca casa pelo critério de data.
{
  const candidatos = [{ indice: 0, valor: 50.00, descricaoNormalizada: "pix enviado alguem", data: "2026-06-19" }];
  const pagas = [{ id: "conta-sem-data", fornecedor: "Sem Nome Aqui", valor: 50.00, dataPagamento: null }];
  const r = calcularBaixasAutomaticas(candidatos, [], pagas);
  assertEqual("dataPagamento null nunca casa por data", r, { baixados: [], ambiguos: [], duplicatas: [] });
}

if (falhas > 0) {
  console.error(`\n${falhas} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar-fallback-data.mjs`
Expected: falha (o fallback por data ainda não existe).

- [ ] **Step 3: Implementar o fallback**

Em `src/lib/baixa-contas-pagar.ts`, trocar as duas interfaces:
```ts
export interface ContaPagarPendente {
  id: string;
  fornecedor: string;
  valor: number;
}
```
por:
```ts
export interface ContaPagarPendente {
  id: string;
  fornecedor: string;
  valor: number;
  // Só relevante no pool de contas já pagas -- usado como critério de
  // desempate quando o nome do fornecedor não aparece no texto do banco
  // (ex.: fornecedor cadastrado "Receita Federal", banco só escreve
  // "PAGAMENTO DARF"). No pool de pendentes, sempre undefined/null, ignorado.
  dataPagamento?: string | null;
}
```
e:
```ts
export interface CandidatoBaixa {
  indice: number;
  valor: number; // valor absoluto (positivo) do lançamento de saída
  descricaoNormalizada: string;
}
```
por:
```ts
export interface CandidatoBaixa {
  indice: number;
  valor: number; // valor absoluto (positivo) do lançamento de saída
  descricaoNormalizada: string;
  data: string; // yyyy-mm-dd, data_lancamento -- usado no fallback por data+valor
}
```

Adicionar, logo depois de `contaCasaComCandidato`:
```ts
// Fallback só usado pro balde de duplicatas quando nenhuma conta paga bate
// por nome -- cobre contas cujo fornecedor cadastrado não aparece no texto
// do banco (DARF, FGTS, IPTU confirmados com dado real). Nunca usado pro
// balde de baixa automática (pendentes): dar baixa sozinho sempre exige nome.
function contaCasaPorDataValor(conta: ContaPagarPendente, candidato: CandidatoBaixa): boolean {
  if (conta.valor !== candidato.valor) return false;
  if (!conta.dataPagamento) return false;
  return conta.dataPagamento === candidato.data;
}
```

E trocar o miolo do loop principal — o trecho:
```ts
    // Nenhuma pendente bateu -- só então procura entre as já pagas. Dar baixa
    // continua tendo prioridade sobre sinalizar duplicata.
    const casadasPagas = contasPagas.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadasPagas.length > 0) {
      duplicatas.push({ indice: candidato.indice, candidatosIds: casadasPagas.map((c) => c.id) });
    }
```
por:
```ts
    // Nenhuma pendente bateu -- só então procura entre as já pagas. Primeiro
    // por nome (mesmo critério de sempre); se nada bater por nome, tenta
    // valor + mesma data de pagamento -- cobre contas cujo fornecedor
    // cadastrado não aparece no texto do banco. Só serve pra sinalizar,
    // nunca decide baixa sozinho, então o critério mais solto é seguro aqui.
    let casadasPagas = contasPagas.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadasPagas.length === 0) {
      casadasPagas = contasPagas.filter((conta) => contaCasaPorDataValor(conta, candidato));
    }
    if (casadasPagas.length > 0) {
      duplicatas.push({ indice: candidato.indice, candidatosIds: casadasPagas.map((c) => c.id) });
    }
```

O resto do arquivo (`TAMANHO_MINIMO_FORNECEDOR`, `contaCasaComCandidato`, a estrutura do loop com `baixados`/`ambiguos`) não muda.

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types src/lib/_test-baixa-contas-pagar-fallback-data.mjs`
Expected: `Todos os testes passaram.` (6 linhas `OK:`).

- [ ] **Step 5: Apagar o script de teste**

```bash
rm src/lib/_test-baixa-contas-pagar-fallback-data.mjs
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: erros SÓ em `src/app/extrato/page.tsx` (que ainda constrói `CandidatoBaixa`/`ContaPagarPendente` sem os campos novos — corrigido na Task 2). Nenhum erro em `src/lib/baixa-contas-pagar.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/baixa-contas-pagar.ts
git commit -m "feat(extrato): casar duplicata provável também por valor+data quando o nome não bate"
```

---

### Task 2: Wiring do fallback + bugs de consulta — `processarBaixasAutomaticas`

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `CandidatoBaixa`/`ContaPagarPendente` com os campos novos (Task 1).

- [ ] **Step 1: Reescrever o trecho de consulta e montagem de `processarBaixasAutomaticas`**

Localize `processarBaixasAutomaticas` (linha 214 antes desta task) e troque do início da função até a linha `const resultado = calcularBaixasAutomaticas(...)` (linhas 214-258 antes desta task):

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

  // Consultas separadas (não uma só com .in) -- contas pendentes e pagas têm
  // volumes muito diferentes (pagas crescem ~300/mês, pendentes ficam baixas
  // sempre), uma única consulta com limite compartilhado arriscava pendentes
  // recentes ficarem de fora quando pagas passassem do teto sozinhas.
  // .limit(2000) em cada uma por precaução -- mesma classe de problema já
  // corrigida antes neste projeto (commit 693a921). A busca de pagas é
  // recortada aos últimos ~12 meses -- conta paga muito antiga não é
  // candidata realista de duplicata, e isso mantém a consulta pequena.
  const dataMinimaPagas = new Date();
  dataMinimaPagas.setFullYear(dataMinimaPagas.getFullYear() - 1);
  const dataMinimaPagasIso = dataMinimaPagas.toISOString().slice(0, 10);

  const [{ data: pendentesRaw, error: erroPendentes }, { data: pagasRaw, error: erroPagas }] = await Promise.all([
    supabase.from("contas_pagar").select("id, fornecedor, valor, categoria_id").eq("status", "pendente").limit(2000),
    supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, categoria_id, data_pagamento")
      .eq("status", "pago")
      .gte("data_pagamento", dataMinimaPagasIso)
      .limit(2000),
  ]);
  // Erro de consulta não pode virar "zero contas": isso limparia sinalizações
  // existentes e liberaria lançamentos que na verdade não foram checados
  // contra nada -- uma falha passageira de rede não pode se transformar na
  // duplicação que esta função existe pra evitar. Retorna sem tocar nas
  // funções de limpeza, deixando tudo como estava.
  if (erroPendentes || erroPagas) {
    return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };
  }

  const pendentes = pendentesRaw ?? [];
  const pagas = pagasRaw ?? [];
  if (pendentes.length === 0 && pagas.length === 0) {
    await Promise.all([limparCandidatasObsoletas(saidas, new Set<number>()), limparDuplicatasObsoletas(saidas, new Set<number>())]);
    return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };
  }

  const { data: categoriasSaidaTodas } = await supabase.from("categorias_saida").select("id, nome");
  const nomeCategoriaPorId = new Map((categoriasSaidaTodas ?? []).map((c) => [c.id as string, c.nome as string]));

  const candidatos: CandidatoBaixa[] = saidas.map((l, indice) => ({
    indice,
    valor: Math.abs(Number(l.valor)),
    descricaoNormalizada: l.descricao_normalizada,
    data: l.data_lancamento,
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
    dataPagamento: c.data_pagamento as string | null,
  }));

  const resultado = calcularBaixasAutomaticas(candidatos, contasPendentes, contasPagas);
```

O resto da função (a partir de `const pendentesPorId = new Map(...)` até o final, incluindo os três loops de `baixados`/`ambiguos`/`duplicatas` e o `return` final) **não muda** — mantenha exatamente como está.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 3: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos avisos pré-existentes, nenhum novo.

- [ ] **Step 4: Teste manual com dados reais**

Via MCP (`mcp__claude_ai_Supabase__execute_sql`, projeto `nheyevdjomfphlzmsszk`):
1. Confirme (consulta real, sem escrever nada) que as contas reais de DARF/FGTS/IPTU mencionadas no contexto acima (ou equivalentes que existam hoje em produção com `status='pago'`) realmente têm `data_pagamento` preenchida.
2. Crie um `extrato_lancamento` de teste com `valor` negativo batendo em uma dessas contas por valor, `descricao_normalizada` SEM o nome do fornecedor mas com a mesma data de `data_lancamento` que a `data_pagamento` da conta.
3. Raciocine sobre o código (ou rode a lógica via script) confirmando que esse lançamento cairia em `contas_pagar_duplicatas`, não em `baixados` nem passaria batido.
4. Simule também uma falha de consulta (ex.: raciocínio sobre o código bastando, já que forçar erro de rede não é prático) confirmando que o novo tratamento de erro não chama as funções de limpeza.
5. Apague os dados de teste criados.

- [ ] **Step 5: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "fix(extrato): separar consulta de contas pendentes/pagas e não tratar erro como zero resultados"
```

---

### Task 3: Limpar sinalização de duplicata ao resolver

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Nenhuma nova — só estende dois handlers já existentes.

- [ ] **Step 1: `handleIgnorar` limpa `contas_pagar_duplicatas`**

Localize (linhas 1188-1198 antes desta task):
```ts
  async function handleIgnorar(lancamento: Lancamento) {
    setAcaoLancamentoId(lancamento.id);
    setMensagem(null);
    const { error } = await supabase.from("extrato_lancamento").update({ status: "ignorado" }).eq("id", lancamento.id);
    setAcaoLancamentoId(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao ignorar lançamento: " + error.message });
      return;
    }
    await Promise.all([carregarLancamentos(), carregarResumo()]);
  }
```
Trocar a linha do `update` por:
```ts
    const { error } = await supabase
      .from("extrato_lancamento")
      .update({ status: "ignorado", contas_pagar_duplicatas: null })
      .eq("id", lancamento.id);
```
(Resto da função idêntico.)

- [ ] **Step 2: `handleClassificarManual` limpa `contas_pagar_duplicatas`**

Localize o primeiro `update` dentro de `handleClassificarManual` (linhas 1034-1045 antes desta task):
```ts
    const { data: linhasAtualizadas, error } = await supabase
      .from("extrato_lancamento")
      .update({
        categoria: categoria.trim(),
        status: "classificado",
        classificado_em: new Date().toISOString(),
        classificado_por: user?.id ?? null,
        regra_id: null,
      })
      .eq("id", lancamento.id)
      .eq("status", "nao_classificado")
      .select("id");
```
Adicionar `contas_pagar_duplicatas: null,` dentro do objeto do `update`, junto dos outros campos:
```ts
    const { data: linhasAtualizadas, error } = await supabase
      .from("extrato_lancamento")
      .update({
        categoria: categoria.trim(),
        status: "classificado",
        classificado_em: new Date().toISOString(),
        classificado_por: user?.id ?? null,
        regra_id: null,
        contas_pagar_duplicatas: null,
      })
      .eq("id", lancamento.id)
      .eq("status", "nao_classificado")
      .select("id");
```
(Resto da função idêntico — inclusive o guard de corrida `.eq("status", "nao_classificado")`, que já existe e não muda.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: limpo.

- [ ] **Step 4: Lint**

Run: `npx eslint src/app/extrato/page.tsx`
Expected: mesmos avisos pré-existentes, nenhum novo.

- [ ] **Step 5: Teste manual**

Via MCP: crie um `extrato_lancamento` de teste com `contas_pagar_duplicatas` preenchido. Simule (via SQL, reproduzindo o update exato) tanto o caminho de ignorar quanto o de classificar manual, confirmando que `contas_pagar_duplicatas` fica `null` nos dois casos. Apague os dados de teste.

- [ ] **Step 6: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "fix(extrato): limpar sinalização de duplicata ao ignorar ou classificar manualmente"
```

---

### Task 4: Boleto sem match — cadastrar Conta a Pagar na hora

**Files:**
- Modify: `src/app/extrato/page.tsx`

**Interfaces:**
- Consumes: `baixarContaPagar` (já existe, linha 116, reaproveitado sem alteração), `ehPagamentoDeBoleto` (já existe, linha 347).

- [ ] **Step 1: Novo estado**

Ao lado dos outros estados de modal (`resolvendoAmbiguo`, `resolvendoDuplicata` — procure por eles no arquivo), adicionar:
```ts
  const [cadastrandoContaPagar, setCadastrandoContaPagar] = useState<{ lancamento: Lancamento } | null>(null);
  const [categoriasSaidaComId, setCategoriasSaidaComId] = useState<{ id: string; nome: string }[]>([]);
  const [novaContaFornecedor, setNovaContaFornecedor] = useState("");
  const [novaContaCategoriaId, setNovaContaCategoriaId] = useState("");
  const [salvandoContaPagar, setSalvandoContaPagar] = useState(false);
```

- [ ] **Step 2: Handlers**

Ao lado de `handleAbrirDuplicata`/`fecharDuplicata` (procure por eles no arquivo), adicionar:
```ts
  async function handleAbrirCadastroContaPagar(lancamento: Lancamento) {
    const { data } = await supabase.from("categorias_saida").select("id, nome").eq("ativo", true).order("nome");
    setCategoriasSaidaComId((data ?? []) as { id: string; nome: string }[]);
    // Sugestão de fornecedor a partir do texto do banco -- tira os prefixos
    // fixos mais comuns do padrão de boleto, deixando a cauda que costuma
    // ser o nome truncado. Sempre editável antes de confirmar.
    const sugestao = lancamento.descricao
      .replace(/pagamento de boleto/i, "")
      .replace(/outros bancos/i, "")
      .trim();
    setNovaContaFornecedor(sugestao);
    setNovaContaCategoriaId("");
    setCadastrandoContaPagar({ lancamento });
  }

  function fecharCadastroContaPagar() {
    setCadastrandoContaPagar(null);
  }

  async function handleConfirmarCadastroContaPagar() {
    if (!cadastrandoContaPagar) return;
    if (!novaContaFornecedor.trim() || !novaContaCategoriaId) {
      setMensagem({ tipo: "erro", texto: "Preencha fornecedor e categoria." });
      return;
    }
    setSalvandoContaPagar(true);
    const lancamento = cadastrandoContaPagar.lancamento;
    const valorAbsoluto = Math.abs(Number(lancamento.valor));

    // Nasce pendente de propósito -- baixarContaPagar reivindica e dá baixa
    // do mesmo jeito que já faz pra qualquer outra conta, sem escrita nova.
    const { data: contaCriada, error: erroInsert } = await supabase
      .from("contas_pagar")
      .insert({
        fornecedor: novaContaFornecedor.trim(),
        valor: valorAbsoluto,
        data_vencimento: lancamento.data_lancamento,
        categoria_id: novaContaCategoriaId,
        status: "pendente",
      })
      .select("id")
      .single();
    if (erroInsert || !contaCriada) {
      setSalvandoContaPagar(false);
      setMensagem({ tipo: "erro", texto: "Erro ao cadastrar conta a pagar: " + (erroInsert?.message ?? "") });
      return;
    }

    const categoriaSelecionada = categoriasSaidaComId.find((c) => c.id === novaContaCategoriaId);
    const categoriaNome = categoriaSelecionada?.nome ?? "Contas a pagar";

    const resultadoEscrita = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: contaCriada.id as string, fornecedor: novaContaFornecedor.trim(), valor: valorAbsoluto, categoria_id: novaContaCategoriaId },
      categoriaNome,
      "manual"
    );

    setSalvandoContaPagar(false);
    if (resultadoEscrita === "mes_fechado") {
      setMensagem({
        tipo: "erro",
        texto: `Conta cadastrada, mas não foi possível dar baixa: ${formatarData(lancamento.data_lancamento)} está num mês contábil já fechado. Dê baixa manualmente pela tela de Contas a Pagar.`,
      });
      setCadastrandoContaPagar(null);
      await Promise.all([carregarLancamentos(), carregarResumo()]);
      return;
    }
    if (resultadoEscrita !== "ok") {
      setMensagem({ tipo: "erro", texto: "Conta cadastrada, mas houve um erro ao dar baixa. Dê baixa manualmente pela tela de Contas a Pagar." });
      setCadastrandoContaPagar(null);
      await Promise.all([carregarLancamentos(), carregarResumo()]);
      return;
    }
    setCadastrandoContaPagar(null);
    setMensagem({ tipo: "sucesso", texto: `Conta cadastrada e baixada: ${novaContaFornecedor.trim()}.` });
    await Promise.all([carregarLancamentos(), carregarResumo()]);
  }
```

- [ ] **Step 3: Botão na célula de Categoria**

Localize o `? :` da célula de Categoria (procure `l.status === "ignorado" ? (` — é o penúltimo ramo antes do `pendente` padrão) e insira um novo ramo logo DEPOIS do `ignorado` e ANTES do fallback final `<span className="text-[10px] text-amber-600 font-medium">pendente</span>`:
```tsx
                                    ) : podeEscrever && ehPagamentoDeBoleto(l.descricao_normalizada) ? (
                                      <button
                                        type="button"
                                        onClick={() => handleAbrirCadastroContaPagar(l)}
                                        className="px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-300 text-[10px] font-semibold whitespace-nowrap hover:bg-slate-200"
                                      >
                                        Cadastrar conta a pagar
                                      </button>
                                    ) : (
                                      <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                                    )}
```
Esse botão só aparece quando NENHUM dos ramos anteriores bateu (`!l.categoria`, sem `contas_pagar_candidatas`, sem `contas_pagar_duplicatas`, `status !== "ignorado"`) — ou seja, exatamente o caso de "não achei nada", que é a condição do desenho.

- [ ] **Step 4: Modal**

Ao lado do modal de duplicata (procure `{resolvendoDuplicata && (` e adicione depois do fechamento dele), adicionar:
```tsx
          {cadastrandoContaPagar && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={fecharCadastroContaPagar}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Cadastrar conta a pagar</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  Nenhuma conta a pagar correspondente foi encontrada para este lançamento de{" "}
                  {formatarData(cadastrandoContaPagar.lancamento.data_lancamento)} ({formatarMoeda(Math.abs(cadastrandoContaPagar.lancamento.valor))}).
                  Cadastre o fornecedor e a categoria — a baixa é feita automaticamente.
                </p>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Fornecedor</label>
                <input
                  value={novaContaFornecedor}
                  onChange={(e) => setNovaContaFornecedor(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-3"
                />
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
                <select
                  value={novaContaCategoriaId}
                  onChange={(e) => setNovaContaCategoriaId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-4"
                >
                  <option value="">Selecione...</option>
                  {categoriasSaidaComId.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={fecharCadastroContaPagar}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={salvandoContaPagar || !novaContaFornecedor.trim() || !novaContaCategoriaId}
                    onClick={handleConfirmarCadastroContaPagar}
                    className="flex-1 px-3 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {salvandoContaPagar ? "Salvando..." : "Cadastrar e dar baixa"}
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

- [ ] **Step 7: Teste manual com dados reais**

Via MCP:
1. Crie um `extrato_lancamento` de teste com descrição batendo no padrão de boleto e valor que não corresponde a NENHUMA `contas_pagar` existente (pendente ou paga).
2. Confirme por raciocínio sobre o código (ou reproduzindo a sequência de escrita via SQL, já que não dá pra rodar o browser aqui) que: o botão "Cadastrar conta a pagar" apareceria; ao confirmar o cadastro, uma `contas_pagar` nasce `pendente` com os dados certos; `baixarContaPagar` a reivindica e dá baixa corretamente (`status='pago'`, `movimentacoes` criada, `extrato_lancamento` vinculado com `status='classificado'`).
3. Apague os dados de teste.

- [ ] **Step 8: Commit**

```bash
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): cadastrar conta a pagar na hora para boleto sem nenhum match"
```

---

## Self-Review

**Cobertura da spec** (`docs/superpowers/specs/2026-08-13-cobertura-duplicata-e-boleto-sem-match-design.md`):
- Seção 1 (casamento em dois estágios): Task 1 (motor) + Task 2 (wiring). Testado com os 3 casos reais (DARF, FGTS, IPTU) + casos sintéticos de fronteira. ✅
- Seção 2 (boleto sem match → cadastro): Task 4. ✅
- Seção 3 (bugs — consulta separada, erro tratado, sinalização limpa): Task 2 (consulta/erro) + Task 3 (limpeza ao resolver). ✅
- Fora de escopo (ajustar nomes de fornecedor cadastrados, afrouxar baixa automática, excluir boleto da checagem de duplicata): nenhuma task viola isso — a Task 1 explicitamente mantém `contaCasaComCandidato` (nome, usado por pendentes) intocado, só adiciona um fallback no balde de duplicatas.

**Checagem de placeholders**: nenhuma neste plano.

**Consistência de tipos entre tasks**: `CandidatoBaixa.data`/`ContaPagarPendente.dataPagamento` definidos na Task 1, consumidos sem redefinição na Task 2. `cadastrandoContaPagar`/`categoriasSaidaComId`/`novaContaFornecedor`/`novaContaCategoriaId` todos definidos e usados só dentro da Task 4, sem colisão com estados existentes (`resolvendoAmbiguo`, `resolvendoDuplicata` continuam intocados).

---

## Execução

Plano salvo em `docs/superpowers/plans/2026-08-13-cobertura-duplicata-e-boleto-sem-match.md`. Sem migração de schema nesta feature — todas as colunas usadas já existem.

**1. Subagent-Driven (recomendado)** — dispatch de subagent fresco por task, revisão entre tasks.

**2. Execução inline** — executar as tasks nesta sessão via executing-plans, em lote com checkpoints.

Qual abordagem?
