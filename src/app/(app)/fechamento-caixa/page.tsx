"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";

const fpLabels: Record<string, string> = {
  cartao: "Cartão", pix_santander: "Pix Santander", pix_inter: "Pix Inter",
  rom_card: "Rom Card", app: "App", prefeitura: "Prefeitura",
  voucher: "Voucher", dinheiro: "Dinheiro",
};

const fpIcons: Record<string, string> = {
  cartao: "💳", pix_santander: "📱", pix_inter: "📱",
  rom_card: "💳", app: "📲", prefeitura: "🏛️",
  voucher: "🎫", dinheiro: "💵",
};

const fpCores: Record<string, string> = {
  cartao: "#2563eb", pix_santander: "#dc2626", pix_inter: "#f97316",
  rom_card: "#7c3aed", app: "#059669", prefeitura: "#0891b2",
  voucher: "#d97706", dinheiro: "#16a34a",
};

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

interface Movimentacao {
  id: string; tipo: string; data: string; valor: number;
  categoria_id: string; observacao: string; forma_pagamento: string | null;
  revisar: boolean; categoria_nome?: string;
}

interface DiaInfo {
  data: string; dia: number; semana: string;
  movs: Movimentacao[]; porFP: Record<string, number>;
  total: number; fechado: boolean; fechamentoId: string | null;
}

