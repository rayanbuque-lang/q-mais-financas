"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import EmptyState from "@/components/empty-state";
import { useRole } from "@/lib/role-context";

interface Conciliacao {
  id: string;
  banco: string;
  mes: number;
  ano: number;
  saldo_extrato: number;
  saldo_sistema: number;
  diferenca: number;
  status: string;
  observacao: string | null;
  conciliado_em: string | null;
}

interface MovResumo {
  entradas: number;
  saidas: number;
  saldo: number;
  quantidade: number;
  detalhes: { id: string; data: string; tipo: string; valor: number; observacao: string; categoria: string }[];
}

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function ConciliacaoPage() {
  const { isReadOnly } = useRole();
  const [conciliacoes, setConciliacoes] = useState<Conciliacao[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [ano, setAno] = useState(new Date().getFullYear());

  // Form
  const [banco, setBanco] = useState("");
  const [bancoCustom, setBancoCustom] = useState("");
  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [saldoExtrato, setSaldoExtrato] = useState("");
  const [observacao, setObservacao] = useState("");

  // Dados do sistema
  const [resumo, setResumo] = useState<MovResumo>({ entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] });

  // Expandir
  const [expandidoId, setExpandidoId] = useState<string | null>(null);
  const [detalhesExpandido, setDetalhesExpandido] = useState<MovResumo>({ entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] });
  const [detalhesLoading, setDetalhesLoading] = useState(false);

  // Bancos encontrados nas movimentações
  const [bancosDisponiveis, setBancosDisponiveis] = useState<string[]>([]);

  const supabase = createClient();

  async function carregarConciliacoes() {
    setLoading(true);
    const { data } = await supabase.from("conciliacoes").select("*").eq("ano", ano).order("mes", { ascending: true });
    if (data) setConciliacoes(data);
    setLoading(false);
  }

  async function carregarBancosDisponiveis() {
    // Buscar nomes de categorias únicos
    const [r1, r2] = await Promise.all([
      supabase.from("categorias_entrada").select("nome").eq("ativo", true),
      supabase.from("categorias_saida").select("nome").eq("ativo", true),
    ]);
    const nomes = new Set<string>();
    r1.data?.forEach((c) => nomes.add(c.nome));
    r2.data?.forEach((c) => nomes.add(c.nome));
    setBancosDisponiveis(Array.from(nomes).sort());
  }

  useEffect(() => { carregarConciliacoes(); carregarBancosDisponiveis(); }, [ano]);

  async function calcularResumo(b: string, m: number, y: number): Promise<MovResumo> {
    const inicio = `${y}-${String(m).padStart(2, "0")}-01`;
    const ultimoDia = new Date(y, m, 0).getDate();
    const fim = `${y}-${String(m).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const movs = await fetchAllRows<{ id: string; data: string; tipo: string; valor: number; categoria_id: string; observacao: string }>((from, to) =>
      supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim).order("data").range(from, to)
    );

    if (movs.length === 0) return { entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] };

    // Buscar IDs de categorias que contenham o nome do banco
    const [r1, r2] = await Promise.all([
      supabase.from("categorias_entrada").select("id,nome").ilike("nome", `%${b}%`),
      supabase.from("categorias_saida").select("id,nome").ilike("nome", `%${b}%`),
    ]);

    const idsEntrada = r1.data?.map((c) => c.id) || [];
    const idsSaida = r2.data?.map((c) => c.id) || [];
    const todosIds = [...idsEntrada, ...idsSaida];
    const catNomes: Record<string, string> = {};
    [...(r1.data || []), ...(r2.data || [])].forEach((c) => { catNomes[c.id] = c.nome; });

    let filtrados = movs;
    if (todosIds.length > 0) {
      filtrados = movs.filter((m) => todosIds.includes(m.categoria_id));
    } else {
      filtrados = movs.filter((m) => m.observacao?.toLowerCase().includes(b.toLowerCase()));
    }

    // Buscar nomes de categorias das movimentações filtradas
    const catIds = [...new Set(filtrados.map((m) => m.categoria_id))];
    const catMap: Record<string, string> = {};
    if (catIds.length > 0) {
      const [ce, cs] = await Promise.all([
        supabase.from("categorias_entrada").select("id,nome").in("id", catIds),
        supabase.from("categorias_saida").select("id,nome").in("id", catIds),
      ]);
      ce.data?.forEach((c) => { catMap[c.id] = c.nome; });
      cs.data?.forEach((c) => { catMap[c.id] = c.nome; });
    }

    const entradas = filtrados.filter((m) => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
    const saidas = filtrados.filter((m) => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);

    return {
      entradas,
      saidas,
      saldo: entradas - saidas,
      quantidade: filtrados.length,
      detalhes: filtrados.map((m) => ({
        id: m.id,
        data: m.data,
        tipo: m.tipo,
        valor: m.valor,
        observacao: m.observacao || "",
        categoria: catMap[m.categoria_id] || "Sem categoria",
      })),
    };
  }

  async function abrirNovo() {
    setEditandoId(null); setBanco(""); setBancoCustom(""); setSaldoExtrato(""); setObservacao("");
    setResumo({ entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] });
    setShowForm(true);
  }

  async function mudarBanco(b: string) {
    setBanco(b);
    if (b) {
      const r = await calcularResumo(b, mes, ano);
      setResumo(r);
    } else {
      setResumo({ entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] });
    }
  }

  async function mudarMes(m: number) {
    setMes(m);
    if (banco) {
      const r = await calcularResumo(banco, m, ano);
      setResumo(r);
    }
  }

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setMensagem("");

    const bancoFinal = banco === "outro" ? bancoCustom : banco;
    if (!bancoFinal) { setMensagem("Selecione ou digite o banco."); setLoading(false); setTimeout(() => setMensagem(""), 3000); return; }

    const saldoExt = parseFloat(saldoExtrato.replace(",", "."));
    const dif = saldoExt - resumo.saldo;
    const { data: { user } } = await supabase.auth.getUser();

    const dados = {
      banco: bancoFinal,
      mes,
      ano,
      saldo_extrato: saldoExt,
      saldo_sistema: resumo.saldo,
      diferenca: dif,
      status: Math.abs(dif) < 0.01 ? "conciliado" : "divergente",
      observacao,
      conciliado_por: user?.id,
      conciliado_em: new Date().toISOString(),
    };

    let error;
    if (editandoId) {
      const r = await supabase.from("conciliacoes").update(dados).eq("id", editandoId);
      error = r.error;
    } else {
      const r = await supabase.from("conciliacoes").insert(dados);
      error = r.error;
    }

    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem(editandoId ? "Atualizado!" : "Conciliação registrada!");
      setShowForm(false); carregarConciliacoes();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 4000);
  }

  async function toggleExpandir(c: Conciliacao) {
    if (expandidoId === c.id) { setExpandidoId(null); return; }
    setExpandidoId(c.id);
    setDetalhesLoading(true);
    const d = await calcularResumo(c.banco, c.mes, c.ano);
    setDetalhesExpandido(d);
    setDetalhesLoading(false);
  }

  async function handleExcluir(id: string) {
    if (!confirm("Excluir conciliação?")) return;
    await supabase.from("conciliacoes").delete().eq("id", id);
    setMensagem("Excluído!"); carregarConciliacoes(); setTimeout(() => setMensagem(""), 3000);
  }

  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  function imprimirConciliacao(c: Conciliacao) {
    const html = `
      <html><head><title>Conciliação ${c.banco} - ${mesesNomes[c.mes - 1]}/${c.ano}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
        h1 { font-size: 22px; border-bottom: 3px solid #2563eb; padding-bottom: 10px; margin-bottom: 20px; }
        .info { font-size: 13px; color: #666; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
        .card { border: 2px solid #e5e7eb; border-radius: 10px; padding: 20px; text-align: center; }
        .card p { font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; }
        .card h2 { font-size: 24px; margin-top: 5px; }
        .green { color: #16a34a; } .red { color: #dc2626; } .blue { color: #2563eb; }
        .status { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: bold; font-size: 13px; }
        .status.ok { background: #dcfce7; color: #166534; }
        .status.erro { background: #fee2e2; color: #991b1b; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
        th { background: #f1f5f9; padding: 10px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
        td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
        .footer { margin-top: 40px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 15px; }
      </style></head><body>
        <h1>+Q Finanças — Conciliação Bancária</h1>
        <div class="info">
          <strong>Banco/Categoria:</strong> ${c.banco} &nbsp;|&nbsp;
          <strong>Período:</strong> ${mesesNomes[c.mes - 1]}/${c.ano} &nbsp;|&nbsp;
          <strong>Status:</strong>
          <span class="status ${c.status === "conciliado" ? "ok" : "erro"}">${c.status === "conciliado" ? "✓ CONCILIADO" : "⚠ DIVERGENTE"}</span>
        </div>
        <div class="grid">
          <div class="card"><p>Saldo Extrato</p><h2 class="blue">${fmt(c.saldo_extrato)}</h2></div>
          <div class="card"><p>Saldo Sistema</p><h2 class="green">${fmt(c.saldo_sistema)}</h2></div>
          <div class="card"><p>Diferença</p><h2 class="${Math.abs(c.diferenca) < 0.01 ? "green" : "red"}">${fmt(c.diferenca)}</h2></div>
        </div>
        ${c.observacao ? `<p style="margin:15px 0;font-size:13px;"><strong>Observação:</strong> ${c.observacao}</p>` : ""}
        <div class="footer">
          Gerado por +Q Finanças em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}
        </div>
      </body></html>`;

    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); win.print(); }
  }

  // Totais
  const conciliados = conciliacoes.filter((c) => c.status === "conciliado").length;
  const divergentes = conciliacoes.filter((c) => c.status === "divergente").length;
  const totalExtrato = conciliacoes.reduce((a, c) => a + c.saldo_extrato, 0);
  const totalSistema = conciliacoes.reduce((a, c) => a + c.saldo_sistema, 0);
  const totalDif = conciliacoes.reduce((a, c) => a + c.diferenca, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Conciliação Bancária</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Compare extratos bancários com os registros do sistema</p>
        </div>
        {!isReadOnly && (
          <button onClick={abrirNovo} className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all text-sm shadow-md shadow-blue-200">
            + Nova Conciliação
          </button>
        )}
      </div>

      {/* Ano */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={() => setAno(ano - 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← {ano - 1}</button>
        <p className="font-bold text-lg">{ano}</p>
        <button onClick={() => setAno(ano + 1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">{ano + 1} →</button>
      </div>

      {/* Resumo anual */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { l: "Extrato Total", v: fmt(totalExtrato), c: "text-blue-600" },
          { l: "Sistema Total", v: fmt(totalSistema), c: "text-emerald-600" },
          { l: "Diferença Total", v: fmt(totalDif), c: Math.abs(totalDif) < 0.01 ? "text-emerald-600" : "text-red-500" },
          { l: "Conciliados", v: `${conciliados}`, c: "text-emerald-600" },
          { l: "Divergentes", v: `${divergentes}`, c: "text-red-500" },
        ].map((c) => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {/* Formulário */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Nova"} Conciliação</h2>
            <button onClick={() => setShowForm(false)} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleSalvar} className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">1. Selecione o banco/categoria</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {bancosDisponiveis.map((b) => (
                  <button key={b} type="button" onClick={() => mudarBanco(b)} className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${banco === b ? "bg-blue-600 text-white shadow-sm" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:bg-[var(--color-surface)]"}`}>
                    {b}
                  </button>
                ))}
                <button type="button" onClick={() => { setBanco("outro"); setResumo({ entradas: 0, saidas: 0, saldo: 0, quantidade: 0, detalhes: [] }); }} className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${banco === "outro" ? "bg-blue-600 text-white shadow-sm" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
                  ✏️ Outro
                </button>
              </div>

              {banco === "outro" && (
                <div className="mt-3">
                  <input type="text" value={bancoCustom} onChange={(e) => setBancoCustom(e.target.value)} placeholder="Digite o nome do banco/categoria" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
              )}
            </div>

            {/* Mês */}
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">2. Selecione o mês</h3>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {mesesNomes.map((m, i) => (
                  <button key={i} type="button" onClick={() => mudarMes(i + 1)} className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${mes === i + 1 ? "bg-blue-600 text-white shadow-sm" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
                    {m.substring(0, 3)}
                  </button>
                ))}
              </div>
            </div>

            {/* Dados do sistema */}
            {banco && banco !== "outro" && (
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">3. Dados do sistema — {banco} / {mesesNomes[mes - 1]}/{ano}</h3>
                <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-emerald-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-emerald-600 font-semibold uppercase">Entradas</p>
                      <p className="text-sm font-bold text-emerald-700">{fmt(resumo.entradas)}</p>
                    </div>
                    <div className="bg-red-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-red-500 font-semibold uppercase">Saídas</p>
                      <p className="text-sm font-bold text-red-600">{fmt(resumo.saidas)}</p>
                    </div>
                    <div className="bg-blue-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-blue-600 font-semibold uppercase">Saldo Sistema</p>
                      <p className="text-sm font-bold text-blue-700">{fmt(resumo.saldo)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-gray-600 font-semibold uppercase">Movimentações</p>
                      <p className="text-sm font-bold text-gray-700">{resumo.quantidade}</p>
                    </div>
                  </div>

                  {resumo.detalhes.length > 0 && (
                    <div className="mt-3 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden max-h-40 overflow-y-auto">
                      <div className="divide-y divide-[var(--color-border)]">
                        {resumo.detalhes.map((d) => (
                          <div key={d.id} className="flex items-center justify-between px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] shrink-0 ${d.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                                {d.tipo === "entrada" ? "▲" : "▼"}
                              </span>
                              <span className="truncate">{d.categoria}{d.observacao ? ` · ${d.observacao}` : ""}</span>
                            </div>
                            <span className={`font-semibold shrink-0 ${d.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                              {d.tipo === "entrada" ? "+" : "-"} {fmt(d.valor)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {resumo.quantidade === 0 && (
                    <p className="text-xs text-[var(--color-text-muted)] text-center mt-3">Nenhuma movimentação encontrada para este banco neste mês.</p>
                  )}
                </div>
              </div>
            )}

            {/* Saldo do extrato + comparação */}
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">{banco && banco !== "outro" ? "4" : "3"}. Saldo do extrato bancário</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor que aparece no extrato (R$)</label>
                  <input type="text" value={saldoExtrato} onChange={(e) => setSaldoExtrato(e.target.value)} placeholder="0,00" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                {saldoExtrato && banco && banco !== "outro" && (
                  <div className="flex items-center">
                    {(() => {
                      const ext = parseFloat(saldoExtrato.replace(",", "."));
                      const dif = ext - resumo.saldo;
                      const ok = Math.abs(dif) < 0.01;
                      return (
                        <div className={`w-full p-4 rounded-xl border-2 ${ok ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}>
                          <p className={`text-sm font-bold ${ok ? "text-emerald-700" : "text-red-700"}`}>
                            {ok ? "✓ Valores conferem!" : `⚠ Diferença de ${fmt(dif)}`}
                          </p>
                          <p className="text-xs text-[var(--color-text-muted)] mt-1">
                            Extrato: {fmt(ext)} vs Sistema: {fmt(resumo.saldo)}
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label>
              <input type="text" value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Ex: Pendência de 1 boleto, tarifa não registrada" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-blue-200">
                {loading ? "Salvando..." : "Salvar Conciliação"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      {loading && conciliacoes.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Carregando...</div>
      ) : conciliacoes.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <EmptyState variant="accounts" title={`Nenhuma conciliação em ${ano}`}
            description='Clique em "+ Nova Conciliação" para reconciliar os bancos com suas movimentações.' />
        </div>
      ) : (
        <div className="space-y-3">
          {conciliacoes.map((c) => {
            const isConciliado = c.status === "conciliado";
            const isExpandido = expandidoId === c.id;
            return (
              <div key={c.id} className={`bg-[var(--color-surface)] border rounded-2xl overflow-hidden ${isConciliado ? "border-emerald-200" : "border-red-200"}`}>
                <div className="p-4 flex items-center justify-between cursor-pointer hover:bg-[var(--color-bg)] transition-colors" onClick={() => toggleExpandir(c)}>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${isConciliado ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                      {isConciliado ? "✓" : "⚠"}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold">{c.banco}</p>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isConciliado ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {isConciliado ? "CONCILIADO" : "DIVERGENTE"}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {mesesNomes[c.mes - 1]}/{c.ano}
                        {c.conciliado_em && ` · ${new Date(c.conciliado_em).toLocaleDateString("pt-BR")}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${Math.abs(c.diferenca) < 0.01 ? "text-emerald-600" : "text-red-500"}`}>
                      {Math.abs(c.diferenca) < 0.01 ? "✓ R$ 0,00" : `${c.diferenca > 0 ? "+" : ""} ${fmt(c.diferenca)}`}
                    </p>
                    <p className="text-[10px] text-[var(--color-text-muted)]">Extrato: {fmt(c.saldo_extrato)} | Sistema: {fmt(c.saldo_sistema)}</p>
                  </div>
                </div>

                {isExpandido && (
                  <div className="border-t border-[var(--color-border)] p-4 bg-[var(--color-bg)] space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-blue-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-blue-600 font-semibold uppercase">Extrato</p>
                        <p className="text-sm font-bold text-blue-700">{fmt(c.saldo_extrato)}</p>
                      </div>
                      <div className="bg-emerald-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-emerald-600 font-semibold uppercase">Sistema</p>
                        <p className="text-sm font-bold text-emerald-700">{fmt(c.saldo_sistema)}</p>
                      </div>
                      <div className={`rounded-xl p-3 text-center ${Math.abs(c.diferenca) < 0.01 ? "bg-emerald-50" : "bg-red-50"}`}>
                        <p className={`text-[10px] font-semibold uppercase ${Math.abs(c.diferenca) < 0.01 ? "text-emerald-600" : "text-red-500"}`}>Diferença</p>
                        <p className={`text-sm font-bold ${Math.abs(c.diferenca) < 0.01 ? "text-emerald-700" : "text-red-600"}`}>{fmt(c.diferenca)}</p>
                      </div>
                    </div>

                    {c.observacao && (
                      <div className="bg-amber-50 rounded-xl p-3">
                        <p className="text-xs text-amber-700"><strong>Nota:</strong> {c.observacao}</p>
                      </div>
                    )}

                    {/* Movimentações do período */}
                    {detalhesLoading ? (
                      <p className="text-xs text-center text-[var(--color-text-muted)]">Carregando movimentações...</p>
                    ) : detalhesExpandido.detalhes.length > 0 ? (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Movimentações ({detalhesExpandido.quantidade})</p>
                        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden max-h-48 overflow-y-auto">
                          <div className="divide-y divide-[var(--color-border)]">
                            {detalhesExpandido.detalhes.map((d) => (
                              <div key={d.id} className="flex items-center justify-between px-3 py-2 text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] shrink-0 ${d.tipo === "entrada" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                                    {d.tipo === "entrada" ? "▲" : "▼"}
                                  </span>
                                  <span className="truncate">{d.categoria}{d.observacao ? ` · ${d.observacao}` : ""}</span>
                                </div>
                                <span className={`font-semibold shrink-0 ${d.tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                                  {d.tipo === "entrada" ? "+" : "-"} {fmt(d.valor)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-center text-[var(--color-text-muted)]">Nenhuma movimentação encontrada.</p>
                    )}

                    <div className="flex gap-2 flex-wrap">
                      <button onClick={() => imprimirConciliacao(c)} className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition">🖨️ Imprimir</button>
                      {!isReadOnly && (
                        <button onClick={() => handleExcluir(c.id)} className="px-3 py-2 rounded-lg bg-red-50 text-red-500 text-xs font-semibold hover:bg-red-100 transition">🗑️ Excluir</button>
                      )}
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
