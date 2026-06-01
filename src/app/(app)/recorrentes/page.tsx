"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";

interface Recorrente {
  id: string;
  descricao: string;
  valor: number;
  tipo: string;
  categoria_id: string;
  dia_vencimento: number;
  frequencia: string;
  data_inicio: string;
  data_fim: string | null;
  total_parcelas: number | null;
  parcelas_geradas: number;
  observacao: string | null;
  ativo: boolean;
  categoria_nome?: string;
}

interface Categoria { id: string; nome: string; }

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const freqLabels: Record<string, string> = { mensal: "Mensal", quinzenal: "Quinzenal", semanal: "Semanal" };

export default function RecorrentesPage() {
  const [recorrentes, setRecorrentes] = useState<Recorrente[]>([]);
  const [categoriasEntrada, setCategoriasEntrada] = useState<Categoria[]>([]);
  const [categoriasSaida, setCategoriasSaida] = useState<Categoria[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");

  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");
  const [tipo, setTipo] = useState<"entrada" | "saida">("saida");
  const [categoriaId, setCategoriaId] = useState("");
  const [diaVencimento, setDiaVencimento] = useState("1");
  const [frequencia, setFrequencia] = useState<"mensal" | "quinzenal" | "semanal">("mensal");
  const [dataInicio, setDataInicio] = useState(new Date().toISOString().split("T")[0]);
  const [dataFim, setDataFim] = useState("");
  const [totalParcelas, setTotalParcelas] = useState("");
  const [observacao, setObservacao] = useState("");
  const [criarComo, setCriarComo] = useState<"movimentacao" | "conta_pagar">("movimentacao");

  const supabase = createClient();
  const categorias = tipo === "entrada" ? categoriasEntrada : categoriasSaida;

  async function carregarDados() {
    const [r1, r2, r3] = await Promise.all([
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true).order("nome"),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true).order("nome"),
      supabase.from("lancamentos_recorrentes").select("*").order("created_at", { ascending: false }),
    ]);
    if (r1.data) setCategoriasEntrada(r1.data);
    if (r2.data) setCategoriasSaida(r2.data);
    if (r3.data) {
      const todosCat = [...(r1.data || []), ...(r2.data || [])];
      setRecorrentes(r3.data.map((r) => ({
        ...r,
        categoria_nome: todosCat.find((c) => c.id === r.categoria_id)?.nome || "Sem categoria",
      })));
    }
  }

  useEffect(() => { carregarDados(); }, []);

  useEffect(() => {
    const cats = tipo === "entrada" ? categoriasEntrada : categoriasSaida;
    if (cats.length > 0 && !cats.find(c => c.id === categoriaId)) setCategoriaId(cats[0].id);
  }, [tipo, categoriasEntrada, categoriasSaida]);

  function resetarForm() {
    setDescricao(""); setValor(""); setTipo("saida");
    setDiaVencimento("1"); setFrequencia("mensal");
    setDataInicio(new Date().toISOString().split("T")[0]);
    setDataFim(""); setTotalParcelas(""); setObservacao("");
    setEditandoId(null); setCriarComo("movimentacao");
  }

  function abrirNovo() {
    resetarForm();
    const cats = tipo === "saida" ? categoriasSaida : categoriasEntrada;
    if (cats.length > 0) setCategoriaId(cats[0].id);
    setShowForm(true);
  }

  function abrirEditar(r: Recorrente) {
    setDescricao(r.descricao); setValor(r.valor.toString().replace(".", ","));
    setTipo(r.tipo as "entrada" | "saida"); setCategoriaId(r.categoria_id);
    setDiaVencimento(String(r.dia_vencimento || 1));
    setFrequencia(r.frequencia as typeof frequencia);
    setDataInicio(r.data_inicio); setDataFim(r.data_fim || "");
    setTotalParcelas(r.total_parcelas ? String(r.total_parcelas) : "");
    setObservacao(r.observacao || "");
    setEditandoId(r.id); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function gerarTodasInstancias(recId: string, desc: string, val: number, tp: string, catId: string, diaVenc: number, freq: string, inicio: string, fim: string | null, parc: number | null) {
    const ehConta = criarComo === "conta_pagar";
    const dataInicioDate = new Date(inicio + "T12:00:00");
    const dataFimDate = fim ? new Date(fim + "T12:00:00") : new Date(dataInicioDate.getFullYear() + 2, 11, 31);
    let geradas = 0;
    const max = parc || 999;

    if (freq === "mensal") {
      let cur = new Date(dataInicioDate.getFullYear(), dataInicioDate.getMonth(), 1);
      while (cur <= dataFimDate && geradas < max) {
        const y = cur.getFullYear(), m = cur.getMonth();
        const ultimoDia = new Date(y, m + 1, 0).getDate();
        const dia = Math.min(diaVenc, ultimoDia);
        const dv = `${y}-${String(m + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;

        if (ehConta) {
          const { data: ex } = await supabase.from("contas_pagar").select("id").eq("recorrente_id", recId).gte("data_vencimento", `${y}-${String(m + 1).padStart(2, "0")}-01`).lte("data_vencimento", `${y}-${String(m + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`).limit(1);
          if (!ex || ex.length === 0) {
            await supabase.from("contas_pagar").insert({ fornecedor: desc, descricao: "Recorrente mensal", valor: val, data_vencimento: dv, status: "pendente", categoria_id: catId, observacao: "Gerado automaticamente", recorrente_id: recId });
            geradas++;
          }
        } else {
          const { data: ex } = await supabase.from("movimentacoes").select("id").eq("recorrente_id", recId).gte("data", `${y}-${String(m + 1).padStart(2, "0")}-01`).lte("data", `${y}-${String(m + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`).limit(1);
          if (!ex || ex.length === 0) {
            await supabase.from("movimentacoes").insert({ tipo: tp, data: dv, valor: val, categoria_id: catId, observacao: `Recorrente: ${desc}`, revisar: false, recorrente_id: recId });
            geradas++;
          }
        }
        cur = new Date(y, m + 1, 1);
      }
    } else if (freq === "quinzenal") {
      let cur = new Date(dataInicioDate);
      while (cur <= dataFimDate && geradas < max) {
        const dv = cur.toISOString().split("T")[0];
        if (ehConta) {
          const { data: ex } = await supabase.from("contas_pagar").select("id").eq("recorrente_id", recId).eq("data_vencimento", dv).limit(1);
          if (!ex || ex.length === 0) { await supabase.from("contas_pagar").insert({ fornecedor: desc, descricao: "Recorrente quinzenal", valor: val, data_vencimento: dv, status: "pendente", categoria_id: catId, observacao: "Gerado automaticamente", recorrente_id: recId }); geradas++; }
        } else {
          const { data: ex } = await supabase.from("movimentacoes").select("id").eq("recorrente_id", recId).eq("data", dv).limit(1);
          if (!ex || ex.length === 0) { await supabase.from("movimentacoes").insert({ tipo: tp, data: dv, valor: val, categoria_id: catId, observacao: `Recorrente: ${desc}`, revisar: false, recorrente_id: recId }); geradas++; }
        }
        cur.setDate(cur.getDate() + 15);
      }
    } else {
      let cur = new Date(dataInicioDate);
      while (cur <= dataFimDate && geradas < max) {
        const dv = cur.toISOString().split("T")[0];
        if (ehConta) {
          const { data: ex } = await supabase.from("contas_pagar").select("id").eq("recorrente_id", recId).eq("data_vencimento", dv).limit(1);
          if (!ex || ex.length === 0) { await supabase.from("contas_pagar").insert({ fornecedor: desc, descricao: "Recorrente semanal", valor: val, data_vencimento: dv, status: "pendente", categoria_id: catId, observacao: "Gerado automaticamente", recorrente_id: recId }); geradas++; }
        } else {
          const { data: ex } = await supabase.from("movimentacoes").select("id").eq("recorrente_id", recId).eq("data", dv).limit(1);
          if (!ex || ex.length === 0) { await supabase.from("movimentacoes").insert({ tipo: tp, data: dv, valor: val, categoria_id: catId, observacao: `Recorrente: ${desc}`, revisar: false, recorrente_id: recId }); geradas++; }
        }
        cur.setDate(cur.getDate() + 7);
      }
    }

    await supabase.from("lancamentos_recorrentes").update({ parcelas_geradas: geradas }).eq("id", recId);
    return geradas;
  }

  async function deletarRecorrenteEInstancias(r: Recorrente) {
    // Deletar contas a pagar vinculadas
    const { data: contas } = await supabase.from("contas_pagar").select("id").eq("recorrente_id", r.id);
    if (contas && contas.length > 0) {
      await supabase.from("contas_pagar").delete().eq("recorrente_id", r.id);
    }

    // Deletar movimentações vinculadas
    const { data: movs } = await supabase.from("movimentacoes").select("id").eq("recorrente_id", r.id);
    if (movs && movs.length > 0) {
      await supabase.from("movimentacoes").delete().eq("recorrente_id", r.id);
    }

    // Deletar o recorrente
    await supabase.from("lancamentos_recorrentes").delete().eq("id", r.id);

    return (contas?.length || 0) + (movs?.length || 0);
  }

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMensagem("");
    const val = parseFloat(valor.replace(",", "."));

    const dados = {
      descricao, valor: val, tipo: criarComo === "conta_pagar" ? "saida" : tipo,
      categoria_id: categoriaId, dia_vencimento: parseInt(diaVencimento),
      frequencia, data_inicio: dataInicio, data_fim: dataFim || null,
      total_parcelas: totalParcelas ? parseInt(totalParcelas) : null,
      observacao, ativo: true,
    };

    let recId = editandoId;
    let error;

    if (editandoId) {
      const r = await supabase.from("lancamentos_recorrentes").update(dados).eq("id", editandoId);
      error = r.error;
    } else {
      const r = await supabase.from("lancamentos_recorrentes").insert(dados).select("id").single();
      error = r.error;
      if (r.data) recId = r.data.id;
    }

    if (error) {
      setMensagem("Erro ao salvar.");
    } else {
      if (!editandoId && recId) {
        const geradas = await gerarTodasInstancias(
          recId, descricao, val, criarComo === "conta_pagar" ? "saida" : tipo,
          categoriaId, parseInt(diaVencimento), frequencia,
          dataInicio, dataFim || null, totalParcelas ? parseInt(totalParcelas) : null
        );
        setMensagem(`Criado! ${geradas} instância${geradas !== 1 ? "s" : ""} gerada${geradas !== 1 ? "s" : ""}.`);
        await registrarLog({ acao: "criou", tabela: "lancamentos_recorrentes", registroId: recId, detalhes: `${descricao} - R$ ${val.toFixed(2)} - ${geradas} instâncias` });
      } else {
        setMensagem("Atualizado!");
        await registrarLog({ acao: "editou", tabela: "lancamentos_recorrentes", registroId: recId || undefined });
      }
      resetarForm(); setShowForm(false); carregarDados();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 5000);
  }

  async function handleExcluir(r: Recorrente) {
    if (!confirm(`Excluir "${r.descricao}" e TODAS as instâncias geradas?`)) return;
    setLoading(true);
    const deletadas = await deletarRecorrenteEInstancias(r);
    await registrarLog({ acao: "excluiu", tabela: "lancamentos_recorrentes", registroId: r.id, detalhes: `${r.descricao} + ${deletadas} instâncias` });
    setMensagem(`"${r.descricao}" e ${deletadas} instâncias excluídos!`);
    carregarDados();
    setLoading(false); setTimeout(() => setMensagem(""), 4000);
  }

  async function toggleAtivo(r: Recorrente) {
    await supabase.from("lancamentos_recorrentes").update({ ativo: !r.ativo }).eq("id", r.id);
    setMensagem(r.ativo ? "Desativado!" : "Ativado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function gerarFaltantes(r: Recorrente) {
    setLoading(true);
    const geradas = await gerarTodasInstancias(
      r.id, r.descricao, r.valor, r.tipo, r.categoria_id,
      r.dia_vencimento || 1, r.frequencia, r.data_inicio,
      r.data_fim || null, r.total_parcelas
    );
    setMensagem(geradas > 0 ? `${geradas} instâncias novas geradas!` : "Nenhuma nova necessária.");
    setLoading(false); carregarDados(); setTimeout(() => setMensagem(""), 4000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  const totalEntradas = recorrentes.filter((r) => r.ativo && r.tipo === "entrada").reduce((a, r) => a + r.valor, 0);
  const totalSaidas = recorrentes.filter((r) => r.ativo && r.tipo === "saida").reduce((a, r) => a + r.valor, 0);
  const ativos = recorrentes.filter((r) => r.ativo).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lançamentos Recorrentes</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Cadastre uma vez, gera todos os meses</p>
        </div>
        <button onClick={abrirNovo} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
          + Novo Recorrente
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Entradas Fixas", v: fmt(totalEntradas), c: "text-emerald-600" },
          { l: "Saídas Fixas", v: fmt(totalSaidas), c: "text-red-500" },
          { l: "Ativos", v: `${ativos}`, c: "text-blue-600" },
          { l: "Instâncias", v: `${recorrentes.reduce((a, r) => a + r.parcelas_geradas, 0)}`, c: "text-purple-600" },
        ].map((c) => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      <div className="bg-purple-50 border border-purple-200 rounded-2xl p-4 flex items-start gap-3">
        <span className="text-xl">💡</span>
        <div>
          <p className="text-sm font-semibold text-purple-800">Como funciona</p>
          <p className="text-xs text-purple-700 mt-1">
            Ao criar, gera <strong>todas as instâncias</strong> de uma vez. Cada instância é independente — pode editar valores. Ao <strong>excluir</strong>, todas as instâncias são apagadas automaticamente de Contas a Pagar, Movimentações e DRE.
          </p>
        </div>
      </div>

      {/* Formulário */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Novo"} Lançamento Recorrente</h2>
            <button onClick={() => { setShowForm(false); resetarForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleSalvar} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Tipo de lançamento</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button type="button" onClick={() => setCriarComo("movimentacao")} className={`p-4 rounded-xl border-2 text-left transition-all ${criarComo === "movimentacao" ? "border-blue-500 bg-blue-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-2 mb-1"><span>💰</span><span className="font-bold text-sm">Movimentação</span></div>
                  <p className="text-xs text-[var(--color-text-muted)]">Entra direto no DRE.</p>
                </button>
                <button type="button" onClick={() => { setCriarComo("conta_pagar"); setTipo("saida"); }} className={`p-4 rounded-xl border-2 text-left transition-all ${criarComo === "conta_pagar" ? "border-amber-500 bg-amber-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-2 mb-1"><span>📋</span><span className="font-bold text-sm">Conta a Pagar</span></div>
                  <p className="text-xs text-[var(--color-text-muted)]">Cria como boleto pendente.</p>
                </button>
              </div>
            </div>

            {criarComo === "movimentacao" && (
              <div className="flex gap-3">
                <button type="button" onClick={() => setTipo("entrada")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "entrada" ? "bg-emerald-600 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▲ Entrada</button>
                <button type="button" onClick={() => setTipo("saida")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "saida" ? "bg-red-500 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▼ Saída</button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">{criarComo === "conta_pagar" ? "Fornecedor" : "Descrição"}</label>
                <input type="text" value={descricao} onChange={(e) => setDescricao(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor (R$)</label>
                <input type="text" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Categoria</label>
                <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">
                  {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Frequência</label>
                <select value={frequencia} onChange={(e) => setFrequencia(e.target.value as typeof frequencia)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">
                  <option value="semanal">Semanal</option>
                  <option value="quinzenal">Quinzenal</option>
                  <option value="mensal">Mensal</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Dia do vencimento</label>
                <select value={diaVencimento} onChange={(e) => setDiaVencimento(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Dia {d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data início</label>
                <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Parcelas (opcional)</label>
                <input type="number" value={totalParcelas} onChange={(e) => setTotalParcelas(e.target.value)} placeholder="Ex: 12" min="1" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data fim (opcional)</label>
                <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label>
                <input type="text" value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Informação adicional" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarForm(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
                {loading ? "Salvando e gerando..." : editandoId ? "Atualizar" : "Salvar e Gerar"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      {recorrentes.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Nenhum lançamento recorrente.</div>
      ) : (
        <div className="space-y-3">
          {recorrentes.map((r) => (
            <div key={r.id} className={`bg-[var(--color-surface)] border rounded-2xl p-4 ${r.ativo ? "border-[var(--color-border)]" : "border-gray-200 opacity-50"}`}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${r.tipo === "saida" ? "bg-red-50 text-red-500" : "bg-emerald-50 text-emerald-600"}`}>
                    {r.tipo === "entrada" ? "▲" : "▼"}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold truncate">{r.descricao}</p>
                      {!r.ativo && <span className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-[10px] font-bold">INATIVO</span>}
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">{r.parcelas_geradas} instâncias</span>
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {r.categoria_nome} · {freqLabels[r.frequencia]} · Dia {r.dia_vencimento}
                      {r.total_parcelas ? ` · ${r.total_parcelas} parcelas` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`font-bold text-sm ${r.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                    {fmt(r.valor)}
                  </span>
                  <div className="flex gap-1">
                    <button onClick={() => gerarFaltantes(r)} title="Gerar meses faltantes" className="p-1.5 rounded-lg hover:bg-purple-50 text-[var(--color-text-muted)] hover:text-purple-600 transition text-sm">🔄</button>
                    <button onClick={() => abrirEditar(r)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                    <button onClick={() => toggleAtivo(r)} className={`p-1.5 rounded-lg transition text-sm ${r.ativo ? "hover:bg-amber-50 text-[var(--color-text-muted)] hover:text-amber-600" : "hover:bg-emerald-50 text-[var(--color-text-muted)] hover:text-emerald-600"}`}>{r.ativo ? "⏸" : "▶"}</button>
                    <button onClick={() => handleExcluir(r)} className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
