"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";

const tabelasRoutes: Record<string, string> = {
  movimentacoes: "/movimentacoes",
  contas_pagar: "/contas-pagar",
  categorias_entrada: "/categorias",
  categorias_saida: "/categorias",
  maquinas: "/maquinas",
  vendas_maquina: "/vendas",
  profiles: "/usuarios",
};

interface LogEntry {
  id: string;
  usuario_id: string;
  usuario_nome: string;
  acao: string;
  tabela: string;
  registro_id: string | null;
  dados_anteriores: Record<string, unknown> | null;
  dados_novos: Record<string, unknown> | null;
  detalhes: string | null;
  created_at: string;
}

const acoesConfig: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  criou: { label: "Criou", icon: "➕", color: "text-emerald-700", bg: "bg-emerald-50" },
  editou: { label: "Editou", icon: "✏️", color: "text-blue-700", bg: "bg-blue-50" },
  excluiu: { label: "Excluiu", icon: "🗑️", color: "text-red-700", bg: "bg-red-50" },
  pagou: { label: "Pagou", icon: "💳", color: "text-purple-700", bg: "bg-purple-50" },
  fechou: { label: "Fechou", icon: "🔒", color: "text-amber-700", bg: "bg-amber-50" },
  reabriu: { label: "Reabriu", icon: "🔓", color: "text-orange-700", bg: "bg-orange-50" },
  recebeu: { label: "Recebeu", icon: "✅", color: "text-emerald-700", bg: "bg-emerald-50" },
  importou: { label: "Importou", icon: "📤", color: "text-cyan-700", bg: "bg-cyan-50" },
};

const tabelasLabels: Record<string, string> = {
  movimentacoes: "Movimentação",
  contas_pagar: "Conta a Pagar",
  categorias_entrada: "Categoria Entrada",
  categorias_saida: "Categoria Saída",
  maquinas: "Máquina",
  vendas_maquina: "Venda Maquininha",
  fechamentos_mensais: "Fechamento Mensal",
  conciliacoes: "Conciliação",
  feriados: "Feriado",
  profiles: "Usuário",
};

