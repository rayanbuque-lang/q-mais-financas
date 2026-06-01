"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const diasSemanaLong = ["Domingo","Segunda-feira","Terça-feira","Quarta-feira","Quinta-feira","Sexta-feira","Sábado"];
const VALOR_1T_SEMANA = 333;
const VALOR_2T_SEMANA = 666;
const VALOR_1T_DOMINGO = 435;

interface CaixaDia {
  id: string; data: string; turnos: number;
  valor_total_vendas: number; cartao: number;
  pix_santander: number; pix_inter: number; rom_card: number;
  app: number; prefeitura: number; voucher: number;
  compras_prazo: number; dinheiro: number;
  valor_inicial_caixa: number; total: number;
  fechado: boolean; fechado_por: string | null; fechado_em: string | null;
}

interface CaixaForm {
  valor_total_vendas: string; cartao: string;
  pix_santander: string; pix_inter: string; rom_card: string;
  app: string; prefeitura: string; voucher: string; compras_prazo: string;
}

const formVazio: CaixaForm = {
  valor_total_vendas: "", cartao: "", pix_santander: "", pix_inter: "",
  rom_card: "", app: "", prefeitura: "", voucher: "", compras_prazo: "",
};

export default function FechamentoCaixaPage() {
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [caixas, setCaixas] = useState<CaixaDia[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  const [showShifts, setShowShifts] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [detailData, setDetailData] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<CaixaDia | null>(null);
  const [form, setForm] = useState<CaixaForm>({ ...formVazio });
  const [turnos, setTurnos] = useState(1);
  const [valorInicial, setValorInicial] = useState(0);

  const supabase = createClient();

  useEffect(() => {
    async function check() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: p } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setIsAdmin(p?.role === "master");
      }
    }
    check();
  }, []);

  async function carregarDados() {
    setLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
    const { data } = await supabase.from("fechamento_caixa").select("*").gte("data", inicio).lte("data", fim).order("data");
    setCaixas((data || []) as CaixaDia[]);
    setLoading(false);
  }

  useEffect(() => { carregarDados(); setShowDetail(false); setShowShifts(false); }, [mes, ano]);

  function mesAnterior() { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); }
  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function pf(s: string) { return s ? parseFloat(s.replace(",", ".")) : 0; }

  function calcDinheiroTotal(f: CaixaForm, vi: number) {
    const tv = pf(f.valor_total_vendas);
    const sub = pf(f.cartao) + pf(f.pix_santander) + pf(f.pix_inter) + pf(f.rom_card) + pf(f.app) + pf(f.prefeitura) + pf(f.voucher) + pf(f.compras_prazo);
    const dinheiro = Math.max(tv - sub, 0);
    const total = dinheiro - vi;
    return { dinheiro, total };
  }

  function getRecord(data: string): CaixaDia | undefined {
    return caixas.find(c => c.data === data);
  }

  function setFormFromRecord(r: CaixaDia) {
    setForm({
      valor_total_vendas: r.valor_total_vendas ? r.valor_total_vendas.toString().replace(".", ",") : "",
      cartao: r.cartao ? r.cartao.toString().replace(".", ",") : "",
      pix_santander: r.pix_santander ? r.pix_santander.toString().replace(".", ",") : "",
      pix_inter: r.pix_inter ? r.pix_inter.toString().replace(".", ",") : "",
      rom_card: r.rom_card ? r.rom_card.toString().replace(".", ",") : "",
      app: r.app ? r.app.toString().replace(".", ",") : "",
      prefeitura: r.prefeitura ? r.prefeitura.toString().replace(".", ",") : "",
      voucher: r.voucher ? r.voucher.toString().replace(".", ",") : "",
      compras_prazo: r.compras_prazo ? r.compras_prazo.toString().replace(".", ",") : "",
    });
    setTurnos(r.turnos);
    setValorInicial(r.valor_inicial_caixa);
    setDetailRecord(r);
  }

  function handleFormChange(field: keyof CaixaForm, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function handleDayClick(data: string) {
    const rec = getRecord(data);

    if (rec) {
      setDetailData(data);
      setFormFromRecord(rec);
      setShowDetail(true);
      setShowShifts(false);
    } else {
      setDetailData(data);
      setForm({ ...formVazio });
      setDetailRecord(null);

      const dow = new Date(data + "T12:00:00").getDay();
      if (dow === 0) {
        setTurnos(1);
        setValorInicial(VALOR_1T_DOMINGO);
        setShowDetail(true);
        setShowShifts(false);
      } else {
        setShowShifts(true);
        setShowDetail(false);
      }
    }
  }

  function selectShift(t: number, v: number) {
    setTurnos(t);
    setValorInicial(v);
    setShowShifts(false);
    setShowDetail(true);
  }

  function cancelShift() {
    setShowShifts(false);
    setDetailData(null);
  }

  async function handleSalvar() {
    if (!detailData) return;
    setLoading(true);
    const { dinheiro, total } = calcDinheiroTotal(form, valorInicial);
    const dados = {
      data: detailData, turnos, valor_total_vendas: pf(form.valor_total_vendas),
      cartao: pf(form.cartao), pix_santander: pf(form.pix_santander),
      pix_inter: pf(form.pix_inter), rom_card: pf(form.rom_card),
      app: pf(form.app), prefeitura: pf(form.prefeitura),
      voucher: pf(form.voucher), compras_prazo: pf(form.compras_prazo),
      dinheiro, valor_inicial_caixa: valorInicial, total,
    };

    if (detailRecord) {
      await supabase.from("fechamento_caixa").update(dados).eq("id", detailRecord.id);
      setMensagem("Atualizado!");
      await registrarLog({ acao: "editou", tabela: "fechamento_caixa", registroId: detailRecord.id, dadosNovos: dados });
    } else {
      await supabase.from("fechamento_caixa").upsert(dados, { onConflict: "data" });
      setMensagem("Dia salvo!");
      await registrarLog({ acao: "criou", tabela: "fechamento_caixa", dadosNovos: dados });
    }
    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function fecharDia() {
    if (!detailData || !detailRecord) return;
    setLoading(true);
    const { dinheiro, total } = calcDinheiroTotal(form, valorInicial);

    await supabase.from("fechamento_caixa").update({
      dinheiro, total, cartao: pf(form.cartao), pix_santander: pf(form.pix_santander),
      pix_inter: pf(form.pix_inter), rom_card: pf(form.rom_card), app: pf(form.app),
      prefeitura: pf(form.prefeitura), voucher: pf(form.voucher),
      compras_prazo: pf(form.compras_prazo), valor_total_vendas: pf(form.valor_total_vendas),
      fechado: true, fechado_em: new Date().toISOString(),
    }).eq("id", detailRecord.id);

    if (total > 0) {
      const { data: catDin } = await supabase.from("categorias_saida").select("id").eq("nome", "Dinheiro (Fechamento Caixa)").limit(1);
      if (catDin && catDin.length > 0) {
        const existente = await supabase.from("movimentacoes").select("id").eq("data", detailData).eq("categoria_id", catDin[0].id).ilike("observacao", "%Fechamento de Caixa%").limit(1);
        if (!existente.data || existente.data.length === 0) {
          await supabase.from("movimentacoes").insert({
            tipo: "entrada", data: detailData, valor: total,
            categoria_id: catDin[0].id,
            observacao: `Fechamento de Caixa ${new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR")}`,
            forma_pagamento: "dinheiro", revisar: false,
          });
        } else {
          await supabase.from("movimentacoes").update({ valor: total }).eq("id", existente.data[0].id);
        }
      }
    }

    await registrarLog({ acao: "fechou", tabela: "fechamento_caixa", registroId: detailRecord.id, detalhes: `Dia ${detailData} - Total: ${fmt(total)}` });
    setMensagem(`Dia fechado! ${fmt(total)} lançado em Movimentações como Dinheiro.`);
    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 5000);
  }

  async function reabrirDia() {
    if (!detailRecord || !isAdmin) {
      setMensagem("Apenas administradores podem reabrir."); setTimeout(() => setMensagem(""), 3000); return;
    }
    setLoading(true);

    const { data: catDin } = await supabase.from("categorias_saida").select("id").eq("nome", "Dinheiro (Fechamento Caixa)").limit(1);
    if (catDin && catDin.length > 0) {
      await supabase.from("movimentacoes").delete().eq("data", detailRecord.data).eq("categoria_id", catDin[0].id).ilike("observacao", "%Fechamento de Caixa%");
    }

    await supabase.from("fechamento_caixa").update({ fechado: false, fechado_por: null, fechado_em: null }).eq("id", detailRecord.id);
    await registrarLog({ acao: "reabriu", tabela: "fechamento_caixa", registroId: detailRecord.id });
    setMensagem("Dia reaberto e movimentação removida.");
    await carregarDados();
    const atualizado = getRecord(detailRecord.data);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function excluirDia() {
    if (!detailRecord) return;
    if (!confirm("Excluir este dia?")) return;
    setLoading(true);

    if (detailRecord.fechado) {
      const { data: catDin } = await supabase.from("categorias_saida").select("id").eq("nome", "Dinheiro (Fechamento Caixa)").limit(1);
      if (catDin && catDin.length > 0) {
        await supabase.from("movimentacoes").delete().eq("data", detailRecord.data).eq("categoria_id", catDin[0].id).ilike("observacao", "%Fechamento de Caixa%");
      }
    }
    await supabase.from("fechamento_caixa").delete().eq("id", detailRecord.id);
    await registrarLog({ acao: "excluiu", tabela: "fechamento_caixa", registroId: detailRecord.id });
    setShowDetail(false); setDetailRecord(null); setMensagem("Dia excluído!");
    carregarDados(); setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  function closeDetail() {
    setShowDetail(false);
    setShowShifts(false);
    setDetailData(null);
    setDetailRecord(null);
  }

  const diasNoMes = new Date(ano, mes, 0).getDate();
  const registros = caixas.filter(c => c.fechado);
  const totalVendidoMes = registros.reduce((a, c) => a + c.total, 0);
  const totalBrutoMes = registros.reduce((a, c) => a + c.valor_total_vendas, 0);
  const diasConferidos = registros.length;

  // Detalhe render
  const detailContent = showDetail && detailData ? (() => {
    const { dinheiro, total } = calcDinheiroTotal(form, valorInicial);
    const dow = new Date(detailData + "T12:00:00").getDay();
    const ehDomingo = dow === 0;

    const campos = [
      { field: "cartao" as const, label: "💳 Cartão", bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
      { field: "pix_santander" as const, label: "📱 Pix Santander", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
      { field: "pix_inter" as const, label: "📱 Pix Inter", bg: "#fff7ed", border: "#fed7aa", color: "#ea580c" },
      { field: "rom_card" as const, label: "💳 Rom Card", bg: "#f5f3ff", border: "#ddd6fe", color: "#7c3aed" },
      { field: "app" as const, label: "📲 App", bg: "#ecfdf5", border: "#a7f3d0", color: "#059669" },
      { field: "prefeitura" as const, label: "🏛️ Prefeitura", bg: "#ecfeff", border: "#a5f3fc", color: "#0891b2" },
      { field: "voucher" as const, label: "🎫 Voucher", bg: "#fffbeb", border: "#fde68a", color: "#d97706" },
      { field: "compras_prazo" as const, label: "🛒 Compras à Prazo", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
    ];

    return (
      <div style={{ animation: "fadeUp 0.3s ease", background: "var(--color-surface)", border: "2px solid #3b82f6", borderRadius: 20, overflow: "hidden" }}>

        <div style={{ padding: "16px 20px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: 16, margin: 0, textTransform: "capitalize" }}>
              {diasSemanaLong[dow]}, {new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
            </h2>
            <span style={{ fontSize: 11, color: "#6b7280" }}>
              {turnos} {turnos === 1 ? "turno" : "turnos"} · Caixa inicial: {fmt(valorInicial)}
              {detailRecord?.fechado && " · ✅ Conferido"}
            </span>
          </div>
          <button onClick={closeDetail} style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "white", cursor: "pointer", fontSize: 14, color: "#6b7280" }}>✕</button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Total Vendas */}
          <div style={{ background: "#f0f9ff", border: "2px solid #0ea5e9", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase" }}>💰 VALOR TOTAL DE VENDAS DO DIA</label>
            <input type="text" value={form.valor_total_vendas} onChange={e => handleFormChange("valor_total_vendas", e.target.value)} placeholder="0,00"
              style={{ width: "100%", marginTop: 6, padding: "10px 12px", borderRadius: 8, border: "1px solid #7dd3fc", background: "white", fontSize: 18, fontWeight: 700, color: "#0369a1", outline: "none" }} />
          </div>

          {/* Grid de campos */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            {campos.map(item => (
              <div key={item.field} style={{ background: item.bg, border: `1px solid ${item.border}`, borderRadius: 12, padding: 12 }}>
                <label style={{ fontSize: 10, fontWeight: 700, color: item.color, textTransform: "uppercase" }}>{item.label}</label>
                <input type="text" value={form[item.field]} onChange={e => handleFormChange(item.field, e.target.value)} placeholder="0,00"
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: `1px solid ${item.border}`, background: "white", fontSize: 14, fontWeight: 600, color: item.color, outline: "none" }} />
              </div>
            ))}

            {/* Dinheiro auto */}
            <div style={{ background: "#f0fdf4", border: "2px solid #16a34a", borderRadius: 12, padding: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: "#16a34a", textTransform: "uppercase" }}>💵 DINHEIRO (auto)</label>
              <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: "white", border: "1px solid #bbf7d0", fontSize: 16, fontWeight: 700, color: dinheiro >= 0 ? "#16a34a" : "#dc2626" }}>
                {fmt(dinheiro)}
              </div>
              <p style={{ fontSize: 9, color: "#6b7280", margin: "4px 0 0" }}>Vendas - métodos</p>
            </div>

            {/* Valor Inicial */}
            <div style={{ background: "#fffbeb", border: "2px solid #d97706", borderRadius: 12, padding: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: "#d97706", textTransform: "uppercase" }}>💰 CAIXA INICIAL</label>
              <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: "white", border: "1px solid #fde68a", fontSize: 16, fontWeight: 700, color: "#d97706" }}>
                - {fmt(valorInicial)}
              </div>
              <p style={{ fontSize: 9, color: "#6b7280", margin: "4px 0 0" }}>{turnos}T · {ehDomingo ? "Dom" : "Seg-Sáb"}</p>
            </div>
          </div>

          {/* Total */}
          <div style={{ marginTop: 12, background: total >= 0 ? "#ecfdf5" : "#fef2f2", border: `2px solid ${total >= 0 ? "#16a34a" : "#dc2626"}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: total >= 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase", margin: 0 }}>📊 TOTAL DO DIA</p>
              <p style={{ fontSize: 9, color: "#6b7280", margin: "2px 0 0" }}>Dinheiro - Caixa Inicial</p>
            </div>
            <span style={{ fontSize: 24, fontWeight: 800, color: total >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(total)}</span>
          </div>

          {/* Botões */}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button onClick={handleSalvar} disabled={loading}
              style={{ flex: 1, minWidth: 120, padding: "12px 20px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #059669, #10b981)", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>
              {loading ? "Salvando..." : "💾 Salvar"}
            </button>
            {detailRecord && !detailRecord.fechado && (
              <button onClick={fecharDia} disabled={loading}
                style={{ padding: "12px 20px", borderRadius: 12, border: "none", background: "#16a34a", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                ✓ Conferir e Fechar
              </button>
            )}
            {detailRecord && detailRecord.fechado && (
              <button onClick={reabrirDia}
                style={{ padding: "12px 20px", borderRadius: 12, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                ↩️ Reabrir {!isAdmin && "(Admin)"}
              </button>
            )}
            {detailRecord && (
              <button onClick={excluirDia}
                style={{ padding: "12px 20px", borderRadius: 12, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                🗑️
              </button>
            )}
          </div>
        </div>
      </div>
    );
  })() : null;

  return (
    <div className="space-y-6">
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fechamento de Caixa</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Preencha cada dia · Dinheiro calculado automaticamente</p>
        </div>
        {loading && <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />}
      </div>

      {/* Navegação mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold text-lg capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Total Bruto", v: fmt(totalBrutoMes), c: "text-blue-600" },
          { l: "Total Vendido", v: fmt(totalVendidoMes), c: totalVendidoMes >= 0 ? "text-emerald-600" : "text-red-500" },
          { l: "Conferidos", v: `${diasConferidos}`, c: "text-emerald-600" },
          { l: "Dias no Mês", v: `${diasNoMes}`, c: "text-[var(--color-text)]" },
        ].map(c => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem && <div className="p-3 rounded-xl text-sm font-medium text-center bg-emerald-50 text-emerald-700">{mensagem}</div>}

      {/* Grid de dias */}
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
        {Array.from({ length: diasNoMes }, (_, i) => i + 1).map(d => {
          const dataStr = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const dt = new Date(ano, mes - 1, d);
          const dow = dt.getDay();
          const rec = getRecord(dataStr);
          const isSelected = detailData === dataStr && (showDetail || showShifts);
          return (
            <button key={d} type="button" onClick={() => handleDayClick(dataStr)}
              style={{
                display: "block", width: "100%", textAlign: "left",
                borderRadius: 12, padding: "10px 12px",
                border: `2px solid ${rec?.fechado ? "#16a34a" : isSelected ? "#3b82f6" : rec ? "#93c5fd" : "#e5e7eb"}`,
                background: rec?.fechado ? "#f0fdf4" : isSelected ? "#eff6ff" : rec ? "#f0f9ff" : "white",
                cursor: "pointer", transition: "all 0.2s",
              }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div>
                  <span style={{ fontWeight: 800, fontSize: 18, lineHeight: 1 }}>{d}</span>
                  <span style={{ fontSize: 9, color: dow === 0 ? "#dc2626" : "#9ca3af", marginLeft: 3, fontWeight: dow === 0 ? 700 : 400 }}>{diasSemana[dow]}</span>
                </div>
                {rec?.fechado && <span style={{ fontSize: 12 }}>✅</span>}
              </div>
              {rec ? (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: rec.total >= 0 ? "#059669" : "#dc2626", lineHeight: 1.2 }}>{fmt(rec.total)}</div>
                  <div style={{ fontSize: 8, color: "#9ca3af", marginTop: 2 }}>{rec.turnos}T · {fmt(rec.dinheiro)}</div>
                </div>
              ) : (
                <div style={{ fontSize: 9, color: "#0ea5e9", padding: "6px 0", fontWeight: 600 }}>+ Abrir</div>
              )}
            </button>
          );
        })}
      </div>

      {/* Dialog de turnos */}
      {showShifts && detailData && (
        <div style={{ background: "var(--color-surface)", border: "2px solid #d97706", borderRadius: 16, padding: 20, animation: "fadeUp 0.2s ease" }}>
          <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            {diasSemanaLong[new Date(detailData + "T12:00:00").getDay()]}, {new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}
          </p>
          <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>Quantos turnos de caixa?</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => selectShift(1, VALOR_1T_SEMANA)}
              style={{ flex: 1, minWidth: 140, padding: "14px 16px", borderRadius: 12, border: "2px solid #d97706", background: "#fffbeb", cursor: "pointer", textAlign: "center" }}>
              <span style={{ fontSize: 20 }}>💰</span>
              <p style={{ fontWeight: 700, fontSize: 13, margin: "4px 0 0", color: "#92400e" }}>1 Turno</p>
              <p style={{ fontSize: 11, color: "#d97706" }}>R$ {VALOR_1T_SEMANA.toFixed(2)}</p>
            </button>
            <button onClick={() => selectShift(2, VALOR_2T_SEMANA)}
              style={{ flex: 1, minWidth: 140, padding: "14px 16px", borderRadius: 12, border: "2px solid #d97706", background: "#fffbeb", cursor: "pointer", textAlign: "center" }}>
              <span style={{ fontSize: 20 }}>💰💰</span>
              <p style={{ fontWeight: 700, fontSize: 13, margin: "4px 0 0", color: "#92400e" }}>2 Turnos</p>
              <p style={{ fontSize: 11, color: "#d97706" }}>R$ {VALOR_2T_SEMANA.toFixed(2)}</p>
            </button>
            <button onClick={cancelShift}
              style={{ padding: "14px 16px", borderRadius: 12, border: "1px solid #d1d5db", background: "white", cursor: "pointer", fontSize: 12, color: "#6b7280" }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Detalhe do dia */}
      {detailContent}
    </div>
  );
}
