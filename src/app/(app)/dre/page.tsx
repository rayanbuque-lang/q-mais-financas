"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface Movimentacao {
  tipo: string;
  valor: number;
  data: string;
  categoria_id: string;
}

interface Categoria {
  id: string;
  nome: string;
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

export default function DrePage() {
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [movimentacoes, setMovimentacoes] = useState<Movimentacao[]>([]);
  const [catEntrada, setCatEntrada] = useState<Categoria[]>([]);
  const [catSaida, setCatSaida] = useState<Categoria[]>([]);
  const supabase = createClient();

  async function carregarDados() {
    const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const fim = new Date(ano, mes + 1, 0);
    const fimStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(fim.getDate()).padStart(2, "0")}`;

    const { data: movs } = await supabase
      .from("movimentacoes")
      .select("*")
      .gte("data", inicio)
      .lte("data", fimStr);

    const { data: catsEntrada } = await supabase
      .from("categorias_entrada")
      .select("*")
      .eq("ativo", true);

    const { data: catsSaida } = await supabase
      .from("categorias_saida")
      .select("*")
      .eq("ativo", true);

    if (movs) setMovimentacoes(movs);
    if (catsEntrada) setCatEntrada(catsEntrada);
    if (catsSaida) setCatSaida(catsSaida);
  }

  useEffect(() => {
    carregarDados();
  }, [mes, ano]);

  // Calcular totais por tipo
  const entradas = movimentacoes.filter((m) => m.tipo === "entrada");
  const saidas = movimentacoes.filter((m) => m.tipo === "saida");

  const totalEntradas = entradas.reduce((acc, m) => acc + m.valor, 0);
  const totalSaidas = saidas.reduce((acc, m) => acc + m.valor, 0);
  const resultado = totalEntradas - totalSaidas;
  const margem = totalEntradas > 0 ? (resultado / totalEntradas) * 100 : 0;

  // Agrupar entradas por categoria
  const entradasPorCategoria = catEntrada.map((cat) => {
    const total = entradas
      .filter((m) => m.categoria_id === cat.id)
      .reduce((acc, m) => acc + m.valor, 0);
    return { nome: cat.nome, total };
  }).filter((c) => c.total > 0);

  // Agrupar saídas por categoria
  const saidasPorCategoria = catSaida.map((cat) => {
    const total = saidas
      .filter((m) => m.categoria_id === cat.id)
      .reduce((acc, m) => acc + m.valor, 0);
    return { nome: cat.nome, total };
  }).filter((c) => c.total > 0);

  function formatarMoeda(valor: number) {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function porcentagem(valor: number, total: number) {
    if (total === 0) return "0%";
    return ((valor / total) * 100).toFixed(1) + "%";
  }

  // Navegar entre meses
  function mesAnterior() {
    if (mes === 0) {
      setMes(11);
      setAno(ano - 1);
    } else {
      setMes(mes - 1);
    }
  }

  function mesProximo() {
    if (mes === 11) {
      setMes(0);
      setAno(ano + 1);
    } else {
      setMes(mes + 1);
    }
  }

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-bold">DRE - Demonstrativo</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          Resultado do período automaticamente
        </p>
      </div>

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button
          onClick={mesAnterior}
          className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition"
        >
          ← Anterior
        </button>
        <div className="text-center">
          <p className="font-semibold text-lg capitalize">{meses[mes]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button
          onClick={mesProximo}
          className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition"
        >
          Próximo →
        </button>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-sm text-[var(--color-text-muted)]">Receita Total</p>
          <p className="text-xl font-bold text-[var(--color-primary)] mt-1">
            {formatarMoeda(totalEntradas)}
          </p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-sm text-[var(--color-text-muted)]">Despesas Totais</p>
          <p className="text-xl font-bold text-[var(--color-danger)] mt-1">
            {formatarMoeda(totalSaidas)}
          </p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-sm text-[var(--color-text-muted)]">Resultado</p>
          <p className={`text-xl font-bold mt-1 ${resultado >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
            {formatarMoeda(resultado)}
          </p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-sm text-[var(--color-text-muted)]">Margem</p>
          <p className={`text-xl font-bold mt-1 ${margem >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
            {margem.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* DRE detalhado */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Receitas por categoria */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)] bg-[var(--color-primary-light)]">
            <h2 className="font-semibold text-[var(--color-primary-dark)]">
              (+) Receitas
            </h2>
          </div>
          {entradasPorCategoria.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              Nenhuma receita neste mês
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {entradasPorCategoria.map((cat) => (
                <div key={cat.nome} className="flex justify-between items-center p-4">
                  <span className="text-sm">{cat.nome}</span>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-[var(--color-primary)]">
                      {formatarMoeda(cat.total)}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)] ml-2">
                      ({porcentagem(cat.total, totalEntradas)})
                    </span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center p-4 bg-[var(--color-bg)]">
                <span className="text-sm font-bold">Total Receitas</span>
                <span className="text-sm font-bold text-[var(--color-primary)]">
                  {formatarMoeda(totalEntradas)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Despesas por categoria */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
            <h2 className="font-semibold text-[var(--color-danger)]">
              (-) Despesas
            </h2>
          </div>
          {saidasPorCategoria.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              Nenhuma despesa neste mês
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {saidasPorCategoria.map((cat) => (
                <div key={cat.nome} className="flex justify-between items-center p-4">
                  <span className="text-sm">{cat.nome}</span>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-[var(--color-danger)]">
                      {formatarMoeda(cat.total)}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)] ml-2">
                      ({porcentagem(cat.total, totalSaidas)})
                    </span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center p-4 bg-[var(--color-bg)]">
                <span className="text-sm font-bold">Total Despesas</span>
                <span className="text-sm font-bold text-[var(--color-danger)]">
                  {formatarMoeda(totalSaidas)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Resultado final */}
      <div className={`rounded-2xl p-6 text-center border ${
        resultado >= 0
          ? "bg-[var(--color-primary-light)] border-[var(--color-primary)]"
          : "bg-red-50 border-[var(--color-danger)]"
      }`}>
        <p className="text-sm font-medium text-[var(--color-text-muted)] mb-1">
          Resultado do Período
        </p>
        <p className={`text-3xl font-bold ${resultado >= 0 ? "text-[var(--color-primary-dark)]" : "text-[var(--color-danger)]"}`}>
          {formatarMoeda(resultado)}
        </p>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">
          {resultado >= 0
            ? "Lucro no período. Continue assim!"
            : "Déficit no período. Revise as despesas."}
        </p>
      </div>
    </div>
  );
}