export default function AuditPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroAcao, setFiltroAcao] = useState("todas");
  const [filtroTabela, setFiltroTabela] = useState("todas");
  const [filtroUsuario, setFiltroUsuario] = useState("todos");
  const [busca, setBusca] = useState("");
  const [pagina, setPagina] = useState(1);
  const [expandidoId, setExpandidoId] = useState<string | null>(null);
  const [usuarios, setUsuarios] = useState<string[]>([]);

  // Filtros de data
  const [filtroData, setFiltroData] = useState<"todos" | "hoje" | "semana" | "mes" | "personalizado">("todos");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");

  const itensPorPagina = 30;

  const supabase = createClient();

  async function carregarLogs() {
    setLoading(true);
    const { data } = await supabase
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (data) {
      setLogs(data);
      const unicos = [...new Set(data.map((l) => l.usuario_nome).filter(Boolean))];
      setUsuarios(unicos.sort());
    }
    setLoading(false);
  }

  useEffect(() => { carregarLogs(); }, []);

  function fmtData(iso: string) {
    const d = new Date(iso);
    return {
      data: d.toLocaleDateString("pt-BR"),
      hora: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    };
  }

  function fmtValor(v: unknown): string {
    if (v === null || v === undefined) return "-";
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (isNaN(num)) return String(v);
    return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function renderJsonDiff(anterior: Record<string, unknown> | null, novo: Record<string, unknown> | null) {
    if (!anterior && !novo) return null;

    const camposIgnorados = ["id", "created_at", "updated_at"];
    const todosCampos = new Set([
      ...Object.keys(anterior || {}),
      ...Object.keys(novo || {}),
    ]);

    const diffs: { campo: string; antes: string; depois: string }[] = [];

    todosCampos.forEach((campo) => {
      if (camposIgnorados.includes(campo)) return;
      const valorAntes = anterior?.[campo];
      const valorDepois = novo?.[campo];

      if (JSON.stringify(valorAntes) !== JSON.stringify(valorDepois)) {
        diffs.push({
          campo: campo.replace(/_/g, " "),
          antes: valorAntes !== undefined && valorAntes !== null ? formatarCampo(campo, valorAntes) : "-",
          depois: valorDepois !== undefined && valorDepois !== null ? formatarCampo(campo, valorDepois) : "-",
        });
      }
    });

    if (diffs.length === 0) return null;

    return (
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden mt-2">
        <div className="divide-y divide-[var(--color-border)]">
          <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-[var(--color-bg)] text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>Campo</span>
            <span>Antes</span>
            <span>Depois</span>
          </div>
          {diffs.map((d, i) => (
            <div key={i} className="grid grid-cols-3 gap-2 px-3 py-2 text-xs">
              <span className="font-medium capitalize">{d.campo}</span>
              <span className="text-red-500">{d.antes}</span>
              <span className="text-emerald-600">{d.depois}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function formatarCampo(campo: string, valor: unknown): string {
    if (campo.includes("valor") || campo.includes("taxa") || campo.includes("saldo")) {
      return fmtValor(valor);
    }
    if (campo.includes("data") && typeof valor === "string" && valor.match(/^\d{4}-\d{2}-\d{2}/)) {
      return new Date(valor + "T12:00:00").toLocaleDateString("pt-BR");
    }
    if (typeof valor === "boolean") return valor ? "Sim" : "Não";
    if (typeof valor === "object") return JSON.stringify(valor);
    return String(valor);
  }

  function buildVerUrl(log: LogEntry): string | null {
    if (log.acao === "excluiu") return null;
    const rota = tabelasRoutes[log.tabela];
    if (!rota || !log.registro_id) return null;
    const params = new URLSearchParams({ destacar: log.registro_id });
    const dados = log.dados_novos || log.dados_anteriores;
    const data = dados?.data ?? dados?.data_vencimento;
    if (data && typeof data === "string") params.set("data", String(data));
    return `${rota}?${params.toString()}`;
  }

  function descreverLog(log: LogEntry): string {
    const tabela = tabelasLabels[log.tabela] || log.tabela;
    const nome = log.detalhes || "";

    switch (log.acao) {
      case "criou": return `cadastrou ${tabela.toLowerCase()}${nome ? `: ${nome}` : ""}`;
      case "editou": return `alterou ${tabela.toLowerCase()}${nome ? `: ${nome}` : ""}`;
      case "excluiu": return `excluiu ${tabela.toLowerCase()}${nome ? `: ${nome}` : ""}`;
      case "pagou": return `marcou como pago${nome ? `: ${nome}` : ""}`;
      case "fechou": return `fechou o período${nome ? `: ${nome}` : ""}`;
      case "reabriu": return `reabriu o período${nome ? `: ${nome}` : ""}`;
      case "recebeu": return `confirmou recebimento${nome ? `: ${nome}` : ""}`;
      case "importou": return `importou dados${nome ? `: ${nome}` : ""}`;
      default: return `${log.acao} em ${tabela.toLowerCase()}`;
    }
  }

  function getDataFiltroRange(): { inicio: Date; fim: Date } | null {
    const hoje = new Date();
    hoje.setHours(23, 59, 59, 999);

    if (filtroData === "hoje") {
      const inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      return { inicio, fim: hoje };
    }

    if (filtroData === "semana") {
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - 7);
      inicio.setHours(0, 0, 0, 0);
      return { inicio, fim: hoje };
    }

    if (filtroData === "mes") {
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - 30);
      inicio.setHours(0, 0, 0, 0);
      return { inicio, fim: hoje };
    }

    if (filtroData === "personalizado" && dataInicio) {
      const inicio = new Date(dataInicio + "T00:00:00");
      const fim = dataFim ? new Date(dataFim + "T23:59:59") : new Date(dataInicio + "T23:59:59");
      return { inicio, fim };
    }

    return null;
  }

  // Filtros
  const logsFiltrados = logs.filter((log) => {
    if (filtroAcao !== "todas" && log.acao !== filtroAcao) return false;
    if (filtroTabela !== "todas" && log.tabela !== filtroTabela) return false;
    if (filtroUsuario !== "todos" && log.usuario_nome !== filtroUsuario) return false;

    // Filtro de data
    const range = getDataFiltroRange();
    if (range) {
      const dataLog = new Date(log.created_at);
      if (dataLog < range.inicio || dataLog > range.fim) return false;
    }

    if (busca) {
      const b = busca.toLowerCase();
      const texto = `${log.usuario_nome} ${log.detalhes} ${tabelasLabels[log.tabela] || log.tabela} ${log.acao}`.toLowerCase();
      if (!texto.includes(b)) return false;
    }
    return true;
  });

  // Paginação
  const totalPaginas = Math.ceil(logsFiltrados.length / itensPorPagina);
  const logsPagina = logsFiltrados.slice(
    (pagina - 1) * itensPorPagina,
    pagina * itensPorPagina
  );

  const tabelasUnicas = [...new Set(logs.map((l) => l.tabela))].sort();

  // Contadores
  const hoje = new Date().toISOString().split("T")[0];
  const logsHoje = logs.filter((l) => l.created_at.startsWith(hoje)).length;
  const logsSemana = logs.filter((l) => {
    const d = new Date(l.created_at);
    const semanaAtras = new Date();
    semanaAtras.setDate(semanaAtras.getDate() - 7);
    return d >= semanaAtras;
  }).length;

  function limparFiltros() {
    setFiltroAcao("todas");
    setFiltroTabela("todas");
    setFiltroUsuario("todos");
    setFiltroData("todos");
    setDataInicio("");
    setDataFim("");
    setBusca("");
    setPagina(1);
  }

  const temFiltroAtivo = filtroAcao !== "todas" || filtroTabela !== "todas" || filtroUsuario !== "todos" || filtroData !== "todos" || busca !== "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Histórico de Alterações</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Rastreie todas as ações realizadas no sistema</p>
        </div>
        <button onClick={carregarLogs} className="px-4 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] font-semibold rounded-xl hover:bg-[var(--color-bg)] transition text-sm">
          🔄 Atualizar
        </button>
      </div>

      {/* Resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: "Total de Registros", v: `${logs.length}`, c: "text-[var(--color-text)]" },
          { l: "Hoje", v: `${logsHoje}`, c: "text-blue-600" },
          { l: "Última Semana", v: `${logsSemana}`, c: "text-purple-600" },
          { l: "Usuários Ativos", v: `${usuarios.length}`, c: "text-emerald-600" },
        ].map((c) => (
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 space-y-3">
        {/* Filtro de ação */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Ação:</span>
          <button onClick={() => { setFiltroAcao("todas"); setPagina(1); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroAcao === "todas" ? "bg-gray-800 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
            Todas
          </button>
          {Object.entries(acoesConfig).map(([key, config]) => (
            <button key={key} onClick={() => { setFiltroAcao(key); setPagina(1); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroAcao === key ? "bg-gray-800 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
              {config.icon} {config.label}
            </button>
          ))}
        </div>

        {/* Filtro de data */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Período:</span>
          {[
            { key: "todos", label: "Todos" },
            { key: "hoje", label: "Hoje" },
            { key: "semana", label: "7 dias" },
            { key: "mes", label: "30 dias" },
            { key: "personalizado", label: "📅 Personalizado" },
          ].map((opt) => (
            <button key={opt.key} onClick={() => { setFiltroData(opt.key as typeof filtroData); setPagina(1); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroData === opt.key ? "bg-blue-600 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>
              {opt.label}
            </button>
          ))}
        </div>

        {/* Datas personalizadas */}
        {filtroData === "personalizado" && (
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[10px] font-semibold mb-1 text-[var(--color-text-muted)] uppercase">De</label>
              <input type="date" value={dataInicio} onChange={(e) => { setDataInicio(e.target.value); setPagina(1); }} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold mb-1 text-[var(--color-text-muted)] uppercase">Até</label>
              <input type="date" value={dataFim} onChange={(e) => { setDataFim(e.target.value); setPagina(1); }} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none" />
            </div>
          </div>
        )}

        {/* Módulo, usuário, busca */}
        <div className="flex flex-wrap gap-3">
          <select value={filtroTabela} onChange={(e) => { setFiltroTabela(e.target.value); setPagina(1); }} className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none">
            <option value="todas">Todos os módulos</option>
            {tabelasUnicas.map((t) => (
              <option key={t} value={t}>{tabelasLabels[t] || t}</option>
            ))}
          </select>
          <select value={filtroUsuario} onChange={(e) => { setFiltroUsuario(e.target.value); setPagina(1); }} className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none">
            <option value="todos">Todos os usuários</option>
            {usuarios.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          <input type="text" value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(1); }} placeholder="Buscar..." className="flex-1 min-w-[150px] px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-xs focus:outline-none" />
          {temFiltroAtivo && (
            <button onClick={limparFiltros} className="px-3 py-2 rounded-lg bg-red-50 text-red-500 text-xs font-semibold hover:bg-red-100 transition">
              ✕ Limpar
            </button>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          {logsFiltrados.length} {logsFiltrados.length === 1 ? "registro encontrado" : "registros encontrados"}
          {temFiltroAtivo && " (filtrado)"}
        </p>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Carregando...</div>
      ) : logsPagina.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <EmptyState variant="search" title="Nenhum registro encontrado"
            description="Tente ajustar os filtros ou ampliar o período de busca." />
        </div>
      ) : (
        <div className="space-y-2">
          {logsPagina.map((log) => {
            const config = acoesConfig[log.acao] || { label: log.acao, icon: "📝", color: "text-gray-700", bg: "bg-gray-50" };
            const dt = fmtData(log.created_at);
            const isExpandido = expandidoId === log.id;
            const temDiff = log.dados_anteriores || log.dados_novos;

            return (
              <div key={log.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden">
                <div
                  className={`p-3 flex items-center gap-3 ${temDiff ? "cursor-pointer hover:bg-[var(--color-bg)]" : ""} transition-colors`}
                  onClick={temDiff ? () => setExpandidoId(isExpandido ? null : log.id) : undefined}
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm shrink-0 ${config.bg}`}>
                    {config.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-semibold">{log.usuario_nome}</span>
                      {" "}
                      <span className="text-[var(--color-text-muted)]">{descreverLog(log)}</span>
                    </p>
                    <p className="text-[10px] text-[var(--color-text-muted)]">
                      {dt.data} às {dt.hora} · {tabelasLabels[log.tabela] || log.tabela}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${config.bg} ${config.color}`}>
                      {config.label}
                    </span>
                    {(() => {
                      const url = buildVerUrl(log);
                      if (!url) return null;
                      return (
                        <span onClick={(e) => e.stopPropagation()}>
                          <Link href={url} className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-blue-50 text-blue-600 hover:bg-blue-100 transition">
                            Ver →
                          </Link>
                        </span>
                      );
                    })()}
                    {temDiff && (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {isExpandido ? "▼" : "▶"}
                      </span>
                    )}
                  </div>
                </div>

                {isExpandido && temDiff && (
                  <div className="px-3 pb-3">
                    {renderJsonDiff(log.dados_anteriores, log.dados_novos)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Paginação */}
      {totalPaginas > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPagina(Math.max(1, pagina - 1))}
            disabled={pagina === 1}
            className="px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-medium disabled:opacity-40 hover:bg-[var(--color-bg)] transition"
          >
            ← Anterior
          </button>
          <span className="text-xs text-[var(--color-text-muted)] px-3">
            Página {pagina} de {totalPaginas}
          </span>
          <button
            onClick={() => setPagina(Math.min(totalPaginas, pagina + 1))}
            disabled={pagina === totalPaginas}
            className="px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-medium disabled:opacity-40 hover:bg-[var(--color-bg)] transition"
          >
            Próxima →
          </button>
        </div>
      )}
    </div>
  );
}
