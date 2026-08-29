"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

interface Movimentacao {
  tipo: string; valor: number; data: string; categoria_id: string;
}
interface Meta { categoria_id: string; valor_meta: number; }

interface Categoria { id: string; nome: string; }

interface FechamentoResumo { valor_total_vendas: number; dinheiro: number; }
const NOME_CATEGORIA_FECHAMENTO = "Dinheiro (Fechamento Caixa)";

const meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function calcTotais(movs: Movimentacao[]) {
  const entradas = movs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
  const saidas = movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
  return { entradas, saidas, resultado: entradas - saidas, margem: entradas > 0 ? ((entradas - saidas) / entradas) * 100 : 0 };
}

function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function pct(v: number, t: number) { return t === 0 ? "—" : ((v / t) * 100).toFixed(1) + "%"; }

function getPeriodo(mes: number, ano: number) {
  const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  const fim = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
  return { inicio, fim };
}

export default function DrePage() {
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [modo, setModo] = useState<"simples" | "comparativo">("simples");

  const [movAtual, setMovAtual] = useState<Movimentacao[]>([]);
  const [movAnterior, setMovAnterior] = useState<Movimentacao[]>([]);
  const [movMesmoAnoPassado, setMovMesmoAnoPassado] = useState<Movimentacao[]>([]);
  const [todasCats, setTodasCats] = useState<Categoria[]>([]);
  const [metasCat, setMetasCat] = useState<Meta[]>([]);
  const [fechamentosMes, setFechamentosMes] = useState<FechamentoResumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingComparativo, setLoadingComparativo] = useState(false);
  const [erro, setErro] = useState("");

  const supabase = createClient();

  async function carregarDados() {
    setLoading(true); setErro("");
    const { inicio, fim } = getPeriodo(mes, ano);

    let mesAnt = mes - 1, anoAnt = ano;
    if (mesAnt < 0) { mesAnt = 11; anoAnt = ano - 1; }
    const { inicio: inicioAnt, fim: fimAnt } = getPeriodo(mesAnt, anoAnt);

    const mesSup = mes + 1;
    const [movAtualData, movAnteriorData, r4, r5, r6, r7] = await Promise.all([
      fetchAllRows<Movimentacao>((from, to) => supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).range(from, to)),
      fetchAllRows<Movimentacao>((from, to) => supabase.from("movimentacoes").select("*").gte("data", inicioAnt).lte("data", fimAnt).range(from, to)),
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true),
      supabase.from("metas").select("categoria_id,valor_meta").eq("tipo", "despesa_categoria").eq("mes", mesSup).eq("ano", ano),
      // Apenas leitura — usado para alertar se há vendas do Fechamento de Caixa
      // (cartão/Pix/outros) ainda não lançadas manualmente em Movimentações.
      // Não dispara nem altera nenhum lançamento.
      supabase.from("fechamento_caixa").select("valor_total_vendas,dinheiro").eq("fechado", true).gte("data", inicio).lte("data", fim),
    ]);

    const erros = [r4.error, r5.error, r6.error, r7.error].filter(Boolean);
    if (erros.length > 0) setErro("Não foi possível carregar todos os dados do período. Os números abaixo podem estar incompletos.");

    setMovAtual(movAtualData);
    setMovAnterior(movAnteriorData);
    if (r6.data) setMetasCat(r6.data as Meta[]);
    if (r7.data) setFechamentosMes(r7.data as FechamentoResumo[]);
    const cats: Categoria[] = [...(r4.data || []), ...(r5.data || [])];
    setTodasCats(cats);
    setLoading(false);
  }

  // "Mesmo mês do ano anterior" só é usado no modo Comparativo — busca
  // sob demanda em vez de sempre, para não gastar uma consulta sem uso
  // quando a tela está em Mês Único.
  async function carregarAnoPassado() {
    setLoadingComparativo(true);
    const { inicio: inicioAP, fim: fimAP } = getPeriodo(mes, ano - 1);
    const data = await fetchAllRows<Movimentacao>((from, to) =>
      supabase.from("movimentacoes").select("*").gte("data", inicioAP).lte("data", fimAP).range(from, to)
    );
    setMovMesmoAnoPassado(data);
    setLoadingComparativo(false);
  }

  useEffect(() => { carregarDados(); }, [mes, ano]);
  useEffect(() => { if (modo === "comparativo") carregarAnoPassado(); }, [modo, mes, ano]);

  const catMap = useMemo(() => new Map(todasCats.map(c => [c.id, c.nome])), [todasCats]);
  function getNomeCategoria(id: string): string {
    return catMap.get(id) || "Sem categoria";
  }

  function mesAnteriorNav() { if (mes === 0) { setMes(11); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximoNav() { if (mes === 11) { setMes(0); setAno(ano + 1); } else setMes(mes + 1); }

  const entradas = movAtual.filter(m => m.tipo === "entrada");
  const saidas = movAtual.filter(m => m.tipo === "saida");
  const totalEntradas = entradas.reduce((a, m) => a + m.valor, 0);
  const totalSaidas = saidas.reduce((a, m) => a + m.valor, 0);
  const resultado = totalEntradas - totalSaidas;
  const margem = totalEntradas > 0 ? (resultado / totalEntradas) * 100 : 0;

  // Agrupado por categoria_id (não por nome) — evita misturar categorias
  // diferentes que por acaso tenham o mesmo nome cadastrado.
  const entradasPorCategoria = Object.entries(
    entradas.reduce((acc: Record<string, { total: number; nome: string }>, m) => {
      const id = m.categoria_id;
      if (!acc[id]) acc[id] = { total: 0, nome: getNomeCategoria(id) };
      acc[id].total += m.valor;
      return acc;
    }, {})
  ).map(([id, { total, nome }]) => ({ id, nome, total })).sort((a, b) => b.total - a.total);

  const saidasPorCategoria = Object.entries(
    saidas.reduce((acc: Record<string, { total: number; nome: string }>, m) => {
      const id = m.categoria_id;
      if (!acc[id]) acc[id] = { total: 0, nome: getNomeCategoria(id) };
      acc[id].total += m.valor;
      return acc;
    }, {})
  ).map(([id, { total, nome }]) => ({ id, nome, total })).sort((a, b) => b.total - a.total);

  const metasByCatId = Object.fromEntries(metasCat.map(m => [m.categoria_id, m.valor_meta]));

  // ── Apenas leitura: comparação Fechamento de Caixa x Movimentações ──
  // Não altera nenhum lançamento — só sinaliza visualmente se vendas de
  // cartão/Pix/outros registradas no Fechamento de Caixa ainda não foram
  // lançadas manualmente em Movimentações neste período.
  const vendasBrutasFechamento = fechamentosMes.reduce((a, f) => a + (f.valor_total_vendas || 0), 0);
  const dinheiroFechamento = fechamentosMes.reduce((a, f) => a + (f.dinheiro || 0), 0);
  const naoDinheiroEsperado = Math.max(vendasBrutasFechamento - dinheiroFechamento, 0);
  const entradasFechamentoCaixa = entradas
    .filter(m => getNomeCategoria(m.categoria_id) === NOME_CATEGORIA_FECHAMENTO)
    .reduce((a, m) => a + m.valor, 0);
  const entradasOutrosMeios = totalEntradas - entradasFechamentoCaixa;
  const gapLancamentoManual = Math.max(naoDinheiroEsperado - entradasOutrosMeios, 0);
  const percLancadoOutrosMeios = naoDinheiroEsperado > 0 ? (entradasOutrosMeios / naoDinheiroEsperado) * 100 : 100;

  let mesAnt = mes - 1, anoAnt = ano;
  if (mesAnt < 0) { mesAnt = 11; anoAnt = ano - 1; }

  const colAtual = calcTotais(movAtual);
  const colAnterior = calcTotais(movAnterior);
  const colAnoPassado = calcTotais(movMesmoAnoPassado);

  function varPct(atual: number, ref: number) {
    if (ref === 0) return null;
    return ((atual - ref) / ref) * 100;
  }

  function VarBadge({ atual, base, inverso = false }: { atual: number; base: number; inverso?: boolean }) {
    const v = varPct(atual, base);
    if (v === null) return <span className="text-xs text-gray-400">—</span>;
    const positivo = inverso ? v < 0 : v > 0;
    return (
      <span className={`text-xs font-semibold ${positivo ? "text-emerald-600" : "text-red-500"}`}>
        {v > 0 ? "↑" : "↓"} {Math.abs(v).toFixed(1)}%
      </span>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">DRE - Demonstrativo</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">Resultado do período automaticamente</p>
      </div>

      {/* Modo */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
        <button onClick={() => setModo("simples")} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${modo === "simples" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
          Mês Único
        </button>
        <button onClick={() => setModo("comparativo")} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${modo === "comparativo" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
          Comparativo 3 Meses
        </button>
      </div>

      {/* Navegação de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnteriorNav} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center">
          <p className="font-semibold text-lg capitalize">{meses[mes]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button onClick={mesProximoNav} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Erro de carregamento — apenas leitura/aviso, não bloqueia a tela */}
      {erro && (
        <div className="rounded-2xl p-3 border bg-red-50 border-red-200 flex items-center gap-2.5">
          <span className="text-sm">⚠️</span>
          <p className="text-xs text-red-700 font-medium">{erro}</p>
        </div>
      )}

      {/* Skeleton de carregamento inicial */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 animate-pulse">
              <div className="h-3 w-20 rounded bg-[var(--color-bg)]" />
              <div className="h-6 w-28 rounded bg-[var(--color-bg)] mt-3" />
            </div>
          ))}
        </div>
      ) : (
      <>
      {/* Alerta (apenas leitura): vendas do Fechamento de Caixa ainda não lançadas
          manualmente em Movimentações. Não lança nem altera nada — só avisa. */}
      {vendasBrutasFechamento > 0 && naoDinheiroEsperado > 0 && (
        gapLancamentoManual > 0.01 ? (
          <div className="rounded-2xl p-4 border bg-amber-50 border-amber-300">
            <div className="flex items-start gap-3">
              <span className="text-lg shrink-0">⚠️</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-800">
                  Possível receita não lançada em Movimentações neste período
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  O Fechamento de Caixa registrou {fmt(vendasBrutasFechamento)} em vendas, das quais {fmt(dinheiroFechamento)} são dinheiro (já lançado automaticamente). Os outros {fmt(naoDinheiroEsperado)} (cartão/Pix/demais meios) são lançados manualmente em Movimentações — até agora {fmt(entradasOutrosMeios)} foram lançados ({percLancadoOutrosMeios.toFixed(0)}%), faltando aproximadamente <strong>{fmt(gapLancamentoManual)}</strong>.
                </p>
                <p className="text-[11px] text-amber-600 mt-1.5">
                  Isso não lança nada automaticamente — é só um aviso para você conferir e lançar manualmente quando os recebimentos baterem no extrato.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl p-3 border bg-emerald-50 border-emerald-200 flex items-center gap-2.5">
            <span className="text-sm">✓</span>
            <p className="text-xs text-emerald-700 font-medium">
              Lançamentos de cartão/Pix/outros meios em dia com o Fechamento de Caixa deste período.
            </p>
          </div>
        )
      )}

      {/* ===== MODO SIMPLES ===== */}
      {modo === "simples" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { l: "Receita Total", icon: "📈", v: fmt(totalEntradas), c: "text-emerald-600", atual: totalEntradas, ant: colAnterior.entradas, inverso: false },
              { l: "Despesas Totais", icon: "📉", v: fmt(totalSaidas), c: "text-red-500", atual: totalSaidas, ant: colAnterior.saidas, inverso: true },
              { l: "Resultado", icon: "💰", v: fmt(resultado), c: resultado >= 0 ? "text-emerald-600" : "text-red-500", atual: resultado, ant: colAnterior.resultado, inverso: false },
              { l: "Margem", icon: "🎯", v: `${margem.toFixed(1)}%`, c: margem >= 0 ? "text-emerald-600" : "text-red-500", atual: margem, ant: colAnterior.margem, inverso: false },
            ].map(c => (
              <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-[var(--color-text-muted)]">{c.l}</p>
                  <span className="text-base">{c.icon}</span>
                </div>
                <p className={`text-xl font-bold mt-1 ${c.c}`}>{c.v}</p>
                <div className="mt-1.5">
                  <VarBadge atual={c.atual} base={c.ant} inverso={c.inverso} />
                  <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">vs mês anterior</span>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50">
                <h2 className="font-semibold text-emerald-700">(+) Receitas</h2>
              </div>
              {entradasPorCategoria.length === 0 ? (
                <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhuma receita neste mês</div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {entradasPorCategoria.map(cat => (
                    <div key={cat.id} className="flex justify-between items-center p-4">
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

            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-[var(--color-border)] bg-red-50">
                <h2 className="font-semibold text-red-600">(-) Despesas</h2>
              </div>
              {saidasPorCategoria.length === 0 ? (
                <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhuma despesa neste mês</div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {saidasPorCategoria.map(cat => {
                    const metaValor = metasByCatId[cat.id];
                    const pctUsado = metaValor ? (cat.total / metaValor) * 100 : null;
                    const acima = pctUsado !== null && pctUsado > 100;
                    return (
                      <div key={cat.id} className="p-4">
                        <div className="flex justify-between items-center">
                          <span className="text-sm">{cat.nome}</span>
                          <div className="flex items-center gap-2">
                            {pctUsado !== null && (
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${acima ? "bg-red-100 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                                {acima ? "⚠️" : "✓"} {pctUsado.toFixed(0)}% do orçamento
                              </span>
                            )}
                            <div className="text-right">
                              <span className="text-sm font-semibold text-red-500">{fmt(cat.total)}</span>
                              <span className="text-xs text-[var(--color-text-muted)] ml-2">({pct(cat.total, totalSaidas)})</span>
                            </div>
                          </div>
                        </div>
                        {metaValor && (
                          <div className="mt-2">
                            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--hover-bg)" }}>
                              <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pctUsado!, 100)}%`, background: acima ? "var(--red)" : "var(--green)" }} />
                            </div>
                            <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                              {fmt(cat.total)} de {fmt(metaValor)} · {acima ? `R$${(cat.total - metaValor).toFixed(0)} acima` : `R$${(metaValor - cat.total).toFixed(0)} disponível`}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex justify-between items-center p-4 bg-[var(--color-bg)]">
                    <span className="text-sm font-bold">Total Despesas</span>
                    <span className="text-sm font-bold text-red-500">{fmt(totalSaidas)}</span>
                  </div>
                  {metasCat.length === 0 && (
                    <div className="px-4 py-3 text-center">
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Defina metas por categoria para acompanhar % do orçamento aqui.{" "}
                        <Link href="/metas" className="text-[var(--color-primary)] font-semibold hover:underline">
                          Ir para Metas →
                        </Link>
                      </p>
                    </div>
                  )}
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
        </>
      )}

      {/* ===== MODO COMPARATIVO ===== */}
      {modo === "comparativo" && (
        <div className="space-y-4">
          {loadingComparativo && (
            <p className="text-xs text-[var(--color-text-muted)] flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-[var(--color-border)] border-t-[var(--color-primary)] rounded-full animate-spin inline-block" />
              Carregando mesmo período do ano anterior...
            </p>
          )}
          {/* Cabeçalho colunas — overflow-x-auto + largura mínima preserva o
              layout de desktop e evita que as colunas fiquem espremidas no mobile */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
            <div className="min-w-[640px]">
            <div className="grid grid-cols-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
              <div className="p-4 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Indicador</div>
              <div className="p-4 text-center">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Mês Atual</p>
                <p className="text-sm font-semibold capitalize">{meses[mes]}/{ano}</p>
              </div>
              <div className="p-4 text-center">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Mês Anterior</p>
                <p className="text-sm font-semibold capitalize">{meses[mesAnt]}/{anoAnt}</p>
              </div>
              <div className="p-4 text-center">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Mesmo Mês/Ano Ant.</p>
                <p className="text-sm font-semibold capitalize">{meses[mes]}/{ano - 1}</p>
              </div>
            </div>

            {[
              { label: "Receita Total", atual: colAtual.entradas, ant: colAnterior.entradas, ap: colAnoPassado.entradas, cor: "text-emerald-600", inverso: false },
              { label: "Despesas Totais", atual: colAtual.saidas, ant: colAnterior.saidas, ap: colAnoPassado.saidas, cor: "text-red-500", inverso: true },
              { label: "Resultado", atual: colAtual.resultado, ant: colAnterior.resultado, ap: colAnoPassado.resultado, cor: colAtual.resultado >= 0 ? "text-emerald-700" : "text-red-600", inverso: false },
              { label: "Margem %", atual: colAtual.margem, ant: colAnterior.margem, ap: colAnoPassado.margem, cor: colAtual.margem >= 0 ? "text-emerald-600" : "text-red-600", inverso: false, isPct: true },
            ].map((row) => (
              <div key={row.label} className="grid grid-cols-4 border-b border-[var(--color-border)] hover:bg-[var(--color-bg)] transition">
                <div className="p-4 text-sm font-medium text-[var(--color-text-muted)]">{row.label}</div>
                <div className="p-4 text-center">
                  <p className={`text-sm font-bold ${row.cor}`}>
                    {row.isPct ? `${row.atual.toFixed(1)}%` : fmt(row.atual)}
                  </p>
                </div>
                <div className="p-4 text-center">
                  <p className="text-sm font-semibold text-[var(--color-text-muted)]">
                    {row.isPct ? `${row.ant.toFixed(1)}%` : fmt(row.ant)}
                  </p>
                  <VarBadge atual={row.atual} base={row.ant} inverso={row.inverso} />
                </div>
                <div className="p-4 text-center">
                  <p className="text-sm font-semibold text-[var(--color-text-muted)]">
                    {row.isPct ? `${row.ap.toFixed(1)}%` : fmt(row.ap)}
                  </p>
                  <VarBadge atual={row.atual} base={row.ap} inverso={row.inverso} />
                </div>
              </div>
            ))}
            </div>
          </div>

          {/* Resumo visual */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { titulo: `${meses[mes]}/${ano}`, dados: colAtual, corBg: "bg-emerald-50 border-emerald-200" },
              { titulo: `${meses[mesAnt]}/${anoAnt}`, dados: colAnterior, corBg: "bg-gray-50 border-gray-200" },
              { titulo: `${meses[mes]}/${ano - 1}`, dados: colAnoPassado, corBg: "bg-blue-50 border-blue-200" },
            ].map((col) => (
              <div key={col.titulo} className={`border rounded-2xl p-5 ${col.corBg}`}>
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 capitalize">{col.titulo}</p>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-gray-600">Receita</span><span className="font-semibold text-emerald-600">{fmt(col.dados.entradas)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-600">Despesa</span><span className="font-semibold text-red-500">{fmt(col.dados.saidas)}</span></div>
                  <div className="flex justify-between text-sm border-t border-gray-200 pt-2 mt-2">
                    <span className="font-bold text-gray-700">Resultado</span>
                    <span className={`font-bold ${col.dados.resultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>{fmt(col.dados.resultado)}</span>
                  </div>
                  <p className="text-xs text-gray-500 text-right">Margem: {col.dados.margem.toFixed(1)}%</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
