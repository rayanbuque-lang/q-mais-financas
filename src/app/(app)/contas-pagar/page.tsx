"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog, verificarMesFechado, verificarAdmin } from "@/lib/audit";

interface ContaPagar {
  id: string;
  fornecedor: string;
  descricao: string;
  valor: number;
  data_vencimento: string;
  data_pagamento: string | null;
  status: string;
  categoria_id: string;
  observacao: string;
  categoria_nome: string;
}

interface Categoria { id: string; nome: string; }

const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function ContasPagarPage() {
  const [contas, setContas] = useState<ContaPagar[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"pendentes" | "pagos" | "todos">("pendentes");
  const [visualizacao, setVisualizacao] = useState<"semanal" | "lista">("semanal");
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());

  // Form
  const [fornecedor, setFornecedor] = useState("");
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");
  const [dataVencimento, setDataVencimento] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [statusInicial, setStatusInicial] = useState<"pendente" | "pago">("pendente");
  const [dataPagamento, setDataPagamento] = useState("");

  // Pagamento inline
  const [pagandoId, setPagandoId] = useState<string | null>(null);
  const [dataPagamentoInline, setDataPagamentoInline] = useState("");

  // Lote
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [modoLote, setModoLote] = useState(false);
  const [loteDataPagamento, setLoteDataPagamento] = useState(new Date().toISOString().split("T")[0]);

  const supabase = createClient();

  async function carregarDados() {
    // Buscar todas as contas do ano
    const inicioAno = `${ano}-01-01`;
    const fimAno = `${ano}-12-31`;

    const [r1, r2] = await Promise.all([
      supabase.from("contas_pagar").select("*").gte("data_vencimento", inicioAno).lte("data_vencimento", fimAno).order("data_vencimento", { ascending: true }),
      supabase.from("categorias_saida").select("*").eq("ativo", true).order("nome"),
    ]);
    if (r1.data) {
      const lista = await Promise.all(r1.data.map(async (conta) => {
        if (conta.categoria_id) {
          const { data: cat } = await supabase.from("categorias_saida").select("nome").eq("id", conta.categoria_id).single();
          return { ...conta, categoria_nome: cat?.nome || "Sem categoria" };
        }
        return { ...conta, categoria_nome: "Sem categoria" };
      }));
      setContas(lista);
    }
    if (r2.data) setCategorias(r2.data);
  }

  useEffect(() => { carregarDados(); gerarRecorrentes(); }, [mes, ano]);

  async function gerarRecorrentes() {
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    // Buscar recorrentes ativos que são contas a pagar
    const { data: recorrentes } = await supabase
      .from("lancamentos_recorrentes")
      .select("*")
      .eq("ativo", true)
      .ilike("observacao", "%CONTA_PAGAR%");

    if (!recorrentes || recorrentes.length === 0) return;

    for (const r of recorrentes) {
      // Verificar se já existe
      const { data: existente } = await supabase
        .from("contas_pagar")
        .select("id")
        .eq("fornecedor", r.descricao)
        .eq("valor", r.valor)
        .gte("data_vencimento", inicio)
        .lte("data_vencimento", fim)
        .limit(1);

      if (existente && existente.length > 0) continue;

      // Verificar período
      const dataInicioR = new Date(r.data_inicio + "T12:00:00");
      const dataVenc = new Date(ano, mes - 1, r.dia_vencimento || 1);
      if (dataVenc < dataInicioR) continue;
      if (r.data_fim && dataVenc > new Date(r.data_fim + "T12:00:00")) continue;
      if (r.total_parcelas && r.parcelas_geradas >= r.total_parcelas) continue;

      const dia = Math.min(r.dia_vencimento || 1, ultimoDia);
      const dataVencimento = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;

      // Criar conta a pagar
      await supabase.from("contas_pagar").insert({
        fornecedor: r.descricao,
        descricao: "Recorrente mensal",
        valor: r.valor,
        data_vencimento: dataVencimento,
        status: "pendente",
        categoria_id: r.categoria_id,
        observacao: "Gerado automaticamente - Recorrente",
      });

      // Atualizar parcelas
      await supabase
        .from("lancamentos_recorrentes")
        .update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 })
        .eq("id", r.id);
    }
  }


  function resetarFormulario() {
    setFornecedor(""); setDescricao(""); setValor(""); setDataVencimento(""); setCategoriaId(""); setObservacao(""); setStatusInicial("pendente"); setDataPagamento(""); setEditandoId(null);
  }

  function abrirNovo() { resetarFormulario(); if (categorias.length > 0) setCategoriaId(categorias[0].id); setShowForm(true); }

  function abrirEditar(conta: ContaPagar) {
    setFornecedor(conta.fornecedor); setDescricao(conta.descricao || ""); setValor(conta.valor.toString().replace(".", ",")); setDataVencimento(conta.data_vencimento); setCategoriaId(conta.categoria_id || ""); setObservacao(conta.observacao || ""); setStatusInicial(conta.status as "pendente" | "pago"); setDataPagamento(conta.data_pagamento || ""); setEditandoId(conta.id); setShowForm(true);
    setPagandoId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMensagem("");
    if (editandoId) {
      const { fechado, nomeMes } = await verificarMesFechado(dataVencimento);
      if (fechado) {
        const isAdmin = await verificarAdmin();
        if (!isAdmin) {
          setMensagem(`Não é possível editar. ${nomeMes} está fechado.`);
          setLoading(false); setTimeout(() => setMensagem(""), 5000); return;
        }
      }
    }

    const dados: Record<string, unknown> = { fornecedor, descricao, valor: parseFloat(valor.replace(",", ".")), data_vencimento: dataVencimento, categoria_id: categoriaId, observacao, status: statusInicial };
    if (statusInicial === "pago") { dados.data_pagamento = dataPagamento || new Date().toISOString().split("T")[0]; } else { dados.data_pagamento = null; }

    let error; let contaId = editandoId;
    if (editandoId) { const r = await supabase.from("contas_pagar").update(dados).eq("id", editandoId); error = r.error; }
    else { const r = await supabase.from("contas_pagar").insert(dados).select("id").single(); error = r.error; if (r.data) contaId = r.data.id; }

    if (!error && statusInicial === "pago" && contaId && !editandoId) {
      await supabase.from("movimentacoes").insert({ tipo: "saida", data: dados.data_pagamento as string, valor: parseFloat(valor.replace(",", ".")), categoria_id: categoriaId, observacao: `Pagamento: ${fornecedor}${descricao ? ` - ${descricao}` : ""}`, revisar: false });
      await registrarLog({ acao: "criou", tabela: "contas_pagar", registroId: contaId, dadosNovos: dados, detalhes: `${fornecedor} - ${fmt(parseFloat(valor.replace(",", ".")))}` });
      setMensagem("Cadastrada como paga!");
    } else if (error) { setMensagem("Erro ao salvar."); }
    else {
      await registrarLog({ acao: editandoId ? "editou" : "criou", tabela: "contas_pagar", registroId: contaId || undefined, dadosNovos: dados, detalhes: `${fornecedor} - ${fmt(parseFloat(valor.replace(",", ".")))}` });
      setMensagem(editandoId ? "Atualizada!" : "Cadastrada!");
    }
    resetarFormulario(); setShowForm(false); carregarDados(); setLoading(false); setTimeout(() => setMensagem(""), 4000);
  }

  function iniciarPagamento(conta: ContaPagar) {
    setPagandoId(conta.id);
    setDataPagamentoInline(new Date().toISOString().split("T")[0]);
  }

  async function confirmarPagamento(conta: ContaPagar) {
    setLoading(true);
    const dataPag = dataPagamentoInline;
    const { error: err1 } = await supabase.from("contas_pagar").update({ status: "pago", data_pagamento: dataPag }).eq("id", conta.id);
    if (err1) { setMensagem("Erro ao confirmar."); setLoading(false); return; }
    await supabase.from("movimentacoes").insert({ tipo: "saida", data: dataPag, valor: conta.valor, categoria_id: conta.categoria_id, observacao: `Pagamento: ${conta.fornecedor}${conta.descricao ? ` - ${conta.descricao}` : ""}`, revisar: false });
    await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: conta.id, detalhes: `${conta.fornecedor} - ${fmt(conta.valor)}` });
    setPagandoId(null); setMensagem("Pago!"); setLoading(false); carregarDados(); setTimeout(() => setMensagem(""), 4000);
  }

  function toggleSelecionada(id: string) {
    setSelecionadas((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function selecionarTodasPendentes() {
    const pendentes = contasDoMes.filter((c) => c.status === "pendente");
    if (selecionadas.size === pendentes.length) { setSelecionadas(new Set()); }
    else { setSelecionadas(new Set(pendentes.map((c) => c.id))); }
  }

  async function pagarLote() {
    if (selecionadas.size === 0) return;
    const contasSelecionadas = contas.filter((c) => selecionadas.has(c.id));
    const total = contasSelecionadas.reduce((a, c) => a + c.valor, 0);
    if (!confirm(`Pagar ${contasSelecionadas.length} contas no valor total de ${fmt(total)}?`)) return;
    setLoading(true);
    let pagas = 0;
    for (const conta of contasSelecionadas) {
      const { error } = await supabase.from("contas_pagar").update({ status: "pago", data_pagamento: loteDataPagamento }).eq("id", conta.id);
      if (!error) {
        await supabase.from("movimentacoes").insert({ tipo: "saida", data: loteDataPagamento, valor: conta.valor, categoria_id: conta.categoria_id, observacao: `Pagamento: ${conta.fornecedor}${conta.descricao ? ` - ${conta.descricao}` : ""}`, revisar: false });
        await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: conta.id, detalhes: `${conta.fornecedor} - ${fmt(conta.valor)}` });
        pagas++;
      }
    }
    setSelecionadas(new Set()); setModoLote(false);
    setMensagem(`${pagas} contas pagas! Total: ${fmt(total)}`);
    setLoading(false); carregarDados(); setTimeout(() => setMensagem(""), 5000);
  }

  async function desfazerPagamento(conta: ContaPagar) {
    if (!confirm("Desfazer?")) return;
    setLoading(true);
    const { data: movs } = await supabase.from("movimentacoes").select("id").eq("tipo", "saida").eq("valor", conta.valor).ilike("observacao", `%${conta.fornecedor}%`);
    if (movs && movs.length > 0) await supabase.from("movimentacoes").delete().eq("id", movs[0].id);
    await supabase.from("contas_pagar").update({ status: "pendente", data_pagamento: null }).eq("id", conta.id);
    setMensagem("Desfeito!"); setLoading(false); carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function handleExcluir(id: string) {
    if (!confirm("Excluir?")) return;
    await registrarLog({ acao: "excluiu", tabela: "contas_pagar", registroId: id });
    await supabase.from("contas_pagar").delete().eq("id", id);
    setMensagem("Excluída!"); carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  function mesAnterior() { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); }

  // Filtrar por mês
  const contasDoMes = contas.filter((c) => {
    const d = new Date(c.data_vencimento + "T12:00:00");
    return d.getMonth() + 1 === mes && d.getFullYear() === ano;
  });

  const contasFiltradas = contasDoMes.filter(c => {
    if (filtroStatus === "pendentes" && c.status !== "pendente") return false;
    if (filtroStatus === "pagos" && c.status !== "pago") return false;
    return true;
  });

  function agruparPorSemana(lista: ContaPagar[]) {
    const grupos: { label: string; contas: ContaPagar[]; total: number }[] = [];
    const hoje = new Date();
    const inicioSemana = new Date(hoje); inicioSemana.setDate(hoje.getDate() - hoje.getDay());
    for (let s = 0; s < 4; s++) {
      const inicio = new Date(inicioSemana); inicio.setDate(inicioSemana.getDate() + s * 7);
      const fim = new Date(inicio); fim.setDate(inicio.getDate() + 6);
      const cs = lista.filter(c => { const v = new Date(c.data_vencimento + "T12:00:00"); return v >= inicio && v <= fim; });
      if (cs.length > 0) grupos.push({ label: `${inicio.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} a ${fim.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}${s === 0 ? " (Esta semana)" : ""}`, contas: cs.sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento)), total: cs.reduce((a, c) => a + c.valor, 0) });
    }
    const anteriores = lista.filter(c => new Date(c.data_vencimento + "T12:00:00") < inicioSemana);
    const ultimoFim = new Date(inicioSemana); ultimoFim.setDate(inicioSemana.getDate() + 27);
    const futuras = lista.filter(c => new Date(c.data_vencimento + "T12:00:00") > ultimoFim);
    if (anteriores.length > 0) grupos.unshift({ label: "⚠️ Vencidas", contas: anteriores.sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento)), total: anteriores.reduce((a, c) => a + c.valor, 0) });
    if (futuras.length > 0) grupos.push({ label: "Futuras", contas: futuras.sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento)), total: futuras.reduce((a, c) => a + c.valor, 0) });
    return grupos;
  }

  const totalPendente = contasDoMes.filter(c => c.status === "pendente").reduce((a, c) => a + c.valor, 0);
  const totalPago = contasDoMes.filter(c => c.status === "pago").reduce((a, c) => a + c.valor, 0);
  const contasVencidas = contasDoMes.filter(c => c.status === "pendente" && c.data_vencimento < new Date().toISOString().split("T")[0]);
  const semanas = agruparPorSemana(contasFiltradas);
  const totalSelecionadoLote = contas.filter((c) => selecionadas.has(c.id)).reduce((a, c) => a + c.valor, 0);

  function renderConta(conta: ContaPagar) {
    const isVencida = conta.status === "pendente" && conta.data_vencimento < new Date().toISOString().split("T")[0];
    const isPagando = pagandoId === conta.id;

    return (
      <div key={conta.id}>
        <div className={`p-4 flex items-center justify-between hover:bg-[var(--color-bg)] transition-colors ${conta.status === "pago" ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-3 min-w-0">
            {modoLote && conta.status === "pendente" && (
              <input type="checkbox" checked={selecionadas.has(conta.id)} onChange={() => toggleSelecionada(conta.id)} className="w-4 h-4 rounded accent-emerald-600 shrink-0" />
            )}
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${conta.status === "pago" ? "bg-emerald-50 text-emerald-600" : isVencida ? "bg-red-50 text-red-500" : "bg-amber-50 text-amber-600"}`}>
              {conta.status === "pago" ? "✓" : "⏳"}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold truncate">{conta.fornecedor}</p>
                {isVencida && <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold shrink-0">VENCIDA</span>}
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                Vence: {new Date(conta.data_vencimento + "T12:00:00").toLocaleDateString("pt-BR")} ({diasSemana[new Date(conta.data_vencimento + "T12:00:00").getDay()]})
                {conta.descricao && ` · ${conta.descricao}`}
                {conta.data_pagamento && ` · Pago em ${new Date(conta.data_pagamento + "T12:00:00").toLocaleDateString("pt-BR")}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-bold text-sm text-red-500">{fmt(conta.valor)}</span>
            <div className="flex gap-0.5">
              {conta.status === "pendente" && (
                <button onClick={() => iniciarPagamento(conta)} title="Marcar como pago" className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-500 transition text-sm">💳</button>
              )}
              {conta.status === "pago" && (
                <button onClick={() => desfazerPagamento(conta)} title="Desfazer" className="p-1.5 rounded-lg hover:bg-amber-50 text-amber-500 transition text-sm">↩️</button>
              )}
              <button onClick={() => abrirEditar(conta)} title="Editar" className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
              <button onClick={() => handleExcluir(conta.id)} title="Excluir" className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
            </div>
          </div>
        </div>

        {isPagando && (
          <div className="bg-emerald-50 border-t border-emerald-200 px-4 py-4 mx-4 mb-2 rounded-xl flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-emerald-800">📅 Data do pagamento:</span>
            <input type="date" value={dataPagamentoInline} onChange={(e) => setDataPagamentoInline(e.target.value)} className="px-3 py-2 rounded-lg border border-emerald-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
            <button onClick={() => confirmarPagamento(conta)} disabled={loading} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50">
              {loading ? "..." : "✓ Confirmar"}
            </button>
            <button onClick={() => setPagandoId(null)} className="px-4 py-2 bg-white text-gray-500 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 transition">Cancelar</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div><h1 className="text-2xl font-bold tracking-tight">Contas a Pagar</h1><p className="text-[var(--color-text-muted)] text-sm mt-1">Boletos, fornecedores e compromissos</p></div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => { setModoLote(!modoLote); setSelecionadas(new Set()); }} className={`px-4 py-3 font-semibold rounded-xl transition-all text-sm ${modoLote ? "bg-blue-600 text-white shadow-md" : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
            ☑️ {modoLote ? "Sair do Lote" : "Selecionar Lote"}
          </button>
          <button onClick={abrirNovo} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">+ Nova Conta</button>
        </div>
      </div>

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Barra de lote */}
      {modoLote && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button onClick={selecionarTodasPendentes} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition">
              {selecionadas.size === contasDoMes.filter((c) => c.status === "pendente").length ? "Desmarcar Todas" : "Selecionar Todas Pendentes"}
            </button>
            <span className="text-sm text-blue-800 font-medium">
              {selecionadas.size} selecionada{selecionadas.size !== 1 ? "s" : ""} — Total: {fmt(totalSelecionadoLote)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-blue-700 mb-1">DATA DO PAGAMENTO</label>
              <input type="date" value={loteDataPagamento} onChange={(e) => setLoteDataPagamento(e.target.value)} className="px-3 py-2 rounded-lg border border-blue-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
            <button onClick={pagarLote} disabled={selecionadas.size === 0 || loading} className="px-5 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-40">
              💳 Pagar Selecionadas ({selecionadas.size})
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[{l:"Pendente",v:fmt(totalPendente),c:"text-amber-600"},{l:"Pago",v:fmt(totalPago),c:"text-emerald-600"},{l:"Vencidas",v:`${contasVencidas.length}`,c:"text-red-500"},{l:"Total",v:fmt(totalPendente+totalPago),c:"text-[var(--color-text)]"}].map(c=>(
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center"><p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p><p className={`font-bold ${c.c}`}>{c.v}</p></div>
        ))}
      </div>

      {contasVencidas.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center gap-3">
          <span className="text-xl">🚨</span>
          <p className="text-sm font-medium text-red-800">{contasVencidas.length} {contasVencidas.length === 1 ? "conta vencida" : "contas vencidas"}! Total: {fmt(contasVencidas.reduce((a, c) => a + c.valor, 0))}</p>
        </div>
      )}

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") || mensagem.includes("Não é possível") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Nova"} Conta a Pagar</h2>
            <button onClick={() => { setShowForm(false); resetarFormulario(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>
          <form onSubmit={handleSalvar} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Fornecedor</label><input type="text" value={fornecedor} onChange={e => setFornecedor(e.target.value)} placeholder="Nome" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Descrição</label><input type="text" value={descricao} onChange={e => setDescricao(e.target.value)} placeholder="Ex: Boleto mensal" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor (R$)</label><input type="text" value={valor} onChange={e => setValor(e.target.value)} placeholder="0,00" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Vencimento</label><input type="date" value={dataVencimento} onChange={e => setDataVencimento(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Categoria</label><select value={categoriaId} onChange={e => setCategoriaId(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">{categorias.map(cat => (<option key={cat.id} value={cat.id}>{cat.nome}</option>))}</select></div>
            </div>
            <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label><input type="text" value={observacao} onChange={e => setObservacao(e.target.value)} placeholder="Informação adicional" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
            <div>
              <label className="block text-sm font-semibold mb-3 text-[var(--color-text-muted)]">Status</label>
              <div className="flex gap-3">
                <button type="button" onClick={() => setStatusInicial("pendente")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${statusInicial === "pendente" ? "bg-amber-500 text-white shadow-md shadow-amber-200" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>⏳ Pendente</button>
                <button type="button" onClick={() => setStatusInicial("pago")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${statusInicial === "pago" ? "bg-emerald-600 text-white shadow-md shadow-emerald-200" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>✓ Já Pago</button>
              </div>
            </div>
            {statusInicial === "pago" && (
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data do Pagamento</label>
                <input type="date" value={dataPagamento} onChange={e => setDataPagamento(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarFormulario(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">{loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
          {(["pendentes", "pagos", "todos"] as const).map(v => (
            <button key={v} onClick={() => setFiltroStatus(v)} className={`px-4 py-2 rounded-lg text-xs font-medium capitalize transition ${filtroStatus === v ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>{v}</button>
          ))}
        </div>
        <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
          <button onClick={() => setVisualizacao("semanal")} className={`px-4 py-2 rounded-lg text-xs font-medium transition ${visualizacao === "semanal" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>Semanal</button>
          <button onClick={() => setVisualizacao("lista")} className={`px-4 py-2 rounded-lg text-xs font-medium transition ${visualizacao === "lista" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>Lista</button>
        </div>
      </div>

      {visualizacao === "semanal" && (
        <div className="space-y-4">
          {semanas.length === 0 ? (<div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Nenhuma conta em {mesesNomes[mes - 1]}/{ano}.</div>) : (
            semanas.map((semana, i) => (
              <div key={i} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                <div className={`p-4 border-b border-[var(--color-border)] flex items-center justify-between ${semana.label.includes("Vencidas") ? "bg-red-50" : "bg-[var(--color-bg)]"}`}>
                  <h3 className="font-bold text-sm">{semana.label}</h3>
                  <span className={`text-sm font-bold ${semana.label.includes("Vencidas") ? "text-red-500" : "text-[var(--color-text)]"}`}>{fmt(semana.total)}</span>
                </div>
                <div className="divide-y divide-[var(--color-border)]">{semana.contas.map(c => renderConta(c))}</div>
              </div>
            ))
          )}
        </div>
      )}

      {visualizacao === "lista" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          {contasFiltradas.length === 0 ? (<div className="p-12 text-center text-[var(--color-text-muted)] text-sm">Nenhuma conta em {mesesNomes[mes - 1]}/{ano}.</div>) : (
            <div className="divide-y divide-[var(--color-border)]">{contasFiltradas.map(c => renderConta(c))}</div>
          )}
        </div>
      )}
    </div>
  );
}
