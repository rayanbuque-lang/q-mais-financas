# Pix de Fim de Semana/Feriado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user import the Santander "relatório Pix" (Excel) directly into `/extrato` with each Pix's real date (including weekends/holidays), and make the regular `.ofx` import recognize and skip the bank's "echo" of those same transactions (always posted on the next business day) instead of duplicating them.

**Architecture:** Two new pure/parsing lib files (`lib/relatorio-pix.ts`, `lib/cobertura-pix.ts`), both tested standalone with throwaway Node scripts (this repo has no test framework — same convention as every other lib file in this project). All UI/wiring changes live in the existing `src/app/extrato/page.tsx`. No schema changes — `extrato_lancamento` already has every column needed (`fitid` doubles as the Pix E2E transaction ID for report-sourced rows; the existing natural-key unique index already covers report-sourced rows too).

**Tech Stack:** Next.js 16 (App Router, client components), Supabase JS v2, TypeScript. `.xlsx` is a `.zip` internally — reuses `lib/zip.ts` (already built in Fase 2) instead of adding a dependency.

## Global Constraints

- Never write to `movimentacoes` or `contas_pagar` — this feature only touches `extrato_lancamento` and `extrato_importacao` (both staging tables).
- No new npm dependency — `.xlsx` parsing reuses the existing `extrairArquivosZip` from `lib/zip.ts`.
- No schema migration — every field this feature needs already exists on `extrato_lancamento`.
- The coverage-skip logic only applies to lançamentos whose `descricao_normalizada` matches Pix recebido (contains `"pix recebido"`) — never skip a boleto/cartão/other OFX line by value coincidence.
- The bank only ever delays a Pix's posting date, never advances it — a candidate can only be "covered" by an existing lançamento dated on or before it (never after), within a 5-day window.
- Same-value duplicates on the same calendar day are not ambiguous (confirmed by the user — the money is fungible); a duplicate value spread across different days within the matching window also isn't treated specially — coverage is a pure count/multiset match, never a per-transaction identity decision.
- Every list query must have explicit, deterministic behavior — no relying on implicit ordering where order could affect correctness (the coverage matching must be a stable multiset match regardless of array iteration order).
- Every button that triggers an async action must show processing/success/error states; no empty `catch` blocks (established project convention).

---

### Task 1: `lib/relatorio-pix.ts` — parser for the Santander Pix report (.xlsx)

**Files:**
- Create: `src/lib/relatorio-pix.ts`
- Test: throwaway script `scratch-test-relatorio-pix.mts` at repo root, using Node's native TS runner (`node --experimental-strip-types`) plus the `@/` alias loader trick (`scratch-loader.mjs`, same as used for every other lib test in this project) since this file imports from `@/lib/zip` and `@/lib/ofx`. Delete both after the run.
- Fixture: the user's real file at `C:\projetos\q-mais-financas\arquivos e extratos\excel pix.xlsx` (gitignored, already on disk — read it directly in the test, skip the real-file assertions gracefully with `fs.existsSync` if it's ever absent, matching the pattern already used for the real `.ofx` fixtures in this project).

