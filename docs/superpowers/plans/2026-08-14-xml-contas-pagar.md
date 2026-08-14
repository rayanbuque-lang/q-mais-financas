# XML → Contas a Pagar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o elo que falta no fluxo de conciliação — um botão manual em `/xml-notas` que lança em Contas a Pagar uma linha por duplicata de boleto extraída do XML de NF-e já importado, pronta pra ser pega pela baixa automática do extrato (já pronta, não muda nada).

**Architecture:** Duas tabelas novas/alteradas (aditivo, sem quebra), um arquivo de lógica pura de matching (mirror de `src/lib/baixa-contas-pagar.ts`), e extensão de `src/app/xml-notas/page.tsx` com uma aba nova (Regras de fornecedor→categoria) e uma ação em lote (Lançar em Contas a Pagar) com resolução manual de duplicata suspeita.

**Tech Stack:** Next.js 16.2.6 (App Router, client components), Supabase JS v2, TypeScript, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-14-xml-contas-pagar-design.md`

## Global Constraints

- Sem framework de testes automatizado neste repo — validação por leitura cuidadosa de código + SQL real (somente leitura, salvo a migração da Task 1) contra o projeto Supabase `nheyevdjomfphlzmsszk`, usando a ferramenta MCP do Supabase.
- `contas_pagar.fornecedor` é texto livre — nunca criar tabela de fornecedor, nunca tentar "cadastrar" fornecedor.
- Nenhuma mudança em `extrato_regra`, `src/lib/baixa-contas-pagar.ts`, ou qualquer arquivo do cluster do extrato já auditado nesta sessão.
- Toda escrita real (criar/editar/excluir regra, criar conta a pagar) precisa de `registrarLog` (import de `@/lib/audit`), seguindo o padrão já usado em todo o resto do sistema.
- Toda leitura que hoje faz `if (!error && data) set...` sem tratar erro é proibida em código novo — sempre um `else if (error)` mostrando a mensagem via `setMensagem`.
- Nenhum laço de processamento em lote pode abortar tudo por causa de um item ruim — cada item processado no seu próprio try/catch (lição direta da auditoria desta sessão no parser de zip).
- Antes de cada task, ler o arquivo real (`src/app/xml-notas/page.tsx` muda a cada task) — os trechos "código atual" abaixo são um retrato de antes da Task 1; a Task 4 assume que a Task 3 já rodou.

---

### Task 1: Migração de banco

**Files:**
- Nenhum arquivo local — executado via ferramenta MCP `mcp__claude_ai_Supabase__apply_migration` (project_id `nheyevdjomfphlzmsszk`).

**Interfaces:**
- Produz: colunas `xml_duplicata.conta_pagar_id` (uuid, nullable, FK `contas_pagar(id)` ON DELETE SET NULL) e `xml_duplicata.contas_pagar_candidatas` (uuid[], nullable); tabela `xml_regra_fornecedor(id, fornecedor_padrao, categoria_id, ativa, criado_em)` com RLS. Todas as tasks seguintes dependem disso existir.

- [ ] **Step 1: Aplicar a migração**

Chame `mcp__claude_ai_Supabase__apply_migration` com `project_id: "nheyevdjomfphlzmsszk"` e este SQL (dê um `name` descritivo tipo `xml_contas_pagar_schema`):

```sql
alter table xml_duplicata
  add column conta_pagar_id uuid references contas_pagar(id) on delete set null;

alter table xml_duplicata
  add column contas_pagar_candidatas uuid[];

create table xml_regra_fornecedor (
  id uuid primary key default gen_random_uuid(),
  fornecedor_padrao text not null,
  categoria_id uuid not null,
  ativa boolean not null default true,
  criado_em timestamptz not null default now()
);

alter table xml_regra_fornecedor enable row level security;

create policy xml_regra_fornecedor_select on xml_regra_fornecedor
  for select using (auth.uid() is not null);

create policy xml_regra_fornecedor_insert on xml_regra_fornecedor
  for insert with check (is_write_allowed());

create policy xml_regra_fornecedor_update on xml_regra_fornecedor
  for update using (is_write_allowed()) with check (is_write_allowed());

create policy xml_regra_fornecedor_delete on xml_regra_fornecedor
  for delete using (is_write_allowed());
