"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
  observacao: string;
  revisar: boolean;
  created_at: string;
}

interface MesGrafico {
  nome: string;
  entradas: number;
  saidas: number;
}

interface ContaPendente {
  id: string;
  fornecedor: string;
  valor: number;
  data_vencimento: string;
}

export default function DashboardPage() {
  const [movAtual, setMovAtual] = useState<Movimentacao[]>([]);
  const [movAnterior, setMovAnterior] = useState<Movimentacao[]>([]);
  const [movRecentes, setMovRecentes] = useState<Movimentacao[]>([]);
  const [grafico, setGrafico] = useState<MesGrafico[]>([]);
  const [contasPendentes, setContasPendentes] = useState<ContaPendente[]>([]);
  const [loading, setLoading] = useState(true);
  const [recentesNomes, setRecentesNomes] = useState<Record<string, string>>({});
  const supabase = createClient();

  const now = new Date();
  const mesAtual = now.getMonth();
  const anoAtual = now.getFullYear();
  const hoje = now.toISOString().split("T")[0];

  const saudacao =
    now.getHours() < 12
      ? "Bom dia"
      : now.getHours() < 18
      ? "Boa tarde"
      : "Boa noite";
  const nomeMes = now.toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  async function carregarDados() {
    setLoading(true);

    const inicioAtual = `${anoAtual}-${String(mesAtual + 1).padStart(
      2,
      "0"
    )}-01`;
    const fimAtual = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(
      new Date(anoAtual, mesAtual + 1, 0).getDate()
    ).padStart(2, "0")}`;

    let mesAnt = mesAtual - 1;
    let anoAnt = anoAtual;
    if (mesAnt < 0) {
      mesAnt = 11;
      anoAnt = anoAtual - 1;
    }
    const inicioAnt = `${anoAnt}-${String(mesAnt + 1).padStart(2, "0")}-01`;
    const fimAnt = `${anoAnt}-${String(mesAnt + 1).padStart(2, "0")}-${String(
      new Date(anoAnt, mesAnt + 1, 0).getDate()
    ).padStart(2, "0")}`;

    const [r1, r2, r3, r4, r5] = await Promise.all([
      supabase
        .from("movimentacoes")
        .select("*")
        .gte("data", inicioAtual)
        .lte("data", fimAtual),
      supabase
        .from("movimentacoes")
        .select("*")
        .gte("data", inicioAnt)
        .lte("data", fimAnt),
      supabase
        .from("movimentacoes")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("contas_pagar")
        .select("*")
        .eq("status", "pendente")
        .order("data_vencimento", { ascending: true }),
      supabase.from("movimentacoes").select("tipo,valor,data"),
    ]);

    if (r1.data) setMovAtual(r1.data);
    if (r2.data) setMovAnterior(r2.data);
    if (r3.data) setMovRecentes(r3.data);
    if (r4.data) setContasPendentes(r4.data);

    const graficoData: MesGrafico[] = [];
    const todosMovs = r5.data || [];
    for (let i = 5; i >= 0; i--) {
      let gMes = mesAtual - i;
      let gAno = anoAtual;
      if (gMes < 0) {
        gMes += 12;
        gAno--;
      }
      const gInicio = `${gAno}-${String(gMes + 1).padStart(2, "0")}-01`;
      const gFim = `${gAno}-${String(gMes + 1).padStart(2, "0")}-${String(
        new Date(gAno, gMes + 1, 0).getDate()
      ).padStart(2, "0")}`;
      const gMovs = todosMovs.filter(
        (m) => m.data >= gInicio && m.data <= gFim
      );
      graficoData.push({
        nome: new Date(gAno, gMes).toLocaleDateString("pt-BR", {
          month: "short",
        }),
        entradas: gMovs
          .filter((m) => m.tipo === "entrada")
          .reduce((a, m) => a + m.valor, 0),
        saidas: gMovs
          .filter((m) => m.tipo === "saida")
          .reduce((a, m) => a + m.valor, 0),
      });
    }
    setGrafico(graficoData);
    setLoading(false);
  }

  async function carregarNomesRecentes() {
    const nomes: Record<string, string> = {};
    for (const mov of movRecentes) {
      const tabela =
        mov.tipo === "entrada" ? "categorias_entrada" : "categorias_saida";
      const { data } = await supabase
        .from(tabela)
        .select("nome")
        .eq("id", mov.categoria_id)
        .single();
      nomes[mov.id] = data?.nome || "Sem categoria";
    }
    setRecentesNomes(nomes);
  }

  useEffect(() => {
    carregarDados();
  }, []);
  useEffect(() => {
    if (movRecentes.length > 0) carregarNomesRecentes();
  }, [movRecentes]);

  function fmt(v: number) {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function variacao(atual: number, anterior: number) {
    if (anterior === 0) return null;
    return ((atual - anterior) / anterior) * 100;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--color-text-muted)]">Carregando dados...</p>
      </div>
    );
  }

  const eAtual = movAtual
    .filter((m) => m.tipo === "entrada")
    .reduce((a, m) => a + m.valor, 0);
  const sAtual = movAtual
    .filter((m) => m.tipo === "saida")
    .reduce((a, m) => a + m.valor, 0);
  const lucro = eAtual - sAtual;
  const margem = eAtual > 0 ? (lucro / eAtual) * 100 : 0;

  const eAnterior = movAnterior
    .filter((m) => m.tipo === "entrada")
    .reduce((a, m) => a + m.valor, 0);
  const sAnterior = movAnterior
    .filter((m) => m.tipo === "saida")
    .reduce((a, m) => a + m.valor, 0);

  const varReceita = variacao(eAtual, eAnterior);
  const varDespesa = variacao(sAtual, sAnterior);
  const revisaoCount = movAtual.filter((m) => m.revisar).length;
  const maxGrafico = Math.max(
    ...grafico.map((g) => Math.max(g.entradas, g.saidas)),
    1
  );

  // Contas que vencem HOJE
  const contasHoje = contasPendentes.filter((c) => c.data_vencimento === hoje);
  const totalContasHoje = contasHoje.reduce((a, c) => a + c.valor, 0);

  // Contas vencidas (antes de hoje)
  const contasVencidas = contasPendentes.filter(
    (c) => c.data_vencimento < hoje
  );

  let resumoTexto = "";
  if (movAtual.length === 0) {
    resumoTexto =
      "Nenhuma movimentação registrada este mês. Comece cadastrando suas entradas e saídas.";
  } else if (lucro > 0 && varReceita !== null && varReceita > 0) {
    resumoTexto = `Receita cresceu ${varReceita.toFixed(
      1
    )}%. Lucro de ${fmt(lucro)} com margem de ${margem.toFixed(1)}%.`;
  } else if (lucro > 0) {
    resumoTexto = `Lucro de ${fmt(lucro)} com margem de ${margem.toFixed(1)}%.`;
  } else if (lucro < 0) {
    resumoTexto = `Atenção: despesas superaram receita em ${fmt(
      Math.abs(lucro)
    )}.`;
  } else {
    resumoTexto = "Receita e despesas empatadas.";
  }

  let saudeCor = "text-emerald-700";
  let saudeBg = "bg-emerald-50";
  let saudeLabel = "Excelente";
  let saudeIcono = "🟢";
  if (margem < 0) {
    saudeCor = "text-red-600";
    saudeBg = "bg-red-50";
    saudeLabel = "Crítica";
    saudeIcono = "🔴";
  } else if (margem < 10) {
    saudeCor = "text-amber-600";
    saudeBg = "bg-amber-50";
    saudeLabel = "Atenção";
    saudeIcono = "🟡";
  } else if (margem < 20) {
    saudeCor = "text-emerald-600";
    saudeBg = "bg-emerald-50";
    saudeLabel = "Boa";
    saudeIcono = "🟢";
  }

  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">{saudacao}!</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1 capitalize">
          {nomeMes}
        </p>
      </div>

      <div
        className={`animate-fade-up delay-1 ${saudeBg} border rounded-2xl p-5 flex items-start gap-3`}
      >
        <span className="text-2xl">{saudeIcono}</span>
        <div>
          <p className={`font-bold text-sm ${saudeCor}`}>
            Saúde Financeira: {saudeLabel}
          </p>
          <p className="text-sm text-[var(--color-text)] mt-1">
            {resumoTexto}
          </p>
        </div>
      </div>

      {/* Contas do dia */}
      {contasHoje.length > 0 && (
        <div className="animate-fade-up delay-1 bg-blue-50 border border-blue-200 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span>📅</span>
              <p className="text-sm font-bold text-blue-800">
                {contasHoje.length}{" "}
                {contasHoje.length === 1
                  ? "conta vence hoje"
                  : "contas vencem hoje"}{" "}
                — Total: {fmt(totalContasHoje)}
              </p>
            </div>
            <Link
              href="/contas-pagar"
              className="text-sm font-semibold text-blue-700 hover:text-blue-900 transition"
            >
              Ver todas →
            </Link>
          </div>
          <div className="space-y-1">
            {contasHoje.map((conta) => (
              <div
                key={conta.id}
                className="flex justify-between items-center text-sm bg-white/60 rounded-lg px-3 py-2"
              >
                <span className="text-blue-900 font-medium">
                  {conta.fornecedor}
                </span>
                <span className="font-bold text-blue-700">
                  {fmt(conta.valor)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contas vencidas */}
      {contasVencidas.length > 0 && (
        <div className="animate-fade-up delay-1 bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center gap-3">
          <span className="text-xl">🚨</span>
          <div>
            <p className="text-sm font-bold text-red-800">
              {contasVencidas.length} contas vencidas!
            </p>
            <p className="text-xs text-red-600">
              Total:{" "}
              {fmt(contasVencidas.reduce((a, c) => a + c.valor, 0))}
            </p>
          </div>
        </div>
      )}

      {/* Revisão */}
      {revisaoCount > 0 && (
        <div className="animate-fade-up delay-1 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <p className="text-sm font-medium text-amber-800">
              {revisaoCount} para revisar
            </p>
          </div>
          <Link
            href="/movimentacoes"
            className="text-sm font-semibold text-amber-700 hover:text-amber-900 transition"
          >
            Ver →
          </Link>
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: "Receita",
            value: fmt(eAtual),
            color: "text-emerald-600",
            bg: "bg-emerald-50",
            icon: "📈",
            variacao: varReceita,
            inverter: false,
          },
          {
            label: "Despesas",
            value: fmt(sAtual),
            color: "text-red-500",
            bg: "bg-red-50",
            icon: "📉",
            variacao: varDespesa,
            inverter: true,
          },
          {
            label: "Lucro",
            value: fmt(lucro),
            color: lucro >= 0 ? "text-emerald-700" : "text-red-600",
            bg: lucro >= 0 ? "bg-emerald-50" : "bg-red-50",
            icon: "💰",
            variacao: null,
            inverter: false,
          },
          {
            label: "Margem",
            value: `${margem.toFixed(1)}%`,
            color: margem >= 0 ? "text-emerald-600" : "text-red-600",
            bg: margem >= 0 ? "bg-emerald-50" : "bg-red-50",
            icon: "📊",
            variacao: null,
            inverter: false,
          },
        ].map((card) => (
          <div
            key={card.label}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 hover:shadow-md transition-all duration-200"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {card.label}
              </span>
              <div
                className={`${card.bg} w-9 h-9 rounded-xl flex items-center justify-center text-base`}
              >
                {card.icon}
              </div>
            </div>
            <p className={`text-2xl font-bold ${card.color} tracking-tight`}>
              {card.value}
            </p>
            {card.variacao !== null && (
              <p
                className={`text-xs mt-1 font-medium ${
                  card.inverter
                    ? card.variacao > 0
                      ? "text-red-500"
                      : "text-emerald-600"
                    : card.variacao > 0
                    ? "text-emerald-600"
                    : "text-red-500"
                }`}
              >
                {card.variacao > 0 ? "↑" : "↓"}{" "}
                {Math.abs(card.variacao).toFixed(1)}% vs mês anterior
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Gráfico + Fluxo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)] mb-5">
            Últimos 6 Meses
          </h2>
          <div className="flex items-end gap-3 h-40">
            {grafico.map((g, i) => (
              <div
                key={i}
                className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
              >
                <div className="flex gap-1 items-end w-full h-full">
                  <div
                    className="flex-1 bg-emerald-400 rounded-t-md transition-all duration-700"
                    style={{
                      height: `${
                        maxGrafico > 0
                          ? (g.entradas / maxGrafico) * 100
                          : 0
                      }%`,
                      minHeight: g.entradas > 0 ? "4px" : "0",
                    }}
                  />
                  <div
                    className="flex-1 bg-red-400 rounded-t-md transition-all duration-700"
                    style={{
                      height: `${
                        maxGrafico > 0 ? (g.saidas / maxGrafico) * 100 : 0
                      }%`,
                      minHeight: g.saidas > 0 ? "4px" : "0",
                    }}
                  />
                </div>
                <span className="text-[10px] text-[var(--color-text-muted)] font-medium capitalize">
                  {g.nome}
                </span>
              </div>
            ))}
          </div>
          <div className="flex justify-center gap-6 mt-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-emerald-400" />
              <span className="text-xs text-[var(--color-text-muted)]">
                Entradas
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-red-400" />
              <span className="text-xs text-[var(--color-text-muted)]">
                Saídas
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
            <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)] mb-5">
              Fluxo de Caixa
            </h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-[var(--color-text-muted)]">
                  Entradas
                </span>
                <span className="font-semibold text-emerald-600">
                  {fmt(eAtual)}
                </span>
              </div>
              <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: "100%" }}
                />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-[var(--color-text-muted)]">
                  Saídas
                </span>
                <span className="font-semibold text-red-500">
                  {fmt(sAtual)}
                </span>
              </div>
              <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-500 rounded-full"
                  style={{
                    width: `${eAtual > 0 ? (sAtual / eAtual) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="border-t border-[var(--color-border)] pt-4 flex justify-between items-center">
                <span className="font-bold">Saldo</span>
                <span
                  className={`font-bold text-lg ${
                    lucro >= 0 ? "text-emerald-700" : "text-red-600"
                  }`}
                >
                  {fmt(lucro)}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
            <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)] mb-5">
              Comparativo
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: "vs. Mês Anterior (Receita)",
                  valor: varReceita,
                  invert: false,
                },
                {
                  label: "vs. Mês Anterior (Despesa)",
                  valor: varDespesa,
                  invert: true,
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex justify-between items-center"
                >
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {item.label}
                  </span>
                  {item.valor !== null ? (
                    <span
                      className={`text-sm font-semibold ${
                        item.inverter
                          ? item.valor > 0
                            ? "text-red-500"
                            : "text-emerald-600"
                          : item.valor > 0
                          ? "text-emerald-600"
                          : "text-red-500"
                      }`}
                    >
                      {item.valor > 0 ? "↑" : "↓"}{" "}
                      {Math.abs(item.valor).toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-sm text-[var(--color-text-muted)]">
                      —
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Atividade recente + Ações */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between">
            <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)]">
              Atividade Recente
            </h2>
            <Link
              href="/movimentacoes"
              className="text-sm font-medium text-emerald-600 hover:text-emerald-700 transition"
            >
              Ver todas →
            </Link>
          </div>
          {movRecentes.length === 0 ? (
            <div className="p-8 text-center text-[var(--color-text-muted)] text-sm">
              Nenhuma movimentação ainda.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {movRecentes.map((mov) => (
                <div
                  key={mov.id}
                  className="flex items-center justify-between p-4 hover:bg-[var(--color-bg)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm shrink-0 ${
                        mov.tipo === "entrada"
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-red-50 text-red-500"
                      }`}
                    >
                      {mov.tipo === "entrada" ? "▲" : "▼"}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {recentesNomes[mov.id] || "..."}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {new Date(
                          mov.data + "T12:00:00"
                        ).toLocaleDateString("pt-BR")}
                        {mov.observacao && ` · ${mov.observacao}`}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`font-bold text-sm shrink-0 ${
                      mov.tipo === "entrada"
                        ? "text-emerald-600"
                        : "text-red-500"
                    }`}
                  >
                    {mov.tipo === "entrada" ? "+" : "-"} {fmt(mov.valor)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <h2 className="font-bold text-sm uppercase tracking-wider text-[var(--color-text-muted)] mb-5">
            Ações Rápidas
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/movimentacoes"
              className="flex flex-col items-center gap-2 p-5 rounded-xl bg-emerald-50 hover:bg-emerald-100 transition-colors"
            >
              <span className="text-2xl">💰</span>
              <span className="text-sm font-semibold text-emerald-800">
                Nova Entrada
              </span>
            </Link>
            <Link
              href="/movimentacoes"
              className="flex flex-col items-center gap-2 p-5 rounded-xl bg-red-50 hover:bg-red-100 transition-colors"
            >
              <span className="text-2xl">📤</span>
              <span className="text-sm font-semibold text-red-700">
                Nova Saída
              </span>
            </Link>
            <Link
              href="/contas-pagar"
              className="flex flex-col items-center gap-2 p-5 rounded-xl bg-amber-50 hover:bg-amber-100 transition-colors"
            >
              <span className="text-2xl">📋</span>
              <span className="text-sm font-semibold text-amber-800">
                Contas a Pagar
              </span>
            </Link>
            <Link
              href="/analise"
              className="flex flex-col items-center gap-2 p-5 rounded-xl bg-purple-50 hover:bg-purple-100 transition-colors"
            >
              <span className="text-2xl">🧠</span>
              <span className="text-sm font-semibold text-purple-800">
                Análise
              </span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