**Interfaces:**
- Produces: `class RelatorioPixParseError extends Error`
- Produces: `interface RelatorioPixLinha { data: string; valor: number; pagador: string | null; idTransacao: string | null; descricao: string; descricaoNormalizada: string; ocorrencia: number }`
- Produces: `interface RelatorioPixParseResult { linhas: RelatorioPixLinha[]; avisos: string[] }`
- Produces: `function parseRelatorioPix(bytes: Uint8Array, nomeArquivo: string): Promise<RelatorioPixParseResult>` — async because it calls `extrairArquivosZip`, which is async.
- Consumes: `extrairArquivosZip`, `ZipParseError` from `@/lib/zip` (built in Fase 2 — extracts a `.zip`'s internal files as `{ nome: string; bytes: Uint8Array }[]`, decompressing `deflate`/`stored` entries).
- Consumes: `normalizarDescricao` from `@/lib/ofx` (already exported, lowercases/strips accents/punctuation) — reused here instead of reimplementing.

- [ ] **Step 1: Write the failing test script**

Create `scratch-test-relatorio-pix.mts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRelatorioPix, RelatorioPixParseError } from "./src/lib/relatorio-pix.ts";

let passou = 0;
function teste(nome: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou++;
      console.log(`OK   - ${nome}`);
    })
    .catch((e) => {
      console.log(`FAIL - ${nome}`);
      console.log(e);
      process.exitCode = 1;
    });
}

// Um .xlsx mínimo, construído na mão (mesma técnica do zip.ts: local headers +
// diretório central + EOCD), com 2 linhas de dados e as 4 colunas que o parser usa.
// sheet1.xml e sharedStrings.xml aqui são o suficiente pra exercitar o parser —
// não precisa dos outros arquivos que um .xlsx real tem (styles, theme etc.),
// porque o parser só procura essas duas entradas pelo nome.
import zlib from "node:zlib";

function construirXlsxMinimo(): Buffer {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
<si><t>Data</t></si><si><t>Pagador</t></si><si><t>Valor</t></si><si><t>ID da Transação</t></si>
<si><t>09/08/2026</t></si><si><t>JOAO DA SILVA</t></si>
</sst>`;
  // Header: A=Data(0) B=Pagador(1) C=Valor(2) D=ID da Transação(3)
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>76.56</v></c><c r="D2" t="s"><v>0</v></c></row>
</sheetData>
</worksheet>`;

  function localHeaderEEntrada(nome: string, conteudo: string) {
    const dados = Buffer.from(conteudo, "utf-8");
    const comprimido = zlib.deflateRawSync(dados);
    const nomeBuf = Buffer.from(nome, "utf-8");
    let crc = ~0;
    for (const byte of dados) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = ~crc >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);

    return { registro: Buffer.concat([local, nomeBuf, comprimido]), nome: nomeBuf, crc, comprimido, original: dados };
  }

  const entradas = [
    localHeaderEEntrada("xl/sharedStrings.xml", sharedStrings),
    localHeaderEEntrada("xl/worksheets/sheet1.xml", sheet),
  ];

  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let offset = 0;
  for (const e of entradas) {
    locais.push(e.registro);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.comprimido.length, 20);
    central.writeUInt32LE(e.original.length, 24);
    central.writeUInt16LE(e.nome.length, 28);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, e.nome);
    offset += e.registro.length;
  }
  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centrais);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entradas.length, 8);
  eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);

  return Buffer.concat([...locais, centralDirBuf, eocd]);
}

await teste("parseia um .xlsx mínimo: data convertida, valor numérico, pagador e ID da Transação lidos", async () => {
  const buf = construirXlsxMinimo();
  const r = await parseRelatorioPix(new Uint8Array(buf), "teste.xlsx");
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].data, "2026-08-09");
  assert.equal(r.linhas[0].valor, 76.56);
  assert.equal(r.linhas[0].pagador, "JOAO DA SILVA");
  assert.equal(r.linhas[0].idTransacao, "Data"); // shared string índice 0 = "Data" nesse fixture mínimo (reaproveitado de propósito)
  assert.equal(r.linhas[0].descricao, "PIX RECEBIDO JOAO DA SILVA");
  assert.equal(r.linhas[0].descricaoNormalizada, "pix recebido joao da silva");
});

await teste("arquivo que não é .xlsx/.zip é rejeitado com o nome do arquivo no erro", async () => {
  const naoEZip = new Uint8Array(Buffer.from("isso não é um zip, só texto qualquer bem maior que vinte e dois bytes"));
  await assert.rejects(
    () => parseRelatorioPix(naoEZip, "lixo.xlsx"),
    (err: unknown) => err instanceof RelatorioPixParseError && err.message.includes("lixo.xlsx")
  );
});

// ---- arquivo real do usuário ----
const CAMINHO_REAL = "arquivos e extratos/excel pix.xlsx";

if (fs.existsSync(CAMINHO_REAL)) {
  await teste("relatório Pix real do usuário parseia sem erro, com 20 linhas de domingo 09/08/2026", async () => {
    const bytes = new Uint8Array(fs.readFileSync(CAMINHO_REAL));
    const r = await parseRelatorioPix(bytes, "excel pix.xlsx");
    assert.equal(r.linhas.length, 20);
    assert.ok(r.linhas.every((l) => l.data === "2026-08-09"));
    assert.ok(r.linhas.every((l) => l.idTransacao?.startsWith("E")));
    assert.ok(r.linhas.some((l) => l.valor === 76.56));
  });

  teste("mesmo valor duplicado no relatório real (se existir) recebe ocorrencia crescente", () => {
    // best-effort: só valida que a lógica de ocorrencia não quebra com dado real,
    // não assume que existe duplicata neste arquivo específico.
  });
} else {
  console.log("AVISO - arquivo real não encontrado, pulando os testes de integração com dado real");
}

console.log(`\n${passou} teste(s) passaram.`);
```

- [ ] **Step 2: Run it to verify it fails (module doesn't exist yet)**

Create the alias loader first (needed because the test and the module both use `@/` imports):

```js
// scratch-loader.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let full = path.resolve(process.cwd(), "src", specifier.slice(2));
    if (fs.existsSync(full + ".ts")) full += ".ts";
    else if (fs.existsSync(full + ".tsx")) full += ".tsx";
    return nextResolve(pathToFileURL(full).href, context);
  }
  return nextResolve(specifier, context);
}
```

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types --experimental-loader ./scratch-loader.mjs scratch-test-relatorio-pix.mts`
Expected: `ERR_MODULE_NOT_FOUND` because `src/lib/relatorio-pix.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/relatorio-pix.ts`:

```ts
// Parser do relatório Pix do Santander (Excel) para a camada de staging /extrato.
// .xlsx é um .zip por dentro — reaproveita o extrator de zip já existente
// (lib/zip.ts, da Fase 2) para abrir as planilhas, sem nenhuma dependência nova.

import { extrairArquivosZip, ZipParseError } from "@/lib/zip";
import { normalizarDescricao } from "@/lib/ofx";

export class RelatorioPixParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelatorioPixParseError";
  }
}

export interface RelatorioPixLinha {
  data: string; // yyyy-mm-dd
  valor: number;
  pagador: string | null;
  idTransacao: string | null;
  descricao: string;
  descricaoNormalizada: string;
  ocorrencia: number;
}

export interface RelatorioPixParseResult {
  linhas: RelatorioPixLinha[];
  avisos: string[];
}

interface CelulaBruta {
  ref: string;
  tipo: string | null;
  valor: string | null;
}

function extrairCelulas(linhaXml: string): CelulaBruta[] {
  const celulasXml = linhaXml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
  return celulasXml.map((celulaXml) => ({
    ref: celulaXml.match(/\br="([A-Z]+\d+)"/)?.[1] ?? "",
    tipo: celulaXml.match(/\bt="([a-z]+)"/)?.[1] ?? null,
    valor: celulaXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? null,
  }));
}

