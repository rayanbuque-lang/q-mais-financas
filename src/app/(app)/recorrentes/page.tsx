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

export default function RecorrentesPage() {
  const [recorrentes, setRecorrentes] = useState<Recorrente[]>([]);
  const [categoriasEntrada, setCategoriasEntrada] = useState<Categoria[]>([]);
  const [categoriasSaida, setCategoriasSaida] = useState<Categoria[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [gerando, setGerando] = useState(false);

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

  const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
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

  useEffect(() => {
    carregarDados().then(() => {
      gerarAutomatico();
    });
  }, []);

  async function gerarAutomatico() {
    const supabaseAuto = createClient();
    const hoje = new Date();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    const mesesNomesAuto = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

    const { data: ativos } = await supabaseAuto
      .from("lancamentos_recorrentes")
      .select("*")
      .eq("ativo", true);

    if (!ativos || ativos.length === 0) return;

    const inicio = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-01`;
    const ultimoDia = new Date(anoAtual, mesAtual + 1, 0).getDate();
    const fim = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    let geradas = 0;

    for (const r of ativos) {
      const ehContaPagar = r.observacao?.includes("[CONTA_PAGAR]");

      // Verificar se já existe
      if (ehContaPagar) {
        const { data: existente } = await supabaseAuto
          .from("contas_pagar").select("id")
          .eq("fornecedor", r.descricao)
          .eq("valor", r.valor)
          .gte("data_vencimento", inicio)
          .lte("data_vencimento", fim)
          .limit(1);
        if (existente && existente.length > 0) continue;
      } else {
        const { data: existente } = await supabaseAuto
          .from("movimentacoes").select("id")
          .eq("tipo", r.tipo).eq("valor", r.valor).eq("categoria_id", r.categoria_id)
          .gte("data", inicio).lte("data", fim).limit(1);
        if (existente && existente.length > 0) continue;
      }

      // Verificar período
      const dataInicioR = new Date(r.data_inicio + "T12:00:00");
      const dataVenc = new Date(anoAtual, mesAtual, r.dia_vencimento || 1);
      if (dataVenc < dataInicioR) continue;
      if (r.data_fim && dataVenc > new Date(r.data_fim + "T12:00:00")) continue;
      if (r.total_parcelas && r.parcelas_geradas >= r.total_parcelas) continue;

      const dia = Math.min(r.dia_vencimento || 1, ultimoDia);
      const dataMov = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      const obsLimpa = (r.observacao || "").replace("[CONTA_PAGAR] ", "").replace("[CONTA_PAGAR]", "");

      if (ehContaPagar) {
        const { error } = await supabaseAuto.from("contas_pagar").insert({
          fornecedor: r.descricao,
          descricao: obsLimpa || `Recorrente`,
          valor: r.valor,
          data_vencimento: dataMov,
          status: "pendente",
          categoria_id: r.categoria_id,
          observacao: `Gerado automaticamente - Recorrente`,
        });
        if (!error) {
          geradas++;
          await supabaseAuto.from("lancamentos_recorrentes").update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 }).eq("id", r.id);
        }
      } else {
        const { error } = await supabaseAuto.from("movimentacoes").insert({
          tipo: r.tipo, data: dataMov, valor: r.valor, categoria_id: r.categoria_id,
          observacao: `Recorrente: ${r.descricao}${obsLimpa ? ` · ${obsLimpa}` : ""}`, revisar: false,
        });
        if (!error) {
          geradas++;
          await supabaseAuto.from("lancamentos_recorrentes").update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 }).eq("id", r.id);
        }
      }
    }

    if (geradas > 0) {
      carregarDados();
    }
  }

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

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMensagem("");
    const dados = {
      descricao, valor: parseFloat(valor.replace(",", ".")), tipo, categoria_id: categoriaId,
      dia_vencimento: parseInt(diaVencimento), frequencia, data_inicio: dataInicio,
      data_fim: dataFim || null, total_parcelas: totalParcelas ? parseInt(totalParcelas) : null,
      observacao: `${criarComo === "conta_pagar" ? "[CONTA_PAGAR] " : ""}${observacao}`, ativo: true,
    };

    let error;
    if (editandoId) {
      const r = await supabase.from("lancamentos_recorrentes").update(dados).eq("id", editandoId);
      error = r.error;
    } else {
      const r = await supabase.from("lancamentos_recorrentes").insert(dados);
      error = r.error;
    }

    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem(editandoId ? "Atualizado!" : "Cadastrado!");
      await registrarLog({ acao: editandoId ? "editou" : "criou", tabela: "lancamentos_recorrentes", detalhes: `${descricao} - R$ ${parseFloat(valor.replace(",", ".")).toFixed(2)} (${frequencia})` });

      // Se criou como conta a pagar e NÃO está editando, gerar agora
      if (!editandoId && criarComo === "conta_pagar") {
        const hoje = new Date();
        const mesAtual = hoje.getMonth();
        const anoAtual = hoje.getFullYear();
        const ultimoDia = new Date(anoAtual, mesAtual + 1, 0).getDate();
        const dia = Math.min(parseInt(diaVencimento), ultimoDia);
        const dataVenc = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
        const val = parseFloat(valor.replace(",", "."));

        await supabase.from("contas_pagar").insert({
          fornecedor: descricao,
          descricao: observacao || `Recorrente ${freqLabels[frequencia]}`,
          valor: val,
          data_vencimento: dataVenc,
          status: "pendente",
          categoria_id: categoriaId,
          observacao: `Gerado automaticamente - Recorrente ${freqLabels[frequencia]}`,
        });

        setMensagem(`Conta a pagar criada! Vencimento: ${new Date(dataVenc + "T12:00:00").toLocaleDateString("pt-BR")}`);
      } else if (!editandoId && criarComo === "movimentacao") {
        // Gerar movimentação do mês atual
        const hoje = new Date();
        const mesAtual = hoje.getMonth();
        const anoAtual = hoje.getFullYear();
        const ultimoDia = new Date(anoAtual, mesAtual + 1, 0).getDate();
        const dia = Math.min(parseInt(diaVencimento), ultimoDia);
        const dataMov = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
        const val = parseFloat(valor.replace(",", "."));

        await supabase.from("movimentacoes").insert({
          tipo, data: dataMov, valor: val, categoria_id: categoriaId,
          observacao: `Recorrente: ${descricao}${observacao ? ` · ${observacao}` : ""}`, revisar: false,
        });

        setMensagem(`Movimentação criada para ${mesesNomes[mesAtual]}/${anoAtual}!`);
      }

      resetarForm(); setShowForm(false); carregarDados();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function toggleAtivo(r: Recorrente) {
    await supabase.from("lancamentos_recorrentes").update({ ativo: !r.ativo }).eq("id", r.id);
    setMensagem(r.ativo ? "Desativado!" : "Ativado!");
    carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function handleExcluir(id: string) {
    if (!confirm("Excluir?")) return;
    await registrarLog({ acao: "excluiu", tabela: "lancamentos_recorrentes", registroId: id });
    await supabase.from("lancamentos_recorrentes").delete().eq("id", id);
    setMensagem("Excluído!"); carregarDados(); setTimeout(() => setMensagem(""), 3000);
  }

  async function gerarMovimentacoes() {
    setGerando(true); setMensagem("");
    const hoje = new Date();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
    let geradas = 0;

    const ativos = recorrentes.filter((r) => r.ativo);

    for (const r of ativos) {
      const inicio = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-01`;
      const ultimoDia = new Date(anoAtual, mesAtual + 1, 0).getDate();
      const fim = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

      const ehContaPagar = r.observacao?.includes("[CONTA_PAGAR]");

      // Verificar se já existe
      if (ehContaPagar) {
        const { data: existente } = await supabase
          .from("contas_pagar").select("id")
          .eq("fornecedor", r.descricao)
          .eq("valor", r.valor)
          .gte("data_vencimento", inicio)
          .lte("data_vencimento", fim)
          .limit(1);
        if (existente && existente.length > 0) continue;
      } else {
        const { data: existente } = await supabase
          .from("movimentacoes").select("id")
          .eq("tipo", r.tipo).eq("valor", r.valor).eq("categoria_id", r.categoria_id)
          .gte("data", inicio).lte("data", fim).limit(1);
        if (existente && existente.length > 0) continue;
      }

      // Verificar período
      const dataInicioR = new Date(r.data_inicio + "T12:00:00");
      const dataVenc = new Date(anoAtual, mesAtual, r.dia_vencimento || 1);
      if (dataVenc < dataInicioR) continue;
      if (r.data_fim && dataVenc > new Date(r.data_fim + "T12:00:00")) continue;
      if (r.total_parcelas && r.parcelas_geradas >= r.total_parcelas) continue;

      const dia = Math.min(r.dia_vencimento || 1, ultimoDia);
      const dataMov = `${anoAtual}-${String(mesAtual + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      const obsLimpa = (r.observacao || "").replace("[CONTA_PAGAR] ", "").replace("[CONTA_PAGAR]", "");

      if (ehContaPagar) {
        // Gerar como conta a pagar
        const { error } = await supabase.from("contas_pagar").insert({
          fornecedor: r.descricao,
          descricao: obsLimpa || `Recorrente ${freqLabels[r.frequencia]}`,
          valor: r.valor,
          data_vencimento: dataMov,
          status: "pendente",
          categoria_id: r.categoria_id,
          observacao: `Gerado automaticamente - ${freqLabels[r.frequencia]}`,
        });
        if (!error) {
          geradas++;
          await supabase.from("lancamentos_recorrentes").update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 }).eq("id", r.id);
          await registrarLog({ acao: "criou", tabela: "contas_pagar", detalhes: `Recorrente: ${r.descricao} - ${fmt(r.valor)} (${mesesNomes[mesAtual]})` });
        }
      } else {
        // Gerar como movimentação
        const { error } = await supabase.from("movimentacoes").insert({
          tipo: r.tipo, data: dataMov, valor: r.valor, categoria_id: r.categoria_id,
          observacao: `Recorrente: ${r.descricao}${obsLimpa ? ` · ${obsLimpa}` : ""}`, revisar: false,
        });
        if (!error) {
          geradas++;
          await supabase.from("lancamentos_recorrentes").update({ parcelas_geradas: (r.parcelas_geradas || 0) + 1 }).eq("id", r.id);
          await registrarLog({ acao: "criou", tabela: "movimentacoes", detalhes: `Recorrente: ${r.descricao} - ${fmt(r.valor)}` });
        }
      }
    }

    if (geradas > 0) {
      setMensagem(`${geradas} ${geradas === 1 ? "item gerado" : "itens gerados"} com sucesso!`);
      carregarDados();
    } else {
      setMensagem("Nenhum item novo para gerar. Todos já existem ou estão fora do período.");
    }
    setGerando(false); setTimeout(() => setMensagem(""), 5000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  const freqLabels: Record<string, string> = { mensal: "Mensal", quinzenal: "Quinzenal", semanal: "Semanal" };

  const totalEntradas = recorrentes.filter((r) => r.ativo && r.tipo === "entrada").reduce((a, r) => a + r.valor, 0);
  const totalSaidas = recorrentes.filter((r) => r.ativo && r.tipo === "saida").reduce((a, r) => a + r.valor, 0);
  const ativos = recorrentes.filter((r) => r.ativo).length;
  const contasAPagar = recorrentes.filter((r) => r.ativo && r.observacao?.includes("[CONTA_PAGAR]")).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lançamentos Recorrentes</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Cadastre uma vez e gere automaticamente</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={gerarMovimentacoes} disabled={gerando} className="px-4 py-3 bg-gradient-to-r from-purple-600 to-purple-500 text-white font-semibold rounded-xl hover:from-purple-700 hover:to-purple-600 transition-all text-sm shadow-md shadow-purple-200 disabled:opacity-50">
            {gerando ? "Gerando..." : "⚡ Gerar Tudo do Mês"}
          </button>
          <button onClick={abrirNovo} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
            + Novo Recorrente
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Entradas Fixas", v: fmt(totalEntradas), c: "text-emerald-600" },
          { l: "Saídas Fixas", v: fmt(totalSaidas), c: "text-red-500" },
          { l: "Ativos", v: `${ativos}`, c: "text-blue-600" },
          { l: "Contas a Pagar", v: `${contasAPagar}`, c: "text-amber-600" },
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
            Cadastre seus gastos e receitas fixas. Ao gerar, o sistema cria: <strong>Movimentações</strong> (entram direto no DRE) ou <strong>Contas a Pagar</strong> (ficam pendentes para você dar baixa). Se já existir no mês, não duplica. Você pode editar o valor a qualquer momento (exceto em meses fechados, onde apenas administradores podem alterar).
          </p>
        </div>
      </div>

      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Novo"} Lançamento Recorrente</h2>
            <button onClick={() => { setShowForm(false); resetarForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleSalvar} className="space-y-4">
            {/* Criar como */}
            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Tipo de lançamento</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button type="button" onClick={() => setCriarComo("movimentacao")} className={`p-4 rounded-xl border-2 text-left transition-all ${criarComo === "movimentacao" ? "border-blue-500 bg-blue-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-2 mb-1"><span>💰</span><span className="font-bold text-sm">Movimentação</span></div>
                  <p className="text-xs text-[var(--color-text-muted)]">Entra direto no DRE como entrada ou saída do mês.</p>
                </button>
                <button type="button" onClick={() => { setCriarComo("conta_pagar"); setTipo("saida"); }} className={`p-4 rounded-xl border-2 text-left transition-all ${criarComo === "conta_pagar" ? "border-amber-500 bg-amber-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-2 mb-1"><span>📋</span><span className="font-bold text-sm">Conta a Pagar</span></div>
                  <p className="text-xs text-[var(--color-text-muted)]">Cria como boleto pendente. Você dá baixa quando pagar.</p>
                </button>
              </div>
            </div>

            {/* Tipo (só para movimentação) */}
            {criarComo === "movimentacao" && (
              <div className="flex gap-3">
                <button type="button" onClick={() => setTipo("entrada")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "entrada" ? "bg-emerald-600 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▲ Entrada</button>
                <button type="button" onClick={() => setTipo("saida")} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo === "saida" ? "bg-red-500 text-white shadow-md" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▼ Saída</button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">{criarComo === "conta_pagar" ? "Fornecedor" : "Descrição"}</label>
                <input type="text" value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder={criarComo === "conta_pagar" ? "Ex: Aluguel, Energia" : "Ex: Recebimento fixo"} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
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

            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label>
              <input type="text" value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Informação adicional" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarForm(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
                {loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}
              </button>
            </div>
          </form>
        </div>
      )}

      {recorrentes.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
          Nenhum lançamento recorrente.
        </div>
      ) : (
        <div className="space-y-3">
          {recorrentes.map((r) => {
            const ehConta = r.observacao?.includes("[CONTA_PAGAR]");
            return (
              <div key={r.id} className={`bg-[var(--color-surface)] border rounded-2xl p-4 ${r.ativo ? "border-[var(--color-border)]" : "border-gray-200 opacity-50"}`}>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${ehConta ? "bg-amber-50 text-amber-600" : r.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                      {ehConta ? "📋" : r.tipo === "entrada" ? "▲" : "▼"}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold truncate">{r.descricao}</p>
                        {ehConta && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold">CONTA A PAGAR</span>}
                        {!r.ativo && <span className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-[10px] font-bold">INATIVO</span>}
                        {r.total_parcelas && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">{r.parcelas_geradas}/{r.total_parcelas}</span>}
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {r.categoria_nome} · {freqLabels[r.frequencia]} · Dia {r.dia_vencimento}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`font-bold text-sm ${ehConta ? "text-amber-600" : r.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                      {ehConta ? "" : r.tipo === "entrada" ? "+" : "-"} {fmt(r.valor)}
                    </span>
                    <div className="flex gap-1">
                      <button onClick={() => abrirEditar(r)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                      <button onClick={() => toggleAtivo(r)} className={`p-1.5 rounded-lg transition text-sm ${r.ativo ? "hover:bg-amber-50 text-[var(--color-text-muted)] hover:text-amber-600" : "hover:bg-emerald-50 text-[var(--color-text-muted)] hover:text-emerald-600"}`}>{r.ativo ? "⏸" : "▶"}</button>
                      <button onClick={() => handleExcluir(r.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
