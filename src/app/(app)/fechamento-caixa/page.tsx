"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";
import { CurrencyInput } from "@/components/currency-input";

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const diasSemanaLong = ["Domingo","Segunda-feira","Terça-feira","Quarta-feira","Quinta-feira","Sexta-feira","Sábado"];

const CAMPOS_CONFIG = [
  { field: "cartao",        label: "Cartão",          emoji: "💳", bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
  { field: "pix_santander", label: "Pix Santander",   emoji: "📱", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
  { field: "pix_inter",     label: "Pix Inter",       emoji: "📱", bg: "#fff7ed", border: "#fed7aa", color: "#ea580c" },
  { field: "rom_card",      label: "Rom Card",        emoji: "💳", bg: "#f5f3ff", border: "#ddd6fe", color: "#7c3aed" },
  { field: "app",           label: "App",             emoji: "📲", bg: "#ecfdf5", border: "#a7f3d0", color: "#059669" },
  { field: "prefeitura",    label: "Prefeitura",      emoji: "🏛️", bg: "#ecfeff", border: "#a5f3fc", color: "#0891b2" },
  { field: "compras_prazo", label: "Compras à Prazo", emoji: "🛒", bg: "#fef2f2", border: "#fecaca", color: "#dc2626" },
  { field: "sobras_faltas", label: "Sobras/Faltas",   emoji: "⚖️", bg: "",        border: "",         color: ""        },
] as const;
type CampoKey = typeof CAMPOS_CONFIG[number]["field"];

const RESUMO_COLS = [
  { key: "cartao" as const,        label: "💳 Cartão" },
  { key: "pix_santander" as const, label: "📱 Pix Santander" },
  { key: "pix_inter" as const,     label: "📱 Pix Inter" },
  { key: "rom_card" as const,      label: "💳 Rom Card" },
  { key: "app" as const,           label: "📲 App" },
  { key: "prefeitura" as const,    label: "🏛️ Prefeitura" },
  { key: "compras_prazo" as const, label: "🛒 À Prazo" },
  { key: "dinheiro" as const,      label: "💵 Dinheiro" },
  { key: "sobras_faltas" as const, label: "⚖️ Sobras/Faltas" },
  { key: "total" as const,         label: "📊 Total" },
];
const RESUMO_PADRAO = ["cartao","pix_santander","pix_inter","rom_card","dinheiro","total"];
const CAMPOS_PADRAO: CampoKey[] = ["cartao","pix_santander","pix_inter","rom_card","app","prefeitura","compras_prazo","sobras_faltas"];

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

function ls<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

export default function FechamentoCaixaPage() {
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [caixas, setCaixas] = useState<CaixaDia[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  const [showDetail, setShowDetail] = useState(false);
  const [detailData, setDetailData] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<CaixaDia | null>(null);
  const [form, setForm] = useState<CaixaForm>({ ...formVazio });
  const [turnos, setTurnos] = useState(1);

  // Sobras/Faltas: valor absoluto + sinal independente
  const [sfAbs, setSfAbs] = useState(0);
  const [sfSigno, setSfSigno] = useState<1 | -1>(1);

  // Campos visíveis no formulário
  const [camposAtivos, setCamposAtivos] = useState<CampoKey[]>(() => ls("fechamento_campos_ativos", CAMPOS_PADRAO));

  // Colunas do resumo mensal
  const [resumoCols, setResumoCols] = useState<string[]>(() => ls("fechamento_resumo_colunas", RESUMO_PADRAO));

  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from("profiles").select("role").eq("id", user.id).single()
        .then(({ data: p }) => setIsAdmin(p?.role === "master"));
    });
  }, []);

  async function garantirCategoria(): Promise<string | null> {
    const nome = "Dinheiro (Fechamento Caixa)";
    const { data: e1 } = await supabase.from("categorias_entrada").select("id").eq("nome", nome).limit(1);
    if (e1?.length) return e1[0].id;
    const { data: n1 } = await supabase.from("categorias_entrada").insert({ nome, ativo: true }).select("id").single();
    if (n1) return n1.id;
    const { data: e2 } = await supabase.from("categorias_saida").select("id").eq("nome", nome).limit(1);
    return e2?.length ? e2[0].id : null;
  }

  async function carregarDados() {
    setLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(new Date(ano, mes, 0).getDate()).padStart(2, "0")}`;
    const { data } = await supabase.from("fechamento_caixa").select("*").gte("data", inicio).lte("data", fim).order("data");
    setCaixas((data ?? []) as CaixaDia[]);
    setLoading(false);
  }

  useEffect(() => { carregarDados(); setShowDetail(false); }, [mes, ano]);

  function mesAnterior() { mes === 1 ? (setMes(12), setAno(ano - 1)) : setMes(mes - 1); }
  function mesProximo() { mes === 12 ? (setMes(1), setAno(ano + 1)) : setMes(mes + 1); }
  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  function calcDinheiro(f: CaixaForm) {
    const sub = f.cartao + f.pix_santander + f.pix_inter + f.rom_card + f.app + f.prefeitura + f.compras_prazo;
    return Math.max(f.valor_total_vendas - sub, 0);
  }

  function getRecord(data: string) { return caixas.find(c => c.data === data); }

  function setFormFromRecord(r: CaixaDia) {
    setForm({
      valor_total_vendas: r.valor_total_vendas ?? 0,
      cartao: r.cartao ?? 0, pix_santander: r.pix_santander ?? 0,
      pix_inter: r.pix_inter ?? 0, rom_card: r.rom_card ?? 0,
      app: r.app ?? 0, prefeitura: r.prefeitura ?? 0,
      compras_prazo: r.compras_prazo ?? 0,
    });
    setTurnos(r.turnos ?? 1);
    const sf = r.sobras_faltas ?? 0;
    setSfAbs(Math.abs(sf));
    setSfSigno(sf < 0 ? -1 : 1);
    setDetailRecord(r);
  }

  function handleDayClick(data: string) {
    const rec = getRecord(data);
    if (rec) {
      setFormFromRecord(rec);
    } else {
      setForm({ ...formVazio });
      setDetailRecord(null);
      setSfAbs(0); setSfSigno(1); setTurnos(1);
    }
    setDetailData(data);
    setShowDetail(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeDetail() { setShowDetail(false); setDetailData(null); setDetailRecord(null); }

  function toggleCampo(field: CampoKey) {
    setCamposAtivos(prev => {
      const next = prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field];
      try { localStorage.setItem("fechamento_campos_ativos", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function toggleResumoCol(key: string) {
    setResumoCols(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      try { localStorage.setItem("fechamento_resumo_colunas", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function handleSalvar() {
    if (!detailData) return;
    setLoading(true);
    const dinheiro = calcDinheiro(form);
    const sobrasValor = sfSigno * sfAbs;
    const dados = {
      data: detailData, turnos,
      valor_total_vendas: form.valor_total_vendas,
      cartao: form.cartao, pix_santander: form.pix_santander,
      pix_inter: form.pix_inter, rom_card: form.rom_card,
      app: form.app, prefeitura: form.prefeitura,
      compras_prazo: form.compras_prazo,
      dinheiro, sobras_faltas: sobrasValor, total: dinheiro,
    };
    if (detailRecord) {
      await supabase.from("fechamento_caixa").update(dados).eq("id", detailRecord.id);
      await registrarLog({ acao: "editou", tabela: "fechamento_caixa", registroId: detailRecord.id });
      setMensagem("Atualizado!");
    } else {
      await supabase.from("fechamento_caixa").upsert(dados, { onConflict: "data" });
      await registrarLog({ acao: "criou", tabela: "fechamento_caixa" });
      setMensagem("Dia salvo!");
    }
    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function fecharDia() {
    if (!detailData) return;
    setLoading(true);
    const dinheiro = calcDinheiro(form);
    const sobrasValor = sfSigno * sfAbs;
    const dados = {
      data: detailData, turnos,
      valor_total_vendas: form.valor_total_vendas,
      cartao: form.cartao, pix_santander: form.pix_santander,
      pix_inter: form.pix_inter, rom_card: form.rom_card,
      app: form.app, prefeitura: form.prefeitura,
      compras_prazo: form.compras_prazo,
      dinheiro, sobras_faltas: sobrasValor, total: dinheiro,
      fechado: true, fechado_em: new Date().toISOString(),
    };
    await supabase.from("fechamento_caixa").upsert(dados, { onConflict: "data" });

    const catId = await garantirCategoria();
    if (catId) {
      const { data: existente } = await supabase.from("movimentacoes")
        .select("id").eq("data", detailData).eq("categoria_id", catId).limit(1);
      const valorMov = dinheiro > 0 ? dinheiro : 0;
      if (existente?.length) {
        await supabase.from("movimentacoes").update({
          valor: valorMov,
          observacao: `Fechamento de Caixa - ${new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR")}`,
        }).eq("id", existente[0].id);
      } else if (valorMov > 0) {
        await supabase.from("movimentacoes").insert({
          tipo: "entrada", data: detailData, valor: valorMov, categoria_id: catId,
          observacao: `Fechamento de Caixa - ${new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR")}`,
          forma_pagamento: "dinheiro", revisar: false,
        });
      }
    }

    await registrarLog({ acao: "fechou", tabela: "fechamento_caixa",
      detalhes: `Dia ${detailData} - Bruto: ${fmt(form.valor_total_vendas)} - Total: ${fmt(dinheiro)}` });

    setMensagem(dinheiro > 0 ? `Dia fechado! ${fmt(dinheiro)} lançado em Movimentações.` : "Dia fechado!");
    await carregarDados();
    const atualizado = getRecord(detailData);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 5000);
  }

  async function reabrirDia() {
    if (!detailRecord || !isAdmin) { setMensagem("Apenas administradores podem reabrir."); setTimeout(() => setMensagem(""), 3000); return; }
    setLoading(true);
    const catId = await garantirCategoria();
    if (catId) await supabase.from("movimentacoes").delete().eq("data", detailRecord.data).eq("categoria_id", catId);
    await supabase.from("fechamento_caixa").update({ fechado: false, fechado_por: null, fechado_em: null }).eq("id", detailRecord.id);
    await registrarLog({ acao: "reabriu", tabela: "fechamento_caixa", registroId: detailRecord.id });
    setMensagem("Dia reaberto.");
    await carregarDados();
    const atualizado = getRecord(detailRecord.data);
    if (atualizado) setFormFromRecord(atualizado);
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function excluirDia() {
    if (!detailRecord || !confirm("Excluir este dia e sua movimentação?")) return;
    setLoading(true);
    const catId = await garantirCategoria();
    if (catId && detailRecord.fechado) await supabase.from("movimentacoes").delete().eq("data", detailRecord.data).eq("categoria_id", catId);
    await supabase.from("fechamento_caixa").delete().eq("id", detailRecord.id);
    await registrarLog({ acao: "excluiu", tabela: "fechamento_caixa", registroId: detailRecord.id });
    closeDetail(); setMensagem("Dia excluído!"); carregarDados(); setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  const diasNoMes = new Date(ano, mes, 0).getDate();
  const registros = caixas.filter(c => c.fechado);
  const totalVendidoMes = registros.reduce((a, c) => a + c.total, 0);
  const totalBrutoMes = registros.reduce((a, c) => a + c.valor_total_vendas, 0);

  const resumoColsAtivas = RESUMO_COLS.filter(c => resumoCols.includes(c.key));

  // ── Detail form ──────────────────────────────────────────────
  const dinheiro = calcDinheiro(form);
  const sobrasValorAtual = sfSigno * sfAbs;
  const camposVisiveis = CAMPOS_CONFIG.filter(c => c.field !== "sobras_faltas" && camposAtivos.includes(c.field as CampoKey));
  const mostrarSobras = camposAtivos.includes("sobras_faltas");

  const inputBase = (border: string, color: string): React.CSSProperties => ({
    width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${border}`, background: "white",
    fontSize: 14, fontWeight: 600, color, outline: "none",
  });

  return (
    <div className="space-y-6">
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Cabeçalho */}
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
        <div className="text-center"><p className="font-bold text-lg">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Total Bruto", v: fmt(totalBrutoMes), c: "text-blue-600" },
          { l: "Total Vendido", v: fmt(totalVendidoMes), c: totalVendidoMes >= 0 ? "text-emerald-600" : "text-red-500" },
          { l: "Conferidos", v: `${registros.length}`, c: "text-emerald-600" },
          { l: "Dias no Mês", v: `${diasNoMes}`, c: "text-[var(--color-text)]" },
        ].map(c => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem && <div className="p-3 rounded-xl text-sm font-medium text-center bg-emerald-50 text-emerald-700">{mensagem}</div>}

      {/* Formulário do dia */}
      {showDetail && detailData && (() => {
        const dow = new Date(detailData + "T12:00:00").getDay();
        return (
          <div style={{ animation: "fadeUp 0.25s ease", background: "var(--color-surface)", border: "2px solid #3b82f6", borderRadius: 20, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "16px 20px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div>
                <h2 style={{ fontWeight: 700, fontSize: 16, margin: 0, textTransform: "capitalize" }}>
                  {diasSemanaLong[dow]}, {new Date(detailData + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
                </h2>
                {detailRecord?.fechado && <span style={{ fontSize: 11, color: "#16a34a", fontWeight: 600, marginTop: 4, display: "block" }}>✅ Conferido</span>}
              </div>
              <button onClick={closeDetail} style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "white", cursor: "pointer", fontSize: 14, color: "#6b7280" }}>✕</button>
            </div>

            <div style={{ padding: 20 }}>
              {/* Total Vendas */}
              <div style={{ background: "#f0f9ff", border: "2px solid #0ea5e9", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase" }}>💰 VALOR TOTAL DE VENDAS DO DIA</label>
                <CurrencyInput value={form.valor_total_vendas} onChange={v => setForm(p => ({ ...p, valor_total_vendas: v }))}
                  style={{ width: "100%", marginTop: 6, padding: "10px 12px", borderRadius: 8, border: "1px solid #7dd3fc", background: "white", fontSize: 18, fontWeight: 700, color: "#0369a1", outline: "none" }} />
              </div>

              {/* Seletor de campos */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12, alignItems: "center" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".05em" }}>Campos:</span>
                {CAMPOS_CONFIG.map(c => {
                  const ativo = camposAtivos.includes(c.field as CampoKey);
                  return (
                    <button key={c.field} type="button" onClick={() => toggleCampo(c.field as CampoKey)}
                      style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1px solid ${ativo ? "#16a34a" : "#e5e7eb"}`, background: ativo ? "#dcfce7" : "#f9fafb", color: ativo ? "#15803d" : "#9ca3af", transition: "all 0.15s" }}>
                      {c.emoji} {c.label}
                    </button>
                  );
                })}
              </div>

              {/* Grid de pagamentos */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
                {camposVisiveis.map(item => (
                  <div key={item.field} style={{ background: item.bg, border: `1px solid ${item.border}`, borderRadius: 12, padding: 12 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: item.color, textTransform: "uppercase" }}>{item.emoji} {item.label}</label>
                    <CurrencyInput value={form[item.field as keyof CaixaForm]} onChange={v => setForm(p => ({ ...p, [item.field]: v }))}
                      style={inputBase(item.border, item.color)} />
                  </div>
                ))}

                {/* Dinheiro (auto) */}
                <div style={{ background: "#f0fdf4", border: "2px solid #16a34a", borderRadius: 12, padding: 12 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#16a34a", textTransform: "uppercase" }}>💵 Dinheiro (auto)</label>
                  <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: "white", border: "1px solid #bbf7d0", fontSize: 16, fontWeight: 700, color: "#16a34a" }}>
                    {fmt(dinheiro)}
                  </div>
                </div>

                {/* Sobras e Faltas */}
                {mostrarSobras && (
                  <div style={{ background: sfSigno > 0 ? "#f0fdf4" : "#fef2f2", border: `2px solid ${sfSigno > 0 ? "#86efac" : "#fca5a5"}`, borderRadius: 12, padding: 12 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: sfSigno > 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase" }}>⚖️ Sobras / Faltas</label>
                    <p style={{ margin: "2px 0 6px", fontSize: 9, color: "#9ca3af" }}>Apenas registro — não altera o total</p>
                    {/* Seletor de modo */}
                    <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                      <button type="button" onClick={() => setSfSigno(1)}
                        style={{ flex: 1, padding: "7px 4px", borderRadius: 8, border: `2px solid ${sfSigno > 0 ? "#16a34a" : "#e5e7eb"}`, background: sfSigno > 0 ? "#16a34a" : "white", color: sfSigno > 0 ? "white" : "#9ca3af", fontWeight: 700, fontSize: 12, cursor: "pointer", transition: "all 0.15s" }}>
                        ▲ Sobras
                      </button>
                      <button type="button" onClick={() => setSfSigno(-1)}
                        style={{ flex: 1, padding: "7px 4px", borderRadius: 8, border: `2px solid ${sfSigno < 0 ? "#dc2626" : "#e5e7eb"}`, background: sfSigno < 0 ? "#dc2626" : "white", color: sfSigno < 0 ? "white" : "#9ca3af", fontWeight: 700, fontSize: 12, cursor: "pointer", transition: "all 0.15s" }}>
                        ▼ Faltas
                      </button>
                    </div>
                    <CurrencyInput value={sfAbs} onChange={v => setSfAbs(v)}
                      style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${sfSigno > 0 ? "#bbf7d0" : "#fecaca"}`, background: "white", fontSize: 14, fontWeight: 700, color: sfSigno > 0 ? "#16a34a" : "#dc2626", outline: "none" }} />
                    {sfAbs > 0 && (
                      <p style={{ margin: "5px 0 0", fontSize: 11, fontWeight: 700, color: sfSigno > 0 ? "#16a34a" : "#dc2626", textAlign: "center" }}>
                        {sfSigno > 0 ? "Sobras: +" : "Faltas: -"}{fmt(sfAbs)}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Total */}
              <div style={{ marginTop: 12, background: dinheiro >= 0 ? "#ecfdf5" : "#fef2f2", border: `2px solid ${dinheiro >= 0 ? "#16a34a" : "#dc2626"}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#16a34a", textTransform: "uppercase", margin: 0 }}>📊 TOTAL DO DIA</p>
                  <p style={{ fontSize: 9, color: "#6b7280", margin: "2px 0 0" }}>Valor em dinheiro do dia</p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 24, fontWeight: 800, color: dinheiro >= 0 ? "#16a34a" : "#dc2626", display: "block" }}>{fmt(dinheiro)}</span>
                  {mostrarSobras && sfAbs > 0 && (
                    <span style={{ fontSize: 10, color: sfSigno > 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
                      {sfSigno > 0 ? "Sobras: +" : "Faltas: -"}{fmt(sfAbs)} (registro)
                    </span>
                  )}
                </div>
              </div>

              {/* Botões */}
              <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                <button onClick={handleSalvar} disabled={loading}
                  style={{ flex: 1, minWidth: 120, padding: "12px 20px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#059669,#10b981)", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>
                  {loading ? "Salvando..." : "💾 Salvar"}
                </button>
                {detailRecord && !detailRecord.fechado && (
                  <button onClick={fecharDia} disabled={loading}
                    style={{ padding: "12px 20px", borderRadius: 12, border: "none", background: "#16a34a", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                    ✓ Conferir e Fechar
                  </button>
                )}
                {detailRecord?.fechado && (
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
      })()}

      {/* Calendário */}
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
        {Array.from({ length: diasNoMes }, (_, i) => i + 1).map(d => {
          const dataStr = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const dow = new Date(ano, mes - 1, d).getDay();
          const rec = getRecord(dataStr);
          const isSelected = detailData === dataStr && showDetail;
          return (
            <button key={d} type="button" onClick={() => handleDayClick(dataStr)}
              style={{
                display: "block", width: "100%", textAlign: "left", borderRadius: 12, padding: "10px 12px", cursor: "pointer", transition: "all 0.2s",
                border: `2px solid ${rec?.fechado ? "#16a34a" : isSelected ? "#3b82f6" : rec ? "#93c5fd" : "#e5e7eb"}`,
                background: rec?.fechado ? "#f0fdf4" : isSelected ? "#eff6ff" : rec ? "#f0f9ff" : "white",
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

      {/* Resumo por método de pagamento */}
      {registros.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--color-border)" }}>
            <p style={{ fontWeight: 700, fontSize: 14, margin: "0 0 10px" }}>📋 Resumo por Método — {mesesNomes[mes - 1]} {ano}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {RESUMO_COLS.map(c => {
                const ativo = resumoCols.includes(c.key);
                return (
                  <button key={c.key} type="button" onClick={() => toggleResumoCol(c.key)}
                    style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1px solid ${ativo ? "#3b82f6" : "#e5e7eb"}`, background: ativo ? "#eff6ff" : "#f9fafb", color: ativo ? "#1d4ed8" : "#9ca3af", transition: "all 0.15s" }}>
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "#6b7280", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>Dia</th>
                  {resumoColsAtivas.map(c => (
                    <th key={c.key} style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: "#6b7280", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {registros.map((r, i) => {
                  const dt = new Date(r.data + "T12:00:00");
                  const dow = dt.getDay();
                  return (
                    <tr key={r.id} style={{ background: i % 2 === 0 ? "white" : "#fafafa", cursor: "pointer" }}
                      onClick={() => handleDayClick(r.data)}>
                      <td style={{ padding: "9px 14px", borderBottom: "1px solid #f3f4f6", fontWeight: 600, whiteSpace: "nowrap" }}>
                        <span style={{ color: dow === 0 ? "#dc2626" : "#374151" }}>
                          {dt.toLocaleDateString("pt-BR", { day: "2-digit", weekday: "short" })}
                        </span>
                      </td>
                      {resumoColsAtivas.map(c => {
                        const v = r[c.key as keyof CaixaDia] as number;
                        return (
                          <td key={c.key} style={{ padding: "9px 12px", textAlign: "right", borderBottom: "1px solid #f3f4f6", color: c.key === "total" ? "#059669" : c.key === "sobras_faltas" ? (v >= 0 ? "#16a34a" : "#dc2626") : "#374151", fontWeight: c.key === "total" ? 700 : 400 }}>
                            {v !== 0 ? fmt(v) : <span style={{ color: "#d1d5db" }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: "#f0fdf4", borderTop: "2px solid #16a34a" }}>
                  <td style={{ padding: "10px 14px", fontWeight: 700, color: "#16a34a", fontSize: 12 }}>TOTAL</td>
                  {resumoColsAtivas.map(c => {
                    const total = registros.reduce((a, r) => a + ((r[c.key as keyof CaixaDia] as number) ?? 0), 0);
                    return (
                      <td key={c.key} style={{ padding: "10px 12px", textAlign: "right", fontWeight: 800, color: "#16a34a" }}>
                        {fmt(total)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
