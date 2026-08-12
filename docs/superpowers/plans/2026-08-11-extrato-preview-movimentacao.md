# Extrato → Prévia de Movimentação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/extrato` classify lançamentos using the real `categorias_entrada`/`categorias_saida` (instead of a generic hardcoded list), show a clear per-lançamento "this would become this movimentação" preview, and a daily summary grouped by category — all still 100% staging, zero writes to `movimentacoes`.

**Architecture:** One new pure-logic file (`src/lib/preview-movimentacao.ts`) for tipo derivation and daily grouping, tested standalone with a throwaway Node script (this repo has no test framework configured). All UI changes live in the existing `src/app/extrato/page.tsx` — no new routes, no new tables, no new migrations.

**Tech Stack:** Next.js 16 (App Router, client components), Supabase JS v2 (`@supabase/supabase-js`), TypeScript, Tailwind CSS v4.

## Global Constraints

- Never write to `movimentacoes` or `contas_pagar` — this feature is a preview only (spec section "Fora de escopo").
- Never write to `categorias_entrada`/`categorias_saida` — read-only reference data (spec section 1).
- No reconciliation/matching against existing `movimentacoes` rows — explicitly out of scope (spec section "Fora de escopo").
- No new columns/migrations on any existing table, nor on the staging tables already created in Fase 1 (spec section "Fora de escopo").
- No changes to any file outside `src/lib/preview-movimentacao.ts` and `src/app/extrato/page.tsx` — every other screen/route stays untouched.
- Every list query must have explicit, deterministic `.order()` — no relying on implicit database order (established project convention, see `contas-pagar` ordering fix in git history).
- Every button that triggers an async action must show processing/success/error states; no empty `catch` blocks (established project convention, CLAUDE.md-equivalent rule already followed in `/extrato`).
- Tipo (`entrada`/`saida`) is always derived from the sign of `valor` (`valor >= 0` → entrada, `valor < 0` → saida) — never stored, never asked from the user.

---

### Task 1: `lib/preview-movimentacao.ts` — tipo derivation and daily grouping