```

- [ ] **Step 2: Verificar por SQL (somente leitura)**

Rode via `mcp__claude_ai_Supabase__execute_sql` (mesmo project_id):

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'xml_duplicata' and column_name in ('conta_pagar_id', 'contas_pagar_candidatas')
order by column_name;
```
Esperado: 2 linhas — `conta_pagar_id` (uuid, YES), `contas_pagar_candidatas` (ARRAY ou `uuid[]`, YES).

```sql
select policyname, cmd from pg_policies where tablename = 'xml_regra_fornecedor' order by cmd;
```
Esperado: 4 linhas (DELETE, INSERT, SELECT, UPDATE).

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'xml_duplicata'::regclass and contype = 'f';
```
Esperado: incluir a nova FK `conta_pagar_id` referenciando `contas_pagar(id)` com `ON DELETE SET NULL`.

- [ ] **Step 3: Commit**

Não há arquivo de código pra commitar nesta task (é só schema remoto). Registre no relatório da task os resultados das 3 queries de verificação — isso substitui o commit.

---

### Task 2: `src/lib/xml-regra-fornecedor.ts` (matching puro)

**Files:**
- Create: `src/lib/xml-regra-fornecedor.ts`

**Interfaces:**
- Consome: `normalizarDescricao` de `@/lib/ofx` (já existe, assinatura `(texto: string) => string`).
- Produz: `RegraFornecedor` (interface), `ContaPagarPendenteParaComparar` (interface), `encontrarCategoriaPorFornecedor(fornecedorNomeXml: string, regras: RegraFornecedor[]): string | null`, `encontrarContasPagarCandidatas(fornecedorNomeXml: string, valorDuplicata: number, contasPendentes: ContaPagarPendenteParaComparar[]): string[]`. Task 4 importa as duas funções e os dois tipos.

- [ ] **Step 1: Escrever o arquivo**

```typescript
// Matching de "fornecedor do XML de NF-e" -- usado tanto pra resolver
// categoria automaticamente (regra fornecedor -> categoria) quanto pra
// detectar se uma duplicata do XML já tem uma conta a pagar parecida
// lançada manualmente antes do XML chegar (nunca decide sozinho um empate,
// só sinaliza -- mesmo espírito de src/lib/baixa-contas-pagar.ts).

import { normalizarDescricao } from "@/lib/ofx";

// Mesmo piso já usado na baixa automática do extrato: abaixo disso o nome
// não é evidência confiável o suficiente pra um match "contém".
export const TAMANHO_MINIMO_FORNECEDOR_XML = 4;

export interface RegraFornecedor {
  id: string;
  fornecedor_padrao: string;
  categoria_id: string;
  ativa: boolean;
}

export interface ContaPagarPendenteParaComparar {
  id: string;
  fornecedor: string;
  valor: number;
}

// Fornecedor do XML (xNome da NF-e) é o nome legal completo -- por isso o
// padrão da regra (tipicamente mais curto, digitado por humano) precisa
// estar CONTIDO no nome do XML, não o contrário.
export function encontrarCategoriaPorFornecedor(fornecedorNomeXml: string, regras: RegraFornecedor[]): string | null {
  const fornecedorNormalizado = normalizarDescricao(fornecedorNomeXml);
  for (const regra of regras) {
    if (!regra.ativa) continue;
    const padraoNormalizado = normalizarDescricao(regra.fornecedor_padrao);
    if (padraoNormalizado.length < TAMANHO_MINIMO_FORNECEDOR_XML) continue;
    if (fornecedorNormalizado.includes(padraoNormalizado)) return regra.categoria_id;
  }
  return null;
}