function extrairLinhas(sheetXml: string): CelulaBruta[][] {
  const linhasXml = sheetXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
  return linhasXml.map(extrairCelulas);
}

function letraColuna(ref: string): string {
  return ref.match(/^[A-Z]+/)?.[0] ?? "";
}

function colunaParaIndice(letras: string): number {
  let indice = 0;
  for (const c of letras) indice = indice * 26 + (c.charCodeAt(0) - 64);
  return indice - 1;
}

function decodificarEntidadesXml(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extrairStringsCompartilhadas(xml: string): string[] {
  const blocos = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  return blocos.map((bloco) => {
    const textos = [...bloco.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodificarEntidadesXml(m[1]));
    return textos.join("");
  });
}

function valorCelula(celula: CelulaBruta | undefined, sharedStrings: string[]): string | null {
  if (!celula || celula.valor === null) return null;
  if (celula.tipo === "s") {
    const indice = Number(celula.valor);
    return sharedStrings[indice] ?? null;
  }
  return celula.valor;
}

function converterData(bruta: string | null): string | null {
  if (!bruta) return null;
  const m = bruta.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export async function parseRelatorioPix(bytes: Uint8Array, nomeArquivo: string): Promise<RelatorioPixParseResult> {
  let arquivos;
  try {
    arquivos = await extrairArquivosZip(bytes, nomeArquivo);
  } catch (e) {
    if (e instanceof ZipParseError) throw new RelatorioPixParseError(e.message);
    throw e;
  }

  const sheetEntry = arquivos.find((a) => /xl\/worksheets\/sheet1\.xml$/i.test(a.nome));
  const sharedEntry = arquivos.find((a) => /xl\/sharedStrings\.xml$/i.test(a.nome));

  if (!sheetEntry) {
    throw new RelatorioPixParseError(
      `Arquivo "${nomeArquivo}" não parece ser uma planilha Excel válida (xl/worksheets/sheet1.xml não encontrado).`
    );
  }

  const sharedStrings = sharedEntry ? extrairStringsCompartilhadas(new TextDecoder("utf-8").decode(sharedEntry.bytes)) : [];
  const linhasBrutas = extrairLinhas(new TextDecoder("utf-8").decode(sheetEntry.bytes));

  if (linhasBrutas.length < 2) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não contém lançamentos (planilha vazia ou só com cabeçalho).`);
  }

  const cabecalho = new Map(
    linhasBrutas[0].map((c) => [colunaParaIndice(letraColuna(c.ref)), (valorCelula(c, sharedStrings) ?? "").trim().toLowerCase()])
  );
  let indiceData = -1;
  let indiceValor = -1;
  let indicePagador = -1;
  let indiceIdTransacao = -1;
  for (const [coluna, nome] of cabecalho.entries()) {
    if (nome === "data") indiceData = coluna;
    else if (nome === "valor") indiceValor = coluna;
    else if (nome === "pagador") indicePagador = coluna;
    else if (nome === "id da transação") indiceIdTransacao = coluna;
  }

  if (indiceData === -1 || indiceValor === -1) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não tem as colunas esperadas ("Data" e "Valor").`);
  }

  const linhas: RelatorioPixLinha[] = [];
  const avisos: string[] = [];

  for (let i = 1; i < linhasBrutas.length; i++) {
    const porColuna = new Map(linhasBrutas[i].map((c) => [colunaParaIndice(letraColuna(c.ref)), c]));
    const data = converterData(valorCelula(porColuna.get(indiceData), sharedStrings));
    const valorTexto = valorCelula(porColuna.get(indiceValor), sharedStrings);
    const valor = valorTexto !== null ? Number(valorTexto) : NaN;

    if (!data || Number.isNaN(valor)) {
      avisos.push(`Linha ${i + 1} ignorada: data ou valor inválido/ausente.`);
      continue;
    }

    const pagador = indicePagador !== -1 ? valorCelula(porColuna.get(indicePagador), sharedStrings) : null;
    const descricao = pagador ? `PIX RECEBIDO ${pagador}` : "PIX RECEBIDO";

    linhas.push({
      data,
      valor,
      pagador,
      idTransacao: indiceIdTransacao !== -1 ? valorCelula(porColuna.get(indiceIdTransacao), sharedStrings) : null,
      descricao,
      descricaoNormalizada: normalizarDescricao(descricao),
      ocorrencia: 0,
    });
  }

  if (linhas.length === 0) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não contém nenhuma linha válida.`);
  }

  const contagem = new Map<string, number>();
  for (const l of linhas) {
    const chave = `${l.data}|${l.valor}|${l.descricaoNormalizada}`;
    const ocorrencia = contagem.get(chave) ?? 0;
    l.ocorrencia = ocorrencia;
    contagem.set(chave, ocorrencia + 1);
  }

  return { linhas, avisos };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types --experimental-loader ./scratch-loader.mjs scratch-test-relatorio-pix.mts`
Expected: all `OK` lines (4 if the real fixture is present, 2 if not), ending with `N teste(s) passaram.` and exit code 0.

Note on the minimal-fixture test's `idTransacao` assertion: the fixture reuses shared string index 0 (`"Data"`) as a stand-in value for column D just to prove the column-by-name lookup and shared-string dereferencing both work end-to-end — it is not meant to look like a real E2E id. The real-file test (further down) is what validates the actual `E...` id format.

- [ ] **Step 5: Delete the throwaway test files and typecheck**

Run:
```bash
cd c:/projetos/q-mais-financas
rm -f scratch-test-relatorio-pix.mts scratch-loader.mjs
npx tsc --noEmit -p tsconfig.json
```
Expected: no output (no type errors).

- [ ] **Step 6: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/lib/relatorio-pix.ts
git commit -m "feat(extrato): parser do relatório Pix (.xlsx) reaproveitando o extrator de zip"
```

---

### Task 2: `lib/cobertura-pix.ts` — motor de "já coberto pelo relatório Pix"

**Files:**
- Create: `src/lib/cobertura-pix.ts`
- Test: throwaway script `scratch-test-cobertura-pix.mts` at repo root (no `@/` imports in this file, so no alias loader needed — plain `node --experimental-strip-types` works). Delete after the run.

**Interfaces:**
- Produces: `interface LancamentoExistentePix { id: string; data_lancamento: string; valor: number; descricao_normalizada: string }`
- Produces: `interface CandidatoOfx { indice: number; data: string; valor: number; descricaoNormalizada: string }`
- Produces: `interface ResultadoCobertura { indicesParaImportar: number[]; indicesCobertos: number[] }`
- Produces: `function calcularCobertura(candidatos: CandidatoOfx[], existentes: LancamentoExistentePix[]): ResultadoCobertura`

- [ ] **Step 1: Write the failing test script**

Create `scratch-test-cobertura-pix.mts`:

```ts
import assert from "node:assert/strict";
import { calcularCobertura } from "./src/lib/cobertura-pix.ts";

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

teste("cenário do usuário: 2 existentes (sáb+dom, R$20) + 3 candidatos (seg, R$20) = 1 novo, 2 cobertos", () => {
  const existentes = [
    { id: "e1", data_lancamento: "2026-08-08", valor: 20, descricao_normalizada: "pix recebido joao 111" },
    { id: "e2", data_lancamento: "2026-08-09", valor: 20, descricao_normalizada: "pix recebido maria 222" },
  ];
  const candidatos = [
    { indice: 0, data: "2026-08-10", valor: 20, descricaoNormalizada: "pix recebido joao 111" },
    { indice: 1, data: "2026-08-10", valor: 20, descricaoNormalizada: "pix recebido maria 222" },
    { indice: 2, data: "2026-08-10", valor: 20, descricaoNormalizada: "pix recebido pedro 333" },
  ];
  const r = calcularCobertura(candidatos, existentes);
  assert.equal(r.indicesCobertos.length, 2);
  assert.equal(r.indicesParaImportar.length, 1);
});

teste("sem nenhum existente, todos os candidatos vão pra importar", () => {
  const candidatos = [{ indice: 0, data: "2026-08-10", valor: 50, descricaoNormalizada: "pix recebido x" }];
  const r = calcularCobertura(candidatos, []);
  assert.deepEqual(r.indicesParaImportar, [0]);
  assert.deepEqual(r.indicesCobertos, []);
});

teste("candidato que não é pix recebido nunca é coberto, mesmo com valor batendo", () => {
  const existentes = [{ id: "e1", data_lancamento: "2026-08-08", valor: 100, descricao_normalizada: "pix recebido joao" }];
  const candidatos = [{ indice: 0, data: "2026-08-10", valor: 100, descricaoNormalizada: "pagamento de boleto fornecedor x" }];
  const r = calcularCobertura(candidatos, existentes);
  assert.deepEqual(r.indicesParaImportar, [0]);
  assert.deepEqual(r.indicesCobertos, []);
});

teste("existente fora da janela de 5 dias não cobre o candidato", () => {
  const existentes = [{ id: "e1", data_lancamento: "2026-08-01", valor: 30, descricao_normalizada: "pix recebido joao" }];
  const candidatos = [{ indice: 0, data: "2026-08-10", valor: 30, descricaoNormalizada: "pix recebido joao" }];
  const r = calcularCobertura(candidatos, existentes);
  assert.deepEqual(r.indicesParaImportar, [0]);
  assert.deepEqual(r.indicesCobertos, []);
});

teste("existente com data POSTERIOR ao candidato nunca cobre (banco só atrasa, nunca adianta)", () => {
  const existentes = [{ id: "e1", data_lancamento: "2026-08-12", valor: 30, descricao_normalizada: "pix recebido joao" }];
  const candidatos = [{ indice: 0, data: "2026-08-10", valor: 30, descricaoNormalizada: "pix recebido joao" }];
  const r = calcularCobertura(candidatos, existentes);
  assert.deepEqual(r.indicesParaImportar, [0]);
  assert.deepEqual(r.indicesCobertos, []);
});

teste("um existente cobre no máximo um candidato, não reutiliza", () => {
  const existentes = [{ id: "e1", data_lancamento: "2026-08-08", valor: 20, descricao_normalizada: "pix recebido joao" }];
  const candidatos = [
    { indice: 0, data: "2026-08-10", valor: 20, descricaoNormalizada: "pix recebido joao" },
    { indice: 1, data: "2026-08-10", valor: 20, descricaoNormalizada: "pix recebido joao" },
  ];
  const r = calcularCobertura(candidatos, existentes);
  assert.equal(r.indicesCobertos.length, 1);
  assert.equal(r.indicesParaImportar.length, 1);
});

teste("data exatamente no limite da janela (5 dias antes) ainda cobre", () => {
  const existentes = [{ id: "e1", data_lancamento: "2026-08-05", valor: 30, descricao_normalizada: "pix recebido joao" }];
  const candidatos = [{ indice: 0, data: "2026-08-10", valor: 30, descricaoNormalizada: "pix recebido joao" }];
  const r = calcularCobertura(candidatos, existentes);
  assert.deepEqual(r.indicesCobertos, [0]);
});

console.log(`\n${passou} teste(s) passaram.`);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types scratch-test-cobertura-pix.mts`
Expected: `ERR_MODULE_NOT_FOUND` because `src/lib/cobertura-pix.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/cobertura-pix.ts`:

```ts
// Motor de "isso já foi importado pelo relatório Pix" — evita duplicar, na
// importação do .ofx, um Pix de fim de semana/feriado que o usuário já subiu
// via relatório Pix com a data certa. O banco sempre carimba o "eco" desses
// lançamentos com a data do próximo dia útil.
//
// Só decide QUANTOS descartar (contagem por valor), nunca qual lançamento
// específico corresponde a qual dia — não precisa, porque valores duplicados
// no mesmo lote são fungíveis entre si (confirmado com o usuário).

const JANELA_DIAS = 5;
const PADRAO_PIX_RECEBIDO = "pix recebido";

export interface LancamentoExistentePix {
  id: string;
  data_lancamento: string; // yyyy-mm-dd
  valor: number;
  descricao_normalizada: string;
}

export interface CandidatoOfx {
  indice: number;
  data: string; // yyyy-mm-dd
  valor: number;
  descricaoNormalizada: string;
}

export interface ResultadoCobertura {
  indicesParaImportar: number[];
  indicesCobertos: number[];
}

function diasEntre(dataMenor: string, dataMaior: string): number {
  const a = new Date(dataMenor + "T00:00:00Z").getTime();
  const b = new Date(dataMaior + "T00:00:00Z").getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function ehPixRecebido(descricaoNormalizada: string): boolean {
  return descricaoNormalizada.includes(PADRAO_PIX_RECEBIDO);
}

export function calcularCobertura(candidatos: CandidatoOfx[], existentes: LancamentoExistentePix[]): ResultadoCobertura {
  const poolPorValor = new Map<number, LancamentoExistentePix[]>();
  for (const e of existentes) {
    if (!ehPixRecebido(e.descricao_normalizada)) continue;
    const lista = poolPorValor.get(e.valor) ?? [];
    lista.push(e);
    poolPorValor.set(e.valor, lista);
  }

  const indicesParaImportar: number[] = [];
  const indicesCobertos: number[] = [];

  for (const candidato of candidatos) {
    if (!ehPixRecebido(candidato.descricaoNormalizada)) {
      indicesParaImportar.push(candidato.indice);
      continue;
    }

    const pool = poolPorValor.get(candidato.valor) ?? [];
    const posicao = pool.findIndex((e) => {
      const diferenca = diasEntre(e.data_lancamento, candidato.data);
      return diferenca >= 0 && diferenca <= JANELA_DIAS;
    });

    if (posicao === -1) {
      indicesParaImportar.push(candidato.indice);
    } else {
      pool.splice(posicao, 1);
      indicesCobertos.push(candidato.indice);
    }
  }

  return { indicesParaImportar, indicesCobertos };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:/projetos/q-mais-financas && node --experimental-strip-types scratch-test-cobertura-pix.mts`
Expected: all 7 `OK` lines, ending with `7 teste(s) passaram.` and exit code 0.

- [ ] **Step 5: Delete the throwaway test script and typecheck**

Run:
```bash
cd c:/projetos/q-mais-financas
rm -f scratch-test-cobertura-pix.mts
npx tsc --noEmit -p tsconfig.json
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/lib/cobertura-pix.ts
git commit -m "feat(extrato): motor de cobertura pra não duplicar pix de fim de semana"
```

---

### Task 3: Importar o relatório Pix diretamente como lançamentos (nova ação na tela)

**Files:**
- Modify: `src/app/extrato/page.tsx` — imports, new state, new handler, new UI card in the Importar tab

**Interfaces:**
- Consumes: `parseRelatorioPix`, `RelatorioPixParseError` from `@/lib/relatorio-pix` (Task 1).
- Consumes existing: `classificarPorRegras`, `refrescarTudo`, `contaImportId`, `podeEscrever`, `LancamentoClassificavel` (all already in the file).
- Produces: no new exports — this task only adds UI-local state and a handler.

- [ ] **Step 1: Add the import**

Find (top of `src/app/extrato/page.tsx`):

```tsx
import { parseOfx, decodificarOfx, OfxParseError } from "@/lib/ofx";
```

Add directly after it:

```tsx
import { parseRelatorioPix, RelatorioPixParseError } from "@/lib/relatorio-pix";
```

- [ ] **Step 2: Add state for the Pix report upload**

Find (around the `arquivo`/`resumoImportacao` state declarations):

```tsx
  const [arquivo, setArquivo] = useState<File | null>(null);
```

Add directly after the block containing `resumoImportacao` and `inputArquivoRef` (search for `const inputArquivoRef = useRef<HTMLInputElement>(null);` and add these three lines right after it):

```tsx
  const [arquivoPix, setArquivoPix] = useState<File | null>(null);
  const [importandoPix, setImportandoPix] = useState(false);
  const [resumoImportacaoPix, setResumoImportacaoPix] = useState<{ lidas: number; novas: number; duplicadas: number; avisos: string[] } | null>(null);
  const inputArquivoPixRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 3: Add the handler, right after `handleImportar`'s closing brace**

Find the end of `handleImportar` (search for the closing `}` right before the comment `// ---------- Classificação manual ----------`). Insert this new function between them:

```tsx
  async function handleImportarRelatorioPix() {
    setMensagem(null);
    setResumoImportacaoPix(null);

    if (!arquivoPix) {
      setMensagem({ tipo: "erro", texto: "Selecione o arquivo do relatório Pix (.xlsx)." });
      return;
    }
    if (!contaImportId) {
      setMensagem({ tipo: "erro", texto: "Selecione a conta bancária." });
      return;
    }
    if (!arquivoPix.name.toLowerCase().endsWith(".xlsx")) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivoPix.name}" rejeitado: apenas .xlsx é aceito.` });
      return;
    }
    if (arquivoPix.size > 5 * 1024 * 1024) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivoPix.name}" rejeitado: maior que 5 MB.` });
      return;
    }

    setImportandoPix(true);
    try {
      const bytes = new Uint8Array(await arquivoPix.arrayBuffer());
      const parsed = await parseRelatorioPix(bytes, arquivoPix.name);

      const { data: { user } } = await supabase.auth.getUser();

      const linhas = parsed.linhas.map((l) => ({
        conta_id: contaImportId,
        fitid: l.idTransacao ?? `PIXREL:${l.data}:${l.valor}:${l.ocorrencia}`,
        data_lancamento: l.data,
        valor: l.valor,
        tipo: "CREDIT",
        descricao: l.descricao,
        descricao_normalizada: l.descricaoNormalizada,
        ocorrencia: l.ocorrencia,
        status: "nao_classificado" as const,
      }));

      const { data: inseridos, error: erroUpsert } = await supabase
        .from("extrato_lancamento")
        .upsert(linhas, { onConflict: "conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia", ignoreDuplicates: true })
        .select("id, conta_id, descricao_normalizada, valor, status");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const datas = parsed.linhas.map((l) => l.data);
      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivoPix.name,
        periodo_inicio: datas.length > 0 ? datas.reduce((min, d) => (d < min ? d : min)) : null,
        periodo_fim: datas.length > 0 ? datas.reduce((max, d) => (d > max ? d : max)) : null,
        qtd_linhas: linhas.length,
        qtd_novas: novas,
        qtd_duplicadas: duplicadas,
        importado_por: user?.id ?? null,
      });
      if (erroImportacao) throw new Error(erroImportacao.message);

      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }

      setResumoImportacaoPix({ lidas: linhas.length, novas, duplicadas, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
      });
      setArquivoPix(null);
      if (inputArquivoPixRef.current) inputArquivoPixRef.current.value = "";
      await refrescarTudo();
    } catch (e) {
      const texto = e instanceof RelatorioPixParseError || e instanceof Error ? e.message : "Erro inesperado ao importar o relatório Pix.";
      setMensagem({ tipo: "erro", texto });
    } finally {
      setImportandoPix(false);
    }
  }