**Files:**
- Create: `src/lib/preview-movimentacao.ts`
- Test: throwaway script `scratch-test-preview.mts` at repo root (Node's native TS runner via `node --experimental-strip-types`; delete after the run — this repo has no permanent test framework, matching how `src/lib/ofx.ts`, `src/lib/regras-extrato.ts`, `src/lib/xml-nfe.ts`, and `src/lib/zip.ts` were verified earlier in this project)

**Interfaces:**
- Produces: `calcularTipoMovimentacao(valor: number): "entrada" | "saida"`
- Produces: `interface LancamentoParaResumo { data_lancamento: string; valor: number; categoria: string | null; status: string }`
- Produces: `interface ResumoCategoriaDia { categoria: string; quantidade: number; total: number }`
- Produces: `interface ResumoDia { data: string; categorias: ResumoCategoriaDia[]; totalDia: number }`
- Produces: `agruparResumoPorDia(lancamentos: LancamentoParaResumo[]): ResumoDia[]` — only considers items with `status === "classificado" && categoria != null`; groups by `data_lancamento`, then by `categoria`, summing `valor` and counting; categories within a day sorted alphabetically (`localeCompare` pt-BR); days sorted most-recent-first (`data` descending).

- [ ] **Step 1: Write the failing test script**

Create `scratch-test-preview.mts` at the repo root:

```ts
import assert from "node:assert/strict";
import { calcularTipoMovimentacao, agruparResumoPorDia } from "./src/lib/preview-movimentacao.ts";

let passou = 0;
function teste(nome: string, fn: () => void) {
  try {
    fn();
    passou++;
    console.log(`OK   - ${nome}`);
  } catch (e) {
    console.log(`FAIL - ${nome}`);
    console.log(e);
    process.exitCode = 1;
  }
}

teste("valor positivo é entrada", () => {
  assert.equal(calcularTipoMovimentacao(150.5), "entrada");
});

teste("valor zero é entrada", () => {
  assert.equal(calcularTipoMovimentacao(0), "entrada");
});

teste("valor negativo é saida", () => {
  assert.equal(calcularTipoMovimentacao(-45.9), "saida");
});

const LANCAMENTOS = [
  { data_lancamento: "2026-01-10", valor: -320, categoria: "Água SABESP", status: "classificado" },
  { data_lancamento: "2026-01-10", valor: -150, categoria: "Energia ENERGISA", status: "classificado" },
  { data_lancamento: "2026-01-10", valor: 1500, categoria: "Pix Santander", status: "classificado" },
  { data_lancamento: "2026-01-10", valor: 500, categoria: "Pix Santander", status: "classificado" },
  { data_lancamento: "2026-01-05", valor: 800, categoria: "Pix Inter", status: "classificado" },
  { data_lancamento: "2026-01-05", valor: -90, categoria: null, status: "nao_classificado" },
  { data_lancamento: "2026-01-05", valor: -10, categoria: "Outros", status: "ignorado" },
];

teste("agrupa por dia e soma por categoria, ignorando não-classificados e ignorados", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  assert.equal(resultado.length, 2);
  assert.equal(resultado[0].data, "2026-01-10");
  assert.equal(resultado[1].data, "2026-01-05");
});

teste("dias mais recentes vêm primeiro", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  assert.ok(resultado[0].data > resultado[1].data);
});

teste("categorias dentro do dia somam quantidade e valor corretamente", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  const dia10 = resultado.find((d) => d.data === "2026-01-10")!;
  const pix = dia10.categorias.find((c) => c.categoria === "Pix Santander")!;
  assert.equal(pix.quantidade, 2);
  assert.equal(pix.total, 2000);
});

teste("categorias dentro do dia vêm ordenadas alfabeticamente", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  const dia10 = resultado.find((d) => d.data === "2026-01-10")!;
  const nomes = dia10.categorias.map((c) => c.categoria);
  assert.deepEqual(nomes, [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR")));
});

teste("totalDia soma entradas e saídas do dia (líquido)", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  const dia10 = resultado.find((d) => d.data === "2026-01-10")!;
  assert.equal(dia10.totalDia, -320 - 150 + 1500 + 500);
});

teste("lançamento sem categoria ou não classificado não aparece no resumo", () => {
  const resultado = agruparResumoPorDia(LANCAMENTOS);
  const dia05 = resultado.find((d) => d.data === "2026-01-05")!;
  assert.equal(dia05.categorias.length, 1);
  assert.equal(dia05.categorias[0].categoria, "Pix Inter");
});

console.log(`\n${passou} teste(s) passaram.`);
```

- [ ] **Step 2: Run it to verify it fails (module doesn't exist yet)**

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types scratch-test-preview.mts`
Expected: `ERR_MODULE_NOT_FOUND` (or similar) because `src/lib/preview-movimentacao.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/preview-movimentacao.ts`:

```ts
// Prévia de "o que este lançamento do extrato viraria como movimentação" —
// usado só para exibição dentro do staging /extrato. Não escreve em
// movimentacoes; tipo é sempre derivado do sinal do valor, nunca armazenado.

export type TipoMovimentacao = "entrada" | "saida";

export function calcularTipoMovimentacao(valor: number): TipoMovimentacao {
  return valor >= 0 ? "entrada" : "saida";
}

export interface LancamentoParaResumo {
  data_lancamento: string; // yyyy-mm-dd
  valor: number;
  categoria: string | null;
  status: string;
}

export interface ResumoCategoriaDia {
  categoria: string;
  quantidade: number;
  total: number;
}

export interface ResumoDia {
  data: string; // yyyy-mm-dd
  categorias: ResumoCategoriaDia[];
  totalDia: number;
}

export function agruparResumoPorDia(lancamentos: LancamentoParaResumo[]): ResumoDia[] {
  const porDia = new Map<string, Map<string, { quantidade: number; total: number }>>();

  for (const l of lancamentos) {
    if (l.status !== "classificado" || !l.categoria) continue;

    if (!porDia.has(l.data_lancamento)) porDia.set(l.data_lancamento, new Map());
    const porCategoria = porDia.get(l.data_lancamento)!;

    const atual = porCategoria.get(l.categoria) ?? { quantidade: 0, total: 0 };
    atual.quantidade += 1;
    atual.total += l.valor;
    porCategoria.set(l.categoria, atual);
  }

  const dias: ResumoDia[] = Array.from(porDia.entries()).map(([data, porCategoria]) => {
    const categorias = Array.from(porCategoria.entries())
      .map(([categoria, { quantidade, total }]) => ({ categoria, quantidade, total }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR"));
    const totalDia = categorias.reduce((soma, c) => soma + c.total, 0);
    return { data, categorias, totalDia };
  });

  return dias.sort((a, b) => b.data.localeCompare(a.data));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types scratch-test-preview.mts`
Expected: all 9 `OK` lines, ending with `9 teste(s) passaram.` and exit code 0.

- [ ] **Step 5: Delete the throwaway test script and typecheck**

Run:
```bash
cd c:/projetos/q-mais-financas
rm -f scratch-test-preview.mts
npx tsc --noEmit -p tsconfig.json
```
Expected: no output (no type errors).

- [ ] **Step 6: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/lib/preview-movimentacao.ts
git commit -m "feat(extrato): adicionar lib de prévia de movimentação (tipo + resumo diário)"
```

---

### Task 2: Trocar categorias genéricas pelas categorias reais do sistema

**Files:**
- Modify: `src/app/extrato/page.tsx:1-19` (imports, remove `CATEGORIAS_INICIAIS`)
- Modify: `src/app/extrato/page.tsx:73-83` (`REGRA_FORM_INICIAL`)
- Modify: `src/app/extrato/page.tsx:85-133` (component state + `categoriasDisponiveis`)
- Modify: `src/app/extrato/page.tsx:198-208` (mount `useEffect`)

**Interfaces:**
- Consumes: nothing new from Task 1 in this task (Task 1's exports are consumed starting Task 4).
- Produces: state `categoriasEntrada: string[]`, `categoriasSaida: string[]` — read by Task 3 and Task 4.
- Produces: `categoriasDisponiveis: string[]` (combined, deduped, sorted) — same variable name as before, now sourced from real data instead of the hardcoded list. Consumed by the regra form (Task 3).

- [ ] **Step 1: Remove the hardcoded category list and update the import block**

In `src/app/extrato/page.tsx`, replace lines 1–19:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseOfx, decodificarOfx, OfxParseError } from "@/lib/ofx";
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel } from "@/lib/regras-extrato";
import { calcularTipoMovimentacao, agruparResumoPorDia } from "@/lib/preview-movimentacao";
import EmptyState from "@/components/empty-state";
```

(This drops the `CATEGORIAS_INICIAIS` constant entirely and adds the Task 1 imports now so later tasks don't need to touch the import block again.)

- [ ] **Step 2: Update `REGRA_FORM_INICIAL` to not reference the removed constant**

Find (around line 73-83):

```tsx
const REGRA_FORM_INICIAL = {
  nome: "",
  tipo_match: "contem" as "contem" | "comeca_com" | "regex",
  padrao: "",
  conta_id: "",
  valor_min: "",
  valor_max: "",
  categoria: CATEGORIAS_INICIAIS[0],
  prioridade: "100",
  ativa: true,
};
```

Replace `categoria: CATEGORIAS_INICIAIS[0],` with `categoria: "",` (empty — the form now uses a `<select>` populated from real data, built in Task 3, so there's no safe hardcoded default anymore).

- [ ] **Step 3: Add state for real categories and replace `categoriasDisponiveis`**

Find (around line 85-133, inside `export default function ExtratoPage()`), the block right after the `regras` state declarations:

```tsx
  // Regras
  const [regras, setRegras] = useState<Regra[]>([]);
  const [carregandoRegras, setCarregandoRegras] = useState(false);
  const [mostrarFormRegra, setMostrarFormRegra] = useState(false);
  const [editandoRegraId, setEditandoRegraId] = useState<string | null>(null);
  const [formRegra, setFormRegra] = useState(REGRA_FORM_INICIAL);
  const [salvandoRegra, setSalvandoRegra] = useState(false);

  const categoriasDisponiveis = Array.from(
    new Set([...CATEGORIAS_INICIAIS, ...regras.map((r) => r.categoria), ...lancamentos.filter((l) => l.categoria).map((l) => l.categoria as string)])
  ).sort((a, b) => a.localeCompare(b, "pt-BR"));
```

Replace with:

```tsx
  // Regras
  const [regras, setRegras] = useState<Regra[]>([]);
  const [carregandoRegras, setCarregandoRegras] = useState(false);
  const [mostrarFormRegra, setMostrarFormRegra] = useState(false);
  const [editandoRegraId, setEditandoRegraId] = useState<string | null>(null);
  const [formRegra, setFormRegra] = useState(REGRA_FORM_INICIAL);
  const [salvandoRegra, setSalvandoRegra] = useState(false);

  // Categorias reais (categorias_entrada / categorias_saida) — só leitura,
  // nunca escrevemos nessas tabelas.
  const [categoriasEntrada, setCategoriasEntrada] = useState<string[]>([]);
  const [categoriasSaida, setCategoriasSaida] = useState<string[]>([]);

  const categoriasDisponiveis = Array.from(new Set([...categoriasEntrada, ...categoriasSaida])).sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );
```

- [ ] **Step 4: Add the loader function for real categories**

Find `carregarContas` (around line 135-138):

```tsx
  async function carregarContas() {
    const { data, error } = await supabase.from("extrato_conta").select("*").order("banco").order("apelido");
    if (!error && data) setContas(data as Conta[]);
  }
```

Add a new function directly after it:

```tsx
  async function carregarContas() {
    const { data, error } = await supabase.from("extrato_conta").select("*").order("banco").order("apelido");
    if (!error && data) setContas(data as Conta[]);
  }

  async function carregarCategoriasReais() {
    const [{ data: entrada }, { data: saida }] = await Promise.all([
      supabase.from("categorias_entrada").select("nome").eq("ativo", true).order("nome"),
      supabase.from("categorias_saida").select("nome").eq("ativo", true).order("nome"),
    ]);
    setCategoriasEntrada((entrada ?? []).map((c) => c.nome as string));
    setCategoriasSaida((saida ?? []).map((c) => c.nome as string));
  }
```

- [ ] **Step 5: Call the loader on mount**

Find the mount `useEffect` (around line 198-208):

```tsx
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarContas();
    carregarRegras();
  }, []);
```

Replace with:

```tsx
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarContas();
    carregarRegras();
    carregarCategoriasReais();
  }, []);
