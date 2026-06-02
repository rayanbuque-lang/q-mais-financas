"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";

interface Movimentacao { id: string; tipo: string; data: string; valor: number; categoria_id: string; observacao: string; revisar: boolean; }
interface Cat { id: string; nome: string; }
interface Item { id: string; movimentacao_id: string; valor: number; }
const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function MovimentacoesPage() {
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
  const [valor, setValor] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const [showSomatoria, setShowSomatoria] = useState(false);
  const [itensTemp, setItensTemp] = useState<number[]>([]);
  const [itemInput, setItemInput] = useState("");

  const [detalheId, setDetalheId] = useState<string | null>(null);

  const supabase = createClient();
  const cats = tipo === "entrada" ? catEntrada : catSaida;

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
    const { data: resultado } = await supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).order("data", { ascending: false });
    if (!resultado) return;
    setMovs(resultado as Movimentacao[]);

    // Buscar itens de CADA movimentação
    const mapa: Record<string, Item[]> = {};
    for (const mov of resultado) {
      const { data: itens } = await supabase
        .from("movimentacao_itens")
        .select("id, movimentacao_id, valor")
        .eq("movimentacao_id", mov.id)
        .order("created_at", { ascending: true });
      if (itens && itens.length > 0) {
        mapa[mov.id] = itens as Item[];
      }
    }
    setItensPorMov(mapa);
  }

  useEffect(() => { carregarMovimentacoes(); carregarCategorias(); }, [mes, ano]);

  useEffect(() => {
    if (!showForm) return;
    const c = tipo === "entrada" ? catEntrada : catSaida;
    if (c.length > 0 && !c.find(x => x.id === categoriaId)) setCategoriaId(c[0].id);
  }, [tipo, catEntrada, catSaida, showForm]);

  function resetForm() {
    setTipo("saida"); setData(""); setValor(""); setCategoriaId("");
    setObservacao(""); setEditandoId(null);
    setShowSomatoria(false); setItensTemp([]); setItemInput("");
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
    setEditandoId(m.id);
    setShowForm(true);

    // Carregar itens existentes
    const itensExistentes = itensPorMov[m.id];
    if (itensExistentes && itensExistentes.length > 0) {
      const valores = itensExistentes.map(i => i.valor);
      setItensTemp(valores);
      setValor(valores.reduce((a, b) => a + b, 0).toFixed(2).replace(".", ","));
      setShowSomatoria(true);
    } else {
      setItensTemp([]);
      setShowSomatoria(false);
      setValor(m.valor.toFixed(2).replace(".", ","));
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
    setValor(atualizados.reduce((a, b) => a + b, 0).toFixed(2).replace(".", ","));
    setItemInput("");
  }

  function removeItem(index: number) {
    const novos = itensTemp.filter((_, i) => i !== index);
    setItensTemp(novos);
    setValor(novos.length > 0 ? novos.reduce((a, b) => a + b, 0).toFixed(2).replace(".", ",") : "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMensagem("");

    const valorNum = itensTemp.length > 0
      ? itensTemp.reduce((a, b) => a + b, 0)
      : parseFloat(valor.replace(",", "."));

    if (isNaN(valorNum) || valorNum <= 0) {
      setMensagem("Informe um valor válido.");
      setLoading(false);
      setTimeout(() => setMensagem(""), 3000);
      return;
    }

    const dados = { tipo, data, valor: valorNum, categoria_id: categoriaId, observacao, forma_pagamento: null, revisar: false };
    let movId = editandoId;
    let error;

    if (editandoId) {
      const { error: err } = await supabase.from("movimentacoes").update(dados).eq("id", editandoId);
      error = err;
      movId = editandoId;
    } else {
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

  const movsFiltrados = movs.filter(m => {
    if (!busca) return true;
    const termo = busca.toLowerCase();
    const nome = getCategoriaNome(m.categoria_id).toLowerCase();
    const valorStr = m.valor.toFixed(2);
    const dataFmt = new Date(m.data + "T12:00:00").toLocaleDateString("pt-BR");
    const obs = (m.observacao || "").toLowerCase();
    return nome.includes(termo) || valorStr.includes(termo) || dataFmt.includes(termo) || obs.includes(termo) || m.data.includes(termo);
  });

  const entradas = movsFiltrados.filter(m => m.tipo === "entrada");
  const saidas = movsFiltrados.filter(m => m.tipo === "saida");
  const totalEntradas = entradas.reduce((a, m) => a + m.valor, 0);
  const totalSaidas = saidas.reduce((a, m) => a + m.valor, 0);
  const saldo = totalEntradas - totalSaidas;
  const totalSomatoria = itensTemp.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Movimentações</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Registre entradas e saídas</p>
        </div>
        <button onClick={novoLancamento} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
          + Nova Movimentação
        </button>
      </div>

      {/* Mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold capitalize">{mesesNomes[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Busca */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <div className="relative">
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#9ca3af" }}>🔍</span>
          <input type="text" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por categoria, valor, data, observação..."
            className="w-full pl-10 pr-10 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
          {busca && <button onClick={() => setBusca("")} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#9ca3af" }}>✕</button>}
        </div>
        {busca && <p className="text-xs text-[var(--color-text-muted)] mt-2">{movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? "s" : ""}</p>}
      </div>

      {/* Cards */}
      <div className="grid grid-cols-3 gap-3">
        {[{ l: "Entradas", v: fmt(totalEntradas), c: "text-emerald-600" }, { l: "Saídas", v: fmt(totalSaidas), c: "text-red-500" }, { l: "Saldo", v: fmt(saldo), c: saldo >= 0 ? "text-emerald-600" : "text-red-500" }].map(c => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* Totais por categoria */}
      {entradas.length > 0 && (() => {
        const fpTotals: Record<string, number> = {};
        entradas.forEach(m => { const n = getCategoriaNome(m.categoria_id); fpTotals[n] = (fpTotals[n] || 0) + m.valor; });
        const ativos = Object.entries(fpTotals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        if (ativos.length === 0) return null;
        return (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
            <p className="text-sm font-bold mb-3">Entradas por Categoria</p>
            <div className="flex flex-wrap gap-3">
              {ativos.map(([nome, val]) => (
                <div key={nome} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                  <span>{getCatIcon(nome)}</span>
                  <span className="text-xs font-medium">{nome}</span>
                  <span className="text-xs font-bold text-emerald-600">{fmt(val)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

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
              <input value={valor} onChange={e => setValor(e.target.value)} placeholder="0,00" required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
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
              <input value={observacao} onChange={e => setObservacao(e.target.value)} placeholder="Ex: Venda balcão" className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
            </div>

            <button type="submit" disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
              {loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}
            </button>
          </form>
        </div>
      )}

      {/* Lista */}
      {movsFiltrados.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
          {busca ? `Nenhum resultado para "${busca}"` : `Nenhuma movimentação em ${mesesNomes[mes]}/${ano}.`}
        </div>
      ) : (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          {movsFiltrados.map(m => {
            const nome = getCategoriaNome(m.categoria_id);
            const icon = getCatIcon(nome);
            const itens = itensPorMov[m.id];
            const temItens = itens && itens.length > 0;
            const isDetalhe = detalheId === m.id;
            return (
              <div key={m.id}>
                {/* Linha principal - clicável se tem itens */}
                <div
                  className={`p-4 flex items-center justify-between transition-colors border-b border-[var(--color-border)] ${temItens ? "cursor-pointer hover:bg-blue-50" : "hover:bg-[var(--color-bg)]"}`}
                  onClick={() => { if (temItens) setDetalheId(isDetalhe ? null : m.id); }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${m.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                      {icon}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{nome}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {new Date(m.data + "T12:00:00").toLocaleDateString("pt-BR")}
                        {m.observacao && ` · ${m.observacao}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`font-bold text-sm ${m.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                      {m.tipo === "entrada" ? "+" : "-"} {fmt(m.valor)}
                    </span>
                    {temItens && (
                      <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-lg">
                        📐 {itens!.length} valores {isDetalhe ? "▲" : "▼"}
                      </span>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); editarMov(m); }} className="p-1.5 rounded-lg hover:bg-blue-100 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                    <button onClick={(e) => { e.stopPropagation(); excluirMov(m.id); }} className="p-1.5 rounded-lg hover:bg-red-100 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                  </div>
                </div>

                {/* Detalhe dos itens */}
                {isDetalhe && temItens && (
                  <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
                    <p className="text-xs font-bold text-blue-700 mb-2">📐 Valores individuais que formaram o total:</p>
                    <div className="flex flex-wrap gap-2">
                      {itens!.map((item, i) => (
                        <span key={item.id} className="inline-flex items-center px-2.5 py-1 bg-white border border-blue-200 rounded-lg text-xs font-medium text-blue-700">
                          {i + 1}ª: {fmt(item.valor)}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center justify-between pt-2 mt-2 border-t border-blue-200">
                      <span className="text-xs font-bold text-blue-800">{itens!.length} valores somados</span>
                      <span className="text-sm font-bold text-blue-800">Total: {fmt(itens!.reduce((a, b) => a + b.valor, 0))}</span>
                    </div>
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