export default function FechamentoCaixaPage() {
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [dias, setDias] = useState<DiaInfo[]>([]);
  const [diaAberto, setDiaAberto] = useState<string | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editValor, setEditValor] = useState("");
  const [editFP, setEditFP] = useState("");
  const [editObs, setEditObs] = useState("");
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const supabase = createClient();

  async function carregarDados() {
    setLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const [r1, r2, r3] = await Promise.all([
      supabase.from("movimentacoes").select("*, categorias_saida(nome)").eq("tipo", "entrada").gte("data", inicio).lte("data", fim).order("data"),
      supabase.from("fechamento_dia").select("*").gte("data", inicio).lte("data", fim),
      supabase.from("categorias_entrada").select("id,nome"),
    ]);

    const movs: Movimentacao[] = (r1.data || []).map((m: Record<string, unknown>) => ({
      ...m,
      categoria_nome: (m.categorias_saida as Record<string, string>)?.nome || (r3.data || []).find((c: { id: string }) => c.id === m.categoria_id)?.nome || "Sem categoria",
    })) as Movimentacao[];

    const fechamentos = r2.data || [];

    const diasDoMes: DiaInfo[] = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const dataStr = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dt = new Date(ano, mes - 1, d);
      const movsDoDia = movs.filter((m) => m.data === dataStr);
      const porFP: Record<string, number> = {};
      let total = 0;
      movsDoDia.forEach((m) => {
        const fp = m.forma_pagamento || "outros";
        porFP[fp] = (porFP[fp] || 0) + m.valor;
        total += m.valor;
      });
      const fech = fechamentos.find((f: { data: string }) => f.data === dataStr);
      diasDoMes.push({
        data: dataStr, dia: d, semana: diasSemana[dt.getDay()],
        movs: movsDoDia, porFP, total,
        fechado: fech?.fechado || false,
        fechamentoId: fech?.id || null,
      });
    }
    setDias(diasDoMes);
    setLoading(false);
  }

  useEffect(() => { carregarDados(); }, [mes, ano]);

  function mesAnterior() { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); setDiaAberto(null); }
  function mesProximo() { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); setDiaAberto(null); }

  async function fecharDia(data: string) {
    const { data: existente } = await supabase.from("fechamento_dia").select("id").eq("data", data).single();
    if (existente) {
      await supabase.from("fechamento_dia").update({ fechado: true, fechado_em: new Date().toISOString() }).eq("id", existente.id);
    } else {
      await supabase.from("fechamento_dia").insert({ data, fechado: true, fechado_em: new Date().toISOString() });
    }
    await registrarLog({ acao: "fechou", tabela: "fechamento_dia", detalhes: `Dia ${data} fechado` });
    setMensagem("Dia conferido e fechado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function reabrirDia(data: string) {
    await supabase.from("fechamento_dia").update({ fechado: false }).eq("data", data);
    await registrarLog({ acao: "reabriu", tabela: "fechamento_dia", detalhes: `Dia ${data} reaberto` });
    setMensagem("Dia reaberto!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function iniciarEdicao(m: Movimentacao) {
    setEditandoId(m.id);
    setEditValor(m.valor.toString().replace(".", ","));
    setEditFP(m.forma_pagamento || "");
    setEditObs(m.observacao || "");
  }

  async function salvarEdicao(mov: Movimentacao) {
    setLoading(true);
    const novoValor = parseFloat(editValor.replace(",", "."));
    await supabase.from("movimentacoes").update({
      valor: novoValor,
      forma_pagamento: editFP || null,
      observacao: editObs,
    }).eq("id", mov.id);

    await registrarLog({ acao: "editou", tabela: "movimentacoes", registroId: mov.id, dadosAnteriores: { valor: mov.valor, fp: mov.forma_pagamento }, dadosNovos: { valor: novoValor, fp: editFP }, detalhes: `R$ ${mov.valor.toFixed(2)} → R$ ${novoValor.toFixed(2)}` });
    setEditandoId(null);
    setMensagem("Atualizado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  // Totais do mês por forma de pagamento
  const totaisFP: Record<string, number> = {};
  let totalMes = 0;
  dias.forEach((d) => {
    Object.entries(d.porFP).forEach(([fp, val]) => { totaisFP[fp] = (totaisFP[fp] || 0) + val; });
    totalMes += d.total;
  });

  const diasFechados = dias.filter((d) => d.fechado).length;
  const diasComDados = dias.filter((d) => d.movs.length > 0).length;

  const diaDetalhe = diaAberto ? dias.find((d) => d.data === diaAberto) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fechamento de Caixa</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Conferência diária de entradas por forma de pagamento</p>
        </div>
        {loading && <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />}
      </div>

      {/* Navegação mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center">
          <p className="font-bold text-lg capitalize">{mesesNomes[mes - 1]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Total Entradas</p>
          <p className="font-bold text-emerald-600">{fmt(totalMes)}</p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Dias c/ Dados</p>
          <p className="font-bold text-blue-600">{diasComDados}</p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Dias Conferidos</p>
          <p className="font-bold text-emerald-600">{diasFechados}</p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Pendentes</p>
          <p className="font-bold text-amber-600">{diasComDados - diasFechados}</p>
        </div>
      </div>

      {/* Totais por FP do mês */}
      {Object.keys(totaisFP).length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
          <p className="text-sm font-bold mb-3">Totais do Mês por Forma de Pagamento</p>
          <div className="flex flex-wrap gap-3">
            {Object.entries(totaisFP).filter(([fp]) => fp !== "outros").sort((a, b) => b[1] - a[1]).map(([fp, val]) => (
              <div key={fp} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <span>{fpIcons[fp] || "💰"}</span>
                <span className="text-xs font-medium">{fpLabels[fp] || fp}</span>
                <span className="text-xs font-bold" style={{ color: fpCores[fp] || "#374151" }}>{fmt(val)}</span>
              </div>
            ))}
            {totaisFP["outros"] && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <span>❓</span>
                <span className="text-xs font-medium">Sem forma</span>
                <span className="text-xs font-bold text-gray-500">{fmt(totaisFP["outros"])}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {mensagem && <div className="p-3 rounded-xl text-sm font-medium text-center bg-emerald-50 text-emerald-700">{mensagem}</div>}

      {/* Grid de dias */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
        {dias.map((d) => {
          const temDados = d.movs.length > 0;
          const isAberto = diaAberto === d.data;
          return (
            <div
              key={d.data}
              onClick={() => { if (temDados) setDiaAberto(isAberto ? null : d.data); }}
              style={{
                borderRadius: 16,
                border: `2px solid ${d.fechado ? "#16a34a" : temDados ? "#e5e7eb" : "#f3f4f6"}`,
                background: d.fechado ? "#f0fdf4" : temDados ? "white" : "#f9fafb",
                overflow: "hidden",
                cursor: temDados ? "pointer" : "default",
                transition: "all 0.2s",
                opacity: temDados ? 1 : 0.5,
              }}
            >
              {/* Header do card */}
              <div style={{ padding: "10px 14px", borderBottom: temDados ? "1px solid #f3f4f6" : "none", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{d.dia}</span>
                  <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6 }}>{d.semana}</span>
                </div>
                {d.fechado && <span style={{ fontSize: 14 }}>✅</span>}
              </div>

              {/* Corpo do card */}
              {temDados ? (
                <div style={{ padding: "8px 14px" }}>
                  {Object.entries(d.porFP).filter(([fp]) => fp !== "outros").sort((a, b) => b[1] - a[1]).map(([fp, val]) => (
                    <div key={fp} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{fpIcons[fp] || "💰"} {fpLabels[fp] || fp}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: fpCores[fp] || "#374151" }}>{fmt(val)}</span>
                    </div>
                  ))}
                  {d.porFP["outros"] && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>❓ Sem forma</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af" }}>{fmt(d.porFP["outros"])}</span>
                    </div>
                  )}
                  <div style={{ borderTop: "1px solid #f3f4f6", marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>TOTAL</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>{fmt(d.total)}</span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: "20px 14px", textAlign: "center", fontSize: 11, color: "#d1d5db" }}>Sem entradas</div>
              )}

              {/* Botão fechar/reabrir */}
              {temDados && (
                <div style={{ padding: "6px 14px 10px" }}>
                  {d.fechado ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); reabrirDia(d.data); }}
                      style={{ width: "100%", padding: "6px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontSize: 10, fontWeight: 600, color: "#6b7280", cursor: "pointer" }}
                    >Reabrir</button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); fecharDia(d.data); }}
                      style={{ width: "100%", padding: "6px", borderRadius: 8, border: "none", background: "#059669", fontSize: 10, fontWeight: 600, color: "white", cursor: "pointer" }}
                    >✓ Conferir e Fechar</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Painel de detalhes do dia selecionado */}
      {diaDetalhe && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden" style={{ animation: "fadeUp 0.3s ease" }}>
          <style>{`@keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }`}</style>

          <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-bg)]">
            <div>
              <h2 className="font-bold text-lg">
                {new Date(diaDetalhe.data + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
              </h2>
              <p className="text-sm text-[var(--color-text-muted)]">{diaDetalhe.movs.length} {diaDetalhe.movs.length === 1 ? "entrada" : "entradas"} — Total: <strong className="text-emerald-600">{fmt(diaDetalhe.total)}</strong></p>
            </div>
            <button onClick={() => setDiaAberto(null)} className="w-8 h-8 rounded-lg hover:bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <div className="divide-y divide-[var(--color-border)]">
            {diaDetalhe.movs.map((m) => {
              const isEdit = editandoId === m.id;
              return (
                <div key={m.id} className="p-4">
                  {isEdit ? (
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-[100px]">
                        <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">VALOR</label>
                        <input type="text" value={editValor} onChange={(e) => setEditValor(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                      </div>
                      <div className="flex-1 min-w-[120px]">
                        <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">FORMA PGTO</label>
                        <select value={editFP} onChange={(e) => setEditFP(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">
                          <option value="">Selecione</option>
                          {Object.entries(fpLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="flex-1 min-w-[120px]">
                        <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">OBSERVAÇÃO</label>
                        <input type="text" value={editObs} onChange={(e) => setEditObs(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                      </div>
                      <div className="flex gap-2 items-end">
                        <button onClick={() => salvarEdicao(m)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition">Salvar</button>
                        <button onClick={() => setEditandoId(null)} className="px-4 py-2 bg-[var(--color-bg)] text-[var(--color-text-muted)] rounded-lg text-xs font-medium border border-[var(--color-border)] hover:bg-gray-100 transition">Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-lg">{fpIcons[m.forma_pagamento || ""] || "💰"}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{fpLabels[m.forma_pagamento || ""] || "Sem forma"}</p>
                          <p className="text-xs text-[var(--color-text-muted)] truncate">{m.categoria_nome}{m.observacao ? ` · ${m.observacao}` : ""}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-emerald-600 text-sm">{fmt(m.valor)}</span>
                        <button onClick={() => iniciarEdicao(m)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
