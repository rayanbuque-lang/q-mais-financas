"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

interface MesDado {
  mes: number;
  ano: number;
  nome: string;
  entradas: number;
  saidas: number;
  resultado: number;
  margem: number;
}

const MESES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function fmt(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fetchTodasMovimentacoes(
  supabase: ReturnType<typeof createClient>,
  inicio: string,
  fim: string
) {
  return fetchAllRows<{ tipo: string; valor: number; data: string }>((from, to) =>
    supabase.from("movimentacoes").select("tipo,valor,data").gte("data", inicio).lte("data", fim).range(from, to)
  );
}

export default function ComparativoPage() {
  const [dados, setDados] = useState<MesDado[]>([]);
  const [loading, setLoading] = useState(true);
  const [mesSelecionado, setMesSelecionado] = useState<number | null>(null);
  const [modo, setModo] = useState<"receita" | "despesa" | "resultado">("receita");
  const [periodos, setPeriodos] = useState(12);
  const supabase = createClient();

  useEffect(() => {
    carregarDados();
  }, [periodos]);

  async function carregarDados() {
    setLoading(true);
    const agora = new Date();
    const mesesList: { mes: number; ano: number }[] = [];
    for (let i = periodos - 1; i >= 0; i--) {
      let m = agora.getMonth() - i;
      let a = agora.getFullYear();
      while (m < 0) { m += 12; a--; }
      mesesList.push({ mes: m, ano: a });
    }

    const primeiro = mesesList[0];
    const ultimo = mesesList[mesesList.length - 1];
    const inicio = `${primeiro.ano}-${String(primeiro.mes + 1).padStart(2, "0")}-01`;
    const fimDia = new Date(ultimo.ano, ultimo.mes + 1, 0).getDate();
    const fim = `${ultimo.ano}-${String(ultimo.mes + 1).padStart(2, "0")}-${String(fimDia).padStart(2, "0")}`;

    const movs = await fetchTodasMovimentacoes(supabase, inicio, fim);

    const lista = mesesList.map(({ mes, ano }) => {
      const inicioM = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
      const fimM = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(new Date(ano, mes + 1, 0).getDate()).padStart(2, "0")}`;
      const movsM = (movs || []).filter(m => m.data >= inicioM && m.data <= fimM);
      const entradas = movsM.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
      const saidas = movsM.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
      const resultado = entradas - saidas;
      const margem = entradas > 0 ? (resultado / entradas) * 100 : 0;
      return { mes, ano, nome: `${MESES[mes]}/${String(ano).slice(2)}`, entradas, saidas, resultado, margem };
    });

    setDados(lista);
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--color-text-muted)]">Carregando dados...</p>
      </div>
    );
  }

  const valores = dados.map(d => modo === "receita" ? d.entradas : modo === "despesa" ? d.saidas : d.resultado);
  const maxVal = Math.max(...valores.map(Math.abs), 1);

  const melhorIdx = valores.indexOf(Math.max(...valores));
  const piorIdx = valores.indexOf(Math.min(...valores));

  const totalEntradas = dados.reduce((a, d) => a + d.entradas, 0);
  const totalSaidas = dados.reduce((a, d) => a + d.saidas, 0);
  const totalResultado = totalEntradas - totalSaidas;
  const mediaEntradas = totalEntradas / dados.length;
  const mediaSaidas = totalSaidas / dados.length;

  const mesAtual = dados[dados.length - 1];
  const mesAnterior = dados[dados.length - 2];
  const varReceita = mesAnterior?.entradas > 0 ? ((mesAtual.entradas - mesAnterior.entradas) / mesAnterior.entradas) * 100 : null;
  const varDespesa = mesAnterior?.saidas > 0 ? ((mesAtual.saidas - mesAnterior.saidas) / mesAnterior.saidas) * 100 : null;

  const selecionado = mesSelecionado !== null ? dados[mesSelecionado] : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Painel Comparativo</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">Evolução visual mês a mês</p>
      </div>

      {/* KPI rápidos */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Receita (período)", valor: fmt(totalEntradas), cor: "text-emerald-600", bg: "bg-emerald-50", icon: "📈" },
          { label: "Despesa (período)", valor: fmt(totalSaidas), cor: "text-red-500", bg: "bg-red-50", icon: "📉" },
          { label: "Resultado total", valor: fmt(totalResultado), cor: totalResultado >= 0 ? "text-emerald-700" : "text-red-600", bg: totalResultado >= 0 ? "bg-emerald-50" : "bg-red-50", icon: "💰" },
          { label: "Média mensal (receita)", valor: fmt(mediaEntradas), cor: "text-blue-600", bg: "bg-blue-50", icon: "📊" },
        ].map(c => (
          <div key={c.label} className={`${c.bg} rounded-2xl p-5`}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{c.label}</p>
              <span className="text-base">{c.icon}</span>
            </div>
            <p className={`text-xl font-bold ${c.cor}`}>{c.valor}</p>
          </div>
        ))}
      </div>

      {/* Comparativo mês atual vs anterior */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {varReceita !== null && (
          <div className={`rounded-2xl p-5 border ${varReceita >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Receita: {mesAtual.nome} vs {mesAnterior.nome}</p>
            <p className={`text-2xl font-bold ${varReceita >= 0 ? "text-emerald-600" : "text-red-500"}`}>
              {varReceita > 0 ? "↑" : "↓"} {Math.abs(varReceita).toFixed(1)}%
            </p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">{fmt(mesAtual.entradas)} vs {fmt(mesAnterior.entradas)}</p>
          </div>
        )}
        {varDespesa !== null && (
          <div className={`rounded-2xl p-5 border ${varDespesa <= 0 ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Despesa: {mesAtual.nome} vs {mesAnterior.nome}</p>
            <p className={`text-2xl font-bold ${varDespesa <= 0 ? "text-emerald-600" : "text-amber-600"}`}>
              {varDespesa > 0 ? "↑" : "↓"} {Math.abs(varDespesa).toFixed(1)}%
            </p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">{fmt(mesAtual.saidas)} vs {fmt(mesAnterior.saidas)}</p>
          </div>
        )}
      </div>

      {/* Gráfico principal */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)]">Gráfico Comparativo</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Clique em um mês para detalhar</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="flex gap-1 bg-[var(--color-bg)] rounded-lg p-1">
              {(["receita","despesa","resultado"] as const).map(m => (
                <button key={m} onClick={() => setModo(m)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold capitalize transition ${modo === m ? "bg-white shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                  {m === "receita" ? "Receita" : m === "despesa" ? "Despesa" : "Resultado"}
                </button>
              ))}
            </div>
            <select value={periodos} onChange={e => setPeriodos(Number(e.target.value))}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs font-medium focus:outline-none">
              <option value={6}>6 meses</option>
              <option value={12}>12 meses</option>
            </select>
          </div>
        </div>

        <div className="flex items-end gap-2 h-64 pb-8 relative">
          {/* Linha de média */}
          <div
            className="absolute left-0 right-0 border-t-2 border-dashed border-blue-300 pointer-events-none"
            style={{ bottom: `${32 + ((modo === "receita" ? mediaEntradas : mediaSaidas) / maxVal) * (256 - 32)}px` }}
          >
            <span className="absolute right-0 -top-4 text-[10px] text-blue-500 font-medium pr-1">média</span>
          </div>

          {dados.map((d, i) => {
            const val = modo === "receita" ? d.entradas : modo === "despesa" ? d.saidas : d.resultado;
            const pct = Math.abs(val) / maxVal;
            const isNeg = val < 0;
            const isSelecionado = mesSelecionado === i;
            const isMelhor = i === melhorIdx && !isNeg;
            const isPior = i === piorIdx;
            const corBase = modo === "receita" ? (isSelecionado ? "bg-emerald-700" : "bg-emerald-500 hover:bg-emerald-600")
              : modo === "despesa" ? (isSelecionado ? "bg-red-700" : "bg-red-500 hover:bg-red-600")
              : isNeg ? (isSelecionado ? "bg-red-700" : "bg-red-400 hover:bg-red-500")
              : (isSelecionado ? "bg-blue-700" : "bg-blue-500 hover:bg-blue-600");

            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end cursor-pointer group"
                onClick={() => setMesSelecionado(isSelecionado ? null : i)}>
                {isMelhor && <span className="text-[9px] text-emerald-600 font-bold">★</span>}
                {isPior && !isMelhor && <span className="text-[9px] text-red-500 font-bold">▼</span>}
                <div
                  className={`w-full rounded-t-lg transition-all duration-500 ${corBase} ${isSelecionado ? "ring-2 ring-offset-1 ring-current" : ""}`}
                  style={{
                    height: `${pct * 85}%`,
                    minHeight: val !== 0 ? "6px" : "0",
                    transformOrigin: "bottom",
                  }}
                />
                <span className={`text-[10px] font-medium transition-colors ${isSelecionado ? "text-[var(--color-text)] font-bold" : "text-[var(--color-text-muted)]"}`}>
                  {d.nome}
                </span>
              </div>
            );
          })}
        </div>

        {/* Detalhe do mês selecionado */}
        {selecionado && (
          <div className="mt-4 p-5 bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)]">
            <div className="flex items-center justify-between mb-4">
              <p className="font-bold text-sm capitalize">{selecionado.nome}</p>
              <button onClick={() => setMesSelecionado(null)} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition">✕ Fechar</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Receita", valor: fmt(selecionado.entradas), cor: "text-emerald-600", bg: "bg-emerald-50" },
                { label: "Despesa", valor: fmt(selecionado.saidas), cor: "text-red-500", bg: "bg-red-50" },
                { label: "Resultado", valor: fmt(selecionado.resultado), cor: selecionado.resultado >= 0 ? "text-emerald-700" : "text-red-600", bg: selecionado.resultado >= 0 ? "bg-emerald-50" : "bg-red-50" },
                { label: "Margem", valor: `${selecionado.margem.toFixed(1)}%`, cor: selecionado.margem >= 0 ? "text-blue-600" : "text-red-500", bg: "bg-blue-50" },
              ].map(c => (
                <div key={c.label} className={`${c.bg} rounded-xl p-4 text-center`}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.label}</p>
                  <p className={`text-sm font-bold ${c.cor}`}>{c.valor}</p>
                </div>
              ))}
            </div>
            {/* Barra de progresso receita vs despesa */}
            <div className="mt-4">
              <div className="flex justify-between text-xs text-[var(--color-text-muted)] mb-1">
                <span>Receita</span>
                <span>Despesa: {selecionado.entradas > 0 ? ((selecionado.saidas / selecionado.entradas) * 100).toFixed(0) : 0}% da receita</span>
              </div>
              <div className="w-full h-3 bg-emerald-100 rounded-full overflow-hidden">
                <div className="h-full bg-red-400 rounded-full transition-all duration-500"
                  style={{ width: `${selecionado.entradas > 0 ? Math.min((selecionado.saidas / selecionado.entradas) * 100, 100) : 0}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tabela resumo */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-[var(--color-border)]">
          <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)]">Tabela Resumo</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs font-semibold uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Mês</th>
                <th className="px-4 py-3 text-right">Receita</th>
                <th className="px-4 py-3 text-right">Despesa</th>
                <th className="px-4 py-3 text-right">Resultado</th>
                <th className="px-4 py-3 text-right">Margem</th>
                <th className="px-4 py-3 text-right">vs Anterior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {dados.map((d, i) => {
                const prev = dados[i - 1];
                const var_ = prev && prev.entradas > 0 ? ((d.entradas - prev.entradas) / prev.entradas) * 100 : null;
                const isLast = i === dados.length - 1;
                return (
                  <tr key={i} className={`hover:bg-[var(--color-bg)] transition cursor-pointer ${isLast ? "font-semibold bg-[var(--color-bg)]" : ""} ${i === melhorIdx ? "bg-emerald-50/50" : ""}`}
                    onClick={() => setMesSelecionado(mesSelecionado === i ? null : i)}>
                    <td className="px-4 py-3 font-medium capitalize">
                      {d.nome}
                      {i === melhorIdx && <span className="ml-2 text-[10px] text-emerald-600 font-bold">★ melhor</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-600 font-medium">{fmt(d.entradas)}</td>
                    <td className="px-4 py-3 text-right text-red-500 font-medium">{fmt(d.saidas)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${d.resultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmt(d.resultado)}</td>
                    <td className={`px-4 py-3 text-right text-xs ${d.margem >= 0 ? "text-emerald-600" : "text-red-500"}`}>{d.margem.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right text-xs">
                      {var_ !== null ? (
                        <span className={`font-semibold ${var_ >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                          {var_ > 0 ? "↑" : "↓"} {Math.abs(var_).toFixed(1)}%
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-[var(--color-bg)] font-bold border-t-2 border-[var(--color-border)]">
                <td className="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Total</td>
                <td className="px-4 py-3 text-right text-emerald-600">{fmt(totalEntradas)}</td>
                <td className="px-4 py-3 text-right text-red-500">{fmt(totalSaidas)}</td>
                <td className={`px-4 py-3 text-right ${totalResultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmt(totalResultado)}</td>
                <td className="px-4 py-3 text-right text-xs text-[var(--color-text-muted)]">
                  {totalEntradas > 0 ? ((totalResultado / totalEntradas) * 100).toFixed(1) : 0}%
                </td>
                <td className="px-4 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
