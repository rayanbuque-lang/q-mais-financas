"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface Maquina {
  id: string;
  nome: string;
  banco: string;
  taxa_debito: number;
  taxa_credito: number;
  taxa_pix: number;
}

interface Venda {
  id: string;
  maquina_id: string;
  tipo_pagamento: string;
  valor_bruto: number;
  taxa_percentual: number;
  valor_taxa: number;
  valor_liquido: number;
  data_venda: string;
  data_previsao: string;
  data_recebimento: string | null;
  status: string;
  valor_recebido: number | null;
  diferenca: number | null;
  observacao: string | null;
  maquina_nome?: string;
}

interface Feriado {
  data: string;
}

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function VendasPage() {
  const [maquinas, setMaquinas] = useState<Maquina[]>([]);
  const [vendas, setVendas] = useState<Venda[]>([]);
  const [feriados, setFeriados] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showFeriado, setShowFeriado] = useState(false);

  // Form venda
  const [maquinaId, setMaquinaId] = useState("");
  const [tipoPagamento, setTipoPagamento] = useState<"debito" | "credito" | "pix">("debito");
  const [valorBruto, setValorBruto] = useState("");
  const [dataVenda, setDataVenda] = useState(new Date().toISOString().split("T")[0]);
  const [observacao, setObservacao] = useState("");

  // Form feriado
  const [feriadoData, setFeriadoData] = useState("");
  const [feriadoDesc, setFeriadoDesc] = useState("");

  // Recebimento
  const [recebendoId, setRecebendoId] = useState<string | null>(null);
  const [valorRecebido, setValorRecebido] = useState("");
  const [dataRecebimento, setDataRecebimento] = useState("");

  // Filtros
  const [filtroStatus, setFiltroStatus] = useState<"todos" | "pendente" | "recebido" | "divergente">("todos");
  const [filtroMaquina, setFiltroMaquina] = useState("todas");
  const [filtroTipo, setFiltroTipo] = useState<"todos" | "debito" | "credito" | "pix">("todos");
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());

  const supabase = createClient();

  async function carregarDados() {
    const [r1, r2, r3] = await Promise.all([
      supabase.from("maquinas").select("*").eq("ativo", true).order("nome"),
      supabase.from("feriados").select("data"),
      supabase.from("vendas_maquina").select("*").order("data_venda", { ascending: false }),
    ]);
    if (r1.data) setMaquinas(r1.data);
    if (r2.data) setFeriados(r2.data.map((f) => f.data));
    if (r3.data) {
      // Enriquecer com nome da máquina
      const maqs = r1.data || maquinas;
      const lista = r3.data.map((v) => ({
        ...v,
        maquina_nome: maqs.find((m) => m.id === v.maquina_id)?.nome || "Desconhecida",
      }));
      setVendas(lista);
    }
  }

  useEffect(() => { carregarDados(); }, []);

  // Calcular próximo dia útil
  function proximoDiaUtil(data: Date): Date {
    const d = new Date(data);
    let tentativas = 0;
    while (tentativas < 60) {
      const diaSemana = d.getDay();
      const dataStr = d.toISOString().split("T")[0];
      const ehFeriado = feriados.includes(dataStr);
      if (diaSemana !== 0 && diaSemana !== 6 && !ehFeriado) return d;
      d.setDate(d.getDate() + 1);
      tentativas++;
    }
    return d;
  }

  function calcularPrevisao(dataStr: string, tipo: string): string {
    const data = new Date(dataStr + "T12:00:00");
    if (tipo === "pix") return dataStr;
    if (tipo === "debito") {
      // Débito: próximo dia útil (pula sábado, domingo e feriado)
      const next = new Date(data);
      next.setDate(next.getDate() + 1);
      return proximoDiaUtil(next).toISOString().split("T")[0];
    }
    if (tipo === "credito") {
      // Crédito: 30 dias CORRIDOS, se cair em fim de semana ou feriado vai pro próximo dia útil
      const next = new Date(data);
      next.setDate(next.getDate() + 30);
      return proximoDiaUtil(next).toISOString().split("T")[0];
    }
    return dataStr;
  }

  const maquinaAtual = maquinas.find((m) => m.id === maquinaId);

  function getTaxa(tipo: string): number {
    if (!maquinaAtual) return 0;
    if (tipo === "debito") return maquinaAtual.taxa_debito;
    if (tipo === "credito") return maquinaAtual.taxa_credito;
    return maquinaAtual.taxa_pix;
  }

  const taxa = getTaxa(tipoPagamento);
  const bruto = parseFloat(valorBruto.replace(",", ".")) || 0;
  const valorTaxa = bruto * (taxa / 100);
  const liquido = bruto - valorTaxa;
  const previsao = dataVenda ? calcularPrevisao(dataVenda, tipoPagamento) : "";

  async function handleSalvarVenda(e: React.FormEvent) {
    e.preventDefault();
    if (!maquinaId) { setMensagem("Selecione uma máquina."); setTimeout(() => setMensagem(""), 3000); return; }
    setLoading(true); setMensagem("");

    const dados = {
      maquina_id: maquinaId,
      tipo_pagamento: tipoPagamento,
      valor_bruto: bruto,
      taxa_percentual: taxa,
      valor_taxa: valorTaxa,
      valor_liquido: liquido,
      data_venda: dataVenda,
      data_previsao: previsao,
      status: "pendente",
      observacao,
    };

    const { error } = await supabase.from("vendas_maquina").insert(dados);
    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem("Venda registrada!");
      setValorBruto(""); setObservacao("");
      setShowForm(false);
      carregarDados();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  function iniciarRecebimento(venda: Venda) {
    setRecebendoId(venda.id);
    setValorRecebido(venda.valor_liquido.toFixed(2).replace(".", ","));
    setDataRecebimento(venda.data_previsao);
  }

  async function confirmarRecebimento(venda: Venda) {
    setLoading(true);
    const recebido = parseFloat(valorRecebido.replace(",", "."));
    const dif = recebido - venda.valor_liquido;
    const status = Math.abs(dif) < 0.01 ? "recebido" : "divergente";

    const { error } = await supabase.from("vendas_maquina").update({
      data_recebimento: dataRecebimento,
      valor_recebido: recebido,
      diferenca: dif,
      status,
    }).eq("id", venda.id);

    if (error) setMensagem("Erro.");
    else {
      setMensagem(status === "recebido" ? "Recebido com sucesso!" : `Divergência de R$ ${dif.toFixed(2)} registrada.`);
      setRecebendoId(null);
      carregarDados();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 4000);
  }

  async function handleExcluir(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("vendas_maquina").delete().eq("id", id);
    setMensagem("Excluído!"); carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  // Feriado
  async function handleAddFeriado(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("feriados").insert({ data: feriadoData, descricao: feriadoDesc });
    if (error) setMensagem("Erro ou feriado já existe.");
    else { setMensagem("Feriado adicionado!"); setFeriadoData(""); setFeriadoDesc(""); setShowFeriado(false); carregarDados(); }
    setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  // Filtros
  const vendasFiltradas = vendas.filter((v) => {
    const dv = new Date(v.data_venda + "T12:00:00");
    if (dv.getMonth() + 1 !== mes || dv.getFullYear() !== ano) return false;
    if (filtroStatus !== "todos" && v.status !== filtroStatus) return false;
    if (filtroMaquina !== "todas" && v.maquina_id !== filtroMaquina) return false;
    if (filtroTipo !== "todos" && v.tipo_pagamento !== filtroTipo) return false;
    return true;
  });

  const totalBruto = vendasFiltradas.reduce((a, v) => a + v.valor_bruto, 0);
  const totalTaxa = vendasFiltradas.reduce((a, v) => a + v.valor_taxa, 0);
  const totalLiquido = vendasFiltradas.reduce((a, v) => a + v.valor_liquido, 0);
  const totalPendente = vendasFiltradas.filter((v) => v.status === "pendente").reduce((a, v) => a + v.valor_liquido, 0);
  const totalDivergente = vendasFiltradas.filter((v) => v.status === "divergente").reduce((a, v) => a + Math.abs(v.diferenca || 0), 0);

  const tiposIcons: Record<string, string> = { debito: "💳", credito: "💳", pix: "📱" };
  const tiposLabel: Record<string, string> = { debito: "Débito", credito: "Crédito", pix: "Pix" };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendas na Maquininha</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Registre vendas e acompanhe recebimentos</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowFeriado(!showFeriado)} className="px-4 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] font-semibold rounded-xl hover:bg-[var(--color-bg)] transition text-sm">📅 Feriados</button>
          <button onClick={() => setShowForm(!showForm)} className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all text-sm shadow-md shadow-blue-200">+ Nova Venda</button>
        </div>
      </div>

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {/* Feriados */}
      {showFeriado && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-sm">Gerenciar Feriados</h3>
            <button onClick={() => setShowFeriado(false)} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>
          <form onSubmit={handleAddFeriado} className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Data</label>
              <input type="date" value={feriadoData} onChange={(e) => setFeriadoData(e.target.value)} required className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Descrição</label>
              <input type="text" value={feriadoDesc} onChange={(e) => setFeriadoDesc(e.target.value)} placeholder="Ex: Natal, Carnaval" className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
            </div>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition">Adicionar</button>
          </form>
          {feriados.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {feriados.sort().map((f) => (
                <span key={f} className="px-2 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-medium">
                  {new Date(f + "T12:00:00").toLocaleDateString("pt-BR")}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Form venda */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">Registrar Venda</h2>
            <button onClick={() => setShowForm(false)} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          {maquinas.length === 0 ? (
            <p className="text-sm text-red-600 text-center py-4">Cadastre uma máquina primeiro em "Máquinas e Contas".</p>
          ) : (
            <form onSubmit={handleSalvarVenda} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Máquina</label>
                  <select value={maquinaId} onChange={(e) => setMaquinaId(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">
                    <option value="">Selecione...</option>
                    {maquinas.map((m) => <option key={m.id} value={m.id}>{m.nome} ({m.banco})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data da Venda</label>
                  <input type="date" value={dataVenda} onChange={(e) => setDataVenda(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor Bruto (R$)</label>
                  <input type="text" value={valorBruto} onChange={(e) => setValorBruto(e.target.value)} placeholder="0,00" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
              </div>

              {/* Tipo de pagamento */}
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Forma de Pagamento</label>
                <div className="grid grid-cols-3 gap-3">
                  {(["debito", "credito", "pix"] as const).map((t) => (
                    <button key={t} type="button" onClick={() => setTipoPagamento(t)} className={`p-4 rounded-xl border-2 text-center transition-all ${tipoPagamento === t ? "border-blue-500 bg-blue-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                      <span className="text-2xl block mb-1">{tiposIcons[t]}</span>
                      <span className="text-sm font-bold block">{tiposLabel[t]}</span>
                      {maquinaAtual && (
                        <span className="text-[10px] text-[var(--color-text-muted)] block mt-1">Taxa: {getTaxa(t)}%</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label>
                <input type="text" value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Opcional" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>

              {/* Preview */}
              {bruto > 0 && maquinaAtual && (
                <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">Resumo</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)] uppercase font-semibold">Bruto</p>
                      <p className="text-sm font-bold">{fmt(bruto)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-red-500 uppercase font-semibold">Taxa ({taxa}%)</p>
                      <p className="text-sm font-bold text-red-500">- {fmt(valorTaxa)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-emerald-600 uppercase font-semibold">Líquido</p>
                      <p className="text-sm font-bold text-emerald-600">{fmt(liquido)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-blue-600 uppercase font-semibold">Previsão</p>
                      <p className="text-sm font-bold text-blue-600">{previsao ? new Date(previsao + "T12:00:00").toLocaleDateString("pt-BR") : "-"}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
                <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-blue-200">
                  {loading ? "Salvando..." : "Registrar Venda"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Mês/Ano */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={() => { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); }} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={() => { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); }} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { l: "Bruto", v: fmt(totalBruto), c: "text-[var(--color-text)]" },
          { l: "Taxas", v: fmt(totalTaxa), c: "text-red-500" },
          { l: "Líquido", v: fmt(totalLiquido), c: "text-emerald-600" },
          { l: "Pendente", v: fmt(totalPendente), c: "text-amber-600" },
          { l: "Divergências", v: fmt(totalDivergente), c: "text-red-500" },
        ].map((c) => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold text-sm ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex flex-wrap gap-3 items-center">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Filtros:</span>
        {(["todos", "pendente", "recebido", "divergente"] as const).map((v) => (
          <button key={v} onClick={() => setFiltroStatus(v)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroStatus === v ? "bg-blue-600 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
            {v === "todos" ? "Todos" : v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
        <select value={filtroMaquina} onChange={(e) => setFiltroMaquina(e.target.value)} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none">
          <option value="todas">Todas máquinas</option>
          {maquinas.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
        </select>
        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value as typeof filtroTipo)} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none">
          <option value="todos">Todos tipos</option>
          <option value="debito">Débito</option>
          <option value="credito">Crédito</option>
          <option value="pix">Pix</option>
        </select>
      </div>

      {/* Lista de vendas */}
      {vendasFiltradas.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
          Nenhuma venda neste período.
        </div>
      ) : (
        <div className="space-y-2">
          {vendasFiltradas.map((v) => {
            const isRecebendo = recebendoId === v.id;
            return (
              <div key={v.id} className={`bg-[var(--color-surface)] border rounded-xl overflow-hidden ${v.status === "divergente" ? "border-red-300" : v.status === "recebido" ? "border-emerald-200" : "border-[var(--color-border)]"}`}>
                <div className="p-3 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm shrink-0 ${v.status === "recebido" ? "bg-emerald-50" : v.status === "divergente" ? "bg-red-50" : "bg-amber-50"}`}>
                      {tiposIcons[v.tipo_pagamento]}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{v.maquina_nome}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg)] font-medium">{tiposLabel[v.tipo_pagamento]}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${v.status === "recebido" ? "bg-emerald-100 text-emerald-700" : v.status === "divergente" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                          {v.status === "recebido" ? "RECEBIDO" : v.status === "divergente" ? "DIVERGENTE" : "PENDENTE"}
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        Venda: {new Date(v.data_venda + "T12:00:00").toLocaleDateString("pt-BR")}
                        {" · "}Prev: {new Date(v.data_previsao + "T12:00:00").toLocaleDateString("pt-BR")}
                        {v.data_recebimento && ` · Rec: ${new Date(v.data_recebimento + "T12:00:00").toLocaleDateString("pt-BR")}`}
                        {v.observacao && ` · ${v.observacao}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-[var(--color-text-muted)]">Bruto: {fmt(v.valor_bruto)}</p>
                      <p className="text-xs text-red-500">Taxa: -{fmt(v.valor_taxa)} ({v.taxa_percentual}%)</p>
                      <p className="text-sm font-bold text-emerald-600">Líq: {fmt(v.valor_liquido)}</p>
                      {v.status === "divergente" && v.diferenca !== null && (
                        <p className="text-xs text-red-500 font-semibold">Dif: {fmt(v.diferenca)}</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      {v.status === "pendente" && (
                        <button onClick={() => iniciarRecebimento(v)} className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-600 text-xs font-semibold hover:bg-emerald-100 transition">💳 Receber</button>
                      )}
                      <button onClick={() => handleExcluir(v.id)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-500 text-xs font-semibold hover:bg-red-100 transition">🗑️</button>
                    </div>
                  </div>
                </div>

                {/* Recebimento inline */}
                {isRecebendo && (
                  <div className="border-t border-[var(--color-border)] bg-emerald-50 p-4 flex items-end gap-3 flex-wrap">
                    <div>
                      <label className="block text-xs font-semibold mb-1 text-emerald-800">Valor Recebido (R$)</label>
                      <input type="text" value={valorRecebido} onChange={(e) => setValorRecebido(e.target.value)} className="px-3 py-2 rounded-lg border border-emerald-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 w-32" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1 text-emerald-800">Data</label>
                      <input type="date" value={dataRecebimento} onChange={(e) => setDataRecebimento(e.target.value)} className="px-3 py-2 rounded-lg border border-emerald-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
                    </div>
                    <button onClick={() => confirmarRecebimento(v)} disabled={loading} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50">
                      {loading ? "..." : "✓ Confirmar"}
                    </button>
                    <button onClick={() => setRecebendoId(null)} className="px-4 py-2 bg-white text-gray-500 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 transition">Cancelar</button>
                    {parseFloat(valorRecebido.replace(",", ".")) !== v.valor_liquido && (
                      <span className="text-xs text-amber-700 font-medium">
                        ⚠ Diferença: {fmt(parseFloat(valorRecebido.replace(",", ".")) - v.valor_liquido)}
                      </span>
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