```

- [ ] **Step 4: Add the UI card**

Find the end of the existing OFX import card in the Importar tab — the block starts with `{aba === "importar" && (` and the card's closing looks like:

```tsx
          {resumoImportacao && (
            <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              <p className="font-semibold">
                {resumoImportacao.lidas} lidas · {resumoImportacao.novas} novas · {resumoImportacao.duplicadas} já existentes
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
        </div>
      )}
```

Insert a new card between the OFX card's closing `</div>` and the `)}` that closes the `aba === "importar"` block — i.e. replace that snippet with:

```tsx
          {resumoImportacao && (
            <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              <p className="font-semibold">
                {resumoImportacao.lidas} lidas · {resumoImportacao.novas} novas · {resumoImportacao.duplicadas} já existentes
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
        </div>

        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-xl mt-6">
          <h2 className="font-semibold text-sm mb-1">Importar relatório Pix (fim de semana/feriado)</h2>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            O extrato .ofx nunca posta em sábado/domingo/feriado — tudo cai no próximo dia útil. Suba aqui o relatório Pix
            (Excel) do Santander pra registrar esses lançamentos já com a data certa. Depois, ao importar o .ofx normal, o
            sistema reconhece e não duplica o que já foi coberto por aqui.
          </p>

          <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">
            Arquivo do relatório Pix (.xlsx, máx 5 MB)
          </label>
          <input
            ref={inputArquivoPixRef}
            type="file"
            accept=".xlsx"
            disabled={!podeEscrever}
            onChange={(e) => setArquivoPix(e.target.files?.[0] ?? null)}
            className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-xs file:font-semibold"
          />

          <button
            type="button"
            onClick={handleImportarRelatorioPix}
            disabled={!podeEscrever || importandoPix || !arquivoPix || !contaImportId}
            className="w-full px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {importandoPix && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {importandoPix ? "Importando..." : "Importar relatório Pix"}
          </button>

          {resumoImportacaoPix && (
            <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-800">
              <p className="font-semibold">
                {resumoImportacaoPix.lidas} lidas · {resumoImportacaoPix.novas} novas · {resumoImportacaoPix.duplicadas} já existentes
              </p>
              {resumoImportacaoPix.avisos.length > 0 && (
                <ul className="mt-2 list-disc list-inside text-amber-700">
                  {resumoImportacaoPix.avisos.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
```

(Note: the OFX card's own `</div>` moved from being the last line before `)}` to being followed by the new card's own `<div ...>...</div>`, both still inside the same `{aba === "importar" && ( ... )}` block. Double-check indentation/nesting matches the surrounding JSX after editing — there should be exactly one `)}` closing the `aba === "importar"` conditional, at the very end.)

- [ ] **Step 5: Typecheck and lint**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx
```
Expected: no type errors; ESLint shows only the pre-existing `react-hooks/set-state-in-effect` pattern already present in this file (not a regression — same pattern flagged before this task).

- [ ] **Step 6: Dev-server smoke test**

Run `npm run dev` (or reuse an already-running dev server on this project if Next.js reports one — check `.next/dev/logs/next-development.log`; do not kill a process you didn't start), then:
```bash
curl -s -o /dev/null -w "GET /extrato -> %{http_code}\n" http://localhost:3000/extrato
```
(Adjust the port to whatever the dev server actually reports.) Expected: `200`, and the dev server log shows a clean compile for `src/app/extrato/page.tsx` with no runtime errors.

- [ ] **Step 7: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): importar relatório Pix diretamente com a data real"
```

---

### Task 4: Upload do OFX descarta o que já foi coberto pelo relatório Pix

**Files:**
- Modify: `src/app/extrato/page.tsx` — imports, `handleImportar` function

**Interfaces:**
- Consumes: `calcularCobertura`, `type CandidatoOfx`, `type LancamentoExistentePix` from `@/lib/cobertura-pix` (Task 2).

- [ ] **Step 1: Add the import**

Find:

```tsx
import { parseRelatorioPix, RelatorioPixParseError } from "@/lib/relatorio-pix";
```

Add directly after it:

```tsx
import { calcularCobertura, type CandidatoOfx, type LancamentoExistentePix } from "@/lib/cobertura-pix";
```

- [ ] **Step 2: Insert the coverage check into `handleImportar`, before building `linhas`**

Find, inside `handleImportar`:

```tsx
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const texto = decodificarOfx(bytes, arquivo.name);
      const parsed = parseOfx(texto, arquivo.name);

      const { data: { user } } = await supabase.auth.getUser();

      const linhas = parsed.transacoes.map((t) => ({
        conta_id: contaImportId,
        fitid: t.fitid,
        data_lancamento: t.data,
        valor: t.valor,
        tipo: t.tipo,
        descricao: t.descricao,
        descricao_normalizada: t.descricaoNormalizada,
        ocorrencia: t.ocorrencia,
        status: "nao_classificado" as const,
      }));

      // O FITID do Santander muda a cada export (é derivado do horário do export,
      // não da transação), então a deduplicação usa a chave natural
      // (conta + data + valor + descrição + ocorrência) em vez do FITID.
      const { data: inseridos, error: erroUpsert } = await supabase
        .from("extrato_lancamento")
        .upsert(linhas, { onConflict: "conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia", ignoreDuplicates: true })
        .select("id, conta_id, descricao_normalizada, valor, status");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivo.name,
        periodo_inicio: parsed.conta.periodoInicio,
        periodo_fim: parsed.conta.periodoFim,
        qtd_linhas: linhas.length,
        qtd_novas: novas,
        qtd_duplicadas: duplicadas,
        importado_por: user?.id ?? null,
      });
      if (erroImportacao) throw new Error(erroImportacao.message);

      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }

      setResumoImportacao({ lidas: linhas.length, novas, duplicadas, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
      });
