"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog, verificarMesFechado, verificarAdmin } from "@/lib/audit";
import ComprovantePicker from "@/components/comprovante-picker";
import { CurrencyInput } from "@/components/currency-input";
import EmptyState from "@/components/empty-state";

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
  comprovante_url?: string;
}

interface Categoria { id: string; nome: string; }

const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function urgencia(dataVencimento: string, status: string) {
  if (status === "pago") return { label: "Pago", dias: 0, cor: "green" };
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const venc = new Date(dataVencimento + "T00:00:00");
  const diff = Math.ceil((venc.getTime() - hoje.getTime()) / (1000*60*60*24));
  if (diff < 0) return { label: `${Math.abs(diff)}d atraso`, dias: diff, cor: "red" };
  if (diff === 0) return { label: "Vence hoje", dias: 0, cor: "orange" };
  if (diff === 1) return { label: "Amanhã", dias: 1, cor: "amber" };
  if (diff <= 7) return { label: `${diff} dias`, dias: diff, cor: "yellow" };
  return { label: `${diff} dias`, dias: diff, cor: "gray" };
}

const urgenciaBadgeClass: Record<string, string> = {
  green:  "bg-emerald-100 text-emerald-700 border border-emerald-200",
  red:    "bg-red-100 text-red-700 border border-red-200",
  orange: "bg-orange-100 text-orange-700 border border-orange-200",
  amber:  "bg-amber-100 text-amber-700 border border-amber-200",
  yellow: "bg-yellow-100 text-yellow-700 border border-yellow-200",
  gray:   "bg-gray-100 text-gray-600 border border-gray-200",
};

const urgenciaIconClass: Record<string, string> = {
  green:  "bg-emerald-50 text-emerald-600",
  red:    "bg-red-50 text-red-500",
  orange: "bg-orange-50 text-orange-500",
  amber:  "bg-amber-50 text-amber-500",
  yellow: "bg-yellow-50 text-yellow-600",
  gray:   "bg-gray-50 text-gray-500",
};