```

- [ ] **Step 6: Typecheck**

Run: `cd c:/projetos/q-mais-financas && npx tsc --noEmit -p tsconfig.json`
Expected: errors about `categoriasEntrada`/`categoriasSaida` being unused are **not** expected yet (they're used by `categoriasDisponiveis`), but there will likely be no errors related to this task. If `calcularTipoMovimentacao`/`agruparResumoPorDia` show as unused-import errors, that's expected and fine — they're wired up in Task 3, Task 4, and Task 5. Confirm no *other* type errors were introduced.

- [ ] **Step 7: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): carregar categorias reais de categorias_entrada/categorias_saida"
```

---

### Task 3: Trocar os campos de categoria (free text) por `<select>` restrito às categorias reais

**Files:**
- Modify: `src/app/extrato/page.tsx` — per-lançamento classification input (currently around line 751-755 for the `<datalist>`, and 801-807 for the `<input list="categorias-extrato">`)
- Modify: `src/app/extrato/page.tsx` — regra form categoria field (currently around line 1000-1008)

**Interfaces:**
- Consumes: `categoriasEntrada`, `categoriasSaida`, `categoriasDisponiveis` (state/derived value from Task 2); `calcularTipoMovimentacao` (imported in Task 2, used here for the first time).
- Produces: no new exports — this task only changes JSX.

