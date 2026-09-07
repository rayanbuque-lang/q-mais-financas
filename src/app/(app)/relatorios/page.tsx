"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
  observacao?: string | null;
}

interface Categoria {
  id: string;
  nome: string;
}

interface CategoriaTotal {
  id: string;
  nome: string;
  total: number;
  movs: Movimentacao[];
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];
const mesesAbrev = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function gerarImpressao(titulo: string, periodo: string, conteudo: string) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo} - +Q Finanças</title><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;padding:40px;color:#1a1a1a;background:#fff}
    .header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:24px}
    .header h1{font-size:22px;color:#16a34a}
    .header .periodo{font-size:13px;color:#666}
    h2{font-size:16px;margin:20px 0 10px;color:#333;border-bottom:1px solid #eee;padding-bottom:6px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px}
    th{background:#f5f5f5;padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ddd}
    td{padding:8px 12px;border-bottom:1px solid #f0f0f0}
    .total{font-weight:bold;border-top:2px solid #333}
    .total td{padding-top:10px}
    .positivo{color:#16a34a}.negativo{color:#dc2626}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
    .card{border:1px solid #e5e5e5;border-radius:8px;padding:14px;text-align:center}
    .card .label{font-size:11px;color:#666;text-transform:uppercase}
    .card .valor{font-size:20px;font-weight:bold;margin-top:4px}
    .footer{margin-top:40px;text-align:center;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px}
    .bar{height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;margin-top:4px}
    .bar-green{background:#16a34a;height:100%;border-radius:4px}
    .bar-red{background:#dc2626;height:100%;border-radius:4px}
    @media print{body{padding:20px}.no-print{display:none}tr{page-break-inside:avoid}}
  </style></head><body>
    <div class="header"><h1>+Q Finanças - ${titulo}</h1><div class="periodo">${periodo}</div></div>
    ${conteudo}
    <div class="footer">Gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")} · +Q Finanças</div>
    <script>setTimeout(function(){window.print()},500)<\/script>
  </body></html>`);
  win.document.close();
}

function fmt(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtData(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("pt-BR");
}

function fetchTodasMovimentacoes(
  supabase: ReturnType<typeof createClient>,
  inicio: string,
  fim: string
): Promise<Movimentacao[]> {
  return fetchAllRows<Movimentacao>((from, to) =>
    supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).order("data").range(from, to)
  );
}

function downloadCSV(rows: string[][], nomeArquivo: string) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nomeArquivo; a.click();
  URL.revokeObjectURL(url);
}

export default function RelatoriosPage() {
  const [ano, setAno] = useState(new Date().getFullYear());
  const [mes, setMes] = useState(new Date().getMonth());
  const [aba, setAba] = useState<"mensal" | "categorias" | "comparativo" | "anual">("mensal");
  const [movimentacoesAno, setMovimentacoesAno] = useState<Movimentacao[]>([]);
  const [catEntrada, setCatEntrada] = useState<Categoria[]>([]);
  const [catSaida, setCatSaida] = useState<Categoria[]>([]);
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());
  const supabase = createClient();

  // ===== Comparativo (multi-mês) =====
  const hoje = new Date();
  const [compDeMes, setCompDeMes] = useState(() => {
    const d = new Date(hoje); d.setMonth(d.getMonth() - 2); return d.getMonth();
  });
  const [compDeAno, setCompDeAno] = useState(() => {
    const d = new Date(hoje); d.setMonth(d.getMonth() - 2); return d.getFullYear();
  });
  const [compAteMes, setCompAteMes] = useState(hoje.getMonth());
  const [compAteAno, setCompAteAno] = useState(hoje.getFullYear());
  const [compMovs, setCompMovs] = useState<Movimentacao[]>([]);
  const [compLoading, setCompLoading] = useState(false);
  const [compCarregado, setCompCarregado] = useState(false);

  async function carregarDados() {
    const inicio = `${ano}-01-01`;
    const fim = `${ano}-12-31`;
    const [movs, r2, r3] = await Promise.all([
      fetchTodasMovimentacoes(supabase, inicio, fim),
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true),
    ]);
    setMovimentacoesAno(movs);
    if (r2.data) setCatEntrada(r2.data);
    if (r3.data) setCatSaida(r3.data);
  }

  useEffect(() => { carregarDados(); }, [ano]);

  function listaMeses(deMes: number, deAno: number, ateMes: number, ateAno: number) {
    const lista: { mes: number; ano: number }[] = [];
    let m = deMes, a = deAno, guard = 0;
    while ((a < ateAno || (a === ateAno && m <= ateMes)) && guard < 36) {
      lista.push({ mes: m, ano: a });
      m++; if (m > 11) { m = 0; a++; }
      guard++;
    }
    return lista;
  }

  async function carregarComparativo() {
    setCompLoading(true);
    const lista = listaMeses(compDeMes, compDeAno, compAteMes, compAteAno);
    if (lista.length === 0) { setCompMovs([]); setCompLoading(false); setCompCarregado(true); return; }
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    const inicio = `${primeiro.ano}-${String(primeiro.mes + 1).padStart(2, "0")}-01`;
    const fimDia = new Date(ultimo.ano, ultimo.mes + 1, 0).getDate();
    const fim = `${ultimo.ano}-${String(ultimo.mes + 1).padStart(2, "0")}-${String(fimDia).padStart(2, "0")}`;
    const data = await fetchTodasMovimentacoes(supabase, inicio, fim);
    setCompMovs(data);
    setCompLoading(false);
    setCompCarregado(true);
  }

  useEffect(() => {
    if (aba === "comparativo" && !compCarregado) carregarComparativo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba]);

  function mesAnterior() { if (mes === 0) { setMes(11); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 11) { setMes(0); setAno(ano + 1); } else setMes(mes + 1); }

  function toggleExpand(key: string) {
    setExpandidas((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function getMovsDoMes(m: number) {
    return movimentacoesAno.filter((mov) => {
      const d = new Date(mov.data + "T12:00:00");
      return d.getMonth() === m;
    });
  }

  function calcTotais(movs: Movimentacao[]) {
    const entradas = movs.filter((m) => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
    const saidas = movs.filter((m) => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
    return { entradas, saidas, resultado: entradas - saidas, margem: entradas > 0 ? ((entradas - saidas) / entradas) * 100 : 0 };
  }

  function getCatsTotais(movs: Movimentacao[], cats: Categoria[], tipo: string): CategoriaTotal[] {
    return cats.map((cat) => {
      const movsCat = movs.filter((m) => m.tipo === tipo && m.categoria_id === cat.id);
      const total = movsCat.reduce((a, m) => a + m.valor, 0);
      return { id: cat.id, nome: cat.nome, total, movs: movsCat };
    }).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  }

  // Dados mês selecionado
  const movsMes = getMovsDoMes(mes);
  const tMes = calcTotais(movsMes);
  const catsEntradaMes = getCatsTotais(movsMes, catEntrada, "entrada");
  const catsSaidaMes = getCatsTotais(movsMes, catSaida, "saida");

  // Dados anuais
  const dadosAnuais = meses.map((nome, i) => {
    const movs = getMovsDoMes(i);
    const t = calcTotais(movs);
    return { nome, ...t };
  });
  const tAno = calcTotais(movimentacoesAno);

  // Evolução acumulada
  let acumulado = 0;
  const evolucao = dadosAnuais.map((m) => { acumulado += m.resultado; return { ...m, acumulado }; });

  const maxBarra = Math.max(...dadosAnuais.map((m) => Math.max(m.entradas, m.saidas)), 1);

  // Dados comparativo
  const mesesComp = listaMeses(compDeMes, compDeAno, compAteMes, compAteAno);
  function movsDoMesComp(m: number, a: number) {
    return compMovs.filter((mov) => {
      const d = new Date(mov.data + "T12:00:00");
      return d.getMonth() === m && d.getFullYear() === a;
    });
  }
  const dadosComp = mesesComp.map(({ mes: m, ano: a }) => {
    const movs = movsDoMesComp(m, a);
    const t = calcTotais(movs);
    return { mes: m, ano: a, label: `${mesesAbrev[m]}/${String(a).slice(2)}`, movs, ...t };
  });

  function matrizCategorias(tipo: "entrada" | "saida") {
    const cats = tipo === "entrada" ? catEntrada : catSaida;
    return cats.map((cat) => {
      const valores = dadosComp.map((d) => d.movs.filter((m) => m.tipo === tipo && m.categoria_id === cat.id).reduce((a, m) => a + m.valor, 0));
      const total = valores.reduce((a, v) => a + v, 0);
      const primeiro = valores.find((v) => v > 0) ?? 0;
      const ultimoRev = [...valores].reverse().find((v) => v > 0) ?? 0;
      const variacao = primeiro > 0 ? ((ultimoRev - primeiro) / primeiro) * 100 : null;
      return { nome: cat.nome, valores, total, variacao };
    }).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  }
  const matrizEntrada = matrizCategorias("entrada");
  const matrizSaida = matrizCategorias("saida");
  const totalEntradasComp = dadosComp.reduce((a, d) => a + d.entradas, 0);
  const totalSaidasComp = dadosComp.reduce((a, d) => a + d.saidas, 0);

  // ===== IMPRESSÃO =====
  function linhasDetalhadas(cats: CategoriaTotal[], totalTipo: number, cls: string) {
    return cats.map((c) => {
      const header = `<tr class="total"><td>${c.nome}</td><td class="${cls}">${fmt(c.total)}</td><td>${totalTipo > 0 ? ((c.total / totalTipo) * 100).toFixed(1) : 0}%</td></tr>`;
      const itens = c.movs.slice().sort((a, b) => a.data.localeCompare(b.data)).map((m) =>
        `<tr><td style="padding-left:28px;font-size:11px;color:#777">${fmtData(m.data)}${m.observacao ? " — " + m.observacao : ""}</td><td style="font-size:11px;color:#777">${fmt(m.valor)}</td><td></td></tr>`
      ).join("");
      return header + itens;
    }).join("");
  }

  function imprimirMensal() {
    const rows = catsEntradaMes.map((c) => `<tr><td>${c.nome}</td><td class="positivo">${fmt(c.total)}</td><td>${((c.total / tMes.entradas) * 100).toFixed(1)}%</td></tr>`).join("");
    const rowsS = catsSaidaMes.map((c) => `<tr><td>${c.nome}</td><td class="negativo">${fmt(c.total)}</td><td>${((c.total / tMes.saidas) * 100).toFixed(1)}%</td></tr>`).join("");
    gerarImpressao("Relatório Mensal", `${meses[mes]} de ${ano}`, `
      <div class="cards">
        <div class="card"><div class="label">Receita</div><div class="valor positivo">${fmt(tMes.entradas)}</div></div>
        <div class="card"><div class="label">Despesas</div><div class="valor negativo">${fmt(tMes.saidas)}</div></div>
        <div class="card"><div class="label">Resultado</div><div class="valor ${tMes.resultado >= 0 ? "positivo" : "negativo"}">${fmt(tMes.resultado)}</div></div>
        <div class="card"><div class="label">Margem</div><div class="valor ${tMes.margem >= 0 ? "positivo" : "negativo"}">${tMes.margem.toFixed(1)}%</div></div>
      </div>
      ${rows ? `<h2>(+) Receitas por Categoria</h2><table><thead><tr><th>Categoria</th><th>Valor</th><th>%</th></tr></thead><tbody>${rows}<tr class="total"><td>TOTAL</td><td class="positivo">${fmt(tMes.entradas)}</td><td>100%</td></tr></tbody></table>` : ""}
      ${rowsS ? `<h2>(-) Despesas por Categoria</h2><table><thead><tr><th>Categoria</th><th>Valor</th><th>%</th></tr></thead><tbody>${rowsS}<tr class="total"><td>TOTAL</td><td class="negativo">${fmt(tMes.saidas)}</td><td>100%</td></tr></tbody></table>` : ""}
      <h2>Resultado</h2>
      <p style="font-size:18px;font-weight:bold;margin:8px 0" class="${tMes.resultado >= 0 ? "positivo" : "negativo"}">${fmt(tMes.resultado)} (${tMes.margem.toFixed(1)}% de margem)</p>
    `);
  }

  function imprimirAnual() {
    const rows = evolucao.map((m) => `<tr><td>${m.nome}</td><td class="positivo">${fmt(m.entradas)}</td><td class="negativo">${fmt(m.saidas)}</td><td class="${m.resultado >= 0 ? "positivo" : "negativo"}">${fmt(m.resultado)}</td><td>${m.margem.toFixed(1)}%</td><td class="${m.acumulado >= 0 ? "positivo" : "negativo"}">${fmt(m.acumulado)}</td></tr>`).join("");
    gerarImpressao("Relatório Anual", `Ano de ${ano}`, `
      <div class="cards">
        <div class="card"><div class="label">Receita Anual</div><div class="valor positivo">${fmt(tAno.entradas)}</div></div>
        <div class="card"><div class="label">Despesas Anual</div><div class="valor negativo">${fmt(tAno.saidas)}</div></div>
        <div class="card"><div class="label">Resultado</div><div class="valor ${tAno.resultado >= 0 ? "positivo" : "negativo"}">${fmt(tAno.resultado)}</div></div>
        <div class="card"><div class="label">Margem</div><div class="valor ${tAno.margem >= 0 ? "positivo" : "negativo"}">${tAno.margem.toFixed(1)}%</div></div>
      </div>
      <h2>Evolução Mês a Mês</h2>
      <table><thead><tr><th>Mês</th><th>Receita</th><th>Despesa</th><th>Resultado</th><th>Margem</th><th>Acumulado</th></tr></thead><tbody>${rows}<tr class="total"><td>TOTAL</td><td class="positivo">${fmt(tAno.entradas)}</td><td class="negativo">${fmt(tAno.saidas)}</td><td class="${tAno.resultado >= 0 ? "positivo" : "negativo"}">${fmt(tAno.resultado)}</td><td>${tAno.margem.toFixed(1)}%</td><td></td></tr></tbody></table>
    `);
  }

  function imprimirCategorias() {
    gerarImpressao("Relatório Detalhado por Categoria", `${meses[mes]} de ${ano}`, `
      <div class="cards">
        <div class="card"><div class="label">Receita</div><div class="valor positivo">${fmt(tMes.entradas)}</div></div>
        <div class="card"><div class="label">Despesas</div><div class="valor negativo">${fmt(tMes.saidas)}</div></div>
        <div class="card"><div class="label">Resultado</div><div class="valor ${tMes.resultado >= 0 ? "positivo" : "negativo"}">${fmt(tMes.resultado)}</div></div>
        <div class="card"><div class="label">Margem</div><div class="valor ${tMes.margem >= 0 ? "positivo" : "negativo"}">${tMes.margem.toFixed(1)}%</div></div>
      </div>
      ${catsEntradaMes.length ? `<h2>(+) Receitas — cada lançamento por categoria</h2><table><thead><tr><th>Categoria / Lançamento</th><th>Valor</th><th>%</th></tr></thead><tbody>${linhasDetalhadas(catsEntradaMes, tMes.entradas, "positivo")}<tr class="total"><td>TOTAL RECEITAS</td><td class="positivo">${fmt(tMes.entradas)}</td><td>100%</td></tr></tbody></table>` : "<p>Nenhuma receita neste período.</p>"}
      ${catsSaidaMes.length ? `<h2>(-) Despesas — cada lançamento por categoria</h2><table><thead><tr><th>Categoria / Lançamento</th><th>Valor</th><th>%</th></tr></thead><tbody>${linhasDetalhadas(catsSaidaMes, tMes.saidas, "negativo")}<tr class="total"><td>TOTAL DESPESAS</td><td class="negativo">${fmt(tMes.saidas)}</td><td>100%</td></tr></tbody></table>` : "<p>Nenhuma despesa neste período.</p>"}
    `);
  }

  function imprimirComparativo() {
    const cardsHtml = `<div class="cards" style="grid-template-columns:repeat(${Math.min(dadosComp.length, 6)},1fr)">
      ${dadosComp.map((d) => `<div class="card"><div class="label">${d.label}</div>
        <div style="font-size:11px;margin-top:6px" class="positivo">${fmt(d.entradas)}</div>
        <div style="font-size:11px" class="negativo">${fmt(d.saidas)}</div>
        <div style="font-size:13px;font-weight:bold;margin-top:2px" class="${d.resultado >= 0 ? "positivo" : "negativo"}">${fmt(d.resultado)}</div>
        <div style="font-size:10px;color:#666">${d.margem.toFixed(1)}% margem</div>
      </div>`).join("")}
    </div>`;

    function tabelaMatriz(titulo: string, matriz: ReturnType<typeof matrizCategorias>, cls: string) {
      if (matriz.length === 0) return "";
      const header = `<th>Categoria</th>${dadosComp.map((d) => `<th>${d.label}</th>`).join("")}<th>Variação</th>`;
      const rows = matriz.map((c) => `<tr><td>${c.nome}</td>${c.valores.map((v) => `<td class="${cls}">${v > 0 ? fmt(v) : "—"}</td>`).join("")}<td>${c.variacao === null ? "—" : `${c.variacao >= 0 ? "↑" : "↓"} ${Math.abs(c.variacao).toFixed(1)}%`}</td></tr>`).join("");
      const totalCols = dadosComp.map((d) => `<td class="${cls}">${fmt(cls === "positivo" ? d.entradas : d.saidas)}</td>`).join("");
      return `<h2>${titulo}</h2><table><thead><tr>${header}</tr></thead><tbody>${rows}<tr class="total"><td>TOTAL</td>${totalCols}<td></td></tr></tbody></table>`;
    }

    const periodo = dadosComp.length ? `${dadosComp[0].label} a ${dadosComp[dadosComp.length - 1].label}` : "";
    gerarImpressao("Comparativo entre Meses", periodo, `
      ${cardsHtml}
      ${tabelaMatriz("(+) Receitas por Categoria", matrizEntrada, "positivo")}
      ${tabelaMatriz("(-) Despesas por Categoria", matrizSaida, "negativo")}
    `);
  }

  function getCatNome(id: string, tipo: string): string {
    const cats = tipo === "entrada" ? catEntrada : catSaida;
    return cats.find(c => c.id === id)?.nome || "Sem categoria";
  }

  function exportarCSVMensal() {
    const rows: string[][] = [
      ["Tipo", "Data", "Categoria", "Observação", "Valor (R$)"],
      ...movsMes.map(m => [
        m.tipo === "entrada" ? "Entrada" : "Saída",
        m.data,
        getCatNome(m.categoria_id, m.tipo),
        m.observacao || "",
        m.valor.toFixed(2).replace(".", ","),
      ]),
    ];
    downloadCSV(rows, `movimentacoes_${meses[mes]}_${ano}.csv`);
  }

  function exportarCSVAnual() {
    const rows: string[][] = [
      ["Mês", "Receita (R$)", "Despesa (R$)", "Resultado (R$)", "Margem %", "Acumulado (R$)"],
      ...evolucao.map(m => [
        m.nome,
        m.entradas.toFixed(2).replace(".", ","),
        m.saidas.toFixed(2).replace(".", ","),
        m.resultado.toFixed(2).replace(".", ","),
        m.margem.toFixed(1),
        m.acumulado.toFixed(2).replace(".", ","),
      ]),
    ];
    downloadCSV(rows, `relatorio_anual_${ano}.csv`);
  }

  function exportarCSVComparativo() {
    const header = ["Tipo", "Categoria", ...dadosComp.map(d => d.label), "Total"];
    const rowsE = matrizEntrada.map(c => ["Receita", c.nome, ...c.valores.map(v => v.toFixed(2).replace(".", ",")), c.total.toFixed(2).replace(".", ",")]);
    const rowsS = matrizSaida.map(c => ["Despesa", c.nome, ...c.valores.map(v => v.toFixed(2).replace(".", ",")), c.total.toFixed(2).replace(".", ",")]);
    const resumo = [
      ["", "TOTAL RECEITA", ...dadosComp.map(d => d.entradas.toFixed(2).replace(".", ",")), totalEntradasComp.toFixed(2).replace(".", ",")],
      ["", "TOTAL DESPESA", ...dadosComp.map(d => d.saidas.toFixed(2).replace(".", ",")), totalSaidasComp.toFixed(2).replace(".", ",")],
      ["", "RESULTADO", ...dadosComp.map(d => d.resultado.toFixed(2).replace(".", ",")), (totalEntradasComp - totalSaidasComp).toFixed(2).replace(".", ",")],
    ];
    const periodo = dadosComp.length ? `${dadosComp[0].label}_a_${dadosComp[dadosComp.length - 1].label}` : "comparativo";
    downloadCSV([header, ...rowsE, ...rowsS, ...resumo], `comparativo_${periodo}.csv`);
  }

  const anosDisponiveis = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 4 + i);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Relatórios</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Visão completa do desempenho financeiro</p>
        </div>
      </div>

      {/* Abas */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 flex-wrap">
        {(["mensal", "categorias", "comparativo", "anual"] as const).map((v) => (
          <button key={v} onClick={() => setAba(v)} className={`flex-1 min-w-[110px] py-2.5 rounded-lg text-sm font-medium transition ${aba === v ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
            {v === "mensal" ? "Mensal" : v === "categorias" ? "Detalhado" : v === "comparativo" ? "Comparar Meses" : "Anual"}
          </button>
        ))}
      </div>

      {/* ===== MENSAL ===== */}
      {aba === "mensal" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
            <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
            <div className="text-center"><p className="font-bold capitalize">{meses[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
            <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Receita", value: fmt(tMes.entradas), color: "text-emerald-600" },
              { label: "Despesas", value: fmt(tMes.saidas), color: "text-red-500" },
              { label: "Lucro", value: fmt(tMes.resultado), color: tMes.resultado >= 0 ? "text-emerald-600" : "text-red-500" },
              { label: "Margem", value: `${tMes.margem.toFixed(1)}%`, color: tMes.margem >= 0 ? "text-emerald-600" : "text-red-500" },
            ].map((c) => (
              <div key={c.label} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{c.label}</p>
                <p className={`text-xl font-bold mt-1 ${c.color}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {catsEntradaMes.length > 0 && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
              <h3 className="font-bold mb-3 text-sm uppercase tracking-wider text-[var(--color-text-muted)]">Principais Receitas</h3>
              <div className="space-y-3">
                {catsEntradaMes.slice(0, 5).map((cat) => (
                  <div key={cat.id}>
                    <div className="flex justify-between text-sm mb-1"><span>{cat.nome}</span><span className="font-semibold text-emerald-600">{fmt(cat.total)} ({((cat.total / tMes.entradas) * 100).toFixed(1)}%)</span></div>
                    <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.entradas) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {catsSaidaMes.length > 0 && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
              <h3 className="font-bold mb-3 text-sm uppercase tracking-wider text-[var(--color-text-muted)]">Principais Despesas</h3>
              <div className="space-y-3">
                {catsSaidaMes.slice(0, 5).map((cat) => (
                  <div key={cat.id}>
                    <div className="flex justify-between text-sm mb-1"><span>{cat.nome}</span><span className="font-semibold text-red-500">{fmt(cat.total)} ({((cat.total / tMes.saidas) * 100).toFixed(1)}%)</span></div>
                    <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.saidas) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={imprimirMensal} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              🖨️ Imprimir / Salvar PDF
            </button>
            <button onClick={exportarCSVMensal} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              📥 Exportar CSV
            </button>
          </div>
        </div>
      )}

      {/* ===== DETALHADO (categorias com cada lançamento) ===== */}
      {aba === "categorias" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
            <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
            <div className="text-center"><p className="font-bold capitalize">{meses[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
            <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] -mt-2">Clique em uma categoria para ver cada lançamento, centavo a centavo.</p>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50">
              <div className="flex justify-between items-center"><h3 className="font-bold text-emerald-800">Receitas por Categoria</h3><span className="text-sm font-bold text-emerald-700">{fmt(tMes.entradas)}</span></div>
            </div>
            {catsEntradaMes.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
              <div className="divide-y divide-[var(--color-border)]">
                {catsEntradaMes.map((cat) => {
                  const key = `entrada-${cat.id}`;
                  const aberta = expandidas.has(key);
                  return (
                    <div key={cat.id}>
                      <button onClick={() => toggleExpand(key)} className="w-full text-left p-4 hover:bg-[var(--color-bg)] transition">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm font-medium">{aberta ? "▾" : "▸"} {cat.nome} <span className="text-[var(--color-text-muted)] font-normal">({cat.movs.length} lanç.)</span></span>
                          <div className="text-right"><span className="text-sm font-bold text-emerald-600">{fmt(cat.total)}</span><span className="text-xs text-[var(--color-text-muted)] ml-2">{((cat.total / tMes.entradas) * 100).toFixed(1)}%</span></div>
                        </div>
                        <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.entradas) * 100}%` }} /></div>
                      </button>
                      {aberta && (
                        <div className="bg-[var(--color-bg)] px-4 pb-3">
                          <div className="divide-y divide-[var(--color-border)]">
                            {cat.movs.slice().sort((a, b) => a.data.localeCompare(b.data)).map((m) => (
                              <div key={m.id} className="flex justify-between items-center py-2 text-xs pl-4">
                                <span className="text-[var(--color-text-muted)]">{fmtData(m.data)}{m.observacao ? ` — ${m.observacao}` : ""}</span>
                                <span className="font-medium text-emerald-600">{fmt(m.valor)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
              <div className="flex justify-between items-center"><h3 className="font-bold text-red-700">Despesas por Categoria</h3><span className="text-sm font-bold text-red-500">{fmt(tMes.saidas)}</span></div>
            </div>
            {catsSaidaMes.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
              <div className="divide-y divide-[var(--color-border)]">
                {catsSaidaMes.map((cat) => {
                  const key = `saida-${cat.id}`;
                  const aberta = expandidas.has(key);
                  return (
                    <div key={cat.id}>
                      <button onClick={() => toggleExpand(key)} className="w-full text-left p-4 hover:bg-[var(--color-bg)] transition">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm font-medium">{aberta ? "▾" : "▸"} {cat.nome} <span className="text-[var(--color-text-muted)] font-normal">({cat.movs.length} lanç.)</span></span>
                          <div className="text-right"><span className="text-sm font-bold text-red-500">{fmt(cat.total)}</span><span className="text-xs text-[var(--color-text-muted)] ml-2">{((cat.total / tMes.saidas) * 100).toFixed(1)}%</span></div>
                        </div>
                        <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.saidas) * 100}%` }} /></div>
                      </button>
                      {aberta && (
                        <div className="bg-[var(--color-bg)] px-4 pb-3">
                          <div className="divide-y divide-[var(--color-border)]">
                            {cat.movs.slice().sort((a, b) => a.data.localeCompare(b.data)).map((m) => (
                              <div key={m.id} className="flex justify-between items-center py-2 text-xs pl-4">
                                <span className="text-[var(--color-text-muted)]">{fmtData(m.data)}{m.observacao ? ` — ${m.observacao}` : ""}</span>
                                <span className="font-medium text-red-500">{fmt(m.valor)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={imprimirCategorias} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              🖨️ Imprimir Detalhado / PDF
            </button>
            <button onClick={exportarCSVMensal} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              📥 Exportar CSV (cada lançamento)
            </button>
          </div>
        </div>
      )}

      {/* ===== COMPARAR MESES ===== */}
      {aba === "comparativo" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Período a comparar</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-[var(--color-text-muted)]">De</span>
              <select value={compDeMes} onChange={(e) => setCompDeMes(Number(e.target.value))} className="px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                {meses.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <select value={compDeAno} onChange={(e) => setCompDeAno(Number(e.target.value))} className="px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                {anosDisponiveis.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <span className="text-sm text-[var(--color-text-muted)]">até</span>
              <select value={compAteMes} onChange={(e) => setCompAteMes(Number(e.target.value))} className="px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                {meses.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <select value={compAteAno} onChange={(e) => setCompAteAno(Number(e.target.value))} className="px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                {anosDisponiveis.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <button onClick={carregarComparativo} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition">
                {compLoading ? "Carregando..." : "Atualizar"}
              </button>
            </div>
          </div>

          {compLoading ? (
            <div className="flex items-center justify-center h-32"><p className="text-[var(--color-text-muted)] text-sm">Carregando dados...</p></div>
          ) : dadosComp.length === 0 ? (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 text-center text-sm text-[var(--color-text-muted)]">Selecione um período válido.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <div className="flex gap-3 min-w-max pb-1">
                  {dadosComp.map((d) => (
                    <div key={`${d.mes}-${d.ano}`} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 w-44 shrink-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">{d.label}</p>
                      <p className="text-xs text-emerald-600 font-medium">{fmt(d.entradas)}</p>
                      <p className="text-xs text-red-500 font-medium">{fmt(d.saidas)}</p>
                      <p className={`text-sm font-bold mt-1 ${d.resultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmt(d.resultado)}</p>
                      <p className="text-[10px] text-[var(--color-text-muted)]">{d.margem.toFixed(1)}% margem</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50">
                  <h3 className="font-bold text-emerald-800 text-sm uppercase tracking-wider">Receitas por Categoria — crescimento no período</h3>
                </div>
                {matrizEntrada.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs font-semibold uppercase tracking-wider">
                          <th className="px-4 py-2 text-left">Categoria</th>
                          {dadosComp.map((d) => <th key={d.label} className="px-3 py-2 text-right whitespace-nowrap">{d.label}</th>)}
                          <th className="px-3 py-2 text-right">Variação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {matrizEntrada.map((c) => (
                          <tr key={c.nome}>
                            <td className="px-4 py-2 font-medium whitespace-nowrap">{c.nome}</td>
                            {c.valores.map((v, i) => <td key={i} className="px-3 py-2 text-right text-emerald-600 whitespace-nowrap">{v > 0 ? fmt(v) : "—"}</td>)}
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {c.variacao === null ? "—" : (
                                <span className={`font-semibold ${c.variacao >= 0 ? "text-emerald-600" : "text-red-500"}`}>{c.variacao >= 0 ? "↑" : "↓"} {Math.abs(c.variacao).toFixed(1)}%</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
                  <h3 className="font-bold text-red-700 text-sm uppercase tracking-wider">Despesas por Categoria — evolução no período</h3>
                </div>
                {matrizSaida.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs font-semibold uppercase tracking-wider">
                          <th className="px-4 py-2 text-left">Categoria</th>
                          {dadosComp.map((d) => <th key={d.label} className="px-3 py-2 text-right whitespace-nowrap">{d.label}</th>)}
                          <th className="px-3 py-2 text-right">Variação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {matrizSaida.map((c) => (
                          <tr key={c.nome}>
                            <td className="px-4 py-2 font-medium whitespace-nowrap">{c.nome}</td>
                            {c.valores.map((v, i) => <td key={i} className="px-3 py-2 text-right text-red-500 whitespace-nowrap">{v > 0 ? fmt(v) : "—"}</td>)}
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {c.variacao === null ? "—" : (
                                <span className={`font-semibold ${c.variacao <= 0 ? "text-emerald-600" : "text-red-500"}`}>{c.variacao >= 0 ? "↑" : "↓"} {Math.abs(c.variacao).toFixed(1)}%</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={imprimirComparativo} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
                  🖨️ Imprimir Comparativo / PDF
                </button>
                <button onClick={exportarCSVComparativo} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
                  📥 Exportar CSV
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== ANUAL ===== */}
      {aba === "anual" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
            <button onClick={() => setAno(ano - 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← {ano - 1}</button>
            <p className="font-bold text-lg">{ano}</p>
            <button onClick={() => setAno(ano + 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">{ano + 1} →</button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Receita Anual", value: fmt(tAno.entradas), color: "text-emerald-600" },
              { label: "Despesas Anual", value: fmt(tAno.saidas), color: "text-red-500" },
              { label: "Resultado", value: fmt(tAno.resultado), color: tAno.resultado >= 0 ? "text-emerald-600" : "text-red-500" },
              { label: "Margem", value: `${tAno.margem.toFixed(1)}%`, color: tAno.margem >= 0 ? "text-emerald-600" : "text-red-500" },
            ].map((c) => (
              <div key={c.label} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{c.label}</p>
                <p className={`text-xl font-bold mt-1 ${c.color}`}>{c.value}</p>
              </div>
            ))}
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)]"><h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)]">Evolução Mês a Mês</h2></div>
            <div className="divide-y divide-[var(--color-border)]">
              {evolucao.map((m) => (
                <div key={m.nome} className="p-4 hover:bg-[var(--color-bg)] transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium capitalize">{m.nome}</span>
                    <span className={`text-sm font-bold ${m.resultado >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmt(m.resultado)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <div className="flex justify-between text-xs mb-1"><span className="text-[var(--color-text-muted)]">Receita</span><span className="text-emerald-600">{fmt(m.entradas)}</span></div>
                      <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${maxBarra > 0 ? (m.entradas / maxBarra) * 100 : 0}%` }} /></div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1"><span className="text-[var(--color-text-muted)]">Despesa</span><span className="text-red-500">{fmt(m.saidas)}</span></div>
                      <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full" style={{ width: `${maxBarra > 0 ? (m.saidas / maxBarra) * 100 : 0}%` }} /></div>
                    </div>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Acumulado: <span className={`font-medium ${m.acumulado >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmt(m.acumulado)}</span> · Margem: <span className="font-medium">{m.margem.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={imprimirAnual} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              🖨️ Imprimir / Salvar PDF
            </button>
            <button onClick={exportarCSVAnual} className="flex-1 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
              📥 Exportar CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
