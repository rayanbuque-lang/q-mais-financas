"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

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
    @media print{body{padding:20px}.no-print{display:none}}
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

export default function RelatoriosPage() {
  const [ano, setAno] = useState(new Date().getFullYear());
  const [mes, setMes] = useState(new Date().getMonth());
  const [aba, setAba] = useState<"mensal" | "anual" | "categorias">("mensal");
  const [movimentacoesAno, setMovimentacoesAno] = useState<Movimentacao[]>([]);
  const [catEntrada, setCatEntrada] = useState<{ id: string; nome: string }[]>([]);
  const [catSaida, setCatSaida] = useState<{ id: string; nome: string }[]>([]);
  const supabase = createClient();

  async function carregarDados() {
    const inicio = `${ano}-01-01`;
    const fim = `${ano}-12-31`;
    const [r1, r2, r3] = await Promise.all([
      supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).order("data"),
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true),
    ]);
    if (r1.data) setMovimentacoesAno(r1.data);
    if (r2.data) setCatEntrada(r2.data);
    if (r3.data) setCatSaida(r3.data);
  }

  useEffect(() => { carregarDados(); }, [ano]);

  function mesAnterior() { if (mes === 0) { setMes(11); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 11) { setMes(0); setAno(ano + 1); } else setMes(mes + 1); }

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

  function getCatsTotais(movs: Movimentacao[], cats: { id: string; nome: string }[], tipo: string) {
    return cats.map((cat) => {
      const total = movs.filter((m) => m.tipo === tipo && m.categoria_id === cat.id).reduce((a, m) => a + m.valor, 0);
      return { nome: cat.nome, total };
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

  // ===== IMPRESSÃO =====
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
    const rowsE = catsEntradaMes.map((c) => `<tr><td>${c.nome}</td><td class="positivo">${fmt(c.total)}</td><td>${((c.total / tMes.entradas) * 100).toFixed(1)}%</td></tr>`).join("");
    const rowsS = catsSaidaMes.map((c) => `<tr><td>${c.nome}</td><td class="negativo">${fmt(c.total)}</td><td>${((c.total / tMes.saidas) * 100).toFixed(1)}%</td></tr>`).join("");
    gerarImpressao("Relatório por Categoria", `${meses[mes]} de ${ano}`, `
      ${rowsE ? `<h2>(+) Receitas por Categoria</h2><table><thead><tr><th>Categoria</th><th>Valor</th><th>%</th></tr></thead><tbody>${rowsE}</tbody></table>` : "<p>Nenhuma receita neste período.</p>"}
      ${rowsS ? `<h2>(-) Despesas por Categoria</h2><table><thead><tr><th>Categoria</th><th>Valor</th><th>%</th></tr></thead><tbody>${rowsS}</tbody></table>` : "<p>Nenhuma despesa neste período.</p>"}
    `);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Relatórios</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Visão completa do desempenho financeiro</p>
        </div>
      </div>

      {/* Abas */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
        {(["mensal", "anual", "categorias"] as const).map((v) => (
          <button key={v} onClick={() => setAba(v)} className={`flex-1 py-2.5 rounded-lg text-sm font-medium capitalize transition ${aba === v ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
            {v === "mensal" ? "Mensal" : v === "anual" ? "Anual" : "Por Categoria"}
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
                  <div key={cat.nome}>
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
                  <div key={cat.nome}>
                    <div className="flex justify-between text-sm mb-1"><span>{cat.nome}</span><span className="font-semibold text-red-500">{fmt(cat.total)} ({((cat.total / tMes.saidas) * 100).toFixed(1)}%)</span></div>
                    <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.saidas) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Botão imprimir */}
          <button onClick={imprimirMensal} className="w-full py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
            🖨️ Imprimir / Salvar PDF
          </button>
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

          <button onClick={imprimirAnual} className="w-full py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
            🖨️ Imprimir / Salvar PDF
          </button>
        </div>
      )}

      {/* ===== CATEGORIAS ===== */}
      {aba === "categorias" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
            <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
            <div className="text-center"><p className="font-bold capitalize">{meses[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
            <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50">
              <div className="flex justify-between items-center"><h3 className="font-bold text-emerald-800">Receitas por Categoria</h3><span className="text-sm font-bold text-emerald-700">{fmt(tMes.entradas)}</span></div>
            </div>
            {catsEntradaMes.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
              <div className="divide-y divide-[var(--color-border)]">
                {catsEntradaMes.map((cat) => (
                  <div key={cat.nome} className="p-4">
                    <div className="flex justify-between items-center mb-2"><span className="text-sm font-medium">{cat.nome}</span><div className="text-right"><span className="text-sm font-bold text-emerald-600">{fmt(cat.total)}</span><span className="text-xs text-[var(--color-text-muted)] ml-2">{((cat.total / tMes.entradas) * 100).toFixed(1)}%</span></div></div>
                    <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.entradas) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
              <div className="flex justify-between items-center"><h3 className="font-bold text-red-700">Despesas por Categoria</h3><span className="text-sm font-bold text-red-500">{fmt(tMes.saidas)}</span></div>
            </div>
            {catsSaidaMes.length === 0 ? <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Sem dados</div> : (
              <div className="divide-y divide-[var(--color-border)]">
                {catsSaidaMes.map((cat) => (
                  <div key={cat.nome} className="p-4">
                    <div className="flex justify-between items-center mb-2"><span className="text-sm font-medium">{cat.nome}</span><div className="text-right"><span className="text-sm font-bold text-red-500">{fmt(cat.total)}</span><span className="text-xs text-[var(--color-text-muted)] ml-2">{((cat.total / tMes.saidas) * 100).toFixed(1)}%</span></div></div>
                    <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${(cat.total / tMes.saidas) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={imprimirCategorias} className="w-full py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2">
            🖨️ Imprimir / Salvar PDF
          </button>
        </div>
      )}
    </div>
  );
}