// Mesmo sentido de comparação: o nome do fornecedor cadastrado manualmente
// na conta a pagar (mais curto) deve estar contido no nome legal do XML.
export function encontrarContasPagarCandidatas(
  fornecedorNomeXml: string,
  valorDuplicata: number,
  contasPendentes: ContaPagarPendenteParaComparar[]
): string[] {
  const fornecedorNormalizado = normalizarDescricao(fornecedorNomeXml);
  return contasPendentes
    .filter((c) => {
      if (c.valor !== valorDuplicata) return false;
      const contaNormalizada = normalizarDescricao(c.fornecedor);
      if (contaNormalizada.length < TAMANHO_MINIMO_FORNECEDOR_XML) return false;
      return fornecedorNormalizado.includes(contaNormalizada);
    })
    .map((c) => c.id);
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erro novo (o arquivo é standalone, não é importado por ninguém ainda nesta task).

- [ ] **Step 3: Validar por raciocínio (sem framework de teste)**

No relatório da task, trace à mão pelo menos estes 3 casos e mostre o resultado esperado vs. o que o código produz:
1. `encontrarCategoriaPorFornecedor("SEVERINI NETTO COMERCIO DE ALIMENTOS LTDA", [{id:"1", fornecedor_padrao:"Severini", categoria_id:"cat-1", ativa:true}])` → `"cat-1"` (contém, normalizado).
2. `encontrarCategoriaPorFornecedor("SEVERINI NETTO COMERCIO DE ALIMENTOS LTDA", [{id:"1", fornecedor_padrao:"jj", categoria_id:"cat-1", ativa:true}])` → `null` (padrão abaixo do piso de 4 caracteres, ignorado mesmo que "bateria" por acidente).
3. `encontrarContasPagarCandidatas("SEVERINI NETTO COMERCIO DE ALIMENTOS LTDA", 500, [{id:"c1", fornecedor:"Severini", valor:500}, {id:"c2", fornecedor:"Severini", valor:600}])` → `["c1"]` (valor tem que bater exato).

- [ ] **Step 4: Commit**

```bash
git add src/lib/xml-regra-fornecedor.ts
git commit -m "feat(xml-notas): matching de fornecedor->categoria e detecção de duplicata"
```

---

### Task 3: Aba "Regras" (CRUD de fornecedor→categoria)

**Files:**
- Modify: `src/app/xml-notas/page.tsx`

**Interfaces:**
- Consome: nada de Task 2 diretamente (essa aba só faz CRUD na tabela `xml_regra_fornecedor`, não usa as funções de matching — quem usa é a Task 4).
- Produz: estado `categoriasSaida`, `regrasFornecedor` (tipo `RegraFornecedor` importado de `@/lib/xml-regra-fornecedor`), funções `carregarCategoriasSaida`, `carregarRegrasFornecedor`, `handleSalvarRegraFornecedor`, `handleAlternarAtivaRegra`, `handleExcluirRegraFornecedor` -- a Task 4 só lê a tabela via query própria, não depende dessas funções, mas depende do `import { registrarLog } from "@/lib/audit";` que esta task adiciona.

**IMPORTANTE:** leia `src/app/xml-notas/page.tsx` real antes de editar — o snapshot abaixo é de antes desta task rodar.

- [ ] **Step 1: Adicionar imports**

No topo do arquivo, depois de `import EmptyState from "@/components/empty-state";`, adicione:

```typescript
import { registrarLog } from "@/lib/audit";
import type { RegraFornecedor } from "@/lib/xml-regra-fornecedor";
```

- [ ] **Step 2: Estender o tipo da aba e adicionar estado novo**

Troque:
```typescript
  const [aba, setAba] = useState<"importar" | "notas">("importar");
```
por:
```typescript
  const [aba, setAba] = useState<"importar" | "notas" | "regras">("importar");
```

Logo depois do bloco `const [notaExpandidaId, setNotaExpandidaId] = useState<string | null>(null);`, adicione:

```typescript
  const [categoriasSaida, setCategoriasSaida] = useState<{ id: string; nome: string }[]>([]);
  const [regrasFornecedor, setRegrasFornecedor] = useState<RegraFornecedor[]>([]);
  const [carregandoRegras, setCarregandoRegras] = useState(false);
  const [editandoRegraId, setEditandoRegraId] = useState<string | null>(null);
  const [formRegraFornecedor, setFormRegraFornecedor] = useState({ fornecedor_padrao: "", categoria_id: "" });
  const [salvandoRegra, setSalvandoRegra] = useState(false);
```

- [ ] **Step 3: Funções de carregamento e CRUD**

Depois da função `carregarNotas` (antes do `useEffect`), adicione:

```typescript
  async function carregarCategoriasSaida() {
    const { data, error } = await supabase.from("categorias_saida").select("id, nome").eq("ativo", true).order("nome");
    if (!error && data) setCategoriasSaida(data as { id: string; nome: string }[]);
    else if (error) setMensagem({ tipo: "erro", texto: "Erro ao carregar categorias: " + error.message });
  }

  async function carregarRegrasFornecedor() {
    setCarregandoRegras(true);
    const { data, error } = await supabase
      .from("xml_regra_fornecedor")
      .select("id, fornecedor_padrao, categoria_id, ativa")
      .order("fornecedor_padrao");
    if (!error && data) setRegrasFornecedor(data as RegraFornecedor[]);
    else if (error) setMensagem({ tipo: "erro", texto: "Erro ao carregar regras: " + error.message });
    setCarregandoRegras(false);
  }

  function iniciarNovaRegra() {
    setEditandoRegraId(null);
    setFormRegraFornecedor({ fornecedor_padrao: "", categoria_id: "" });
  }

  function iniciarEdicaoRegra(r: RegraFornecedor) {
    setEditandoRegraId(r.id);
    setFormRegraFornecedor({ fornecedor_padrao: r.fornecedor_padrao, categoria_id: r.categoria_id });
  }

  async function handleSalvarRegraFornecedor() {
    if (!formRegraFornecedor.fornecedor_padrao.trim() || !formRegraFornecedor.categoria_id) {
      setMensagem({ tipo: "erro", texto: "Informe o fornecedor padrão e a categoria." });
      return;
    }
    setSalvandoRegra(true);
    const payload = {
      fornecedor_padrao: formRegraFornecedor.fornecedor_padrao.trim(),
      categoria_id: formRegraFornecedor.categoria_id,
    };
    const { error } = editandoRegraId
      ? await supabase.from("xml_regra_fornecedor").update(payload).eq("id", editandoRegraId)
      : await supabase.from("xml_regra_fornecedor").insert({ ...payload, ativa: true });
    setSalvandoRegra(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao salvar regra: " + error.message });
      return;
    }
    await registrarLog({
      acao: editandoRegraId ? "editou" : "criou",
      tabela: "xml_regra_fornecedor",
      registroId: editandoRegraId ?? undefined,
      detalhes: payload.fornecedor_padrao,
    });
    setMensagem({ tipo: "sucesso", texto: editandoRegraId ? "Regra atualizada." : "Regra criada." });
    iniciarNovaRegra();
    await carregarRegrasFornecedor();
  }

  async function handleAlternarAtivaRegra(r: RegraFornecedor) {
    const { error } = await supabase.from("xml_regra_fornecedor").update({ ativa: !r.ativa }).eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar regra: " + error.message });
      return;
    }
    await registrarLog({
      acao: "editou",
      tabela: "xml_regra_fornecedor",
      registroId: r.id,
      detalhes: `${r.fornecedor_padrao} -> ${!r.ativa ? "ativada" : "desativada"}`,
    });
    await carregarRegrasFornecedor();
  }

  async function handleExcluirRegraFornecedor(r: RegraFornecedor) {
    if (!confirm(`Excluir a regra de fornecedor "${r.fornecedor_padrao}"?`)) return;
    const { error } = await supabase.from("xml_regra_fornecedor").delete().eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao excluir regra: " + error.message });
      return;
    }
    await registrarLog({ acao: "excluiu", tabela: "xml_regra_fornecedor", registroId: r.id, detalhes: r.fornecedor_padrao });
    await carregarRegrasFornecedor();
  }
```

- [ ] **Step 4: Carregar no mount**

Troque:
```typescript
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarNotas();
  }, []);
```
por:
```typescript
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarNotas();
    carregarCategoriasSaida();
    carregarRegrasFornecedor();
  }, []);
```

- [ ] **Step 5: Aba nova na barra de tabs**

Troque:
```typescript
        {[
          { id: "importar", label: "📥 Importar" },
          { id: "notas", label: "📄 Notas" },
        ].map((t) => (
```
por:
```typescript
        {[
          { id: "importar", label: "📥 Importar" },
          { id: "notas", label: "📄 Notas" },
          { id: "regras", label: "🔧 Regras" },
        ].map((t) => (
```

- [ ] **Step 6: JSX da aba Regras**

Logo depois do bloco `{aba === "notas" && ( ... )}` (antes do `</div>` final que fecha o componente), adicione:

```tsx
      {aba === "regras" && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
            {carregandoRegras ? (
              <div className="skeleton h-40 rounded-xl m-4" />
            ) : regrasFornecedor.length === 0 ? (
              <EmptyState variant="search" title="Nenhuma regra cadastrada" description="Crie uma regra pra categorizar automaticamente." compact />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Fornecedor padrão</th>
                    <th className="px-3 py-2.5 font-semibold">Categoria</th>
                    <th className="px-3 py-2.5 font-semibold text-center">Ativa</th>
                    <th className="px-3 py-2.5 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {regrasFornecedor.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                      <td className="px-3 py-2.5">{r.fornecedor_padrao}</td>
                      <td className="px-3 py-2.5">{categoriasSaida.find((c) => c.id === r.categoria_id)?.nome ?? "—"}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          type="button"
                          disabled={!podeEscrever}
                          onClick={() => handleAlternarAtivaRegra(r)}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border disabled:opacity-50 ${
                            r.ativa ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-500 border-gray-200"
                          }`}
                        >
                          {r.ativa ? "Ativa" : "Inativa"}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {podeEscrever && (
                          <>
                            <button type="button" onClick={() => iniciarEdicaoRegra(r)} className="text-blue-600 hover:underline text-[11px] font-medium mr-2">
                              Editar
                            </button>
                            <button type="button" onClick={() => handleExcluirRegraFornecedor(r)} className="text-red-500 hover:underline text-[11px] font-medium">
                              Excluir
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {podeEscrever && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 h-fit">
              <h3 className="font-semibold text-sm mb-3">{editandoRegraId ? "Editar regra" : "Nova regra"}</h3>

              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Fornecedor padrão</label>
              <input
                type="text"
                value={formRegraFornecedor.fornecedor_padrao}
                onChange={(e) => setFormRegraFornecedor((f) => ({ ...f, fornecedor_padrao: e.target.value }))}
                placeholder="Ex.: Severini"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-3"
              />

              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
              <select
                value={formRegraFornecedor.categoria_id}
                onChange={(e) => setFormRegraFornecedor((f) => ({ ...f, categoria_id: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-4"
              >
                <option value="">selecione...</option>
                {categoriasSaida.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSalvarRegraFornecedor}
                  disabled={salvandoRegra}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
                >
                  {salvandoRegra ? "Salvando..." : editandoRegraId ? "Salvar edição" : "Criar regra"}
                </button>
                {editandoRegraId && (
                  <button type="button" onClick={iniciarNovaRegra} className="px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-semibold">
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 7: Verificar**

Run: `npx tsc --noEmit -p tsconfig.json` — esperado: limpo.
Run: `npx eslint src/app/xml-notas/page.tsx` — esperado: só o `setState`-em-effect pré-existente (já documentado nas rodadas anteriores desta sessão), nenhum erro novo.
Suba `npm run dev`, confira que `/xml-notas` responde 200 e que a aba "🔧 Regras" aparece na barra (curl no HTML não mostra conteúdo client-only, então valide via `tsc`+`eslint` e leitura do JSX; não há ferramenta de browser disponível).

- [ ] **Step 8: Commit**

```bash
git add src/app/xml-notas/page.tsx
git commit -m "feat(xml-notas): aba de regras fornecedor->categoria (CRUD)"
```

---

### Task 4: "Lançar em Contas a Pagar" + resolução de duplicata suspeita

**Files:**
- Modify: `src/app/xml-notas/page.tsx`

**Interfaces:**
- Consome: `encontrarCategoriaPorFornecedor`, `encontrarContasPagarCandidatas` de `@/lib/xml-regra-fornecedor` (Task 2); `registrarLog` de `@/lib/audit` (já importado pela Task 3); colunas `xml_duplicata.conta_pagar_id`/`contas_pagar_candidatas` (Task 1).
- Produz: função `handleLancarContasPagar`, estado de resolução de duplicata suspeita, badges de status na tabela de Notas.

**IMPORTANTE:** leia `src/app/xml-notas/page.tsx` real antes de editar — ele já tem a aba Regras da Task 3.

- [ ] **Step 1: Import**

A Task 3 já deixou esta linha no topo do arquivo:
```typescript
import type { RegraFornecedor } from "@/lib/xml-regra-fornecedor";
```
Troque-a (não adicione uma segunda linha importando do mesmo módulo — duas linhas de import do mesmo módulo no mesmo arquivo é redundante e pode disparar `no-duplicate-imports` do eslint) por:
```typescript
import { encontrarCategoriaPorFornecedor, encontrarContasPagarCandidatas, type RegraFornecedor } from "@/lib/xml-regra-fornecedor";
```

`RegraFornecedor` continua com o mesmo nome — é o mesmo tipo que a Task 3 já usa, só que agora a linha de import também traz as duas funções.

- [ ] **Step 2: Estender a interface `Duplicata`**

Troque:
```typescript
interface Duplicata {
  id: string;
  numero: string | null;
  vencimento: string | null;
  valor: number;
  status: string;
}
```
por:
```typescript
interface Duplicata {
  id: string;
  numero: string | null;
  vencimento: string | null;
  valor: number;
  status: string;
  conta_pagar_id: string | null;
  contas_pagar_candidatas: string[] | null;
}
```

(A query `select("*, xml_duplicata(*)")` já traz essas colunas assim que a Task 1 rodar — nenhuma mudança de query necessária, só o tipo TypeScript.)

- [ ] **Step 3: Estado novo**

Junto dos outros estados (perto de `notaExpandidaId`), adicione:

```typescript
  const [lancando, setLancando] = useState(false);
  const [resolvendoSuspeita, setResolvendoSuspeita] = useState<{
    duplicata: Duplicata;
    nota: Nota;
    candidatas: { id: string; fornecedor: string; valor: number; data_vencimento: string; status: string }[];
  } | null>(null);
  const [resolvendoAcao, setResolvendoAcao] = useState(false);
```

- [ ] **Step 4: `handleLancarContasPagar`**

Depois de `handleImportar`, adicione:

```typescript
  async function handleLancarContasPagar() {
    if (!podeEscrever) return;
    setLancando(true);
    setMensagem(null);

    try {
      const candidatas: { duplicata: Duplicata; nota: Nota }[] = [];
      let semBoleto = 0;
      for (const nota of notas) {
        if (nota.xml_duplicata.length === 0) {
          semBoleto++;
          continue;
        }
        for (const d of nota.xml_duplicata) {
          if (d.status === "candidata") candidatas.push({ duplicata: d, nota });
        }
      }

      if (candidatas.length === 0) {
        setMensagem({
          tipo: "sucesso",
          texto:
            semBoleto > 0
              ? `Nada pra lançar agora. ${semBoleto} nota(s) sem boleto no XML precisam ser lançadas manualmente.`
              : "Nada pendente pra lançar.",
        });
        return;
      }

      const [{ data: pendentes, error: erroPendentes }, { data: regras, error: erroRegras }] = await Promise.all([
        supabase.from("contas_pagar").select("id, fornecedor, valor").eq("status", "pendente").limit(5000),
        supabase.from("xml_regra_fornecedor").select("id, fornecedor_padrao, categoria_id, ativa").eq("ativa", true),
      ]);
      if (erroPendentes || erroRegras) {
        setMensagem({ tipo: "erro", texto: "Erro ao carregar dados pra lançamento: " + (erroPendentes?.message ?? erroRegras?.message ?? "") });
        return;
      }
      const contasPendentes = (pendentes ?? []) as { id: string; fornecedor: string; valor: number }[];
      const regrasAtivas = (regras ?? []) as RegraFornecedor[];

      let criadas = 0;
      let suspeitas = 0;
      let falharam = 0;

      for (const { duplicata, nota } of candidatas) {
        try {
          const candidatosIds = encontrarContasPagarCandidatas(nota.fornecedor_nome ?? "", duplicata.valor, contasPendentes);

          if (candidatosIds.length > 0) {
            const { error } = await supabase
              .from("xml_duplicata")
              .update({ status: "duplicata_suspeita", contas_pagar_candidatas: candidatosIds })
              .eq("id", duplicata.id)
              .eq("status", "candidata");
            if (error) throw new Error(error.message);
            suspeitas++;
            continue;
          }

          const categoriaId = encontrarCategoriaPorFornecedor(nota.fornecedor_nome ?? "", regrasAtivas);

          const { data: contaCriada, error: erroConta } = await supabase
            .from("contas_pagar")
            .insert({
              fornecedor: nota.fornecedor_nome ?? "(sem nome no XML)",
              descricao: `NF-e ${nota.numero_nota ?? "?"} - parcela ${duplicata.numero ?? "(sem número)"}`,
              valor: duplicata.valor,
              data_vencimento: duplicata.vencimento,
              status: "pendente",
              categoria_id: categoriaId,
              observacao: `Gerado a partir do XML da NF-e (chave ${nota.chave_acesso})`,
            })
            .select("id")
            .single();
          if (erroConta || !contaCriada) throw new Error(erroConta?.message ?? "Erro ao criar conta a pagar.");

          // Claim-then-write: condicional a status ainda ser "candidata" --
          // se 0 linhas mudarem, outra aba já processou esta duplicata entre
          // a leitura e agora, e a conta que acabamos de criar ficaria órfã.
          const { data: linhasAtualizadas, error: erroVinculo } = await supabase
            .from("xml_duplicata")
            .update({ status: "lancada", conta_pagar_id: contaCriada.id })
            .eq("id", duplicata.id)
            .eq("status", "candidata")
            .select("id");
          if (erroVinculo) throw new Error(erroVinculo.message);

          if (!linhasAtualizadas || linhasAtualizadas.length === 0) {
            const { error: erroExclusao } = await supabase.from("contas_pagar").delete().eq("id", contaCriada.id);
            if (erroExclusao) {
              await registrarLog({
                acao: "excluiu",
                tabela: "contas_pagar",
                registroId: contaCriada.id,
                detalhes: `Falha ao desfazer conta a pagar órfã (perdeu corrida de vínculo com xml_duplicata ${duplicata.id}): ${erroExclusao.message}`,
              });
            }
            falharam++;
            continue;
          }

          await registrarLog({
            acao: "criou",
            tabela: "contas_pagar",
            registroId: contaCriada.id,
            detalhes: `${nota.fornecedor_nome ?? "?"} - ${formatarMoeda(duplicata.valor)} gerado a partir do XML da NF-e ${nota.numero_nota ?? "?"}`,
          });
          criadas++;
        } catch {
          falharam++;
        }
      }

      const partes: string[] = [];
      if (criadas > 0) partes.push(`${criadas} conta(s) a pagar criada(s)`);
      if (suspeitas > 0) partes.push(`${suspeitas} possível(is) duplicata(s) (revisar na tabela)`);
      if (semBoleto > 0) partes.push(`${semBoleto} nota(s) sem boleto no XML (lançar manualmente)`);
      if (falharam > 0) partes.push(`${falharam} erro(s) ao lançar`);

      setMensagem({
        tipo: falharam > 0 ? "erro" : "sucesso",
        texto: partes.length > 0 ? partes.join(" · ") : "Nada pendente pra lançar.",
      });
      await carregarNotas();
    } finally {
      setLancando(false);
    }
  }
```

- [ ] **Step 5: Resolução de duplicata suspeita**

Logo depois de `handleLancarContasPagar`, adicione:

```typescript
  async function handleAbrirResolucaoSuspeita(nota: Nota, duplicata: Duplicata) {
    if (!duplicata.contas_pagar_candidatas || duplicata.contas_pagar_candidatas.length === 0) return;
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_vencimento, status")
      .in("id", duplicata.contas_pagar_candidatas);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas candidatas: " + (error?.message ?? "") });
      return;
    }
    setResolvendoSuspeita({ duplicata, nota, candidatas: data as { id: string; fornecedor: string; valor: number; data_vencimento: string; status: string }[] });
  }

  function fecharResolucaoSuspeita() {
    if (resolvendoAcao) return;
    setResolvendoSuspeita(null);
  }

  async function handleNaoEDuplicata() {
    if (!resolvendoSuspeita) return;
    setResolvendoAcao(true);
    const { duplicata } = resolvendoSuspeita;
    const { error } = await supabase
      .from("xml_duplicata")
      .update({ status: "candidata", contas_pagar_candidatas: null })
      .eq("id", duplicata.id)
      .eq("status", "duplicata_suspeita");
    setResolvendoAcao(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar: " + error.message });
      return;
    }
    setResolvendoSuspeita(null);
    await carregarNotas();
    setMensagem({ tipo: "sucesso", texto: 'Marcado pra lançar -- clique em "Lançar em Contas a Pagar" de novo pra criar a conta.' });
  }

  async function handleEDuplicataConfirmada() {
    if (!resolvendoSuspeita) return;
    setResolvendoAcao(true);
    const { duplicata } = resolvendoSuspeita;
    const { error } = await supabase
      .from("xml_duplicata")
      .update({ status: "duplicata_confirmada" })
      .eq("id", duplicata.id)
      .eq("status", "duplicata_suspeita");
    setResolvendoAcao(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar: " + error.message });
      return;
    }
    setResolvendoSuspeita(null);
    await carregarNotas();
  }
```

- [ ] **Step 6: Botão "Lançar em Contas a Pagar" + badge de "sem boleto"**

Na aba Notas, dentro do bloco `{aba === "notas" && ( <div> ... )}`, logo depois da abertura `<div>` e antes do `{carregandoNotas ? (`, adicione o botão (só quando há notas e o usuário pode escrever):

```tsx
          {podeEscrever && notas.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                onClick={handleLancarContasPagar}
                disabled={lancando}
                className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                {lancando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                {lancando ? "Lançando..." : "Lançar em Contas a Pagar"}
              </button>
            </div>
          )}
```

- [ ] **Step 7: Badge "sem boleto" na linha da nota**

Na célula "Vencimento(s)" (última coluna da tabela de notas), troque o ramo `else` (quando `n.xml_duplicata.length === 0`) de:
```tsx
                          ) : (
                            <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                          )}
```
por:
```tsx
                          ) : (
                            <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap">
                              sem boleto no XML — lançar manualmente
                            </span>
                          )}
```

- [ ] **Step 8: Badges de status por duplicata na tabela expandida**

No detalhe expandido (tabela interna com colunas Parcela/Vencimento/Valor/Status), troque a célula de status de:
```tsx
                                      <td className="py-0.5 pl-3">
                                        <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px]">{d.status}</span>
                                      </td>
```
por:
```tsx
                                      <td className="py-0.5 pl-3">
                                        {d.status === "lancada" ? (
                                          <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">lançada</span>
                                        ) : d.status === "duplicata_suspeita" ? (
                                          <button
                                            type="button"
                                            onClick={() => handleAbrirResolucaoSuspeita(n, d)}
                                            className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold"
                                          >
                                            possível duplicata — revisar
                                          </button>
                                        ) : d.status === "duplicata_confirmada" ? (
                                          <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200 text-[10px]">duplicata (não lançada)</span>
                                        ) : (
                                          <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px]">pendente de lançar</span>
                                        )}
                                      </td>
```

- [ ] **Step 9: Modal de resolução**

Logo antes do `</div>` final que fecha o componente (depois do bloco da aba Regras da Task 3), adicione:

```tsx
      {resolvendoSuspeita && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => fecharResolucaoSuspeita()}>
          <div className="bg-[var(--color-surface)] rounded-2xl p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-sm mb-1">Possível duplicata</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Já existe conta a pagar pendente parecida com esta parcela do XML. É a mesma conta, ou são coisas diferentes?
            </p>

            <div className="mb-3 p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
              <p className="font-semibold mb-1">Do XML:</p>
              <p>{resolvendoSuspeita.nota.fornecedor_nome ?? "—"} · {formatarMoeda(resolvendoSuspeita.duplicata.valor)} · vence {formatarData(resolvendoSuspeita.duplicata.vencimento)}</p>
            </div>

            <div className="mb-4 space-y-2">
              <p className="text-xs font-semibold">Já cadastrado(s):</p>
              {resolvendoSuspeita.candidatas.map((c) => (
                <div key={c.id} className="p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
                  {c.fornecedor} · {formatarMoeda(c.valor)} · vence {formatarData(c.data_vencimento)} · {c.status}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleEDuplicataConfirmada}
                disabled={resolvendoAcao}
                className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-semibold disabled:opacity-50"
              >
                É duplicata — não lançar
              </button>
              <button
                type="button"
                onClick={handleNaoEDuplicata}
                disabled={resolvendoAcao}
                className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                Não é — lançar mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 10: Verificar**

Run: `npx tsc --noEmit -p tsconfig.json` — esperado: limpo.
Run: `npx eslint src/app/xml-notas/page.tsx` — esperado: só o `setState`-em-effect pré-existente, nenhum erro novo.
Suba `npm run dev`, confirme `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/xml-notas` → 200.

Valide por SQL real (somente leitura) que o comportamento bate com o esperado — pelo menos:
```sql
-- confirma que nenhuma conta_pagar órfã ficou sem vínculo depois de um teste manual
select cp.id, cp.fornecedor, cp.valor, xd.id as xml_duplicata_id
from contas_pagar cp
left join xml_duplicata xd on xd.conta_pagar_id = cp.id
where cp.observacao like 'Gerado a partir do XML%' and xd.id is null;
```
Esperado: 0 linhas (toda conta criada por este fluxo tem que ter uma duplicata apontando de volta pra ela).

- [ ] **Step 11: Commit**

```bash
git add src/app/xml-notas/page.tsx
git commit -m "feat(xml-notas): lança contas a pagar a partir das duplicatas do XML"
```