- [ ] **Step 1: Remove the shared `<datalist>` (no longer needed — both fields become controlled `<select>`s)**

Find (around line 751-755):

```tsx
          <datalist id="categorias-extrato">
            {categoriasDisponiveis.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>

```

Delete this block entirely.

- [ ] **Step 2: Replace the per-lançamento free-text category input with a direction-filtered `<select>`**

Find (around line 799-824), inside the lançamentos table body, the classification controls:

```tsx
                      <td className="px-3 py-2.5">
                        {l.status === "nao_classificado" && podeEscrever ? (
                          <div className="flex gap-1.5 items-center">
                            <input
                              list="categorias-extrato"
                              placeholder="categoria..."
                              value={categoriaEmEdicao[l.id] ?? ""}
                              onChange={(e) => setCategoriaEmEdicao((prev) => ({ ...prev, [l.id]: e.target.value }))}
                              className="w-28 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px]"
                            />
                            <button
                              type="button"
                              disabled={!categoriaEmEdicao[l.id]?.trim() || acaoLancamentoId === l.id}
                              onClick={() => handleClassificarManual(l, categoriaEmEdicao[l.id])}
                              className="px-2 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-50 whitespace-nowrap"
                            >
                              {acaoLancamentoId === l.id ? "..." : "Classificar"}
                            </button>
                            <button
                              type="button"
                              disabled={acaoLancamentoId === l.id}
                              onClick={() => handleIgnorar(l)}
                              className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)] disabled:opacity-50"
                            >
                              Ignorar
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            {l.classificado_em ? new Date(l.classificado_em).toLocaleDateString("pt-BR") : ""}
                          </span>
                        )}
                      </td>
```

