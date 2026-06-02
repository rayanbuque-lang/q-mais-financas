"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface Movimentacao {
  tipo: string; valor: number; data: string; categoria_id: string;
}

interface Categoria { id: string; nome: string; }

const meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function DrePage() {
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [movimentacoes, setMovimentacoes] = useState<Movimentacao[]>([]);
  const [todasCats, setTodasCats] = useState<Categoria[]>([]);
  const supabase = createClient();

  async function carregarDados() {
    const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const fimStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const [r1, r2, r3] = await Promise.all([
      supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fimStr),
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true),
    ]);

    if (r1.data) setMovimentacoes(r1.data);
    const cats: Categoria[] = [...(r2.data || []), ...(r3.data || [])];
    setTodasCats(cats);
  }

  useEffect(() => { carregarDados(); }, [mes, ano]);

  function getNomeCategoria(id: string): string {
    return todasCats.find(c => c.id === id)?.nome || "Sem categoria";
  }

  function mesAnterior() { if (mes === 0) { setMes(11); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 11) { setMes(0); setAno(ano + 1); } else setMes(mes + 1); }
  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function pct(v: number, t: number) { return t === 0 ? "0%" : ((v / t) * 100).toFixed(1) + "%"; }

  const entradas = movimentacoes.filter(m => m.tipo === "entrada");
  const saidas = movimentacoes.filter(m => m.tipo === "saida");
  const totalEntradas = entradas.reduce((a, m) => a + m.valor, 0);
  const totalSaidas = saidas.reduce((a, m) => a + m.valor, 0);
  const resultado = totalEntradas - totalSaidas;
  const margem = totalEntradas > 0 ? (resultado / totalEntradas) * 100 : 0;

  // Agrupar por categoria (usando todas as categorias)
  const entradasPorCategoria = Object.entries(
    entradas.reduce((acc: Record<string, number>, m) => {
      const nome = getNomeCategoria(m.categoria_id);
      acc[nome] = (acc[nome] || 0) + m.valor;
      return acc;
    }, {})
  ).map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total);

  const saidasPorCategoria = Object.entries(
    saidas.reduce((acc: Record<string, number>, m) => {
      const nome = getNomeCategoria(m.categoria_id);
      acc[nome] = (acc[nome] || 0) + m.valor;
      return acc;
    }, {})
  ).map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">DRE - Demonstrativo</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">Resultado do período automaticamente</p>
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-semibold text-lg capitalize">{meses[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { l: "Receita Total", v: fmt(totalEntradas), c: "text-[var(--color-primary)]" },
          { l: "Despesas Totais", v: fmt(totalSaidas), c: "text-[var(--color-danger)]" },
          { l: "Resultado", v: fmt(resultado), c: resultado >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]" },
          { l: "Margem", v: `${margem.toFixed(1)}%`, c: margem >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]" },
        ].map(c => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <p className="text-sm text-[var(--color-text-muted)]">{c.l}</p>
            <p className={`text-xl font-bold mt-1 ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Receitas */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50">
            <h2 className="font-semibold text-emerald-700">(+) Receitas</h2>
          </div>
          {entradasPorCategoria.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhuma receita neste mês</div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {entradasPorCategoria.map(cat => (
                <div key={cat.nome} className="flex justify-between items-center p-4">
                  <span className="text-sm">{cat.nome}</span>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-emerald-600">{fmt(cat.total)}</span>
                    <span className="text-xs text-[var(--color-text-muted)] ml-2">({pct(cat.total, totalEntradas)})</span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center p-4 bg-[var(--color-bg)]">
                <span className="text-sm font-bold">Total Receitas</span>
                <span className="text-sm font-bold text-emerald-600">{fmt(totalEntradas)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Despesas */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
            <h2 className="font-semibold text-red-600">(-) Despesas</h2>
          </div>
          {saidasPorCategoria.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhuma despesa neste mês</div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {saidasPorCategoria.map(cat => (
                <div key={cat.nome} className="flex justify-between items-center p-4">
                  <span className="text-sm">{cat.nome}</span>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-red-500">{fmt(cat.total)}</span>
                    <span className="text-xs text-[var(--color-text-muted)] ml-2">({pct(cat.total, totalSaidas)})</span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center p-4 bg-[var(--color-bg)]">
                <span className="text-sm font-bold">Total Despesas</span>
                <span className="text-sm font-bold text-red-500">{fmt(totalSaidas)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={`rounded-2xl p-6 text-center border ${resultado >= 0 ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}>
        <p className="text-sm font-medium text-[var(--color-text-muted)] mb-1">Resultado do Período</p>
        <p className={`text-3xl font-bold ${resultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmt(resultado)}</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">
          {resultado >= 0 ? "Lucro no período. Continue assim!" : "Déficit no período. Revise as despesas."}
        </p>
      </div>
    </div>
  );
}
