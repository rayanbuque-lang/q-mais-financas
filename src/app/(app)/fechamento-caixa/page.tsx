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
const diasSemanaLong = ["Domingo","Segunda-feira","Terça-feira","Quarta-feira","Quinta-feira","Sexta-feira","Sábado"];
const VALOR_INICIAL_SEMANA = 333;
const VALOR_INICIAL_DOMINGO = 435;

interface Movimentacao {
  id: string; tipo: string; data: string; valor: number;
  categoria_id: string; observacao: string; forma_pagamento: string | null; revisar: boolean;
}

interface CompraPrazo {
  id: string; data: string; descricao: string; valor: number; observacao: string | null;
}

interface FechamentoInfo {
  id: string; data: string; fechado: boolean; valor_inicial_caixa: number | null;
  fechado_por: string | null; fechado_em: string | null;
}

interface DiaInfo {
  data: string; dia: number; semana: string; semanaLong: string; ehDomingo: boolean;
  movs: Movimentacao[]; porFP: Record<string, number>; totalBruto: number;
  valorInicial: number; comprasPrazo: CompraPrazo[]; totalComprasPrazo: number;
  totalDescontos: number; totalVendido: number;
  fechado: boolean; fechamentoId: string | null;
}

export default function FechamentoCaixaPage() {
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [dias, setDias] = useState<DiaInfo[]>([]);
  const [diaAberto, setDiaAberto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");

  const [editMovId, setEditMovId] = useState<string | null>(null);
  const [editMovValor, setEditMovValor] = useState("");
  const [editMovFP, setEditMovFP] = useState("");
  const [editMovObs, setEditMovObs] = useState("");

  const [editandoInicial, setEditandoInicial] = useState<string | null>(null);
  const [editInicialValor, setEditInicialValor] = useState("");

  const [addCompraData, setAddCompraData] = useState<string | null>(null);
  const [novaCompraDesc, setNovaCompraDesc] = useState("");
  const [novaCompraValor, setNovaCompraValor] = useState("");
  const [novaCompraObs, setNovaCompraObs] = useState("");
  const [editCompraId, setEditCompraId] = useState<string | null>(null);

  const supabase = createClient();

  async function carregarDados() {
    setLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const [r1, r2, r3] = await Promise.all([
      supabase.from("movimentacoes").select("*").eq("tipo", "entrada").gte("data", inicio).lte("data", fim).order("data"),
      supabase.from("fechamento_dia").select("*").gte("data", inicio).lte("data", fim),
      supabase.from("compras_prazo").select("*").gte("data", inicio).lte("data", fim).order("data"),
    ]);

    const movs = (r1.data || []) as Movimentacao[];
    const fechamentos = (r2.data || []) as FechamentoInfo[];
    const compras = (r3.data || []) as CompraPrazo[];

    const diasDoMes: DiaInfo[] = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const dataStr = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dt = new Date(ano, mes - 1, d);
      const dow = dt.getDay();
      const movsDoDia = movs.filter(m => m.data === dataStr);
      const porFP: Record<string, number> = {};
      let totalBruto = 0;
      movsDoDia.forEach(m => {
        const fp = m.forma_pagamento || "outros";
        porFP[fp] = (porFP[fp] || 0) + m.valor;
        totalBruto += m.valor;
      });
      const fech = fechamentos.find(f => f.data === dataStr);
      const valorInicial = fech?.valor_inicial_caixa ?? (dow === 0 ? VALOR_INICIAL_DOMINGO : VALOR_INICIAL_SEMANA);
      const comprasDoDia = compras.filter(c => c.data === dataStr);
      const totalComprasPrazo = comprasDoDia.reduce((a, c) => a + c.valor, 0);

      diasDoMes.push({
        data: dataStr, dia: d, semana: diasSemana[dow], semanaLong: diasSemanaLong[dow],
        ehDomingo: dow === 0, movs: movsDoDia, porFP, totalBruto,
        valorInicial, comprasPrazo: comprasDoDia, totalComprasPrazo,
        totalDescontos: valorInicial + totalComprasPrazo,
        totalVendido: totalBruto - valorInicial - totalComprasPrazo,
        fechado: fech?.fechado || false, fechamentoId: fech?.id || null,
      });
    }
    setDias(diasDoMes);
    setLoading(false);
  }

  useEffect(() => { carregarDados(); }, [mes, ano]);

  function mesAnterior() { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); setDiaAberto(null); }
  function mesProximo() { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); setDiaAberto(null); }

  async function garantirFechamento(data: string): Promise<string> {
    const { data: results } = await supabase.from("fechamento_dia").select("id").eq("data", data).limit(1);
    if (results && results.length > 0) return results[0].id;
    const diaInfo = dias.find(d => d.data === data);
    const { data: novo } = await supabase.from("fechamento_dia").insert({
      data, fechado: false, valor_inicial_caixa: diaInfo?.valorInicial || VALOR_INICIAL_SEMANA,
    }).select("id").single();
    return novo?.id || "";
  }

  async function fecharDia(data: string) {
    const id = await garantirFechamento(data);
    await supabase.from("fechamento_dia").update({ fechado: true, fechado_em: new Date().toISOString() }).eq("id", id);
    await registrarLog({ acao: "fechou", tabela: "fechamento_dia", detalhes: `Dia ${data} conferido` });
    setMensagem("Dia conferido e fechado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function reabrirDia(data: string) {
    await supabase.from("fechamento_dia").update({ fechado: false }).eq("data", data);
    await registrarLog({ acao: "reabriu", tabela: "fechamento_dia", detalhes: `Dia ${data} reaberto` });
    setMensagem("Dia reaberto!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function iniciarEdicaoMov(m: Movimentacao) {
    setEditMovId(m.id); setEditMovValor(m.valor.toString().replace(".", ","));
    setEditMovFP(m.forma_pagamento || ""); setEditMovObs(m.observacao || "");
  }

  async function salvarEdicaoMov(m: Movimentacao) {
    const novoValor = parseFloat(editMovValor.replace(",", "."));
    await supabase.from("movimentacoes").update({
      valor: novoValor, forma_pagamento: editMovFP || null, observacao: editMovObs,
    }).eq("id", m.id);
    await registrarLog({ acao: "editou", tabela: "movimentacoes", registroId: m.id, dadosAnteriores: { valor: m.valor }, dadosNovos: { valor: novoValor }, detalhes: `R$ ${m.valor.toFixed(2)} → R$ ${novoValor.toFixed(2)}` });
    setEditMovId(null); setMensagem("Movimentação atualizada!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function iniciarEdicaoInicial(dia: DiaInfo) {
    setEditandoInicial(dia.data); setEditInicialValor(dia.valorInicial.toString().replace(".", ","));
  }

  async function salvarValorInicial(data: string) {
    const novoValor = parseFloat(editInicialValor.replace(",", "."));
    const id = await garantirFechamento(data);
    await supabase.from("fechamento_dia").update({ valor_inicial_caixa: novoValor }).eq("id", id);
    await registrarLog({ acao: "editou", tabela: "fechamento_dia", detalhes: `Valor inicial ${data}: R$ ${novoValor.toFixed(2)}` });
    setEditandoInicial(null); setMensagem("Valor inicial atualizado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function adicionarCompraPrazo(data: string) {
    if (!novaCompraDesc || !novaCompraValor) return;
    const valor = parseFloat(novaCompraValor.replace(",", "."));
    await supabase.from("compras_prazo").insert({ data, descricao: novaCompraDesc, valor, observacao: novaCompraObs || null });
    await registrarLog({ acao: "criou", tabela: "compras_prazo", detalhes: `${novaCompraDesc} - R$ ${valor.toFixed(2)} em ${data}` });
    setAddCompraData(null); setNovaCompraDesc(""); setNovaCompraValor(""); setNovaCompraObs("");
    setMensagem("Compra à prazo adicionada!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function iniciarEdicaoCompra(c: CompraPrazo) {
    setEditCompraId(c.id); setNovaCompraDesc(c.descricao);
    setNovaCompraValor(c.valor.toString().replace(".", ",")); setNovaCompraObs(c.observacao || "");
  }

  async function salvarEdicaoCompra(c: CompraPrazo) {
    const valor = parseFloat(novaCompraValor.replace(",", "."));
    await supabase.from("compras_prazo").update({ descricao: novaCompraDesc, valor, observacao: novaCompraObs || null }).eq("id", c.id);
    setEditCompraId(null); setMensagem("Compra à prazo atualizada!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function excluirCompraPrazo(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("compras_prazo").delete().eq("id", id);
    setMensagem("Excluído!"); carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function importarComprasPrazo(data: string) {
    const { data: cat } = await supabase.from("categorias_saida").select("id").eq("nome", "Compras à Prazo").limit(1);
    if (!cat || cat.length === 0) { setMensagem("Categoria 'Compras à Prazo' não encontrada."); setTimeout(() => setMensagem(""), 3000); return; }
    const { data: movs } = await supabase.from("movimentacoes").select("*").eq("data", data).eq("categoria_id", cat[0].id);
    if (!movs || movs.length === 0) { setMensagem("Nenhuma compra à prazo nas movimentações deste dia."); setTimeout(() => setMensagem(""), 3000); return; }
    const { data: existentes } = await supabase.from("compras_prazo").select("descricao,valor").eq("data", data);
    const existentesSet = new Set((existentes || []).map(e => `${e.descricao}|${e.valor}`));
    let importadas = 0;
    for (const m of movs) {
      const key = `${m.observacao || "Compra"}|${m.valor}`;
      if (!existentesSet.has(key)) {
        await supabase.from("compras_prazo").insert({ data, descricao: m.observacao || "Compra à prazo", valor: m.valor, observacao: "Importado" });
        importadas++;
      }
    }
    setMensagem(importadas > 0 ? `${importadas} compra(s) importada(s)!` : "Nenhuma nova para importar.");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  const totalBrutoMes = dias.reduce((a, d) => a + d.totalBruto, 0);
  const totalDescMes = dias.reduce((a, d) => a + d.totalDescontos, 0);
  const totalVendidoMes = dias.reduce((a, d) => a + d.totalVendido, 0);
  const diasFechados = dias.filter(d => d.fechado).length;
  const diasComDados = dias.filter(d => d.movs.length > 0 || d.comprasPrazo.length > 0).length;

  const totaisFP: Record<string, number> = {};
  dias.forEach(d => { Object.entries(d.porFP).forEach(([fp, v]) => { if (fp !== "outros") totaisFP[fp] = (totaisFP[fp] || 0) + v; }); });

  const diaDetalhe = diaAberto ? dias.find(d => d.data === diaAberto) : null;

  return (
    <div className="space-y-6">
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fechamento de Caixa</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Conferência diária — Valor inicial R$ 333 (seg-sáb) / R$ 435 (dom)</p>
        </div>
        {loading && <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />}
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold text-lg capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Total Bruto", v: fmt(totalBrutoMes), c: "text-blue-600" },
          { l: "Descontos", v: fmt(totalDescMes), c: "text-red-500" },
          { l: "Total Vendido", v: fmt(totalVendidoMes), c: "text-emerald-600" },
          { l: "Conferidos", v: `${diasFechados}/${diasComDados}`, c: "text-emerald-600" },
        ].map(c => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {Object.keys(totaisFP).length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
          <p className="text-sm font-bold mb-3">Totais do Mês por Forma de Pagamento</p>
          <div className="flex flex-wrap gap-3">
            {Object.entries(totaisFP).sort((a, b) => b[1] - a[1]).map(([fp, val]) => (
              <div key={fp} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <span>{fpIcons[fp] || "💰"}</span>
                <span className="text-xs font-medium">{fpLabels[fp] || fp}</span>
                <span className="text-xs font-bold" style={{ color: fpCores[fp] || "#374151" }}>{fmt(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mensagem && <div className="p-3 rounded-xl text-sm font-medium text-center bg-emerald-50 text-emerald-700">{mensagem}</div>}

      {/* Grid de dias */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
        {dias.map(d => {
          const temDados = d.movs.length > 0 || d.comprasPrazo.length > 0;
          const isAberto = diaAberto === d.data;
          return (
            <div
              key={d.data}
              onClick={() => { if (temDados) setDiaAberto(isAberto ? null : d.data); }}
              style={{
                borderRadius: 14, padding: 14,
                border: `2px solid ${d.fehado ? "#16a34a" : isAberto ? "#3b82f6" : temDados ? "#e5e7eb" : "#f3f4f6"}`,
                background: d.fehado ? "#f0fdf4" : isAberto ? "#eff6ff" : temDados ? "white" : "#f9fafb",
                cursor: temDados ? "pointer" : "default",
                transition: "all 0.2s", opacity: temDados ? 1 : 0.45,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: temDados ? 8 : 0 }}>
                <div>
                  <span style={{ fontWeight: 800, fontSize: 20 }}>{d.dia}</span>
                  <span style={{ fontSize: 10, color: d.ehDomingo ? "#dc2626" : "#9ca3af", marginLeft: 4, fontWeight: d.ehDomingo ? 700 : 400 }}>{d.semana}</span>
                </div>
                {d.fehado && <span>✅</span>}
              </div>
              {temDados ? (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: d.totalVendido >= 0 ? "#059669" : "#dc2626", marginBottom: 2 }}>{fmt(d.totalVendido)}</div>
                  <div style={{ fontSize: 9, color: "#9ca3af" }}>{d.movs.length} mov · {d.comprasPrazo.length} compras</div>
                </div>
              ) : (
                <div style={{ textAlign: "center", fontSize: 10, color: "#d1d5db", padding: "8px 0" }}>Sem dados</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Painel de detalhes */}
      {diaDetalhe && (
        <div className="bg-[var(--color-surface)] border-2 border-blue-200 rounded-2xl overflow-hidden" style={{ animation: "fadeUp 0.3s ease" }}>

          {/* Header */}
          <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between flex-wrap gap-3 bg-blue-50">
            <div>
              <h2 className="font-bold text-lg capitalize">{diaDetalhe.semanaLong}, {new Date(diaDetalhe.data + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}</h2>
              <p className="text-sm text-[var(--color-text-muted)]">Total Vendido: <strong className={diaDetalhe.totalVendido >= 0 ? "text-emerald-600" : "text-red-500"}>{fmt(diaDetalhe.totalVendido)}</strong>{diaDetalhe.fechado && " · ✅ Conferido"}</p>
            </div>
            <div className="flex items-center gap-2">
              {diaDetalhe.fechado ? (
                <button onClick={() => reabrirDia(diaDetalhe.data)} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 transition">↩️ Reabrir</button>
              ) : (
                <button onClick={() => fecharDia(diaDetalhe.data)} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition">✓ Conferir e Fechar</button>
              )}
              <button onClick={() => setDiaAberto(null)} className="w-8 h-8 rounded-lg hover:bg-white flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[var(--color-border)]">
            {/* ENTRADAS */}
            <div className="p-5">
              <h3 className="font-bold text-sm mb-3 text-emerald-700">📥 ENTRADAS ({diaDetalhe.movs.length})</h3>
              {diaDetalhe.movs.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">Nenhuma entrada neste dia.</p>
              ) : (
                <div className="space-y-1">
                  {diaDetalhe.movs.map(m => {
                    const isEdit = editMovId === m.id;
                    if (isEdit) return (
                      <div key={m.id} className="bg-[var(--color-bg)] rounded-xl p-3 border border-blue-200">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex-1 min-w-[80px]">
                            <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">VALOR</label>
                            <input type="text" value={editMovValor} onChange={e => setEditMovValor(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-white text-sm focus:outline-none" />
                          </div>
                          <div className="flex-1 min-w-[100px]">
                            <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">FORMA</label>
                            <select value={editMovFP} onChange={e => setEditMovFP(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-white text-sm focus:outline-none">
                              <option value="">Selecione</option>
                              {Object.entries(fpLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          </div>
                          <div className="flex-1 min-w-[80px]">
                            <label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">OBS</label>
                            <input type="text" value={editMovObs} onChange={e => setEditMovObs(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-white text-sm focus:outline-none" />
                          </div>
                          <div className="flex gap-1 items-end">
                            <button onClick={() => salvarEdicaoMov(m)} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700">OK</button>
                            <button onClick={() => setEditMovId(null)} className="px-3 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-xs">✕</button>
                          </div>
                        </div>
                      </div>
                    );
                    return (
                      <div key={m.id} className="flex items-center justify-between py-2 px-3 rounded-xl hover:bg-[var(--color-bg)] transition group">
                        <div className="flex items-center gap-2 min-w-0">
                          <span>{fpIcons[m.forma_pagamento || ""] || "💰"}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{fpLabels[m.forma_pagamento || ""] || "Sem forma"}</p>
                            <p className="text-xs text-[var(--color-text-muted)] truncate">{m.observacao || "—"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-emerald-600">{fmt(m.valor)}</span>
                          <button onClick={() => iniciarEdicaoMov(m)} className="p-1 rounded hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 text-xs opacity-0 group-hover:opacity-100 transition">✏️</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
                {Object.entries(diaDetalhe.porFP).filter(([fp]) => fp !== "outros").sort((a, b) => b[1] - a[1]).map(([fp, val]) => (
                  <div key={fp} className="flex items-center justify-between py-1">
                    <span className="text-xs font-medium" style={{ color: fpCores[fp] }}>{fpIcons[fp]} {fpLabels[fp]}</span>
                    <span className="text-xs font-bold" style={{ color: fpCores[fp] }}>{fmt(val)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-2 mt-2 border-t border-[var(--color-border)]">
                  <span className="text-sm font-bold">TOTAL BRUTO</span>
                  <span className="text-sm font-bold text-blue-600">{fmt(diaDetalhe.totalBruto)}</span>
                </div>
              </div>
            </div>

            {/* DESCONTOS */}
            <div className="p-5">
              <h3 className="font-bold text-sm mb-3 text-red-600">📤 DESCONTOS</h3>

              {/* Valor Inicial */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-amber-800">💰 Valor Inicial de Caixa</span>
                  <span className="text-[10px] text-amber-600 font-medium">{diaDetalhe.ehDomingo ? "Domingo" : "Seg-Sáb"}</span>
                </div>
                {editandoInicial === diaDetalhe.data ? (
                  <div className="flex items-center gap-2">
                    <input type="text" value={editInicialValor} onChange={e => setEditInicialValor(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-amber-300 bg-white text-sm focus:outline-none" />
                    <button onClick={() => salvarValorInicial(diaDetalhe.data)} className="px-3 py-2 bg-amber-600 text-white rounded-lg text-xs font-semibold">Salvar</button>
                    <button onClick={() => setEditandoInicial(null)} className="px-3 py-2 bg-white text-gray-500 rounded-lg text-xs border border-gray-300">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-amber-700 text-lg">- {fmt(diaDetalhe.valorInicial)}</span>
                    <button onClick={() => iniciarEdicaoInicial(diaDetalhe)} className="p-1 rounded hover:bg-amber-100 text-amber-600 text-xs">✏️</button>
                  </div>
                )}
              </div>

              {/* Compras à Prazo */}
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-red-800">🛒 Compras à Prazo</span>
                  <div className="flex gap-1">
                    <button onClick={() => { setAddCompraData(diaDetalhe.data); setNovaCompraDesc(""); setNovaCompraValor(""); setNovaCompraObs(""); }} className="px-2 py-1 bg-red-600 text-white rounded-lg text-[10px] font-semibold hover:bg-red-700">+ Adicionar</button>
                    <button onClick={() => importarComprasPrazo(diaDetalhe.data)} className="px-2 py-1 bg-white text-red-600 rounded-lg text-[10px] font-semibold border border-red-300 hover:bg-red-50">📥 Importar</button>
                  </div>
                </div>

                {diaDetalhe.comprasPrazo.length === 0 && addCompraData !== diaDetalhe.data && (
                  <p className="text-xs text-red-400 text-center py-3">Nenhuma compra à prazo</p>
                )}

                <div className="space-y-1">
                  {diaDetalhe.comprasPrazo.map(c => {
                    if (editCompraId === c.id) return (
                      <div key={c.id} className="bg-white rounded-lg p-2 border border-red-200">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input type="text" value={novaCompraDesc} onChange={e => setNovaCompraDesc(e.target.value)} placeholder="Descrição" className="flex-1 min-w-[80px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs focus:outline-none" />
                          <input type="text" value={novaCompraValor} onChange={e => setNovaCompraValor(e.target.value)} placeholder="Valor" className="w-24 px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs focus:outline-none" />
                          <button onClick={() => salvarEdicaoCompra(c)} className="px-2 py-1.5 bg-emerald-600 text-white rounded-lg text-[10px] font-semibold">OK</button>
                          <button onClick={() => setEditCompraId(null)} className="px-2 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-[10px]">✕</button>
                        </div>
                      </div>
                    );
                    return (
                      <div key={c.id} className="flex items-center justify-between py-1.5 px-2 bg-white rounded-lg group">
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">{c.descricao}</p>
                          {c.observacao && <p className="text-[10px] text-[var(--color-text-muted)]">{c.observacao}</p>}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-bold text-red-600">- {fmt(c.valor)}</span>
                          <button onClick={() => iniciarEdicaoCompra(c)} className="p-1 rounded hover:bg-red-100 text-[var(--color-text-muted)] text-[10px] opacity-0 group-hover:opacity-100 transition">✏️</button>
                          <button onClick={() => excluirCompraPrazo(c.id)} className="p-1 rounded hover:bg-red-100 text-[var(--color-text-muted)] text-[10px] opacity-0 group-hover:opacity-100 transition">🗑️</button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {addCompraData === diaDetalhe.data && (
                  <div className="mt-2 bg-white rounded-lg p-3 border border-red-200">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input type="text" value={novaCompraDesc} onChange={e => setNovaCompraDesc(e.target.value)} placeholder="Descrição" className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs focus:outline-none" />
                      <input type="text" value={novaCompraValor} onChange={e => setNovaCompraValor(e.target.value)} placeholder="Valor R$" className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs focus:outline-none" />
                      <input type="text" value={novaCompraObs} onChange={e => setNovaCompraObs(e.target.value)} placeholder="Obs (opcional)" className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs focus:outline-none" />
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => adicionarCompraPrazo(diaDetalhe.data)} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-[10px] font-semibold hover:bg-red-700">Adicionar</button>
                      <button onClick={() => setAddCompraData(null)} className="px-3 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-[10px]">Cancelar</button>
                    </div>
                  </div>
                )}

                {diaDetalhe.totalComprasPrazo > 0 && (
                  <div className="flex items-center justify-between pt-2 mt-2 border-t border-red-200">
                    <span className="text-xs font-bold text-red-700">Total Compras</span>
                    <span className="text-xs font-bold text-red-700">- {fmt(diaDetalhe.totalComprasPrazo)}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 mt-3 border-t border-[var(--color-border)]">
                <span className="text-sm font-bold">TOTAL DESCONTOS</span>
                <span className="text-sm font-bold text-red-500">- {fmt(diaDetalhe.totalDescontos)}</span>
              </div>
            </div>
          </div>

          {/* RESUMO */}
          <div className="p-5 border-t-2 border-blue-200 bg-gradient-to-r from-blue-50 to-emerald-50">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-center">
                  <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">Bruto</p>
                  <p className="font-bold text-blue-600">{fmt(diaDetalhe.totalBruto)}</p>
                </div>
                <span className="text-xl text-gray-300">-</span>
                <div className="text-center">
                  <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">Descontos</p>
                  <p className="font-bold text-red-500">{fmt(diaDetalhe.totalDescontos)}</p>
                </div>
                <span className="text-xl text-gray-300">=</span>
                <div className="text-center">
                  <p className="text-[10px] font-semibold uppercase">Total Vendido</p>
                  <p className={`text-xl font-bold ${diaDetalhe.totalVendido >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmt(diaDetalhe.totalVendido)}</p>
                </div>
              </div>
              {diaDetalhe.fechado ? (
                <button onClick={() => reabrirDia(diaDetalhe.data)} className="px-6 py-3 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50 transition">↩️ Reabrir Dia</button>
              ) : (
                <button onClick={() => fecharDia(diaDetalhe.data)} className="px-6 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition shadow-md shadow-emerald-200">✓ Conferir e Fechar Dia</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