Replace with:

```tsx
                      <td className="px-3 py-2.5">
                        {l.status === "nao_classificado" && podeEscrever ? (
                          <div className="flex gap-1.5 items-center">
                            <select
                              value={categoriaEmEdicao[l.id] ?? ""}
                              onChange={(e) => setCategoriaEmEdicao((prev) => ({ ...prev, [l.id]: e.target.value }))}
                              className="w-32 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px]"
                            >
                              <option value="">categoria...</option>
                              {(calcularTipoMovimentacao(l.valor) === "entrada" ? categoriasEntrada : categoriasSaida).map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={!categoriaEmEdicao[l.id]?.trim() || acaoLancamentoId === l.id}
                              onClick={() => handleClassificarManual(l, categoriaEmEdicao[l.id])}
                              className="px-2 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-50 whitespace-nowrap"
                            >
                              {acaoLancamentoId === l.id ? "..." : "Classificar"}
                            </button>
                            <button
                              type="button"
                              disabled={acaoLancamentoId === l.id}
                              onClick={() => handleIgnorar(l)}
                              className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)] disabled:opacity-50"
                            >
                              Ignorar
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            {l.classificado_em ? new Date(l.classificado_em).toLocaleDateString("pt-BR") : ""}
                          </span>
                        )}
                      </td>
```

(Only the `<input list="categorias-extrato" .../>` became a `<select>` with an empty first option and direction-filtered `<option>`s built from `categoriasEntrada`/`categoriasSaida`. The `handleClassificarManual`/`handleIgnorar` calls and the rest of the row are unchanged.)

- [ ] **Step 3: Replace the regra-form free-text category input with a `<select>`**

Find (around line 1000-1008):

```tsx
                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
                  <input
                    list="categorias-extrato"
                    value={formRegra.categoria}
                    onChange={(e) => setFormRegra((f) => ({ ...f, categoria: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  />
                </div>
```

Replace with:

```tsx
                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
                  <select
                    value={formRegra.categoria}
                    onChange={(e) => setFormRegra((f) => ({ ...f, categoria: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  >
                    <option value="">Selecione...</option>
                    <optgroup label="Entrada">
                      {categoriasEntrada.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Saída">
                      {categoriasSaida.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
```

- [ ] **Step 4: Typecheck and lint**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx
```
Expected: no type errors. ESLint may still show the pre-existing `react-hooks/set-state-in-effect` warnings/errors already present before this plan (same pattern as `contas-pagar/page.tsx` — not a regression); no *new* error categories should appear.

- [ ] **Step 5: Manual smoke test with the dev server**

Run:
```bash
cd c:/projetos/q-mais-financas
npm run dev
```
Then in another terminal: `curl -s -o /dev/null -w "GET /extrato -> %{http_code}\n" http://localhost:3000/extrato` (adjust port if 3000 is taken — check the dev server's own log output for the actual port).
Expected: `200`, and the dev server log shows no compile errors for the request.

Then stop the dev server (`taskkill //F //PID <pid>` on the port it used, found via `netstat -ano | grep :<port> | grep LISTENING`).