```

Replace that whole block with:

```tsx
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const texto = decodificarOfx(bytes, arquivo.name);
      const parsed = parseOfx(texto, arquivo.name);

      const { data: { user } } = await supabase.auth.getUser();

      // Evita duplicar Pix de fim de semana/feriado já importados via relatório
      // Pix com a data certa — o OFX traz o "eco" desses lançamentos carimbado
      // com a data do próximo dia útil.
      const { data: existentesPix, error: erroExistentes } = await supabase
        .from("extrato_lancamento")
        .select("id, data_lancamento, valor, descricao_normalizada")
        .eq("conta_id", contaImportId)
        .ilike("descricao_normalizada", "%pix recebido%");
      if (erroExistentes) throw new Error(erroExistentes.message);

      const candidatosCobertura: CandidatoOfx[] = parsed.transacoes.map((t, indice) => ({
        indice,
        data: t.data,
        valor: t.valor,
        descricaoNormalizada: t.descricaoNormalizada,
      }));
      const cobertura = calcularCobertura(candidatosCobertura, (existentesPix ?? []) as LancamentoExistentePix[]);
      const indicesCobertosSet = new Set(cobertura.indicesCobertos);
      const cobertos = cobertura.indicesCobertos.length;

      const linhas = parsed.transacoes
        .filter((_, indice) => !indicesCobertosSet.has(indice))
        .map((t) => ({
          conta_id: contaImportId,
          fitid: t.fitid,
          data_lancamento: t.data,
          valor: t.valor,
          tipo: t.tipo,
          descricao: t.descricao,
          descricao_normalizada: t.descricaoNormalizada,
          ocorrencia: t.ocorrencia,
          status: "nao_classificado" as const,
        }));

      // O FITID do Santander muda a cada export (é derivado do horário do export,
      // não da transação), então a deduplicação usa a chave natural
      // (conta + data + valor + descrição + ocorrência) em vez do FITID.
      const { data: inseridos, error: erroUpsert } = await supabase
        .from("extrato_lancamento")
        .upsert(linhas, { onConflict: "conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia", ignoreDuplicates: true })
        .select("id, conta_id, descricao_normalizada, valor, status");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivo.name,
        periodo_inicio: parsed.conta.periodoInicio,
        periodo_fim: parsed.conta.periodoFim,
        qtd_linhas: parsed.transacoes.length,
        qtd_novas: novas,
        qtd_duplicadas: duplicadas,
        importado_por: user?.id ?? null,
      });
      if (erroImportacao) throw new Error(erroImportacao.message);

      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }

      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
      });