export default function ContasPagarPage() {
  const [contas, setContas] = useState<ContaPagar[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"pendentes" | "pagos" | "todos">("pendentes");
  const [visualizacao, setVisualizacao] = useState<"lista" | "semanal" | "cronograma">("lista");
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());

  // Form
  const [fornecedor, setFornecedor] = useState("");
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState(0);
  const [dataVencimento, setDataVencimento] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [statusInicial, setStatusInicial] = useState<"pendente" | "pago">("pendente");
  const [statusOriginal, setStatusOriginal] = useState<"pendente" | "pago">("pendente");
  const [dataPagamento, setDataPagamento] = useState("");

  // Pagamento inline
  const [pagandoId, setPagandoId] = useState<string | null>(null);
  const [dataPagamentoInline, setDataPagamentoInline] = useState("");

  // Lote
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [modoLote, setModoLote] = useState(false);
  const [loteDataPagamento, setLoteDataPagamento] = useState(new Date().toISOString().split("T")[0]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [comprovanteUrl, setComprovanteUrl] = useState<string | null>(null);

  // Filtros avançados
  const [filtroCategoria, setFiltroCategoria] = useState("");
  const [filtroBusca, setFiltroBusca] = useState("");

  // Calendário – dia selecionado para detalhe
  const [diaSelecionado, setDiaSelecionado] = useState<number | null>(null);

  // Lista colapsável
  const [listaExpandida, setListaExpandida] = useState(true);

  const supabase = createClient();

  async function carregarDados() {
    const inicioAno = `${ano}-01-01`;
    const fimAno = `${ano}-12-31`;

    const [r1, r2] = await Promise.all([
      supabase.from("contas_pagar").select("*").gte("data_vencimento", inicioAno).lte("data_vencimento", fimAno).order("data_vencimento", { ascending: true }),
      supabase.from("categorias_saida").select("*").eq("ativo", true).order("nome"),
    ]);
    if (r2.data) setCategorias(r2.data);

    if (r1.data) {
      const catMap = Object.fromEntries((r2.data || []).map(c => [c.id, c.nome]));
      const lista = r1.data.map(conta => ({
        ...conta,
        categoria_nome: conta.categoria_id ? (catMap[conta.categoria_id] || "Sem categoria") : "Sem categoria",
      }));
      setContas(lista);
    }
  }

  useEffect(() => { carregarDados(); gerarRecorrentes(); setDiaSelecionado(null); }, [mes, ano]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const destacar = params.get("destacar");
    const dataParam = params.get("data");
    if (!destacar) return;

    setHighlightId(destacar);

    if (dataParam) {
      const d = new Date(dataParam + "T12:00:00");
      setMes(d.getMonth() + 1);
      setAno(d.getFullYear());
    } else {
      createClient()
        .from("contas_pagar")
        .select("data_vencimento")
        .eq("id", destacar)
        .single()
        .then(({ data: registro }) => {
          if (registro?.data_vencimento) {
            const d = new Date(registro.data_vencimento + "T12:00:00");
            setMes(d.getMonth() + 1);
            setAno(d.getFullYear());
          }
        });
    }
  }, []);

  useEffect(() => {
    if (!highlightId) return;
    const el = document.getElementById(`conta-${highlightId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = setTimeout(() => setHighlightId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [contas, highlightId]);

  async function gerarRecorrentes() {
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const { data: recorrentes } = await supabase
      .from("lancamentos_recorrentes")
      .select("*")
      .eq("ativo", true)
      .ilike("observacao", "%CONTA_PAGAR%");

    if (!recorrentes || recorrentes.length === 0) return;

    for (const r of recorrentes) {
      const { data: existente } = await supabase
        .from("contas_pagar")
        .select("id")
        .eq("fornecedor", r.descricao)
        .eq("valor", r.valor)
        .gte("data_vencimento", inicio)
        .lte("data_vencimento", fim)
        .limit(1);

      if (existente && existente.length > 0) continue;

      const dataInicioR = new Date(r.data_inicio + "T12:00:00");
      const dataVenc = new Date(ano, mes - 1, r.dia_vencimento || 1);
      if (dataVenc < dataInicioR) continue;
      if (r.data_fim && dataVenc > new Date(r.data_fim + "T12:00:00")) continue;
      if (r.total_parcelas && r.parcelas_geradas >= r.total_parcelas) continue;

      const dia = Math.min(r.dia_vencimento || 1, ultimoDia);
      const dataVencimento = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;

      await supabase.from("contas_pagar").insert({
        fornecedor: r.descricao,
        descricao: "Recorrente mensal",
        valor: r.valor,
        data_vencimento: dataVencimento,
        status: "pendente",
        categoria_id: r.categoria_id,
        observacao: "Gerado automaticamente - Recorrente",
      });

      await supabase
        .from("lancamentos_recorrentes")
        .update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 })
        .eq("id", r.id);
    }
  }

  function resetarFormulario() {
    setFornecedor(""); setDescricao(""); setValor(0); setDataVencimento(""); setCategoriaId(""); setObservacao(""); setStatusInicial("pendente"); setStatusOriginal("pendente"); setDataPagamento(""); setEditandoId(null); setComprovanteUrl(null);
  }

  function abrirNovo() { resetarFormulario(); if (categorias.length > 0) setCategoriaId(categorias[0].id); setShowForm(true); }

  function abrirEditar(conta: ContaPagar) {
    setFornecedor(conta.fornecedor); setDescricao(conta.descricao || ""); setValor(conta.valor); setDataVencimento(conta.data_vencimento); setCategoriaId(conta.categoria_id || ""); setObservacao(conta.observacao || ""); setStatusInicial(conta.status as "pendente" | "pago"); setStatusOriginal(conta.status as "pendente" | "pago"); setDataPagamento(conta.data_pagamento || ""); setComprovanteUrl(conta.comprovante_url ?? null); setEditandoId(conta.id); setShowForm(true);
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

    const dados: Record<string, unknown> = { fornecedor, descricao, valor: valor, data_vencimento: dataVencimento, categoria_id: categoriaId, observacao, status: statusInicial, comprovante_url: comprovanteUrl };
    if (statusInicial === "pago") { dados.data_pagamento = dataPagamento || new Date().toISOString().split("T")[0]; } else { dados.data_pagamento = null; }

    let error; let contaId = editandoId;
    if (editandoId) { const r = await supabase.from("contas_pagar").update(dados).eq("id", editandoId); error = r.error; }
    else { const r = await supabase.from("contas_pagar").insert(dados).select("id").single(); error = r.error; if (r.data) contaId = r.data.id; }

    if (error) {
      setMensagem("Erro ao salvar.");
    } else if (statusInicial === "pago" && contaId && !editandoId) {
      await supabase.from("movimentacoes").insert({ tipo: "saida", data: dados.data_pagamento as string, valor: valor, categoria_id: categoriaId, observacao: `Pagamento: ${fornecedor}${descricao ? ` - ${descricao}` : ""}`, revisar: false });
      await registrarLog({ acao: "criou", tabela: "contas_pagar", registroId: contaId, dadosNovos: dados, detalhes: `${fornecedor} - ${fmt(valor)}` });
      setMensagem("Cadastrada como paga e lançada nas movimentações!");
    } else if (editandoId && statusOriginal === "pendente" && statusInicial === "pago") {
      const dataPag = dataPagamento || new Date().toISOString().split("T")[0];
      await supabase.from("movimentacoes").insert({ tipo: "saida", data: dataPag, valor: valor, categoria_id: categoriaId, observacao: `Pagamento: ${fornecedor}${descricao ? ` - ${descricao}` : ""}`, revisar: false });
      await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: editandoId, dadosNovos: dados, detalhes: `${fornecedor} - ${fmt(valor)}` });
      setMensagem("Paga e lançada nas movimentações!");
    } else {
      await registrarLog({ acao: editandoId ? "editou" : "criou", tabela: "contas_pagar", registroId: contaId || undefined, dadosNovos: dados, detalhes: `${fornecedor} - ${fmt(valor)}` });
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

  function selecionarPorData(data: string) {
    const ids = contasDoMes
      .filter(c => c.status === "pendente" && c.data_vencimento === data)
      .map(c => c.id);
    setSelecionadas(prev => {
      const todasJaSelecionadas = ids.every(id => prev.has(id));
      const novo = new Set(prev);
      if (todasJaSelecionadas) { ids.forEach(id => novo.delete(id)); }
      else { ids.forEach(id => novo.add(id)); }
      return novo;
    });
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
    if (filtroCategoria && c.categoria_id !== filtroCategoria) return false;
    if (filtroBusca && !c.fornecedor.toLowerCase().includes(filtroBusca.toLowerCase())) return false;
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

  // KPI extras
  const totalMes = totalPendente + totalPago;
  const percPago = totalMes > 0 ? (totalPago / totalMes) * 100 : 0;
  const hoje = new Date().toISOString().split("T")[0];
  const contasHoje = contasDoMes.filter(c => c.status === "pendente" && c.data_vencimento === hoje);
  const contas7dias = contasDoMes.filter(c => {
    if (c.status !== "pendente") return false;
    const agora = new Date(); agora.setHours(0,0,0,0);
    const venc = new Date(c.data_vencimento + "T00:00:00");
    const diff = Math.ceil((venc.getTime() - agora.getTime()) / (1000*60*60*24));
    return diff >= 0 && diff <= 7;
  });

  // Banner contextual
  const totalVencidas = contasVencidas.reduce((a, c) => a + c.valor, 0);
  const totalHoje = contasHoje.reduce((a, c) => a + c.valor, 0);
  const contas2dias = contasDoMes.filter(c => {
    if (c.status !== "pendente") return false;
    const agora = new Date(); agora.setHours(0,0,0,0);
    const venc = new Date(c.data_vencimento + "T00:00:00");
    const diff = Math.ceil((venc.getTime() - agora.getTime()) / (1000*60*60*24));
    return diff > 0 && diff <= 2;
  });

  // Datas únicas com pendências (para seleção por data no lote)
  const datasPendentesMes = [...new Set(
    contasDoMes.filter(c => c.status === "pendente").map(c => c.data_vencimento)
  )].sort();

  // Projeção por categoria (pendentes)
  const projecaoCategoria = categorias.map(cat => {
    const total = contasDoMes.filter(c => c.status === "pendente" && c.categoria_id === cat.id).reduce((a, c) => a + c.valor, 0);
    const qtd = contasDoMes.filter(c => c.status === "pendente" && c.categoria_id === cat.id).length;
    return { ...cat, total, qtd };
  }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);

  // Comprovantes em falta (pagas sem anexo)
  const contasSemComprovante = contasDoMes.filter(c => c.status === "pago" && !c.comprovante_url).length;

  // Agrupamento para cronograma
  function agruparPorDia(lista: ContaPagar[]) {
    const mapa: Record<string, ContaPagar[]> = {};
    for (const c of lista) {
      if (!mapa[c.data_vencimento]) mapa[c.data_vencimento] = [];
      mapa[c.data_vencimento].push(c);
    }
    return Object.entries(mapa).sort(([a], [b]) => a.localeCompare(b));
  }

  function renderConta(conta: ContaPagar) {
    const urg = urgencia(conta.data_vencimento, conta.status);
    const isPagando = pagandoId === conta.id;
    const iconClass = urgenciaIconClass[urg.cor] || urgenciaIconClass.gray;
    const badgeClass = urgenciaBadgeClass[urg.cor] || urgenciaBadgeClass.gray;

    return (
      <div key={conta.id} id={`conta-${conta.id}`}>
        <div className={`px-4 py-3.5 flex items-center justify-between gap-3 transition-all duration-300 ${
          highlightId === conta.id
            ? "bg-yellow-50 ring-2 ring-inset ring-yellow-400"
            : `hover:bg-[var(--color-bg)] ${conta.status === "pago" ? "opacity-60" : ""}`
        }`}>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {modoLote && conta.status === "pendente" && (
              <input type="checkbox" checked={selecionadas.has(conta.id)} onChange={() => toggleSelecionada(conta.id)} className="w-4 h-4 rounded accent-emerald-600 shrink-0" />
            )}
            {/* Ícone de status */}
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 ${iconClass}`}>
              {conta.status === "pago" ? "✓" : urg.cor === "red" ? "!" : "·"}
            </div>
            {/* Conteúdo */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold truncate">{conta.fornecedor}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 ${badgeClass}`}>{urg.label}</span>
                {conta.categoria_nome && conta.categoria_nome !== "Sem categoria" && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)] shrink-0">{conta.categoria_nome}</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-xs text-[var(--color-text-muted)]">
                  {diasSemana[new Date(conta.data_vencimento + "T12:00:00").getDay()]}{" "}
                  {new Date(conta.data_vencimento + "T12:00:00").toLocaleDateString("pt-BR")}
                </span>
                {conta.descricao && <span className="text-xs text-[var(--color-text-muted)]">· {conta.descricao}</span>}
                {conta.data_pagamento && <span className="text-xs text-emerald-600">· Pago {new Date(conta.data_pagamento + "T12:00:00").toLocaleDateString("pt-BR")}</span>}
                {conta.status === "pago" && conta.comprovante_url && (
                  <a href={conta.comprovante_url} target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 transition">
                    📎 Comprovante
                  </a>
                )}
                {conta.status === "pago" && !conta.comprovante_url && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-50 text-orange-600 border border-orange-200">
                    ⚠️ Sem comprovante
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Valor e ações */}
          <div className="flex items-center gap-3 shrink-0">
            <span className={`font-bold text-sm tabular-nums ${conta.status === "pago" ? "text-emerald-600" : urg.cor === "red" ? "text-red-500" : "text-[var(--color-text)]"}`}>
              {fmt(conta.valor)}
            </span>
            <div className="flex gap-0.5">
              {conta.status === "pendente" && (
                <button onClick={() => iniciarPagamento(conta)} title="Marcar como pago" className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-500 transition text-sm">💳</button>
              )}
              {conta.status === "pago" && (
                <button onClick={() => desfazerPagamento(conta)} title="Desfazer pagamento" className="p-1.5 rounded-lg hover:bg-amber-50 text-amber-500 transition text-sm">↩️</button>
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

  function renderContaCompacta(conta: ContaPagar) {
    const urg = urgencia(conta.data_vencimento, conta.status);
    const badgeClass = urgenciaBadgeClass[urg.cor] || urgenciaBadgeClass.gray;
    const isPagando = pagandoId === conta.id;

    return (
      <div key={conta.id} id={`conta-${conta.id}`}>
        <div className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg transition-all ${
          highlightId === conta.id ? "bg-yellow-50 ring-1 ring-yellow-400" : "hover:bg-[var(--color-bg)]"
        } ${conta.status === "pago" ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {modoLote && conta.status === "pendente" && (
              <input type="checkbox" checked={selecionadas.has(conta.id)} onChange={() => toggleSelecionada(conta.id)} className="w-4 h-4 rounded accent-emerald-600 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium truncate">{conta.fornecedor}</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold shrink-0 ${badgeClass}`}>{urg.label}</span>
                {conta.categoria_nome && conta.categoria_nome !== "Sem categoria" && (
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)] shrink-0">{conta.categoria_nome}</span>
                )}
              </div>
              {conta.descricao && <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{conta.descricao}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-sm font-bold tabular-nums ${conta.status === "pago" ? "text-emerald-600" : urg.cor === "red" ? "text-red-500" : "text-[var(--color-text)]"}`}>
              {fmt(conta.valor)}
            </span>
            <div className="flex gap-0.5">
              {conta.status === "pendente" && (
                <button onClick={() => iniciarPagamento(conta)} title="Pagar" className="p-1 rounded-lg hover:bg-emerald-50 text-emerald-500 transition text-xs">💳</button>
              )}
              {conta.status === "pago" && (
                <button onClick={() => desfazerPagamento(conta)} title="Desfazer" className="p-1 rounded-lg hover:bg-amber-50 text-amber-500 transition text-xs">↩️</button>
              )}
              <button onClick={() => abrirEditar(conta)} title="Editar" className="p-1 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-xs">✏️</button>
              <button onClick={() => handleExcluir(conta.id)} title="Excluir" className="p-1 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-xs">🗑️</button>
            </div>
          </div>
        </div>
        {isPagando && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-3 mx-1 mb-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-emerald-800">📅 Data:</span>
            <input type="date" value={dataPagamentoInline} onChange={(e) => setDataPagamentoInline(e.target.value)} className="px-2 py-1.5 rounded-lg border border-emerald-300 bg-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400" />
            <button onClick={() => confirmarPagamento(conta)} disabled={loading} className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition disabled:opacity-50">
              {loading ? "..." : "✓ Confirmar"}
            </button>
            <button onClick={() => setPagandoId(null)} className="px-3 py-1.5 bg-white text-gray-500 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50 transition">Cancelar</button>
          </div>
        )}
      </div>
    );
  }

  function renderCronograma() {
    const grupos = agruparPorDia(contasFiltradas);
    const agoraStr = new Date().toISOString().split("T")[0];

    if (grupos.length === 0) {
      return (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <EmptyState variant="accounts" title={`Sem contas em ${mesesNomes[mes - 1]}/${ano}`} description="Nenhuma conta a pagar registrada neste mês." compact />
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {grupos.map(([data, lista]) => {
          const dataObj = new Date(data + "T12:00:00");
          const diaSem = diasSemana[dataObj.getDay()];
          const dataFmt = dataObj.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
          const totalDia = lista.reduce((a, c) => a + c.valor, 0);
          const temPendente = lista.some(c => c.status === "pendente");
          const isPassado = data < agoraStr && temPendente;
          const isHoje = data === agoraStr;

          let headerBg = "bg-[var(--color-bg)]";
          let headerText = "text-[var(--color-text)]";
          let headerBorder = "border-[var(--color-border)]";
          let dayLabel: string | null = null;

          if (isPassado) {
            headerBg = "bg-red-50";
            headerText = "text-red-700";
            headerBorder = "border-red-200";
            dayLabel = "VENCIDO";
          } else if (isHoje) {
            headerBg = "bg-orange-50";
            headerText = "text-orange-700";
            headerBorder = "border-orange-200";
            dayLabel = "HOJE";
          }

          return (
            <div key={data} className={`border rounded-2xl overflow-hidden ${headerBorder}`}>
              {/* Header do dia */}
              <div className={`px-4 py-3 flex items-center justify-between ${headerBg} border-b ${headerBorder}`}>
                <div className="flex items-center gap-2.5">
                  <span className={`text-sm font-bold ${headerText}`}>{diaSem} {dataFmt}</span>
                  {dayLabel && (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      isPassado ? "bg-red-100 text-red-700 border border-red-200" : "bg-orange-100 text-orange-700 border border-orange-200"
                    }`}>
                      {isPassado ? "⚠️ " : "📅 "}{dayLabel}
                    </span>
                  )}
                  <span className={`text-xs font-medium ${headerText} opacity-70`}>{lista.length} {lista.length === 1 ? "conta" : "contas"}</span>
                </div>
                <span className={`text-sm font-bold tabular-nums ${headerText}`}>{fmt(totalDia)}</span>
              </div>
              {/* Lista de contas do dia */}
              <div className="bg-[var(--color-surface)] divide-y divide-[var(--color-border)] px-2 py-1">
                {lista.map(c => renderContaCompacta(c))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Contas a Pagar</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-0.5">Boletos, fornecedores e compromissos</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => { setModoLote(!modoLote); setSelecionadas(new Set()); }}
            className={`px-4 py-2.5 font-semibold rounded-xl transition-all text-sm border ${modoLote ? "bg-blue-600 text-white border-blue-600 shadow-md" : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-blue-400 hover:text-blue-600"}`}
          >
            ☑️ {modoLote ? "Sair do Lote" : "Selecionar Lote"}
          </button>
          <button
            onClick={abrirNovo}
            className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200"
          >
            + Nova Conta
          </button>
        </div>
      </div>

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3 flex items-center justify-between gap-3">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition flex items-center gap-1">
          ← <span className="hidden sm:inline">Anterior</span>
        </button>
        <div className="text-center">
          <p className="font-bold capitalize text-base">{mesesNomes[mes - 1]}</p>
          <p className="text-xs text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition flex items-center gap-1">
          <span className="hidden sm:inline">Próximo</span> →
        </button>
      </div>

      {/* Barra de lote */}
      {modoLote && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={selecionarTodasPendentes} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition">
                {selecionadas.size === contasDoMes.filter((c) => c.status === "pendente").length ? "Desmarcar Todas" : "Todas Pendentes"}
              </button>
              {datasPendentesMes.map(data => {
                const d = new Date(data + "T12:00:00");
                const label = `${diasSemana[d.getDay()]} ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
                const idsData = contasDoMes.filter(c => c.status === "pendente" && c.data_vencimento === data).map(c => c.id);
                const todasSel = idsData.every(id => selecionadas.has(id));
                return (
                  <button key={data} onClick={() => selecionarPorData(data)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold transition border ${todasSel ? "bg-blue-700 text-white border-blue-700" : "bg-white text-blue-700 border-blue-300 hover:bg-blue-100"}`}>
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="text-sm text-blue-800 font-semibold">
              {selecionadas.size} selecionada{selecionadas.size !== 1 ? "s" : ""} · {fmt(totalSelecionadoLote)}
            </span>
          </div>
          <div className="flex items-center gap-3 pt-1 border-t border-blue-200 flex-wrap">
            <div>
              <label className="block text-[10px] font-semibold text-blue-700 mb-1">DATA DO PAGAMENTO</label>
              <input type="date" value={loteDataPagamento} onChange={(e) => setLoteDataPagamento(e.target.value)} className="px-3 py-2 rounded-lg border border-blue-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
            <button onClick={pagarLote} disabled={selecionadas.size === 0 || loading} className="px-5 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-40 mt-4">
              💳 Pagar Selecionadas ({selecionadas.size})
            </button>
          </div>
        </div>
      )}

      {/* Banner de alerta inteligente */}
      {contasVencidas.length > 0 && (
        <div className="rounded-2xl p-4 flex items-center gap-3 border" style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.25)" }}>
          <span className="text-lg shrink-0">🚨</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-800">
              {contasVencidas.length} {contasVencidas.length === 1 ? "conta vencida" : "contas vencidas"} · Total: {fmt(totalVencidas)}
            </p>
            <p className="text-xs text-red-600 mt-0.5">Regularize para evitar juros e multas</p>
          </div>
        </div>
      )}
      {contasVencidas.length === 0 && contasHoje.length > 0 && (
        <div className="rounded-2xl p-4 flex items-center gap-3 border" style={{ background: "rgba(249,115,22,0.06)", borderColor: "rgba(249,115,22,0.25)" }}>
          <span className="text-lg shrink-0">⏰</span>
          <p className="text-sm font-semibold text-orange-800">
            {contasHoje.length} {contasHoje.length === 1 ? "conta vence" : "contas vencem"} HOJE · Total: {fmt(totalHoje)}
          </p>
        </div>
      )}
      {contasVencidas.length === 0 && contasHoje.length === 0 && contas2dias.length > 0 && (
        <div className="rounded-2xl p-4 flex items-center gap-3 border" style={{ background: "rgba(234,179,8,0.06)", borderColor: "rgba(234,179,8,0.25)" }}>
          <span className="text-lg shrink-0">📅</span>
          <p className="text-sm font-semibold text-yellow-800">
            {contas2dias.length} {contas2dias.length === 1 ? "conta vence" : "contas vencem"} em até 2 dias · Total: {fmt(contas2dias.reduce((a, c) => a + c.valor, 0))}
          </p>
        </div>
      )}

      {/* Mensagem de feedback */}
      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") || mensagem.includes("Não é possível") ? "bg-red-50 text-red-600 border border-red-200" : "bg-emerald-50 text-emerald-700 border border-emerald-200"}`}>
          {mensagem}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Pendente */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-2">Pendente</p>
          <p className="text-xl font-bold text-amber-600 tabular-nums leading-none">{fmt(totalPendente)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1.5">{contasDoMes.filter(c => c.status === "pendente").length} contas</p>
        </div>
        {/* Pago */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-2">Pago ✓</p>
          <p className="text-xl font-bold text-emerald-600 tabular-nums leading-none">{fmt(totalPago)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1.5">{percPago.toFixed(0)}% do mês</p>
        </div>
        {/* Vencidas */}
        <div className={`border rounded-2xl p-4 ${contasVencidas.length > 0 ? "bg-red-50 border-red-200" : "bg-[var(--color-surface)] border-[var(--color-border)]"}`}>
          <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${contasVencidas.length > 0 ? "text-red-500" : "text-[var(--color-text-muted)]"}`}>Vencidas 🔴</p>
          <p className={`text-xl font-bold tabular-nums leading-none ${contasVencidas.length > 0 ? "text-red-600" : "text-[var(--color-text-muted)]"}`}>{contasVencidas.length} contas</p>
          {contasVencidas.length > 0 && <p className="text-xs text-red-500 mt-1.5">{fmt(totalVencidas)}</p>}
          {contasVencidas.length === 0 && <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Tudo em dia</p>}
        </div>
        {/* Próximos 7 dias */}
        <div className={`border rounded-2xl p-4 ${contas7dias.length > 0 ? "bg-amber-50 border-amber-200" : "bg-[var(--color-surface)] border-[var(--color-border)]"}`}>
          <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${contas7dias.length > 0 ? "text-amber-600" : "text-[var(--color-text-muted)]"}`}>7 dias ⚠️</p>
          <p className={`text-xl font-bold tabular-nums leading-none ${contas7dias.length > 0 ? "text-amber-700" : "text-[var(--color-text-muted)]"}`}>
            {fmt(contas7dias.reduce((a, c) => a + c.valor, 0))}
          </p>
          <p className={`text-xs mt-1.5 ${contas7dias.length > 0 ? "text-amber-600" : "text-[var(--color-text-muted)]"}`}>{contas7dias.length} contas</p>
        </div>
      </div>

      {/* Barra de progresso + alerta comprovantes */}
      {totalMes > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-5 py-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Progresso de pagamento</span>
            <div className="flex items-center gap-3">
              {contasSemComprovante > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 border border-orange-200">
                  ⚠️ {contasSemComprovante} sem comprovante
                </span>
              )}
              <span className="text-xs font-bold text-emerald-600">{percPago.toFixed(0)}% pago</span>
            </div>
          </div>
          <div className="h-2 rounded-full bg-[var(--color-bg)] overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700"
              style={{ width: `${Math.min(percPago, 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-[var(--color-text-muted)]">{fmt(totalPago)} pagos</span>
            <span className="text-xs text-[var(--color-text-muted)]">Total: {fmt(totalMes)}</span>
          </div>
        </div>
      )}

      {/* Projeção por categoria */}
      {projecaoCategoria.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-5 py-4">
          <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-3">Pendente por categoria</p>
          <div className="space-y-2">
            {projecaoCategoria.map(cat => {
              const perc = totalPendente > 0 ? (cat.total / totalPendente) * 100 : 0;
              return (
                <div key={cat.id}>
                  <div className="flex items-center justify-between mb-1">
                    <button onClick={() => setFiltroCategoria(filtroCategoria === cat.id ? "" : cat.id)}
                      className={`text-xs font-medium transition ${filtroCategoria === cat.id ? "text-[var(--color-primary)] font-bold" : "text-[var(--color-text)] hover:text-[var(--color-primary)]"}`}>
                      {cat.nome} <span className="text-[var(--color-text-muted)]">({cat.qtd})</span>
                    </button>
                    <span className="text-xs font-bold tabular-nums text-amber-600">{fmt(cat.total)} <span className="text-[var(--color-text-muted)] font-normal">{perc.toFixed(0)}%</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--color-bg)] overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400 transition-all duration-500" style={{ width: `${perc}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          {filtroCategoria && (
            <button onClick={() => setFiltroCategoria("")} className="mt-3 text-xs text-[var(--color-primary)] hover:underline">
              ✕ Limpar filtro de categoria
            </button>
          )}
        </div>
      )}

      {/* Formulário */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold text-base">{editandoId ? "Editar" : "Nova"} Conta a Pagar</h2>
            <button onClick={() => { setShowForm(false); resetarFormulario(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)] transition">✕</button>
          </div>
          <form onSubmit={handleSalvar} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Fornecedor</label><input type="text" value={fornecedor} onChange={e => setFornecedor(e.target.value)} placeholder="Nome" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Descrição</label><input type="text" value={descricao} onChange={e => setDescricao(e.target.value)} placeholder="Ex: Boleto mensal" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor (R$)</label><CurrencyInput value={valor} onChange={setValor} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" /></div>
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
            <ComprovantePicker
              tabela="contas-pagar"
              urlAtual={comprovanteUrl}
              onChange={setComprovanteUrl}
            />
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarFormulario(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">{loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}</button>
            </div>
          </form>
        </div>
      )}

      {/* Barra de busca e filtros */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[160px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] text-sm">🔍</span>
          <input
            type="text"
            value={filtroBusca}
            onChange={e => setFiltroBusca(e.target.value)}
            placeholder="Buscar fornecedor..."
            className="w-full pl-8 pr-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </div>
        <select
          value={filtroCategoria}
          onChange={e => setFiltroCategoria(e.target.value)}
          className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 min-w-[160px]"
        >
          <option value="">Todas as categorias</option>
          {categorias.map(cat => <option key={cat.id} value={cat.id}>{cat.nome}</option>)}
        </select>
        {(filtroBusca || filtroCategoria) && (
          <button onClick={() => { setFiltroBusca(""); setFiltroCategoria(""); }} className="px-3 py-2 rounded-xl text-xs font-semibold text-red-500 hover:bg-red-50 border border-red-200 transition">
            ✕ Limpar
          </button>
        )}
        <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 border border-[var(--color-border)] ml-auto">
          {(["pendentes", "pagos", "todos"] as const).map(v => (
            <button key={v} onClick={() => setFiltroStatus(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition ${filtroStatus === v ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Seletor de visualização + contagem + toggle colapso */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-4 py-2.5 flex items-center justify-between flex-wrap gap-3">
        <button
          onClick={() => setListaExpandida(v => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-primary)] transition select-none"
        >
          <span className={`transition-transform duration-200 text-xs ${listaExpandida ? "rotate-90" : ""}`}>▶</span>
          {contasFiltradas.length} {contasFiltradas.length === 1 ? "conta" : "contas"}
          <span className="text-[var(--color-text-muted)] font-normal">· {fmt(contasFiltradas.reduce((a,c)=>a+c.valor,0))}</span>
          {(filtroBusca || filtroCategoria) && <span className="text-amber-600 font-semibold text-xs">filtrado</span>}
          <span className="text-xs font-normal text-[var(--color-text-muted)] ml-1">
            {listaExpandida ? "Ocultar lista" : "Mostrar lista"}
          </span>
        </button>
        <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 border border-[var(--color-border)]">
          {(["lista", "semanal", "cronograma"] as const).map(v => (
            <button key={v} onClick={() => { setVisualizacao(v); setListaExpandida(true); }}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition ${visualizacao === v ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {v === "lista" ? "Lista" : v === "semanal" ? "Semanal" : "Cronograma"}
            </button>
          ))}
        </div>
      </div>

      {/* Views – colapsáveis */}
      {listaExpandida && (
        <>
          {/* View: Semanal */}
          {visualizacao === "semanal" && (
            <div className="space-y-4">
              {semanas.length === 0 ? (
                <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                  <EmptyState variant="accounts" title={`Sem contas em ${mesesNomes[mes - 1]}/${ano}`} description="Nenhuma conta a pagar registrada neste mês." />
                </div>
              ) : (
                semanas.map((semana, i) => (
                  <div key={i} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                    <div className={`px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between ${semana.label.includes("Vencidas") ? "bg-red-50" : "bg-[var(--color-bg)]"}`}>
                      <h3 className={`font-bold text-sm ${semana.label.includes("Vencidas") ? "text-red-700" : "text-[var(--color-text)]"}`}>{semana.label}</h3>
                      <span className={`text-sm font-bold tabular-nums ${semana.label.includes("Vencidas") ? "text-red-500" : "text-[var(--color-text)]"}`}>{fmt(semana.total)}</span>
                    </div>
                    <div className="divide-y divide-[var(--color-border)]">{semana.contas.map(c => renderConta(c))}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* View: Lista */}
          {visualizacao === "lista" && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              {contasFiltradas.length === 0 ? (
                <EmptyState variant="accounts" title={`Sem contas em ${mesesNomes[mes - 1]}/${ano}`} description="Nenhuma conta a pagar registrada neste mês." compact />
              ) : (
                <div className="divide-y divide-[var(--color-border)]">{contasFiltradas.map(c => renderConta(c))}</div>
              )}
            </div>
          )}

          {/* View: Cronograma */}
          {visualizacao === "cronograma" && renderCronograma()}
        </>
      )}

      {/* Calendário Mensal de Valores por Dia */}
      {(() => {
        const priDiaSem = new Date(ano, mes - 1, 1).getDay();
        const diasNoMes = new Date(ano, mes, 0).getDate();
        const offset = priDiaSem === 0 ? 6 : priDiaSem - 1;
        const hojeStr = new Date().toISOString().split("T")[0];

        const porDia: Record<number, { pendente: number; pago: number; nPendente: number; nPago: number }> = {};
        for (let d = 1; d <= diasNoMes; d++) {
          const dataStr = `${ano}-${String(mes).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
          const lista = contasDoMes.filter(c => c.data_vencimento === dataStr);
          porDia[d] = {
            pendente: lista.filter(c => c.status === "pendente").reduce((a, c) => a + c.valor, 0),
            pago: lista.filter(c => c.status === "pago").reduce((a, c) => a + c.valor, 0),
            nPendente: lista.filter(c => c.status === "pendente").length,
            nPago: lista.filter(c => c.status === "pago").length,
          };
        }

        const cells: (number | null)[] = [];
        for (let i = 0; i < offset; i++) cells.push(null);
        for (let d = 1; d <= diasNoMes; d++) cells.push(d);
        while (cells.length % 7 !== 0) cells.push(null);
        const semanas: (number | null)[][] = [];
        for (let i = 0; i < cells.length; i += 7) semanas.push(cells.slice(i, i + 7));

        const DOW = ["Seg","Ter","Qua","Qui","Sex","Sáb","Dom"];

        function getDayStyle(dia: number) {
          const dataStr = `${ano}-${String(mes).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
          const isHoje = dataStr === hojeStr;
          const isPassado = dataStr < hojeStr;
          const d = porDia[dia];
          const isSel = diaSelecionado === dia;
          if (d.nPendente + d.nPago === 0) return { bg: "bg-[var(--color-bg)]", border: "border-[var(--color-border)]", text: "text-[var(--color-text-muted)]", numText: "text-[var(--color-text-muted)] opacity-50", empty: true };
          if (isSel) return { bg: "bg-blue-50", border: "border-blue-400 border-2", text: "text-blue-800", numText: "text-blue-900 font-extrabold", empty: false };
          if (isHoje && d.nPendente > 0) return { bg: "bg-orange-50", border: "border-orange-300", text: "text-orange-800", numText: "text-orange-900 font-extrabold", empty: false };
          if (isPassado && d.nPendente > 0) return { bg: "bg-red-50", border: "border-red-300", text: "text-red-700", numText: "text-red-900 font-extrabold", empty: false };
          if (d.nPendente > 0) return { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800", numText: "text-amber-900 font-bold", empty: false };
          return { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", numText: "text-emerald-900 font-bold", empty: false };
        }

        function fmtCal(v: number) {
          if (v >= 1000) return `R$${(v / 1000).toFixed(1)}k`;
          return `R$${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
        }

        const diasComContas = Object.values(porDia).filter(d => d.nPendente + d.nPago > 0).length;

        // Detalhe do dia selecionado
        const detalheDia = diaSelecionado ? (() => {
          const dataStr = `${ano}-${String(mes).padStart(2,"0")}-${String(diaSelecionado).padStart(2,"0")}`;
          const lista = contasDoMes.filter(c => c.data_vencimento === dataStr);
          const d = new Date(dataStr + "T12:00:00");
          const nomeDia = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
          const totalDia = lista.reduce((a, c) => a + c.valor, 0);
          const pendentes = lista.filter(c => c.status === "pendente");
          const pagos = lista.filter(c => c.status === "pago");
          return { lista, nomeDia, totalDia, pendentes, pagos, dataStr };
        })() : null;

        return (
          <div className="space-y-3">
            {/* Grade calendário */}
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-sm font-bold text-[var(--color-text)]">Calendário {mesesNomes[mes - 1]} {ano}</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Clique em um dia para ver os detalhes</p>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  {[
                    { color: "bg-red-200 border-red-300", label: "Vencida" },
                    { color: "bg-orange-200 border-orange-300", label: "Hoje" },
                    { color: "bg-amber-100 border-amber-300", label: "Pendente" },
                    { color: "bg-emerald-100 border-emerald-300", label: "Pago" },
                  ].map(({ color, label }) => (
                    <div key={label} className="flex items-center gap-1.5">
                      <div className={`w-3 h-3 rounded border ${color}`} />
                      <span className="text-xs text-[var(--color-text-muted)] font-medium">{label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4">
                {/* Cabeçalho dias da semana */}
                <div className="grid grid-cols-7 gap-2 mb-2">
                  {DOW.map(d => (
                    <div key={d} className="text-center text-xs font-bold text-[var(--color-text-muted)] uppercase py-1 tracking-wider">{d}</div>
                  ))}
                </div>

                {/* Células dos dias */}
                {semanas.map((semana, si) => (
                  <div key={si} className="grid grid-cols-7 gap-2 mb-2">
                    {semana.map((dia, di) => {
                      if (!dia) return <div key={di} className="h-20 rounded-xl" />;
                      const d = porDia[dia];
                      const dataStr = `${ano}-${String(mes).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
                      const isHoje = dataStr === hojeStr;
                      const isSel = diaSelecionado === dia;
                      const { bg, border, text, numText, empty } = getDayStyle(dia);
                      const total = d.pendente + d.pago;
                      return (
                        <div key={di}
                          onClick={() => !empty && setDiaSelecionado(isSel ? null : dia)}
                          className={`h-20 rounded-xl border ${border} ${bg} p-2 flex flex-col transition-all select-none ${!empty ? "cursor-pointer hover:shadow-md hover:scale-[1.03]" : "cursor-default"} ${isHoje && !isSel ? "ring-2 ring-orange-400 ring-offset-1" : ""} ${isSel ? "shadow-md" : ""}`}
                        >
                          <span className={`text-sm leading-none ${numText}`}>{dia}</span>
                          {!empty ? (
                            <div className="mt-auto">
                              <span className={`text-xs font-bold tabular-nums block leading-tight ${text}`}>
                                {fmtCal(total)}
                              </span>
                              <div className="flex gap-1 mt-1 flex-wrap">
                                {d.nPendente > 0 && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 border border-amber-200 leading-none">
                                    {d.nPendente}p
                                  </span>
                                )}
                                {d.nPago > 0 && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 border border-emerald-200 leading-none">
                                    {d.nPago}✓
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--color-text-muted)] mt-auto opacity-40 font-medium">R$0</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Resumo rodapé */}
                <div className="mt-4 pt-4 border-t border-[var(--color-border)] grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest">Dias com contas</p>
                    <p className="text-base font-bold mt-1">{diasComContas} de {diasNoMes}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest">Total pendente</p>
                    <p className="text-base font-bold mt-1 text-amber-600">{fmt(totalPendente)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest">Total pago</p>
                    <p className="text-base font-bold mt-1 text-emerald-600">{fmt(totalPago)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Painel de detalhe do dia */}
            {detalheDia && (
              <div className="bg-[var(--color-surface)] border border-blue-200 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-blue-100 flex items-center justify-between bg-blue-50">
                  <div>
                    <p className="text-sm font-bold capitalize text-blue-900">{detalheDia.nomeDia}</p>
                    <p className="text-xs text-blue-600 mt-0.5">
                      {detalheDia.lista.length} {detalheDia.lista.length === 1 ? "conta" : "contas"} · Total {fmt(detalheDia.totalDia)}
                    </p>
                  </div>
                  <button
                    onClick={() => setDiaSelecionado(null)}
                    className="w-8 h-8 rounded-lg hover:bg-blue-100 flex items-center justify-center text-blue-500 text-sm font-bold transition"
                  >
                    ✕
                  </button>
                </div>

                <div className="divide-y divide-[var(--color-border)]">
                  {detalheDia.lista.map(conta => {
                    const urg = urgencia(conta.data_vencimento, conta.status);
                    const badgeClass = urgenciaBadgeClass[urg.cor] || urgenciaBadgeClass.gray;
                    return (
                      <div key={conta.id}
                        className="flex items-center justify-between px-5 py-3.5 hover:bg-[var(--color-bg)] transition cursor-pointer"
                        onClick={() => abrirEditar(conta)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 ${conta.status === "pago" ? "bg-emerald-100 text-emerald-600" : urg.cor === "red" ? "bg-red-50 text-red-500" : "bg-amber-50 text-amber-600"}`}>
                            {conta.status === "pago" ? "✓" : urg.cor === "red" ? "!" : "·"}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[var(--color-text)] truncate">{conta.fornecedor}</p>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              {conta.categoria_nome && conta.categoria_nome !== "Sem categoria" && (
                                <span className="text-xs text-[var(--color-text-muted)]">{conta.categoria_nome}</span>
                              )}
                              {conta.descricao && <span className="text-xs text-[var(--color-text-muted)] truncate">· {conta.descricao}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${badgeClass}`}>{urg.label}</span>
                          <span className={`text-sm font-bold tabular-nums ${conta.status === "pago" ? "text-emerald-600" : urg.cor === "red" ? "text-red-500" : "text-[var(--color-text)]"}`}>
                            {fmt(conta.valor)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="px-5 py-3.5 border-t border-blue-100 bg-blue-50 flex items-center justify-between flex-wrap gap-3">
                  <div className="flex gap-4 flex-wrap">
                    {detalheDia.pendentes.length > 0 && (
                      <span className="text-xs font-semibold text-amber-700">
                        ⏳ {detalheDia.pendentes.length} pendente{detalheDia.pendentes.length > 1 ? "s" : ""} · {fmt(detalheDia.pendentes.reduce((a, c) => a + c.valor, 0))}
                      </span>
                    )}
                    {detalheDia.pagos.length > 0 && (
                      <span className="text-xs font-semibold text-emerald-700">
                        ✓ {detalheDia.pagos.length} pago{detalheDia.pagos.length > 1 ? "s" : ""} · {fmt(detalheDia.pagos.reduce((a, c) => a + c.valor, 0))}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold text-blue-900">Total: {fmt(detalheDia.totalDia)}</span>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
