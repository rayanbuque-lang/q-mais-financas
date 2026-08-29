"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { useRole } from "@/lib/role-context";

interface Fechamento {
  id: string;
  mes: number;
  ano: number;
  status: string;
  fechado_por: string | null;
  fechado_em: string | null;
  total_entradas: number;
  total_saidas: number;
  saldo: number;
  qtd_movimentacoes: number;
  observacao: string | null;
}

interface DetalheMov {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
  observacao: string;
  categoria_nome: string;
}

const mesesNomes = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

export default function FechamentoPage() {
  const { isReadOnly } = useRole();
  const [ano, setAno] = useState(new Date().getFullYear());
  const [fechamentos, setFechamentos] = useState<Fechamento[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [mesExpandido, setMesExpandido] = useState<number | null>(null);
  const [detalhes, setDetalhes] = useState<DetalheMov[]>([]);
  const [detalhesLoading, setDetalhesLoading] = useState(false);
  const [confirmando, setConfirmando] = useState<number | null>(null);
  const [observacaoFechamento, setObservacaoFechamento] = useState("");
  const supabase = createClient();

  async function carregarFechamentos() {
    setLoading(true);

    // Carregar fechamentos existentes
    const { data: existentes } = await supabase
      .from("fechamentos_mensais")
      .select("*")
      .eq("ano", ano)
      .order("mes");

    // Para cada mês, calcular totais reais
    const resultado: Fechamento[] = [];

    for (let m = 0; m < 12; m++) {
      const existente = existentes?.find((f) => f.mes === m + 1);

      // Calcular totais do mês
      const inicio = `${ano}-${String(m + 1).padStart(2, "0")}-01`;
      const ultimoDia = new Date(ano, m + 1, 0).getDate();
      const fim = `${ano}-${String(m + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

      const movs = await fetchAllRows<{ tipo: string; valor: number }>((from, to) =>
        supabase.from("movimentacoes").select("tipo,valor").gte("data", inicio).lte("data", fim).range(from, to)
      );

      const entradas = movs.filter((m) => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
      const saidas = movs.filter((m) => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);

      if (existente) {
        resultado.push({
          ...existente,
          total_entradas: entradas,
          total_saidas: saidas,
          saldo: entradas - saidas,
          qtd_movimentacoes: movs?.length || 0,
        });
      } else {
        resultado.push({
          id: "",
          mes: m + 1,
          ano,
          status: "aberto",
          fechado_por: null,
          fechado_em: null,
          total_entradas: entradas,
          total_saidas: saidas,
          saldo: entradas - saidas,
          qtd_movimentacoes: movs?.length || 0,
          observacao: null,
        });
      }
    }

    setFechamentos(resultado);
    setLoading(false);
  }

  useEffect(() => {
    carregarFechamentos();
  }, [ano]);

  async function carregarDetalhes(mes: number) {
    setDetalhesLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const movs = await fetchAllRows<{ id: string; tipo: string; data: string; valor: number; categoria_id: string; observacao: string }>((from, to) =>
      supabase
        .from("movimentacoes")
        .select("*")
        .gte("data", inicio)
        .lte("data", fim)
        .order("data", { ascending: true })
        .range(from, to)
    );

    const lista = await Promise.all(
      movs.map(async (mov) => {
        const tabela = mov.tipo === "entrada" ? "categorias_entrada" : "categorias_saida";
        const { data: cat } = await supabase.from(tabela).select("nome").eq("id", mov.categoria_id).single();
        return { ...mov, categoria_nome: cat?.nome || "Sem categoria" };
      })
    );
    setDetalhes(lista);
    setDetalhesLoading(false);
  }

  function toggleExpandir(mes: number) {
    if (mesExpandido === mes) {
      setMesExpandido(null);
      setDetalhes([]);
    } else {
      setMesExpandido(mes);
      carregarDetalhes(mes);
    }
  }

  async function fecharMes(fechamento: Fechamento) {
    setLoading(true);
    setMensagem("");

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const dados = {
      mes: fechamento.mes,
      ano: fechamento.ano,
      status: "fechado",
      fechado_por: user.id,
      fechado_em: new Date().toISOString(),
      total_entradas: fechamento.total_entradas,
      total_saidas: fechamento.total_saidas,
      saldo: fechamento.saldo,
      qtd_movimentacoes: fechamento.qtd_movimentacoes,
      observacao: observacaoFechamento,
    };

    let error;
    if (fechamento.id) {
      const r = await supabase.from("fechamentos_mensais").update(dados).eq("id", fechamento.id);
      error = r.error;
    } else {
      const r = await supabase.from("fechamentos_mensais").insert(dados);
      error = r.error;
    }

    if (error) {
      setMensagem("Erro ao fechar mês.");
    } else {
      setMensagem(`${mesesNomes[fechamento.mes - 1]}/${ano} fechado com sucesso!`);
      setConfirmando(null);
      setObservacaoFechamento("");
      carregarFechamentos();
    }
    setLoading(false);
    setTimeout(() => setMensagem(""), 4000);
  }

  async function reabrirMes(fechamento: Fechamento) {
    if (!confirm(`Reabrir ${mesesNomes[fechamento.mes - 1]}/${ano}? Isso permitirá alterações nos dados novamente.`)) return;

    setLoading(true);
    if (fechamento.id) {
      await supabase.from("fechamentos_mensais").update({ status: "aberto", fechado_por: null, fechado_em: null }).eq("id", fechamento.id);
    }
    setMensagem(`${mesesNomes[fechamento.mes - 1]}/${ano} reaberto!`);
    carregarFechamentos();
    setLoading(false);
    setTimeout(() => setMensagem(""), 4000);
  }

  async function fecharTodosAbertos() {
    const abertos = fechamentos.filter((f) => f.status === "aberto" && f.qtd_movimentacoes > 0);
    if (abertos.length === 0) {
      setMensagem("Nenhum mês com dados para fechar.");
      setTimeout(() => setMensagem(""), 3000);
      return;
    }
    if (!confirm(`Fechar ${abertos.length} meses?`)) return;

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    for (const f of abertos) {
      const dados = {
        mes: f.mes, ano: f.ano, status: "fechado",
        fechado_por: user.id, fechado_em: new Date().toISOString(),
        total_entradas: f.total_entradas, total_saidas: f.total_saidas,
        saldo: f.saldo, qtd_movimentacoes: f.qtd_movimentacoes,
      };
      if (f.id) {
        await supabase.from("fechamentos_mensais").update(dados).eq("id", f.id);
      } else {
        await supabase.from("fechamentos_mensais").insert(dados);
      }
    }
    setMensagem(`${abertos.length} meses fechados!`);
    carregarFechamentos();
    setLoading(false);
    setTimeout(() => setMensagem(""), 4000);
  }

  function fmt(v: number) {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function imprimirFechamento(fechamento: Fechamento) {
    const entradasCategoria: Record<string, number> = {};
    const saidasCategoria: Record<string, number> = {};

    detalhes.forEach((d) => {
      if (d.tipo === "entrada") {
        entradasCategoria[d.categoria_nome] = (entradasCategoria[d.categoria_nome] || 0) + d.valor;
      } else {
        saidasCategoria[d.categoria_nome] = (saidasCategoria[d.categoria_nome] || 0) + d.valor;
      }
    });

    const html = `
      <html><head><title>Fechamento ${mesesNomes[fechamento.mes - 1]}/${ano}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 30px; color: #333; }
        h1 { font-size: 20px; border-bottom: 2px solid #16a34a; padding-bottom: 8px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
        .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; text-align: center; }
        .card p { margin: 0; font-size: 12px; color: #666; text-transform: uppercase; }
        .card h2 { margin: 5px 0 0; font-size: 22px; }
        .green { color: #16a34a; } .red { color: #dc2626; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
        th { background: #f9fafb; font-weight: 600; text-transform: uppercase; font-size: 11px; }
        .footer { margin-top: 30px; font-size: 11px; color: #999; text-align: center; }
      </style></head><body>
        <h1>+Q Finanças — Fechamento de ${mesesNomes[fechamento.mes - 1]}/${ano}</h1>
        <div class="grid">
          <div class="card"><p>Entradas</p><h2 class="green">${fmt(fechamento.total_entradas)}</h2></div>
          <div class="card"><p>Saídas</p><h2 class="red">${fmt(fechamento.total_saidas)}</h2></div>
          <div class="card"><p>Saldo</p><h2 class="${fechamento.saldo >= 0 ? "green" : "red"}">${fmt(fechamento.saldo)}</h2></div>
        </div>
        <p><strong>Movimentações:</strong> ${fechamento.qtd_movimentacoes} | <strong>Status:</strong> ${fechamento.status === "fechado" ? "Fechado" : "Aberto"}${fechamento.fechado_em ? ` | <strong>Data:</strong> ${new Date(fechamento.fechado_em).toLocaleDateString("pt-BR")}` : ""}</p>
        ${fechamento.observacao ? `<p><strong>Observação:</strong> ${fechamento.observacao}</p>` : ""}
        <h3 style="margin-top:25px;">Entradas por Categoria</h3>
        <table><thead><tr><th>Categoria</th><th style="text-align:right">Total</th></tr></thead><tbody>
        ${Object.entries(entradasCategoria).map(([nome, total]) => `<tr><td>${nome}</td><td style="text-align:right" class="green">${fmt(total)}</td></tr>`).join("")}
        ${Object.keys(entradasCategoria).length === 0 ? "<tr><td colspan='2' style='text-align:center;color:#999'>Nenhuma</td></tr>" : ""}
        </tbody></table>
        <h3 style="margin-top:20px;">Saídas por Categoria</h3>
        <table><thead><tr><th>Categoria</th><th style="text-align:right">Total</th></tr></thead><tbody>
        ${Object.entries(saidasCategoria).map(([nome, total]) => `<tr><td>${nome}</td><td style="text-align:right" class="red">${fmt(total)}</td></tr>`).join("")}
        ${Object.keys(saidasCategoria).length === 0 ? "<tr><td colspan='2' style='text-align:center;color:#999'>Nenhuma</td></tr>" : ""}
        </tbody></table>
        <h3 style="margin-top:20px;">Todas as Movimentações</h3>
        <table><thead><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th>Observação</th><th style="text-align:right">Valor</th></tr></thead><tbody>
        ${detalhes.map((d) => `<tr><td>${new Date(d.data + "T12:00:00").toLocaleDateString("pt-BR")}</td><td>${d.tipo === "entrada" ? "Entrada" : "Saída"}</td><td>${d.categoria_nome}</td><td>${d.observacao || "-"}</td><td style="text-align:right" class="${d.tipo === "entrada" ? "green" : "red"}">${d.tipo === "entrada" ? "+" : "-"} ${fmt(d.valor)}</td></tr>`).join("")}
        ${detalhes.length === 0 ? "<tr><td colspan='5' style='text-align:center;color:#999'>Nenhuma</td></tr>" : ""}
        </tbody></table>
        <div class="footer">Gerado por +Q Finanças em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}</div>
      </body></html>`;

    const win = window.open("", "_blank");
    if (win) {
      win.document.write(html);
      win.document.close();
      win.print();
    }
  }

  const totalAnoEntradas = fechamentos.reduce((a, f) => a + f.total_entradas, 0);
  const totalAnoSaidas = fechamentos.reduce((a, f) => a + f.total_saidas, 0);
  const totalAnoSaldo = totalAnoEntradas - totalAnoSaidas;
  const mesesFechados = fechamentos.filter((f) => f.status === "fechado").length;
  const mesesAbertos = fechamentos.filter((f) => f.status === "aberto" && f.qtd_movimentacoes > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fechamento Mensal</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Congule e audite os dados de cada mês</p>
        </div>
        {mesesAbertos > 0 && !isReadOnly && (
          <button onClick={fecharTodosAbertos} disabled={loading} className="px-5 py-3 bg-gradient-to-r from-purple-600 to-purple-500 text-white font-semibold rounded-xl hover:from-purple-700 hover:to-purple-600 transition-all text-sm shadow-md shadow-purple-200 disabled:opacity-50">
            🔒 Fechar Todos Abertos
          </button>
        )}
      </div>

      {/* Seletor de ano */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={() => setAno(ano - 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← {ano - 1}</button>
        <div className="text-center">
          <p className="font-bold text-lg">{ano}</p>
        </div>
        <button onClick={() => setAno(ano + 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">{ano + 1} →</button>
      </div>

      {/* Resumo anual */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { l: "Entradas", v: fmt(totalAnoEntradas), c: "text-emerald-600" },
          { l: "Saídas", v: fmt(totalAnoSaidas), c: "text-red-500" },
          { l: "Saldo", v: fmt(totalAnoSaldo), c: totalAnoSaldo >= 0 ? "text-emerald-600" : "text-red-500" },
          { l: "Fechados", v: `${mesesFechados}/12`, c: "text-purple-600" },
          { l: "Abertos", v: `${mesesAbertos}`, c: "text-amber-600" },
        ].map((c) => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>
          {mensagem}
        </div>
      )}

      {/* Grid de meses */}
      {loading && fechamentos.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Carregando...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {fechamentos.map((f) => {
            const isExpandido = mesExpandido === f.mes;
            const isFechado = f.status === "fechado";
            const temDados = f.qtd_movimentacoes > 0;
            const isConfirmando = confirmando === f.mes;

            return (
              <div key={f.mes} className={`bg-[var(--color-surface)] border rounded-2xl overflow-hidden transition-all ${isFechado ? "border-purple-300" : "border-[var(--color-border)]"}`}>
                {/* Header do mês */}
                <div className={`p-4 flex items-center justify-between cursor-pointer hover:bg-[var(--color-bg)] transition-colors`} onClick={() => toggleExpandir(f.mes)}>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${isFechado ? "bg-purple-50 text-purple-600" : temDados ? "bg-amber-50 text-amber-600" : "bg-gray-50 text-gray-400"}`}>
                      {isFechado ? "🔒" : temDados ? "📂" : "📭"}
                    </div>
                    <div>
                      <p className="text-sm font-bold">{mesesNomes[f.mes - 1]}</p>
                      <p className="text-[10px] text-[var(--color-text-muted)]">
                        {f.qtd_movimentacoes} movimentações
                        {isFechado && f.fechado_em && ` · Fechado em ${new Date(f.fechado_em).toLocaleDateString("pt-BR")}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${f.saldo >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmt(f.saldo)}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isFechado ? "bg-purple-100 text-purple-700" : "bg-amber-100 text-amber-700"}`}>
                      {isFechado ? "FECHADO" : "ABERTO"}
                    </span>
                  </div>
                </div>

                {/* Detalhes expandidos */}
                {isExpandido && (
                  <div className="border-t border-[var(--color-border)] p-4 bg-[var(--color-bg)] space-y-3">
                    {/* Totais */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-emerald-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-emerald-600 font-semibold uppercase">Entradas</p>
                        <p className="text-sm font-bold text-emerald-700">{fmt(f.total_entradas)}</p>
                      </div>
                      <div className="bg-red-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-red-500 font-semibold uppercase">Saídas</p>
                        <p className="text-sm font-bold text-red-600">{fmt(f.total_saidas)}</p>
                      </div>
                      <div className={`rounded-xl p-3 text-center ${f.saldo >= 0 ? "bg-blue-50" : "bg-orange-50"}`}>
                        <p className={`text-[10px] font-semibold uppercase ${f.saldo >= 0 ? "text-blue-600" : "text-orange-500"}`}>Saldo</p>
                        <p className={`text-sm font-bold ${f.saldo >= 0 ? "text-blue-700" : "text-orange-600"}`}>{fmt(f.saldo)}</p>
                      </div>
                    </div>

                    {/* Observação do fechamento */}
                    {f.observacao && (
                      <div className="bg-purple-50 rounded-xl p-3">
                        <p className="text-xs text-purple-700"><strong>Nota:</strong> {f.observacao}</p>
                      </div>
                    )}

                    {/* Lista de movimentações */}
                    {detalhesLoading && isExpandido ? (
                      <p className="text-xs text-center text-[var(--color-text-muted)]">Carregando movimentações...</p>
                    ) : detalhes.length > 0 ? (
                      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden max-h-48 overflow-y-auto">
                        <div className="divide-y divide-[var(--color-border)]">
                          {detalhes.map((d) => (
                            <div key={d.id} className="flex items-center justify-between px-3 py-2 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] shrink-0 ${d.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                                  {d.tipo === "entrada" ? "▲" : "▼"}
                                </span>
                                <span className="truncate">{d.categoria_nome}</span>
                              </div>
                              <span className={`font-semibold shrink-0 ${d.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                                {d.tipo === "entrada" ? "+" : "-"} {fmt(d.valor)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-center text-[var(--color-text-muted)]">Nenhuma movimentação neste mês.</p>
                    )}

                    {/* Ações */}
                    <div className="flex gap-2 flex-wrap">
                      {detalhes.length > 0 && (
                        <button onClick={() => imprimirFechamento(f)} className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition">
                          🖨️ Imprimir
                        </button>
                      )}

                      {!isFechado && temDados && !isConfirmando && !isReadOnly && (
                        <button onClick={() => setConfirmando(f.mes)} className="px-3 py-2 rounded-lg bg-purple-50 text-purple-600 text-xs font-semibold hover:bg-purple-100 transition">
                          🔒 Fechar Mês
                        </button>
                      )}

                      {isFechado && !isReadOnly && (
                        <button onClick={() => reabrirMes(f)} className="px-3 py-2 rounded-lg bg-amber-50 text-amber-600 text-xs font-semibold hover:bg-amber-100 transition">
                          🔓 Reabrir
                        </button>
                      )}
                    </div>

                    {/* Confirmação de fechamento */}
                    {isConfirmando && !isReadOnly && (
                      <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3">
                        <p className="text-sm font-semibold text-purple-800">Confirmar fechamento de {mesesNomes[f.mes - 1]}/{ano}?</p>
                        <p className="text-xs text-purple-600">Após fechar, os dados serão registrados e você poderá visualizar o relatório a qualquer momento.</p>
                        <div>
                          <label className="block text-xs font-semibold mb-1 text-purple-700">Observação (opcional)</label>
                          <input type="text" value={observacaoFechamento} onChange={(e) => setObservacaoFechamento(e.target.value)} placeholder="Ex: Mês auditado, valores conferidos" className="w-full px-3 py-2 rounded-lg border border-purple-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-400" />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => { setConfirmando(null); setObservacaoFechamento(""); }} className="px-4 py-2 bg-white text-gray-500 rounded-lg text-xs font-semibold border border-gray-300 hover:bg-gray-50 transition">Cancelar</button>
                          <button onClick={() => fecharMes(f)} disabled={loading} className="px-5 py-2 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 transition disabled:opacity-50">
                            {loading ? "Fechando..." : "✓ Confirmar Fechamento"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
