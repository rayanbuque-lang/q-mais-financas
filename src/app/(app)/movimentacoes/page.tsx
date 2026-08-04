"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CurrencyInput } from "@/components/currency-input";
import { registrarLog } from "@/lib/audit";
import ComprovantePicker from "@/components/comprovante-picker";
import EmptyState from "@/components/empty-state";
import { useRole } from "@/lib/role-context";

interface Movimentacao { id: string; tipo: string; data: string; valor: number; categoria_id: string; observacao: string; revisar: boolean; comprovante_url?: string; }
interface Cat { id: string; nome: string; }
interface Item { id: string; movimentacao_id: string; valor: number; }
interface Template { id: string; nome: string; tipo: "entrada" | "saida"; valor: number; categoria_id: string; observacao: string; }
const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function MovimentacoesPage() {
  const { isReadOnly } = useRole();
  const [movs, setMovs] = useState<Movimentacao[]>([]);
  const [catEntrada, setCatEntrada] = useState<Cat[]>([]);
  const [catSaida, setCatSaida] = useState<Cat[]>([]);
  const [itensPorMov, setItensPorMov] = useState<Record<string, Item[]>>({});
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busca, setBusca] = useState("");

  const [tipo, setTipo] = useState<"entrada" | "saida">("saida");
  const [data, setData] = useState("");
  const [valor, setValor] = useState(0);
  const [categoriaId, setCategoriaId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const [showSomatoria, setShowSomatoria] = useState(false);
  const [itensTemp, setItensTemp] = useState<number[]>([]);
  const [itemInput, setItemInput] = useState("");

  const [detalheId, setDetalheId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [sugestaoCat, setSugestaoCat] = useState<string | null>(null);
  const [comprovanteUrl, setComprovanteUrl] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [salvandoTemplate, setSalvandoTemplate] = useState(false);
  const [nomeTemplate, setNomeTemplate] = useState("");
  const [filtroCatNome, setFiltroCatNome] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"lista" | "calendario">("lista");
  const [listaVisible, setListaVisible] = useState(true);
  const [calDiaSel, setCalDiaSel] = useState<string | null>(null);

  const supabase = createClient();
  const cats = tipo === "entrada" ? catEntrada : catSaida;

  async function carregarTemplates() {
    const { data } = await supabase.from("movimentacao_templates").select("*").order("nome");
    if (data) setTemplates(data as Template[]);
  }

  function usarTemplate(t: Template) {
    setTipo(t.tipo);
    setCategoriaId(t.categoria_id);
    setValor(t.valor);
    setObservacao(t.observacao || "");
    setData(new Date().toISOString().split("T")[0]);
    setEditandoId(null);
    setShowForm(true);
    setShowTemplates(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function excluirTemplate(id: string) {
    await supabase.from("movimentacao_templates").delete().eq("id", id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }

  async function salvarTemplate() {
    if (!nomeTemplate.trim()) { setMensagem("Dê um nome ao template."); setTimeout(() => setMensagem(""), 3000); return; }
    if (!categoriaId || !valor || valor <= 0) { setMensagem("Preencha o valor e a categoria antes de salvar o template."); setTimeout(() => setMensagem(""), 3000); return; }
    const { error } = await supabase.from("movimentacao_templates").insert({ nome: nomeTemplate.trim(), tipo, valor, categoria_id: categoriaId, observacao });
    if (error) { setMensagem("Erro ao salvar template: " + error.message); setTimeout(() => setMensagem(""), 4000); return; }
    setNomeTemplate("");
    setSalvandoTemplate(false);
    setMensagem("⚡ Template salvo com sucesso!");
    setTimeout(() => setMensagem(""), 3000);
    carregarTemplates();
  }

  async function carregarCategorias() {
    const [r1, r2] = await Promise.all([
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true).order("nome"),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true).order("nome"),
    ]);
    if (r1.data) setCatEntrada(r1.data);
    if (r2.data) setCatSaida(r2.data);
  }

  async function carregarMovimentacoes() {
    const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const fim = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
    const { data: resultado } = await supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).order("data", { ascending: true });
    if (!resultado) return;
    setMovs(resultado as Movimentacao[]);

    // Buscar todos os itens de uma vez (evita N+1)
    const ids = resultado.map(m => m.id);
    if (ids.length > 0) {
      const { data: todosItens } = await supabase
        .from("movimentacao_itens")
        .select("id, movimentacao_id, valor")
        .in("movimentacao_id", ids)
        .order("created_at", { ascending: true });
      const mapa: Record<string, Item[]> = {};
      (todosItens || []).forEach(item => {
        if (!mapa[item.movimentacao_id]) mapa[item.movimentacao_id] = [];
        mapa[item.movimentacao_id].push(item as Item);
      });
      setItensPorMov(mapa);
    }
  }

  useEffect(() => { carregarMovimentacoes(); carregarCategorias(); }, [mes, ano]);
  useEffect(() => { carregarTemplates(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const destacar = params.get("destacar");
    const dataParam = params.get("data");
    const mesParam = params.get("mes");
    const anoParam = params.get("ano");

    if (mesParam) setMes(parseInt(mesParam) - 1);
    if (anoParam) setAno(parseInt(anoParam));

    if (!destacar) return;

    setHighlightId(destacar);

    if (dataParam) {
      const d = new Date(dataParam + "T12:00:00");
      setMes(d.getMonth());
      setAno(d.getFullYear());
    } else {
      // data não veio na URL — busca direto no banco
      createClient()
        .from("movimentacoes")
        .select("data")
        .eq("id", destacar)
        .single()
        .then(({ data: registro }) => {
          if (registro?.data) {
            const d = new Date(registro.data + "T12:00:00");
            setMes(d.getMonth());
            setAno(d.getFullYear());
          }
        });
    }
  }, []);

  useEffect(() => {
    if (!highlightId) return;
    const el = document.getElementById(`mov-${highlightId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = setTimeout(() => setHighlightId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [movs, highlightId]);

  useEffect(() => {
    if (!showForm) return;
    const c = tipo === "entrada" ? catEntrada : catSaida;
    if (c.length > 0 && !c.find(x => x.id === categoriaId)) setCategoriaId(c[0].id);
  }, [tipo, catEntrada, catSaida, showForm]);

  function resetForm() {
    setTipo("saida"); setData(""); setValor(0); setCategoriaId("");
    setObservacao(""); setEditandoId(null);
    setShowSomatoria(false); setItensTemp([]); setItemInput("");
    setComprovanteUrl(null);
  }

  function novoLancamento() {
    resetForm();
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function editarMov(m: Movimentacao) {
    setTipo(m.tipo as "entrada" | "saida");
    setData(m.data);
    setCategoriaId(m.categoria_id);
    setObservacao(m.observacao || "");
    setComprovanteUrl(m.comprovante_url ?? null);
    setEditandoId(m.id);
    setShowForm(true);

    // Carregar itens existentes
    const itensExistentes = itensPorMov[m.id];
    if (itensExistentes && itensExistentes.length > 0) {
      const valores = itensExistentes.map(i => i.valor);
      setItensTemp(valores);
      setValor(valores.reduce((a, b) => a + b, 0));
      setShowSomatoria(true);
    } else {
      setItensTemp([]);
      setShowSomatoria(false);
      setValor(m.valor);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addItem() {
    const limpo = itemInput.replace(/\s/g, "");
    if (!limpo) return;

    const novos: number[] = [];

    if (limpo.includes("+")) {
      const partes = limpo.split("+").filter(Boolean);
      for (const p of partes) {
        const v = parseFloat(p.replace(",", "."));
        if (!isNaN(v) && v > 0) novos.push(v);
      }
    } else {
      const v = parseFloat(limpo.replace(",", "."));
      if (!isNaN(v) && v > 0) novos.push(v);
    }

    if (novos.length === 0) return;

    const atualizados = [...itensTemp, ...novos];
    setItensTemp(atualizados);
    setValor(atualizados.reduce((a, b) => a + b, 0));
    setItemInput("");
  }

  function removeItem(index: number) {
    const novos = itensTemp.filter((_, i) => i !== index);
    setItensTemp(novos);
    setValor(novos.reduce((a, b) => a + b, 0));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMensagem("");

    const valorNum = itensTemp.length > 0 ? itensTemp.reduce((a, b) => a + b, 0) : valor;

    if (isNaN(valorNum) || valorNum <= 0) {
      setMensagem("Informe um valor válido.");
      setLoading(false);
      setTimeout(() => setMensagem(""), 3000);
      return;
    }

    const dados = { tipo, data, valor: valorNum, categoria_id: categoriaId, observacao, forma_pagamento: null, revisar: false, comprovante_url: comprovanteUrl };
    let movId = editandoId;
    let error;

    if (editandoId) {
      const { error: err } = await supabase.from("movimentacoes").update(dados).eq("id", editandoId);
      error = err;
      movId = editandoId;
    } else {
      const { data: existente } = await supabase
        .from("movimentacoes").select("id")
        .eq("tipo", tipo).eq("data", data).eq("categoria_id", categoriaId)
        .gte("valor", valorNum * 0.99).lte("valor", valorNum * 1.01).limit(1);
      if (existente && existente.length > 0) {
        setMensagem("⚠️ Lançamento similar encontrado. Verifique se não é duplicado.");
        setTimeout(() => setMensagem(""), 5000);
      }
      const { data: novo, error: err } = await supabase.from("movimentacoes").insert(dados).select("id").single();
      error = err;
      if (novo) movId = novo.id;
    }

    if (error) {
      setMensagem("Erro ao salvar movimentação: " + error.message);
      setLoading(false);
      setTimeout(() => setMensagem(""), 5000);
      return;
    }

    // Salvar itens individuais da somatória
    if (movId && itensTemp.length > 0) {
      // Deletar itens antigos
      await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", movId);

      // Inserir todos de uma vez
      const novosItens = itensTemp.map((v, i) => ({
        movimentacao_id: movId,
        descricao: `Valor ${i + 1}`,
        valor: parseFloat(v.toFixed(2)),
      }));

      const { data: itensInseridos, error: errItens } = await supabase
        .from("movimentacao_itens")
        .insert(novosItens)
        .select();

      if (errItens) {
        setMensagem(`ERRO ao salvar somatória: ${errItens.message}. Detalhes: ${errItens.details || "nenhum"}`);
      } else {
        setMensagem(`Salvo! ${itensInseridos?.length || 0} valores individuais registrados.`);
      }
    } else if (movId && editandoId) {
      await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", movId);
      setMensagem(editandoId ? "Atualizado!" : "Salvo!");
    } else {
      setMensagem(editandoId ? "Atualizado!" : "Salvo!");
    }

    await registrarLog({
      acao: editandoId ? "editou" : "criou",
      tabela: "movimentacoes",
      registroId: movId || undefined,
      detalhes: `R$ ${valorNum.toFixed(2)}${itensTemp.length > 0 ? ` (${itensTemp.length} valores)` : ""}`,
    });

    setMensagem(editandoId ? "Atualizado!" : "Salvo!");
    resetForm();
    setShowForm(false);
    await carregarMovimentacoes();
    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function excluirMov(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("movimentacao_itens").delete().eq("movimentacao_id", id);
    await supabase.from("movimentacoes").delete().eq("id", id);
    await registrarLog({ acao: "excluiu", tabela: "movimentacoes", registroId: id });
    setMensagem("Excluído!");
    carregarMovimentacoes();
    setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function mesAnterior() { if (mes === 0) { setMes(11); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 11) { setMes(0); setAno(ano + 1); } else setMes(mes + 1); }

  function getCategoriaNome(id: string) {
    return [...catEntrada, ...catSaida].find(c => c.id === id)?.nome || "Sem categoria";
  }

  function getCatIcon(nome: string): string {
    const n = nome.toLowerCase();
    if (n.includes("pix") && n.includes("santander")) return "📱";
    if (n.includes("pix") && n.includes("inter")) return "📱";
    if (n.includes("pix")) return "📱";
    if (n.includes("cart")) return "💳";
    if (n.includes("rom")) return "💳";
    if (n.includes("dinh")) return "💵";
    if (n.includes("app")) return "📲";
    if (n.includes("pref")) return "🏛️";
    if (n.includes("vouch")) return "🎫";
    if (n.includes("vend")) return "🛒";
    if (n.includes("serv")) return "🔧";
    return "💰";
  }

  // 1º nível: filtro de texto (base para os totais das chips)
  const movsBusca = movs.filter(m => {
    if (!busca) return true;
    const termo = busca.toLowerCase();
    const nome = getCategoriaNome(m.categoria_id).toLowerCase();
    const valorStr = m.valor.toFixed(2);
    const dataFmt = new Date(m.data + "T12:00:00").toLocaleDateString("pt-BR");
    const obs = (m.observacao || "").toLowerCase();
    return nome.includes(termo) || valorStr.includes(termo) || dataFmt.includes(termo) || obs.includes(termo) || m.data.includes(termo);
  });

  // 2º nível: filtro por categoria (aplica sobre o resultado da busca)
  const movsFiltrados = filtroCatNome
    ? movsBusca.filter(m => getCategoriaNome(m.categoria_id) === filtroCatNome)
    : movsBusca;

  // Totais dos chips calculados sempre sobre movsBusca (sem filtro de categoria)
  const entradasBusca = movsBusca.filter(m => m.tipo === "entrada");
  const saidasBusca = movsBusca.filter(m => m.tipo === "saida");

  const entryCatTotais = (() => {
    const acc: Record<string, number> = {};
    entradasBusca.forEach(m => { const n = getCategoriaNome(m.categoria_id); acc[n] = (acc[n] || 0) + m.valor; });
    return Object.entries(acc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  })();
  const saidaCatTotais = (() => {
    const acc: Record<string, number> = {};
    saidasBusca.forEach(m => { const n = getCategoriaNome(m.categoria_id); acc[n] = (acc[n] || 0) + m.valor; });
    return Object.entries(acc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  })();

  const entradas = movsFiltrados.filter(m => m.tipo === "entrada");
  const saidas = movsFiltrados.filter(m => m.tipo === "saida");
  const totalEntradas = entradas.reduce((a, m) => a + m.valor, 0);
  const totalSaidas = saidas.reduce((a, m) => a + m.valor, 0);
  const saldo = totalEntradas - totalSaidas;
  const totalSomatoria = itensTemp.reduce((a, b) => a + b, 0);

  const calDados: Record<string, { ent: number; sai: number; movs: Movimentacao[] }> = {};
  movsFiltrados.forEach(m => {
    if (!calDados[m.data]) calDados[m.data] = { ent: 0, sai: 0, movs: [] };
    if (m.tipo === "entrada") calDados[m.data].ent += m.valor;
    else calDados[m.data].sai += m.valor;
    calDados[m.data].movs.push(m);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Movimentações</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Registre entradas e saídas</p>
        </div>
        {!isReadOnly && (
          <button onClick={novoLancamento} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
            + Nova Movimentação
          </button>
        )}
      </div>

      {/* Nav + Resumo compacto */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-4 py-3 flex items-center flex-wrap gap-y-3">
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={mesAnterior} className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm hover:bg-[var(--color-border)] transition">←</button>
          <div className="text-center min-w-[96px]">
            <p className="font-bold capitalize text-sm">{mesesNomes[mes]}</p>
            <p className="text-xs text-[var(--color-text-muted)]">{ano}</p>
          </div>
          <button onClick={mesProximo} className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm hover:bg-[var(--color-border)] transition">→</button>
        </div>
        <div className="w-px bg-[var(--color-border)] h-8 mx-4 shrink-0 hidden sm:block" />
        <div className="flex flex-1 flex-wrap gap-y-2">
          {[
            { l: "Entradas", v: fmt(totalEntradas), c: "text-emerald-600" },
            { l: "Saídas", v: fmt(totalSaidas), c: "text-red-500" },
            { l: "Saldo", v: fmt(saldo), c: saldo >= 0 ? "text-emerald-600" : "text-red-500" },
          ].map((item, i) => (
            <div key={item.l} className={`flex flex-col px-4 ${i > 0 ? "border-l border-[var(--color-border)]" : ""}`}>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">{item.l}</span>
              <span className={`text-sm font-bold tabular-nums ${item.c}`}>{item.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Busca + alternância de vista */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 space-y-2">
        <div className="flex gap-3 items-center">
          <div className="relative flex-1">
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "var(--text-placeholder)" }}>🔍</span>
            <input type="text" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por categoria, valor, data, observação..."
              className="w-full pl-10 pr-10 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
            {busca && <button onClick={() => setBusca("")} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--text-placeholder)" }}>✕</button>}
          </div>
          <div className="flex border border-[var(--color-border)] rounded-xl overflow-hidden shrink-0">
            <button
              onClick={() => { setViewMode("lista"); setCalDiaSel(null); }}
              className={`px-4 py-2.5 text-xs font-bold transition-all ${viewMode === "lista" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-border)]"}`}
            >📋 Lista</button>
            <button
              onClick={() => setViewMode("calendario")}
              className={`px-4 py-2.5 text-xs font-bold transition-all border-l border-[var(--color-border)] ${viewMode === "calendario" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-border)]"}`}
            >📅 Calendário</button>
          </div>
        </div>
        {busca && <p className="text-xs text-[var(--color-text-muted)]">{movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? "s" : ""}</p>}
      </div>

      {/* Templates Rápidos */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
        <button
          onClick={() => setShowTemplates(!showTemplates)}
          className="w-full flex items-center justify-between p-4 hover:bg-[var(--color-bg)] transition text-left"
        >
          <div className="flex items-center gap-2">
            <span>⚡</span>
            <span className="text-sm font-bold">Templates Rápidos</span>
            {templates.length > 0 && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">{templates.length}</span>}
          </div>
          <span className="text-[var(--color-text-muted)] text-xs">{showTemplates ? "▲ Fechar" : "▼ Ver"}</span>
        </button>
        {showTemplates && (
          <div className="border-t border-[var(--color-border)] p-4">
            {templates.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] text-center py-2">
                Nenhum template ainda. Salve um lançamento frequente como template no formulário.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {templates.map((t) => {
                  const catNome = [...catEntrada, ...catSaida].find(c => c.id === t.categoria_id)?.nome || "Sem categoria";
                  return (
                    <div key={t.id} className={`border rounded-xl p-4 flex items-start justify-between gap-2 ${t.tipo === "entrada" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-bold truncate">{t.nome}</p>
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{catNome}</p>
                        <p className={`text-sm font-semibold mt-1 ${t.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                          {t.tipo === "entrada" ? "+" : "-"} {t.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                        </p>
                      </div>
                      {!isReadOnly && (
                        <div className="flex flex-col gap-1 shrink-0">
                          <button onClick={() => usarTemplate(t)} className="px-3 py-1.5 bg-white border border-current rounded-lg text-xs font-semibold hover:bg-gray-50 transition text-emerald-700">Usar</button>
                          <button onClick={() => excluirTemplate(t.id)} className="px-3 py-1.5 bg-white border border-red-200 rounded-lg text-xs text-red-400 hover:bg-red-50 transition">✕</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>


      {/* Filtros por categoria */}
      {(entryCatTotais.length > 0 || saidaCatTotais.length > 0) && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 space-y-4">
          {filtroCatNome && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "var(--blue-subtle)", border: "1px solid var(--blue-border)", borderRadius: 10 }}>
              <span style={{ fontSize: 12, color: "var(--blue-strong)", fontWeight: 600 }}>Filtrando: {filtroCatNome}</span>
              <button onClick={() => setFiltroCatNome(null)} style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>✕ Limpar</button>
            </div>
          )}
          {entryCatTotais.length > 0 && (
            <div>
              <p className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Entradas por Categoria</p>
              <div className="flex flex-wrap gap-2">
                {entryCatTotais.map(([nome, val]) => {
                  const ativo = filtroCatNome === nome;
                  return (
                    <button key={nome} type="button" onClick={() => setFiltroCatNome(ativo ? null : nome)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 12, cursor: "pointer", transition: "all 0.15s",
                        border: `2px solid ${ativo ? "var(--green)" : "var(--border)"}`,
                        background: ativo ? "var(--green-muted)" : "var(--color-bg)" }}>
                      <span style={{ fontSize: 13 }}>{getCatIcon(nome)}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: ativo ? "var(--green-strong)" : "var(--color-text)" }}>{nome}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--green)" }}>{fmt(val)}</span>
                      {ativo && <span style={{ fontSize: 10, color: "var(--green)" }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {saidaCatTotais.length > 0 && (
            <div>
              <p className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Saídas por Categoria</p>
              <div className="flex flex-wrap gap-2">
                {saidaCatTotais.map(([nome, val]) => {
                  const ativo = filtroCatNome === nome;
                  return (
                    <button key={nome} type="button" onClick={() => setFiltroCatNome(ativo ? null : nome)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 12, cursor: "pointer", transition: "all 0.15s",
                        border: `2px solid ${ativo ? "var(--red)" : "var(--border)"}`,
                        background: ativo ? "var(--red-muted)" : "var(--color-bg)" }}>
                      <span style={{ fontSize: 13 }}>{getCatIcon(nome)}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: ativo ? "var(--red-strong)" : "var(--color-text)" }}>{nome}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--red)" }}>{fmt(val)}</span>
                      {ativo && <span style={{ fontSize: 10, color: "var(--red)" }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : mensagem.includes("⚠️") ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {/* Formulário */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Nova"} Movimentação</h2>
            <button onClick={() => { setShowForm(false); resetForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex gap-3">
              <button type="button" onClick={() => { setTipo("entrada"); }}
                className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "entrada" ? "bg-emerald-600 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▲ Entrada</button>
              <button type="button" onClick={() => { setTipo("saida"); }}
                className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "saida" ? "bg-red-500 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▼ Saída</button>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Data</label>
              <input type="date" value={data} onChange={e => setData(e.target.value)} required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
              <select value={categoriaId} onChange={e => setCategoriaId(e.target.value)} required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm">
                {cats.map(c => <option key={c.id} value={c.id}>{getCatIcon(c.nome)} {c.nome}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Valor Total (R$)</label>
              <CurrencyInput value={valor} onChange={setValor} required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
            </div>

            {/* Somatória */}
            <div style={{ border: "1px dashed #d1d5db", borderRadius: 12, padding: 16 }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-[var(--color-text-muted)]">📐 Somatória de valores (opcional)</span>
                <button type="button" onClick={() => setShowSomatoria(!showSomatoria)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${showSomatoria ? "bg-blue-100 text-blue-700 border border-blue-300" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
                  {showSomatoria ? "✕ Fechar" : "+ Abrir"}
                </button>
              </div>

              {showSomatoria && (
                <div>
                  <div className="flex gap-2 mb-2">
                    <input type="text" value={itemInput} onChange={e => setItemInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
                      placeholder="Ex: 15+30+22 ou 13,50"
                      className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                    <button type="button" onClick={addItem}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition">+ Add</button>
                  </div>

                  {itensTemp.length > 0 && (
                    <div>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {itensTemp.map((v, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs font-medium text-blue-700">
                            {v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                            <button type="button" onClick={() => removeItem(i)} className="ml-1 text-blue-400 hover:text-red-500 font-bold">✕</button>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t border-dashed border-[var(--color-border)]">
                        <span className="text-xs font-bold text-[var(--color-text-muted)]">{itensTemp.length} valores</span>
                        <span className="text-sm font-bold text-emerald-600">Total: {totalSomatoria.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Observação</label>
              <input value={observacao} onChange={e => {
                const v = e.target.value;
                setObservacao(v);
                if (v.length > 2) {
                  const lower = v.toLowerCase();
                  const match = cats.find(c => lower.includes(c.nome.toLowerCase()));
                  setSugestaoCat(match?.id ?? null);
                } else {
                  setSugestaoCat(null);
                }
              }} placeholder="Ex: Venda balcão" className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
              {sugestaoCat && !categoriaId && (
                <button type="button" onClick={() => { setCategoriaId(sugestaoCat); setSugestaoCat(null); }}
                  className="mt-1.5 text-xs px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition">
                  Categoria sugerida: {cats.find(c => c.id === sugestaoCat)?.nome} — Usar
                </button>
              )}
            </div>

            <ComprovantePicker
              tabela="movimentacoes"
              urlAtual={comprovanteUrl}
              onChange={setComprovanteUrl}
            />

            {!editandoId && (
              <div className="border border-dashed border-[var(--color-border)] rounded-xl p-3">
                <button type="button" onClick={() => setSalvandoTemplate(!salvandoTemplate)}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition flex items-center gap-1.5">
                  ⚡ {salvandoTemplate ? "Cancelar template" : "Salvar como template rápido"}
                </button>
                {salvandoTemplate && (
                  <div className="mt-2 flex gap-2">
                    <input value={nomeTemplate} onChange={e => setNomeTemplate(e.target.value)} placeholder="Nome do template (ex: Pix Santander)" className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                    <button type="button" onClick={salvarTemplate} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition">Salvar</button>
                  </div>
                )}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
              {loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}
            </button>
          </form>
        </div>
      )}

      {/* Lista / Calendário */}
      {viewMode === "lista" ? (
        <div className="space-y-2">
          {/* Cabeçalho recolhível */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setListaVisible(v => !v)}
              className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition py-1"
            >
              <span className={`text-[10px] transition-transform inline-block ${listaVisible ? "" : "-rotate-90"}`}>▼</span>
              <span className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-0.5 text-xs font-bold text-[var(--color-text)] tabular-nums">
                {movsFiltrados.length} lançamento{movsFiltrados.length !== 1 ? "s" : ""}
              </span>
              <span className="text-xs text-[var(--color-text-muted)] tabular-nums">{fmt(totalEntradas + totalSaidas)}</span>
            </button>
            <button
              onClick={() => setListaVisible(v => !v)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition"
            >
              {listaVisible ? "Ocultar lista" : "Mostrar lista"}
            </button>
          </div>

          {listaVisible && (movsFiltrados.length === 0 ? (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <EmptyState
                variant={busca || filtroCatNome ? "search" : "movements"}
                title={busca ? `Sem resultados para "${busca}"` : filtroCatNome ? `Nenhuma movimentação em "${filtroCatNome}"` : `Nenhuma movimentação em ${mesesNomes[mes]}/${ano}`}
                description={busca || filtroCatNome ? "Tente outros termos ou remova o filtro." : "Registre sua primeira movimentação deste mês."}
                action={!busca && !filtroCatNome ? { label: "+ Nova movimentação", onClick: () => {} } : undefined}
              />
            </div>
          ) : (() => {
            const grupos: { data: string; movs: Movimentacao[] }[] = [];
            movsFiltrados.forEach(m => {
              const last = grupos[grupos.length - 1];
              if (last && last.data === m.data) last.movs.push(m);
              else grupos.push({ data: m.data, movs: [m] });
            });

            return (
              <div className="space-y-2">
                {grupos.map(grupo => {
                  const entDia = grupo.movs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
                  const saiDia = grupo.movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
                  const saldoDia = entDia - saiDia;
                  const dObj = new Date(grupo.data + "T12:00:00");
                  const diaSem = dObj.toLocaleDateString("pt-BR", { weekday: "short" });
                  const dataFmt = dObj.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
                  const isHoje = grupo.data === new Date().toISOString().split("T")[0];

                  return (
                    <div key={grupo.data} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                      {/* Cabeçalho do dia */}
                      <div className={`px-4 py-2.5 flex items-center justify-between border-b border-[var(--color-border)] ${isHoje ? "bg-emerald-50" : "bg-[var(--color-bg)]"}`}>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold capitalize ${isHoje ? "text-emerald-700" : "text-[var(--color-text)]"}`}>
                            {diaSem} {dataFmt}
                          </span>
                          {isHoje && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 border border-emerald-200">HOJE</span>}
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            {grupo.movs.length} lançamento{grupo.movs.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          {entDia > 0 && <span className="text-[11px] font-semibold text-emerald-600">+{fmt(entDia)}</span>}
                          {saiDia > 0 && <span className="text-[11px] font-semibold text-red-500">–{fmt(saiDia)}</span>}
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-lg ${saldoDia >= 0 ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                            {saldoDia >= 0 ? "+" : ""}{fmt(saldoDia)}
                          </span>
                        </div>
                      </div>

                      {/* Linhas compactas */}
                      <div className="divide-y divide-[var(--color-border)]">
                        {grupo.movs.map(m => {
                          const nome = getCategoriaNome(m.categoria_id);
                          const icon = getCatIcon(nome);
                          const itens = itensPorMov[m.id];
                          const temItens = itens && itens.length > 0;
                          const isDetalhe = detalheId === m.id;
                          return (
                            <div key={m.id} id={`mov-${m.id}`}>
                              <div
                                className={`px-4 py-2.5 flex items-center gap-3 transition-all ${
                                  highlightId === m.id
                                    ? "bg-yellow-50 ring-2 ring-inset ring-yellow-400"
                                    : temItens ? "cursor-pointer hover:bg-blue-50" : "hover:bg-[var(--color-bg)]"
                                }`}
                                onClick={() => { if (temItens) setDetalheId(isDetalhe ? null : m.id); }}
                              >
                                <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0 ${m.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                                  {icon}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-[var(--color-text)] truncate">
                                    {nome}
                                    {m.observacao && <span className="text-[var(--color-text-muted)] font-normal text-xs"> · {m.observacao}</span>}
                                  </p>
                                  {m.comprovante_url && (
                                    <a href={m.comprovante_url} target="_blank" rel="noopener noreferrer"
                                      onClick={e => e.stopPropagation()}
                                      className="text-[10px] text-blue-500 hover:underline">📎 comprovante</a>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {m.revisar && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 border border-amber-200">revisar</span>}
                                  {temItens && (
                                    <span className="text-[10px] font-medium text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-md border border-blue-100">
                                      {itens!.length}✦ {isDetalhe ? "▲" : "▼"}
                                    </span>
                                  )}
                                  <span className={`text-sm font-bold tabular-nums ${m.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                                    {m.tipo === "entrada" ? "+" : "–"} {fmt(m.valor)}
                                  </span>
                                  {!isReadOnly && (
                                    <>
                                      <button onClick={e => { e.stopPropagation(); editarMov(m); }} className="p-1 rounded-lg hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-blue-600 transition text-xs">✏️</button>
                                      <button onClick={e => { e.stopPropagation(); excluirMov(m.id); }} className="p-1 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-xs">🗑️</button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {isDetalhe && temItens && (
                                <div className="bg-blue-50 border-t border-blue-100 px-4 py-3">
                                  <div className="flex flex-wrap gap-2">
                                    {itens!.map((item, i) => (
                                      <span key={item.id} className="px-2.5 py-1 bg-white border border-blue-200 rounded-lg text-xs font-medium text-blue-700">
                                        {i + 1}ª {fmt(item.valor)}
                                      </span>
                                    ))}
                                  </div>
                                  <p className="text-xs font-bold text-blue-800 mt-2 pt-2 border-t border-blue-200 text-right">
                                    {itens!.length} valores · Total {fmt(itens!.reduce((a, b) => a + b.valor, 0))}
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })())}
        </div>
      ) : (
        /* Calendário */
        (() => {
          const primeiroDia = new Date(ano, mes, 1).getDay();
          const offset = (primeiroDia + 6) % 7;
          const diasNoMes = new Date(ano, mes + 1, 0).getDate();
          const hoje = new Date().toISOString().split("T")[0];
          const diasSemana = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
          const celulas: (number | null)[] = [
            ...Array(offset).fill(null),
            ...Array.from({ length: diasNoMes }, (_, i) => i + 1),
          ];

          return (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                {diasSemana.map(d => (
                  <div key={d} className="py-2 text-center text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {celulas.map((dia, i) => {
                  if (dia === null) {
                    return <div key={`e-${i}`} className="border-r border-b border-[var(--color-border)] bg-[var(--color-bg)] opacity-30 min-h-[80px]" />;
                  }
                  const dStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
                  const d = calDados[dStr];
                  const isHoje = dStr === hoje;
                  const isSel = calDiaSel === dStr;
                  const saldo = d ? d.ent - d.sai : 0;
                  return (
                    <div
                      key={dStr}
                      onClick={() => d ? setCalDiaSel(isSel ? null : dStr) : undefined}
                      className={`border-r border-b border-[var(--color-border)] p-2 min-h-[80px] relative transition-colors ${
                        isSel
                          ? "bg-blue-50"
                          : isHoje
                          ? "bg-amber-50"
                          : d
                          ? "cursor-pointer hover:bg-[var(--color-bg)]"
                          : "bg-[var(--color-bg)] opacity-40"
                      }`}
                    >
                      <p className={`text-xs font-bold mb-1 ${isHoje ? "text-amber-600" : isSel ? "text-blue-600" : "text-[var(--color-text-muted)]"}`}>{dia}</p>
                      {d && (
                        <>
                          {d.ent > 0 && <p className="text-[10px] font-bold text-emerald-600 leading-tight tabular-nums">↑ {fmt(d.ent)}</p>}
                          {d.sai > 0 && <p className="text-[10px] font-bold text-red-500 leading-tight tabular-nums">↓ {fmt(d.sai)}</p>}
                          <span className={`mt-1 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full text-[9px] font-bold ${
                            isHoje ? "bg-amber-500 text-white" : isSel ? "bg-blue-500 text-white" : "bg-[var(--color-border)] text-[var(--color-text-muted)]"
                          }`}>{d.movs.length}</span>
                          <span className={`absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${saldo >= 0 ? "bg-emerald-500" : "bg-red-500"}`} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {calDiaSel && calDados[calDiaSel] && (() => {
                const d = calDados[calDiaSel];
                const dObj = new Date(calDiaSel + "T12:00:00");
                const diaSem = dObj.toLocaleDateString("pt-BR", { weekday: "short" });
                const dataFmt = dObj.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
                return (
                  <div className="border-t border-[var(--color-border)] p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-bold capitalize">{diaSem} {dataFmt} — {d.movs.length} lançamento{d.movs.length > 1 ? "s" : ""}</span>
                      <button onClick={() => setCalDiaSel(null)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] text-base">✕</button>
                    </div>
                    <div className="divide-y divide-[var(--color-border)]">
                      {d.movs.slice(0, 8).map(m => {
                        const nome = getCategoriaNome(m.categoria_id);
                        const icon = getCatIcon(nome);
                        return (
                          <div key={m.id} className="flex items-center gap-2 py-2">
                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0 ${m.tipo === "entrada" ? "bg-emerald-50" : "bg-red-50"}`}>{icon}</div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-[var(--color-text)] truncate">{nome}</p>
                              {m.observacao && <p className="text-[10px] text-[var(--color-text-muted)]">{m.observacao}</p>}
                            </div>
                            <span className={`text-xs font-bold tabular-nums shrink-0 ${m.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                              {m.tipo === "entrada" ? "+" : "–"} {fmt(m.valor)}
                            </span>
                            {!isReadOnly && (
                              <div className="flex gap-1 shrink-0">
                                <button onClick={() => { setViewMode("lista"); editarMov(m); }} className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] text-xs">✏️</button>
                                <button onClick={() => excluirMov(m.id)} className="p-1 rounded hover:bg-red-50 text-[var(--color-text-muted)] text-xs">🗑️</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {d.movs.length > 8 && (
                        <p className="text-xs text-center text-[var(--color-text-muted)] pt-3">{d.movs.length - 8} lançamento{d.movs.length - 8 > 1 ? "s" : ""} adicionais neste dia</p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()
      )}
    </div>
  );
}
