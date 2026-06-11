"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";
import { CurrencyInput } from "@/components/currency-input";

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const diasSemanaLong = ["Domingo","Segunda-feira","Terça-feira","Quarta-feira","Quinta-feira","Sexta-feira","Sábado"];

interface CaixaDia {
  id: string; data: string; turnos: number;
  valor_total_vendas: number; cartao: number;
  pix_santander: number; pix_inter: number; rom_card: number;
  app: number; prefeitura: number;
  compras_prazo: number; dinheiro: number;
  sobras_faltas: number; total: number;
  fechado: boolean; fechado_por: string | null; fechado_em: string | null;
}

interface CaixaForm {
  valor_total_vendas: number; cartao: number;
  pix_santander: number; pix_inter: number; rom_card: number;
  app: number; prefeitura: number; compras_prazo: number;
}

const formVazio: CaixaForm = {
  valor_total_vendas: 0, cartao: 0, pix_santander: 0, pix_inter: 0,
  rom_card: 0, app: 0, prefeitura: 0, compras_prazo: 0,
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
  const [sobrasfaltas, setSobrasfaltas] = useState(0); // positivo = sobras, negativo = faltas

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

  async function garantirCategoria(): Promise<string | null> {
    const nome = "Dinheiro (Fechamento Caixa)";
    const { data: existenteEntrada } = await supabase.from("categorias_entrada").select("id").eq("nome", nome).limit(1);
    if (existenteEntrada && existenteEntrada.length > 0) return existenteEntrada[0].id;
    const { data: novaEntrada } = await supabase.from("categorias_entrada").insert({ nome, ativo: true }).select("id").single();
    if (novaEntrada) return novaEntrada.id;
    const { data: existenteSaida } = await supabase.from("categorias_saida").select("id").eq("nome", nome).limit(1);
    if (existenteSaida && existenteSaida.length > 0) return existenteSaida[0].id;
    return null;
  }

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

  function calcDinheiroTotal(f: CaixaForm, sf: number) {
    const sub = f.cartao + f.pix_santander + f.pix_inter + f.rom_card + f.app + f.prefeitura + f.compras_prazo;
    const dinheiro = Math.max(f.valor_total_vendas - sub, 0);
    const total = dinheiro + sf;
    return { dinheiro, total };
  }

  function getRecord(data: string): CaixaDia | undefined {
    return caixas.find(c => c.data === data);
  }

  function setFormFromRecord(r: CaixaDia) {
    setForm({
      valor_total_vendas: r.valor_total_vendas ?? 0,
      cartao: r.cartao ?? 0,
      pix_santander: r.pix_santander ?? 0,
      pix_inter: r.pix_inter ?? 0,
      rom_card: r.rom_card ?? 0,
      app: r.app ?? 0,
      prefeitura: r.prefeitura ?? 0,
      compras_prazo: r.compras_prazo ?? 0,
    });
    setTurnos(r.turnos);
    setSobrasfaltas(r.sobras_faltas ?? 0);
    setDetailRecord(r);
  }

  function handleFormChange(field: keyof CaixaForm, value: number) {
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
      setSobrasfaltas(0);
      const dow = new Date(data + "T12:00:00").getDay();
      if (dow === 0) {
        setTurnos(1);
        setShowDetail(true);
        setShowShifts(false);
      } else {
        setShowShifts(true);
        setShowDetail(false);
      }
    }
  }

  function selectShift(t: number) {
    setTurnos(t);
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
    const { dinheiro, total } = calcDinheiroTotal(form, sobrasfaltas);
    const dados = {
      data: detailData, turnos,
      valor_total_vendas: form.valor_total_vendas,
      cartao: form.cartao, pix_santander: form.pix_santander,
      pix_inter: form.pix_inter, rom_card: form.rom_card,
      app: form.app, prefeitura: form.prefeitura,
      compras_prazo: form.compras_prazo,
      dinheiro, sobras_faltas: sobrasfaltas, total,
    };

    if (detailRecord) {
      await supabase.from("fechamento_caixa").update(dados).eq("id", detailRecord.id);
      setMensagem("Atualizado!");
      await registrarLog({ acao: "editou", tabela: "fechamento_caixa", registroId: detailRecord.id });
    } else {
      await supabase.from("fechamento_caixa").upsert(dados, { onConflict: "data" });
      setMensagem("Dia salvo!");
      await registrarLog({ acao: "criou", tabela: "fechamento_caixa" });
    }
    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function fecharDia() {
    if (!detailData) return;
    setLoading(true);
    const { dinheiro, total } = calcDinheiroTotal(form, sobrasfaltas);

    const dados = {
      data: detailData, turnos,
      valor_total_vendas: form.valor_total_vendas,
      cartao: form.cartao, pix_santander: form.pix_santander,
      pix_inter: form.pix_inter, rom_card: form.rom_card,
      app: form.app, prefeitura: form.prefeitura,
      compras_prazo: form.compras_prazo,
      dinheiro, sobras_faltas: sobrasfaltas, total,
      fechado: true, fechado_em: new Date().toISOString(),
    };

    await supabase.from("fechamento_caixa").upsert(dados, { onConflict: "data" });

    const catId = await garantirCategoria();
    if (catId) {
      const { data: existente } = await supabase.from("movimentacoes")
        .select("id, valor").eq("data", detailData).eq("categoria_id", catId).limit(1);

      const valorMov = total > 0 ? total : 0;
      if (existente && existente.length > 0) {
        await supabase.from("movimentacoes").update({
          valor: valorMov,
          observacao: `Fechamento de Caixa - ${new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR")}`,
        }).eq("id", existente[0].id);
      } else if (valorMov > 0) {
        await supabase.from("movimentacoes").insert({
          tipo: "entrada", data: detailData, valor: valorMov,
          categoria_id: catId,
          observacao: `Fechamento de Caixa - ${new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR")}`,
          forma_pagamento: "dinheiro", revisar: false,
        });
      }
    }

    await registrarLog({
      acao: "fechou", tabela: "fechamento_caixa",
      detalhes: `Dia ${detailData} - Bruto: ${fmt(form.valor_total_vendas)} - Dinheiro: ${fmt(dinheiro)} - Total: ${fmt(total)}`,
    });

    const msg = total > 0
      ? `Dia fechado! ${fmt(total)} lançado em Movimentações.`
      : `Dia fechado! Total ${fmt(total)} — sem valor para lançar.`;

    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setMensagem(msg);
    setLoading(false); setTimeout(() => setMensagem(""), 5000);
  }

  async function reabrirDia() {
    if (!detailRecord || !isAdmin) {
      setMensagem("Apenas administradores podem reabrir."); setTimeout(() => setMensagem(""), 3000); return;
    }
    setLoading(true);
    const catId = await garantirCategoria();
    if (catId) {
      await supabase.from("movimentacoes").delete()
        .eq("data", detailRecord.data).eq("categoria_id", catId);
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
    if (!confirm("Excluir este dia e sua movimentação?")) return;
    setLoading(true);
    const catId = await garantirCategoria();
    if (catId && detailRecord.fechado) {
      await supabase.from("movimentacoes").delete()
        .eq("data", detailRecord.data).eq("categoria_id", catId);
    }
    await supabase.from("fechamento_caixa").delete().eq("id", detailRecord.id);
    await registrarLog({ acao: "excluiu", tabela: "fechamento_caixa", registroId: detailRecord.id });
    setShowDetail(false); setDetailRecord(null); setMensagem("Dia excluído!");
    carregarDados(); setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  function closeDetail() {
    setShowDetail(false); setShowShifts(false);
    setDetailData(null); setDetailRecord(null);
  }

  const diasNoMes = new Date(ano, mes, 0).getDate();
  const registros = caixas.filter(c => c.fechado);
  const totalVendidoMes = registros.reduce((a, c) => a + c.total, 0);
  const totalBrutoMes = registros.reduce((a, c) => a + c.valor_total_vendas, 0);
  const diasConferidos = registros.length;

  // Derived sign state for UI
  const sfSinal = sobrasfaltas >= 0 ? 1 : -1;
  const sfAbs = Math.abs(sobrasfaltas);
  function toggleSinal() { setSobrasfaltas(prev => (prev === 0 ? 0 : -prev)); }

  const detailContent = showDetail && detailData ? (() => {
    const { dinheiro, total } = calcDinheiroTotal(form, sobrasfaltas);
    const dow = new Date(detailData + "T12:00:00").getDay();

    const inputStyle = (border: string, color: string): React.CSSProperties => ({
      width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 8,
      border: `1px solid ${border}`, background: "white",
      fontSize: 14, fontWeight: 600, color, outline: "none",
    });

    const campos: { field: keyof CaixaForm; label: string; bg: string; border: string; color: string }[] = [
      { field: "cartao", label: "💳 Cartão", bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
      { field: "pix_santander", label: "📱 Pix Santander", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
      { field: "pix_inter", label: "📱 Pix Inter", bg: "#fff7ed", border: "#fed7aa", color: "#ea580c" },
      { field: "rom_card", label: "💳 Rom Card", bg: "#f5f3ff", border: "#ddd6fe", color: "#7c3aed" },
      { field: "app", label: "📲 App", bg: "#ecfdf5", border: "#a7f3d0", color: "#059669" },
      { field: "prefeitura", label: "🏛️ Prefeitura", bg: "#ecfeff", border: "#a5f3fc", color: "#0891b2" },
      { field: "compras_prazo", label: "🛒 Compras à Prazo", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
    ];

    return (
      <div style={{ animation: "fadeUp 0.3s ease", background: "var(--color-surface)", border: "2px solid #3b82f6", borderRadius: 20, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: 16, margin: 0, textTransform: "capitalize" }}>
              {diasSemanaLong[dow]}, {new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
            </h2>
            <span style={{ fontSize: 11, color: "#6b7280" }}>
              {turnos} {turnos === 1 ? "turno" : "turnos"}
              {detailRecord?.fechado && " · ✅ Conferido"}
            </span>
          </div>
          <button onClick={closeDetail} style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "white", cursor: "pointer", fontSize: 14, color: "#6b7280" }}>✕</button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Total Vendas */}
          <div style={{ background: "#f0f9ff", border: "2px solid #0ea5e9", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase" }}>💰 VALOR TOTAL DE VENDAS DO DIA</label>
            <CurrencyInput
              value={form.valor_total_vendas}
              onChange={v => handleFormChange("valor_total_vendas", v)}
              style={{ width: "100%", marginTop: 6, padding: "10px 12px", borderRadius: 8, border: "1px solid #7dd3fc", background: "white", fontSize: 18, fontWeight: 700, color: "#0369a1", outline: "none" }}
            />
          </div>

          {/* Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            {campos.map(item => (
              <div key={item.field} style={{ background: item.bg, border: `1px solid ${item.border}`, borderRadius: 12, padding: 12 }}>
                <label style={{ fontSize: 10, fontWeight: 700, color: item.color, textTransform: "uppercase" }}>{item.label}</label>
                <CurrencyInput
                  value={form[item.field]}
                  onChange={v => handleFormChange(item.field, v)}
                  style={inputStyle(item.border, item.color)}
                />
              </div>
            ))}

            {/* Dinheiro (auto) */}
            <div style={{ background: "#f0fdf4", border: "2px solid #16a34a", borderRadius: 12, padding: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: "#16a34a", textTransform: "uppercase" }}>💵 DINHEIRO (auto)</label>
              <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: "white", border: "1px solid #bbf7d0", fontSize: 16, fontWeight: 700, color: dinheiro >= 0 ? "#16a34a" : "#dc2626" }}>
                {fmt(dinheiro)}
              </div>
            </div>

            {/* Sobras e Faltas */}
            <div style={{ background: sobrasfaltas > 0 ? "#f0fdf4" : sobrasfaltas < 0 ? "#fef2f2" : "#fffbeb", border: `2px solid ${sobrasfaltas > 0 ? "#16a34a" : sobrasfaltas < 0 ? "#dc2626" : "#d97706"}`, borderRadius: 12, padding: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: sobrasfaltas > 0 ? "#16a34a" : sobrasfaltas < 0 ? "#dc2626" : "#d97706", textTransform: "uppercase" }}>
                ⚖️ SOBRAS E FALTAS
              </label>
              <div style={{ display: "flex", gap: 5, marginTop: 4, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={toggleSinal}
                  title={sfSinal > 0 ? "Clique para Faltas (−)" : "Clique para Sobras (+)"}
                  style={{
                    width: 30, height: 30, borderRadius: 7, border: "none",
                    background: sfSinal > 0 ? "#dcfce7" : "#fee2e2",
                    color: sfSinal > 0 ? "#16a34a" : "#dc2626",
                    fontWeight: 800, fontSize: 15, cursor: "pointer", flexShrink: 0,
                  }}
                >
                  {sfSinal > 0 ? "+" : "−"}
                </button>
                <CurrencyInput
                  value={sfAbs}
                  onChange={v => setSobrasfaltas(sfSinal * v)}
                  style={{
                    flex: 1, padding: "7px 9px", borderRadius: 8,
                    border: `1px solid ${sfSinal > 0 ? "#bbf7d0" : "#fecaca"}`,
                    background: "white", fontSize: 14, fontWeight: 600,
                    color: sfSinal > 0 ? "#16a34a" : "#dc2626", outline: "none",
                  }}
                />
              </div>
              {sobrasfaltas !== 0 && (
                <p style={{ margin: "3px 0 0", fontSize: 10, color: sobrasfaltas > 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
                  {sobrasfaltas > 0 ? "Sobras" : "Faltas"}: {sobrasfaltas > 0 ? "+" : "−"}{fmt(sfAbs)}
                </p>
              )}
            </div>
          </div>

          {/* Total */}
          <div style={{ marginTop: 12, background: total >= 0 ? "#ecfdf5" : "#fef2f2", border: `2px solid ${total >= 0 ? "#16a34a" : "#dc2626"}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: total >= 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase", margin: 0 }}>📊 TOTAL DO DIA</p>
              <p style={{ fontSize: 9, color: "#6b7280", margin: "2px 0 0" }}>
                Dinheiro {sobrasfaltas !== 0 ? (sobrasfaltas > 0 ? "+ Sobras" : "− Faltas") : ""}
              </p>
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

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold text-lg capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

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

      {showShifts && detailData && (
        <div style={{ background: "var(--color-surface)", border: "2px solid #d97706", borderRadius: 16, padding: 20, animation: "fadeUp 0.2s ease" }}>
          <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            {diasSemanaLong[new Date(detailData + "T12:00:00").getDay()]}, {new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}
          </p>
          <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>Quantos turnos de caixa?</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => selectShift(1)}
              style={{ flex: 1, minWidth: 140, padding: "14px 16px", borderRadius: 12, border: "2px solid #d97706", background: "#fffbeb", cursor: "pointer", textAlign: "center" }}>
              <span style={{ fontSize: 20 }}>☀️</span>
              <p style={{ fontWeight: 700, fontSize: 13, margin: "4px 0 0", color: "#92400e" }}>1 Turno</p>
            </button>
            <button onClick={() => selectShift(2)}
              style={{ flex: 1, minWidth: 140, padding: "14px 16px", borderRadius: 12, border: "2px solid #d97706", background: "#fffbeb", cursor: "pointer", textAlign: "center" }}>
              <span style={{ fontSize: 20 }}>🌙</span>
              <p style={{ fontWeight: 700, fontSize: 13, margin: "4px 0 0", color: "#92400e" }}>2 Turnos</p>
            </button>
            <button onClick={cancelShift}
              style={{ padding: "14px 16px", borderRadius: 12, border: "1px solid #d1d5db", background: "white", cursor: "pointer", fontSize: 12, color: "#6b7280" }}>Cancelar</button>
          </div>
        </div>
      )}

      {detailContent}
    </div>
  );
}