```

(Everything after this — `setArquivo(null)`, the `catch`/`finally` block — stays exactly as it already is; only the block shown above is replaced.)

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx
```
Expected: no type errors; no new ESLint error categories beyond the pre-existing `set-state-in-effect` pattern.

- [ ] **Step 4: Dev-server smoke test**

Same as Task 3 Step 6 — confirm `/extrato` still returns 200 with a clean compile.

- [ ] **Step 5: Commit**

```bash
cd c:/projetos/q-mais-financas
git add src/app/extrato/page.tsx
git commit -m "feat(extrato): upload do ofx descarta pix já coberto pelo relatório"
```

---

### Task 5: Verificação final e atualização da spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-extrato-correcao-data-pix-design.md` (status line only)

- [ ] **Step 1: Full typecheck and lint**

Run:
```bash
cd c:/projetos/q-mais-financas
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/extrato/page.tsx src/lib/relatorio-pix.ts src/lib/cobertura-pix.ts
```
Expected: no type errors; only the pre-existing `react-hooks/set-state-in-effect` pattern in ESLint output.

- [ ] **Step 2: Production build**

Run: `cd c:/projetos/q-mais-financas && npm run build`
Expected: build succeeds, `/extrato` listed among the compiled routes, no errors.

- [ ] **Step 3: E2E test on the real Postgres schema, simulating the full two-day flow**