- [ ] **Step 6: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): restringir classificação às categorias reais por direção (select)"
```

---

### Task 4: Mostrar a prévia "Entrada/Saída · categoria" em cada lançamento

**Files:**
- Modify: `src/app/extrato/page.tsx` — Categoria table cell (around line 784-794)

**Interfaces:**
- Consumes: `calcularTipoMovimentacao` (already imported in Task 2).
- Produces: no new exports — JSX only.

- [ ] **Step 1: Replace the Categoria cell to show the tipo badge alongside the category badge**

Find (around line 784-794):

```tsx
                      <td className="px-3 py-2.5">
                        {l.categoria ? (
                          <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold whitespace-nowrap">
                            {l.categoria}
                          </span>
                        ) : l.status === "ignorado" ? (
                          <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                        ) : (
                          <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                        )}
                      </td>
```

Replace with:

```tsx
                      <td className="px-3 py-2.5">
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
                          </div>
                        ) : l.status === "ignorado" ? (
                          <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                        ) : (
                          <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                        )}
                      </td>
```

- [ ] **Step 2: Typecheck**

Run: `cd c:/projetos/q-mais-financas && npx tsc --noEmit -p tsconfig.json`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): exibir prévia Entrada/Saída junto da categoria por lançamento"
```

---

### Task 5: Resumo diário por categoria

**Files:**
- Modify: `src/app/extrato/page.tsx` — add state near the other `lancamentos`-tab state (around line 109-121), and add the panel JSX right before the lançamentos table (around line 757)

**Interfaces:**
- Consumes: `agruparResumoPorDia` (imported in Task 2); `lancamentos` state (already exists); `formatarData`, `formatarMoeda` (already exist in the file).
- Produces: no new exports — local state + JSX only.

- [ ] **Step 1: Add a toggle state and the computed summary**

Find (around line 109-121), the `Lançamentos` state block:

```tsx
  // Lançamentos
  const [lancamentos, setLancamentos] = useState<Lancamento[]>([]);
  const [carregandoLancamentos, setCarregandoLancamentos] = useState(false);
  const [filtroContaId, setFiltroContaId] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | "nao_classificado" | "classificado" | "ignorado">("todos");
  const [resumo, setResumo] = useState({ total: 0, classificados: 0, naoClassificados: 0, automaticos: 0 });
  const [reprocessando, setReprocessando] = useState(false);
```

Add `mostrarResumoDiario` right after `resumo`:

```tsx
  // Lançamentos
  const [lancamentos, setLancamentos] = useState<Lancamento[]>([]);
  const [carregandoLancamentos, setCarregandoLancamentos] = useState(false);
  const [filtroContaId, setFiltroContaId] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | "nao_classificado" | "classificado" | "ignorado">("todos");
  const [resumo, setResumo] = useState({ total: 0, classificados: 0, naoClassificados: 0, automaticos: 0 });
  const [mostrarResumoDiario, setMostrarResumoDiario] = useState(false);
  const [reprocessando, setReprocessando] = useState(false);
```

Then, right after the `categoriasDisponiveis` derived value (added in Task 2), add the daily grouping:

```tsx
  const categoriasDisponiveis = Array.from(new Set([...categoriasEntrada, ...categoriasSaida])).sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );

  const resumoPorDia = agruparResumoPorDia(lancamentos);
```

(No cast needed: `Lancamento` already has every field `LancamentoParaResumo` requires, so it's structurally assignable as-is.)

- [ ] **Step 2: Add the collapsible panel in the Lançamentos tab, before the table**

Find (around line 757), immediately after the deleted `<datalist>` spot (from Task 3 Step 1) and before:

```tsx
          {carregandoLancamentos ? (
            <div className="skeleton h-40 rounded-xl" />
```

Insert this block directly above that `{carregandoLancamentos ? (`:

```tsx
          {resumoPorDia.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setMostrarResumoDiario((v) => !v)}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
              >
                {mostrarResumoDiario ? "▲" : "▼"} Resumo diário por categoria ({resumoPorDia.length} dia{resumoPorDia.length > 1 ? "s" : ""})
              </button>
              {mostrarResumoDiario && (
                <div className="mt-2 space-y-2 max-h-96 overflow-y-auto">
                  {resumoPorDia.map((dia) => (
                    <div key={dia.data} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-semibold">{formatarData(dia.data)}</span>
                        <span className={`text-xs font-bold ${dia.totalDia < 0 ? "text-red-600" : "text-emerald-600"}`}>
                          {formatarMoeda(dia.totalDia)}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {dia.categorias.map((c) => (
                          <div key={c.categoria} className="flex justify-between text-[11px] text-[var(--color-text-muted)]">
                            <span>
                              {c.categoria} <span className="text-[10px]">×{c.quantidade}</span>
                            </span>
                            <span className={c.total < 0 ? "text-red-500" : "text-emerald-600"}>{formatarMoeda(c.total)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

```

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx
```
Expected: no type errors; no new ESLint error categories beyond the pre-existing `set-state-in-effect` pattern.

- [ ] **Step 4: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): adicionar resumo diário por categoria"
```

---

### Task 6: Verificação final e atualização da spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-extrato-preview-movimentacao-design.md` (status line only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this is the closing verification task.

- [ ] **Step 1: Full typecheck and lint of the whole project**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx src/lib/preview-movimentacao.ts
```
Expected: no type errors; only the pre-existing `react-hooks/set-state-in-effect` pattern in ESLint output (already present in `/extrato` before this plan and throughout the codebase, e.g. `contas-pagar/page.tsx`), no new error categories.

- [ ] **Step 2: Dev server smoke test — `/extrato` and confirm other routes are unaffected**

Run:
```bash
cd c:/projetos/q-mais-financas
npm run dev
```
In another terminal (adjust port to whatever the dev server log reports):
```bash
curl -s -o /dev/null -w "GET /extrato -> %{http_code}\n" http://localhost:3000/extrato
curl -s -o /dev/null -w "GET /xml-notas -> %{http_code}\n" http://localhost:3000/xml-notas
curl -s -o /dev/null -w "GET /cartoes-teste -> %{http_code}\n" http://localhost:3000/cartoes-teste
curl -s -o /dev/null -w "GET /login -> %{http_code}\n" http://localhost:3000/login
curl -s -o /dev/null -w "GET / -> %{http_code}\n" http://localhost:3000/
```
Expected: all five return `200`, and the dev server log shows no compile/runtime errors for any of the requests. Then stop the dev server.

- [ ] **Step 3: Manual QA checklist (requires a logged-in session with `master` or `funcionario` role and at least one imported `.ofx`)**

Written checklist to follow in the browser — this repo has no component/E2E test harness, so this is the closest equivalent to an integration test:

1. Open `/extrato` → Lançamentos tab. Confirm the category badge on any classified row now shows a real category name (e.g. "Pix Santander"), not a generic one (e.g. "pix recebido").
2. Confirm every classified row shows a small "Entrada" (green) or "Saída" (red) badge above the category badge, and that it matches the sign of the row's Valor column.
3. Pick a "não classificado" (pendente) row: confirm the category `<select>` only lists entrada categories if the value is positive, or only saida categories if negative — never both.
4. Classify one row: confirm the "Ensinar uma regra?" modal still opens as before (unchanged behavior from Fase 1).
5. Go to the Regras tab → "+ Nova regra": confirm the Categoria field is now a `<select>` with "Entrada" and "Saída" `<optgroup>`s populated from the real categories.
6. Back in Lançamentos: confirm the "Resumo diário por categoria" button appears once at least one lançamento is classified, and expands to show days (most recent first) with per-category totals and counts, matching what's visible in the table.
7. Confirm nothing was written to the real `movimentacoes` table (spot-check via Supabase: `select count(*) from movimentacoes` before and after using `/extrato` — count must be unchanged).

- [ ] **Step 4: Confirm no existing file was touched beyond what this plan intended**

Run:
```bash
cd c:/projetos/q-mais-financas
git diff --stat HEAD~6 HEAD
```
Expected: only `src/lib/preview-movimentacao.ts` (new) and `src/app/extrato/page.tsx` (modified) appear — no other file in the diff.

- [ ] **Step 5: Update the spec status and commit**

In `docs/superpowers/specs/2026-08-11-extrato-preview-movimentacao-design.md`, change:

```markdown
Status: aprovado, aguardando implementação.
```

to:

```markdown
Status: implementado.
```

Then:
```bash
cd c:/projetos/q-mais-financas
git add docs/superpowers/specs/2026-08-11-extrato-preview-movimentacao-design.md
git commit -m "docs: marcar spec de prévia de movimentação como implementada"
```