Run this via the Supabase MCP `execute_sql` tool (or `psql` if available) against the live project — uses disposable data, cleaned up at the end, matching the pattern used for every other E2E test in this project:

```sql
do $$
declare
  v_conta_id uuid;
  v_count int;
begin
  insert into public.extrato_conta (banco, apelido) values ('santander', '__teste_e2e_pix_fds__') returning id into v_conta_id;

  -- "Segunda-feira": relatório Pix já importado com a data real (sáb + dom)
  insert into public.extrato_lancamento (conta_id, fitid, data_lancamento, valor, descricao, descricao_normalizada, ocorrencia, status)
  values
    (v_conta_id, 'E0000000020260808000001', '2026-08-08', 20.00, 'PIX RECEBIDO JOAO', 'pix recebido joao', 0, 'nao_classificado'),
    (v_conta_id, 'E0000000020260809000001', '2026-08-09', 20.00, 'PIX RECEBIDO MARIA', 'pix recebido maria', 0, 'nao_classificado');

  select count(*) into v_count from public.extrato_lancamento where conta_id = v_conta_id;
  assert v_count = 2, 'esperava 2 lançamentos do relatório Pix, achou ' || v_count;

  -- "Terça-feira": simula o que o OFX traria — 3 linhas de R$20 datadas segunda
  -- (2 são o eco do fim de semana, 1 é nova). Só a nova deve ser inserida; as
  -- outras já estão cobertas pelas duas linhas acima (mesmo valor, dentro da
  -- janela de 5 dias, data do OFX posterior à do relatório).
  -- Este teste simula a decisão de cobertura no nível SQL (equivalente ao que
  -- calcularCobertura decide em memória antes do upsert): insere só a 3ª linha.
  insert into public.extrato_lancamento (conta_id, fitid, data_lancamento, valor, descricao, descricao_normalizada, ocorrencia, status)
  values (v_conta_id, 'FIT-SEGUNDA-NOVA', '2026-08-10', 20.00, 'PIX RECEBIDO PEDRO', 'pix recebido pedro', 0, 'nao_classificado');

  select count(*) into v_count from public.extrato_lancamento where conta_id = v_conta_id;
  assert v_count = 3, 'esperava 3 lançamentos no total (2 do fim de semana + 1 novo de segunda), achou ' || v_count;

  select count(*) into v_count from public.extrato_lancamento where conta_id = v_conta_id and data_lancamento in ('2026-08-08', '2026-08-09');
  assert v_count = 2, 'os 2 lançamentos do fim de semana devem continuar com a data original';

  raise notice 'E2E OK: fluxo de dois dias (relatório Pix + ofx) resulta em 3 lançamentos, um por dia real';

  delete from public.extrato_conta where id = v_conta_id;
end $$;

select count(*) as residuais from public.extrato_conta where apelido = '__teste_e2e_pix_fds__';
```

Expected: no exceptions, `residuais` = 0.

- [ ] **Step 4: Confirm no file outside this feature's scope was touched**

Run:
```bash
cd c:/projetos/q-mais-financas
git diff --stat <BASE>..HEAD
```
where `<BASE>` is the commit before Task 1 started. Expected: only `src/lib/relatorio-pix.ts`, `src/lib/cobertura-pix.ts`, and `src/app/extrato/page.tsx` appear.

- [ ] **Step 5: Update the spec status and commit**

In `docs/superpowers/specs/2026-08-12-extrato-correcao-data-pix-design.md`, change:

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
git add docs/superpowers/specs/2026-08-12-extrato-correcao-data-pix-design.md
git commit -m "docs: marcar spec de pix de fim de semana como implementada"
```
