"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Achado, ClasseAchado, DetalheRecebimento, ItemMix, RelatorioAnaliseInteligente, SemanaVendas } from "@/lib/analise-inteligente/tipos";
import { Logo } from "@/components/logo";

type Atalho = "mes_atual_vs_anterior" | "trimestre_vs_trimestre" | "ano_vs_ano" | "acumulado_vs_acumulado" | "personalizado";

function fmt(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function hojeIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function ultimoDiaMes(ano: number, mes: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}-${String(new Date(ano, mes, 0).getDate()).padStart(2, "0")}`;
}
function primeiroDiaMes(ano: number, mes: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}-01`;
}

const CORES_CLASSE: Record<ClasseAchado, { bg: string; border: string; texto: string; emoji: string; label: string }> = {
  critico: { bg: "var(--red-subtle)", border: "var(--red-border)", texto: "var(--red-strong)", emoji: "🔴", label: "Crítico" },
  atencao: { bg: "var(--amber-subtle)", border: "var(--amber-border)", texto: "var(--amber-strong)", emoji: "🟠", label: "Atenção" },
  observacao: { bg: "var(--blue-subtle)", border: "var(--blue-border)", texto: "var(--blue-strong)", emoji: "🟡", label: "Observação" },
  oportunidade: { bg: "var(--brand-subtle, var(--color-primary-light))", border: "var(--brand-border, var(--color-primary))", texto: "var(--brand-strong, var(--color-primary-dark))", emoji: "🟢", label: "Oportunidade" },
};

const CORES_ROSCA = ["#059669", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#6b7280"];

function calcularAtalho(atalho: Atalho): { inicio: string; fim: string; compInicio: string | null; compFim: string | null } {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;

  if (atalho === "trimestre_vs_trimestre") {
    const trimAtual = Math.floor((mesAtual - 1) / 3);
    const mesIniTrim = trimAtual * 3 + 1;
    const inicio = primeiroDiaMes(anoAtual, mesIniTrim);
    const fim = ultimoDiaMes(anoAtual, mesIniTrim + 2);
    const anoAnt = trimAtual === 0 ? anoAtual - 1 : anoAtual;
    const mesIniAnt = trimAtual === 0 ? 10 : mesIniTrim - 3;
    return { inicio, fim, compInicio: primeiroDiaMes(anoAnt, mesIniAnt), compFim: ultimoDiaMes(anoAnt, mesIniAnt + 2) };
  }
  if (atalho === "ano_vs_ano") {
    return { inicio: `${anoAtual}-01-01`, fim: `${anoAtual}-12-31`, compInicio: `${anoAtual - 1}-01-01`, compFim: `${anoAtual - 1}-12-31` };
  }
  if (atalho === "acumulado_vs_acumulado") {
    const fim = hojeIso();
    const fimAntStr = `${anoAtual - 1}-${String(mesAtual).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
    return { inicio: `${anoAtual}-01-01`, fim, compInicio: `${anoAtual - 1}-01-01`, compFim: fimAntStr };
  }
  const inicio = primeiroDiaMes(anoAtual, mesAtual);
  const fim = ultimoDiaMes(anoAtual, mesAtual);
  const mesAnt = mesAtual === 1 ? 12 : mesAtual - 1;
  const anoAnt = mesAtual === 1 ? anoAtual - 1 : anoAtual;
  return { inicio, fim, compInicio: primeiroDiaMes(anoAnt, mesAnt), compFim: ultimoDiaMes(anoAnt, mesAnt) };
}

export function AnaliseInteligentePainel() {
  const supabase = createClient();
  const [atalho, setAtalho] = useState<Atalho>("mes_atual_vs_anterior");
  const [custIni, setCustIni] = useState(primeiroDiaMes(new Date().getFullYear(), new Date().getMonth() + 1));
  const [custFim, setCustFim] = useState(hojeIso());
  const [custCompIni, setCustCompIni] = useState("");
  const [custCompFim, setCustCompFim] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [relatorio, setRelatorio] = useState<RelatorioAnaliseInteligente | null>(null);
  const [verTodos, setVerTodos] = useState(false);

  async function gerar() {
    setCarregando(true);
    setErro("");
    setRelatorio(null);

    let periodoInicio: string, periodoFim: string, periodoComparacaoInicio: string | null, periodoComparacaoFim: string | null;
    if (atalho === "personalizado") {
      periodoInicio = custIni;
      periodoFim = custFim;
      periodoComparacaoInicio = custCompIni || null;
      periodoComparacaoFim = custCompFim || null;
    } else {
      const r = calcularAtalho(atalho);
      periodoInicio = r.inicio; periodoFim = r.fim; periodoComparacaoInicio = r.compInicio; periodoComparacaoFim = r.compFim;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setErro("Sessão expirada — recarregue a página."); setCarregando(false); return; }

    try {
      const res = await fetch("/api/analise-inteligente", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ periodoInicio, periodoFim, periodoComparacaoInicio, periodoComparacaoFim }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErro(data?.error || "Não foi possível gerar a análise.");
      } else {
        setRelatorio(data.relatorio as RelatorioAnaliseInteligente);
        setVerTodos(false);
      }
    } catch {
      setErro("Erro de conexão ao gerar a análise.");
    }
    setCarregando(false);
  }

  function imprimir() {
    if (!relatorio) return;
    const janela = window.open("", "_blank");
    if (!janela) return;
    const r = relatorio;
    const achadosHtml = (vt: boolean, lista?: Achado[]) =>
      (lista ?? (vt ? [...r.achados, ...r.achadosOcultos] : r.achados))
        .map((a) => {
          const c = CORES_CLASSE[a.classe];
          return `<div style="border-left:4px solid ${corImpressao(a.classe)};background:#fafafa;border-radius:6px;padding:10px 14px;margin-bottom:8px;">
            <strong>${c.emoji} ${escapeHtml(a.titulo)}</strong>
            <p style="margin:4px 0 0;font-size:12px;color:#374151;">${escapeHtml(a.texto)}</p>
          </div>`;
        })
        .join("");
    const mixHtml = r.mixRecebimento
      .map((m) => `<tr><td>${escapeHtml(m.categoria)}</td><td style="text-align:right;">${fmt(m.valor)}</td></tr>`)
      .join("");
    const fornHtml = r.topFornecedores
      .map((f) => `<tr><td>${escapeHtml(f.categoria)}</td><td style="text-align:right;">${fmt(f.valor)}</td></tr>`)
      .join("");
    janela.document.write(`<html><head><title>Análise Inteligente - ${r.periodoInicio} a ${r.periodoFim}</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;color:#111827;}
        h1{font-size:22px;margin:0;} h2{font-size:14px;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;}
        table{width:100%;border-collapse:collapse;font-size:12px;} td{padding:5px 8px;border-bottom:1px solid #f3f4f6;}
        .kpis{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;}
        .kpi{flex:1;min-width:120px;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center;}
        .kpi-label{font-size:10px;color:#6b7280;text-transform:uppercase;}
        .kpi-value{font-size:16px;font-weight:700;}
        footer{margin-top:24px;border-top:1px solid #e5e7eb;padding-top:8px;font-size:10px;color:#9ca3af;text-align:center;}
        @media print{body{padding:16px;}}
      </style></head><body>
      <h1>+Q Finanças — Análise Inteligente</h1>
      <p style="color:#6b7280;font-size:13px;">${formatarPeriodo(r.periodoInicio, r.periodoFim)} · comparado com ${escapeHtml(r.comparadoCom)}</p>
      <h2>Como foi o período</h2>
      <p style="font-size:13px;line-height:1.6;">${escapeHtml(r.comoFoiOMes)}</p>
      <div class="kpis">
        <div class="kpi"><div class="kpi-label">Receita</div><div class="kpi-value">${fmt(r.kpis.receita)}</div></div>
        <div class="kpi"><div class="kpi-label">Despesa</div><div class="kpi-value">${fmt(r.kpis.despesa)}</div></div>
        <div class="kpi"><div class="kpi-label">Resultado</div><div class="kpi-value">${fmt(r.kpis.resultado)}</div></div>
        <div class="kpi"><div class="kpi-label">Margem de Caixa</div><div class="kpi-value">${r.kpis.margemCaixa !== null ? (r.kpis.margemCaixa * 100).toFixed(1) + "%" : "—"}</div></div>
      </div>
      <h2>Mix de Recebimento</h2>
      <table>${mixHtml}</table>
      <h2>Fornecedores (top ${r.topFornecedores.length})</h2>
      <table>${fornHtml}</table>
      ${r.pressaoCaixa.length > 0 ? `<h2>⏰ Pressão de caixa — próximos 35 dias (sempre atual, não é do período acima)</h2>${achadosHtml(false, r.pressaoCaixa)}` : ""}
      <h2>Achados do período analisado</h2>
      ${achadosHtml(true)}
      <h2>Conclusão</h2>
      <p style="font-size:13px;line-height:1.6;">${escapeHtml(r.conclusao)}</p>
      ${r.limitacoesDados.length > 0 ? `<h2>Limitações dos dados</h2><ul style="font-size:12px;color:#6b7280;">${r.limitacoesDados.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
      <footer>Gerado em ${new Date(r.geradoEm).toLocaleString("pt-BR")} · motor v${r.versaoMotor} · +Q Finanças</footer>
      <script>window.print();</script>
      </body></html>`);
    janela.document.close();
  }

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <h3 className="font-bold text-lg">🧠 Análise Inteligente</h3>
        {relatorio && (
          <button onClick={imprimir} className="px-4 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm font-semibold hover:bg-[var(--color-border)] transition">
            Imprimir / Salvar PDF
          </button>
        )}
      </div>

      <div className="space-y-3 mb-5">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">Período</label>
          <select
            value={atalho}
            onChange={(e) => setAtalho(e.target.value as Atalho)}
            className="w-full sm:w-auto px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm font-medium"
          >
            <option value="mes_atual_vs_anterior">Mês atual x mês anterior</option>
            <option value="trimestre_vs_trimestre">Trimestre x trimestre anterior</option>
            <option value="ano_vs_ano">Ano x ano anterior</option>
            <option value="acumulado_vs_acumulado">Acumulado do ano x ano anterior</option>
            <option value="personalizado">Período personalizado</option>
          </select>
        </div>

        {atalho === "personalizado" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border-2 border-[var(--color-border)] p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text)] mb-2">① Período que você quer analisar</p>
              <div className="flex items-center gap-2">
                <input type="date" value={custIni} onChange={(e) => setCustIni(e.target.value)} className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
                <span className="text-xs text-[var(--color-text-muted)]">até</span>
                <input type="date" value={custFim} onChange={(e) => setCustFim(e.target.value)} className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
              </div>
            </div>
            <div className="rounded-xl border-2 border-dashed border-[var(--color-border)] p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">② Comparar com (opcional — se vazio, usa o período anterior de mesmo tamanho)</p>
              <div className="flex items-center gap-2">
                <input type="date" value={custCompIni} onChange={(e) => setCustCompIni(e.target.value)} className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
                <span className="text-xs text-[var(--color-text-muted)]">até</span>
                <input type="date" value={custCompFim} onChange={(e) => setCustCompFim(e.target.value)} className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
              </div>
            </div>
          </div>
        )}

        <button
          onClick={gerar}
          disabled={carregando}
          className="w-full sm:w-auto px-5 py-3 bg-gradient-to-r from-purple-600 to-purple-500 text-white font-bold rounded-xl hover:from-purple-700 hover:to-purple-600 transition-all text-sm shadow-md disabled:opacity-50"
        >
          {carregando ? "Gerando..." : "Gerar Análise Inteligente"}
        </button>
      </div>

      {erro && (
        <div className="rounded-xl p-3 border bg-red-50 border-red-200 text-sm text-red-700 font-semibold mb-4">⚠️ {erro}</div>
      )}

      {relatorio && (
        <div id="analise-inteligente-conteudo" className="space-y-6">
          <Logo />

          <p className="text-sm font-medium text-[var(--color-text-muted)]">
            {formatarPeriodo(relatorio.periodoInicio, relatorio.periodoFim)} · comparado com {relatorio.comparadoCom}
          </p>

          <p className="text-base leading-relaxed bg-[var(--color-bg)] rounded-xl p-5 font-medium">{relatorio.comoFoiOMes}</p>

          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Receita" valor={fmt(relatorio.kpis.receita)} variacao={relatorio.kpis.varReceitaPct} cor="text-emerald-600" />
            <KpiCard label="Despesa" valor={fmt(relatorio.kpis.despesa)} variacao={relatorio.kpis.varDespesaPct} cor="text-red-500" inverso />
            <KpiCard label="Resultado" valor={fmt(relatorio.kpis.resultado)} variacao={relatorio.kpis.varResultadoPct} cor={relatorio.kpis.resultado >= 0 ? "text-emerald-600" : "text-red-500"} />
            <KpiCard label="Margem de Caixa" valor={relatorio.kpis.margemCaixa !== null ? `${(relatorio.kpis.margemCaixa * 100).toFixed(1)}%` : "—"} variacao={null} cor="text-blue-600" />
          </div>

          <Cascata receita={relatorio.kpis.receita} despesa={relatorio.kpis.despesa} resultado={relatorio.kpis.resultado} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <MixRecebimento itens={relatorio.mixRecebimento} />
            <TopFornecedores itens={relatorio.topFornecedores} />
          </div>

          <VendasPorSemana itens={relatorio.vendasPorSemana} />
          <DetalhamentoRecebimento itens={relatorio.detalhamentoRecebimento} />

          {relatorio.pressaoCaixa.length > 0 && (
            <div>
              <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-1">⏰ Pressão de caixa — próximos 35 dias</h4>
              <p className="text-xs text-[var(--color-text-muted)] mb-3">Sempre atual a partir de hoje — independente do período que você selecionou acima.</p>
              <div className="space-y-3">
                {relatorio.pressaoCaixa.map((a) => (
                  <AchadoCard key={a.id} achado={a} />
                ))}
              </div>
            </div>
          )}

          {/* Achados */}
          <div>
            <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-1">Achados do período analisado</h4>
            <p className="text-xs text-[var(--color-text-muted)] mb-3">{formatarPeriodo(relatorio.periodoInicio, relatorio.periodoFim)}, comparado com {relatorio.comparadoCom}.</p>
            {relatorio.achados.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Nenhum achado relevante neste período.</p>
            ) : (
              <div className="space-y-3">
                {(verTodos ? [...relatorio.achados, ...relatorio.achadosOcultos] : relatorio.achados).map((a) => (
                  <AchadoCard key={a.id} achado={a} />
                ))}
              </div>
            )}
            {relatorio.achadosOcultos.length > 0 && (
              <button onClick={() => setVerTodos((v) => !v)} className="mt-3 text-sm font-semibold text-blue-600 hover:underline">
                {verTodos ? "Mostrar só os principais" : `Ver todos (+${relatorio.achadosOcultos.length})`}
              </button>
            )}
          </div>

          <p className="text-base leading-relaxed bg-[var(--color-bg)] rounded-xl p-5 font-medium">{relatorio.conclusao}</p>

          {relatorio.limitacoesDados.length > 0 && (
            <div className="rounded-xl p-4 border bg-[var(--color-bg)] border-[var(--color-border)]">
              <h4 className="font-bold text-xs uppercase tracking-wide text-[var(--color-text-muted)] mb-2">Limitações dos dados</h4>
              <ul className="text-xs text-[var(--color-text-muted)] list-disc pl-4 space-y-1">
                {relatorio.limitacoesDados.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-[var(--color-text-muted)] text-center">
            Gerado em {new Date(relatorio.geradoEm).toLocaleString("pt-BR")} · motor v{relatorio.versaoMotor} · sem IA (texto por template)
          </p>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, valor, variacao, cor, inverso = false }: { label: string; valor: string; variacao: number | null; cor: string; inverso?: boolean }) {
  const positivo = variacao !== null && (inverso ? variacao < 0 : variacao > 0);
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl p-4 text-center">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">{label}</p>
      <p className={`font-extrabold text-xl sm:text-2xl ${cor}`}>{valor}</p>
      {variacao !== null && (
        <p className={`text-xs font-bold mt-1.5 ${positivo ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(variacao)} vs comparação</p>
      )}
    </div>
  );
}

function AchadoCard({ achado }: { achado: Achado }) {
  const c = CORES_CLASSE[achado.classe];
  return (
    <div className="rounded-xl p-4 border-2" style={{ background: c.bg, borderColor: c.border }}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-bold text-sm" style={{ color: c.texto }}>
          {c.emoji} {achado.titulo}
        </p>
        <span className="text-[10px] font-extrabold uppercase tracking-wide opacity-80 whitespace-nowrap px-2 py-0.5 rounded-full" style={{ color: c.texto, background: "rgba(255,255,255,0.5)" }}>
          {c.label} · {achado.score.toFixed(0)}
        </span>
      </div>
      <p className="text-sm mt-2 text-[var(--color-text)] leading-relaxed">{achado.texto}</p>
      {achado.fatoOuHipotese === "hipotese" && achado.explicacao && (
        <p className="text-xs mt-1.5 italic text-[var(--color-text-muted)]">Hipótese: {achado.explicacao}</p>
      )}
      {achado.acaoSugerida && <p className="text-xs mt-2 font-bold" style={{ color: c.texto }}>→ {achado.acaoSugerida}</p>}
    </div>
  );
}

function Cascata({ receita, despesa, resultado }: { receita: number; despesa: number; resultado: number }) {
  const max = Math.max(receita, despesa, Math.abs(resultado), 1);
  const barras = [
    { label: "Receita", valor: receita, cor: "var(--brand-strong, var(--color-primary-dark))" },
    { label: "Despesa", valor: -despesa, cor: "var(--red-strong, var(--red))" },
    { label: "Resultado", valor: resultado, cor: resultado >= 0 ? "var(--brand-strong, var(--color-primary-dark))" : "var(--red-strong, var(--red))" },
  ];
  return (
    <div>
      <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-3">Ponte do resultado</h4>
      <div className="flex items-end gap-5 h-32 px-2 bg-[var(--color-bg)] rounded-xl p-4">
        {barras.map((b) => (
          <div key={b.label} className="flex-1 flex flex-col items-center justify-end h-full">
            <span className="text-sm font-bold mb-1.5">{fmt(Math.abs(b.valor))}</span>
            <div
              className="w-full rounded-t-md transition-all"
              style={{ height: `${Math.max((Math.abs(b.valor) / max) * 100, 4)}%`, background: b.cor }}
            />
            <span className="text-xs font-semibold text-[var(--color-text-muted)] mt-1.5">{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MixRecebimento({ itens }: { itens: ItemMix[] }) {
  const total = itens.reduce((a, i) => a + i.valor, 0);
  const top = itens.slice(0, 8);
  const outros = itens.slice(8).reduce((a, i) => a + i.valor, 0);
  const fatias = outros > 0 ? [...top, { categoria: "Outros", valor: outros }] : top;

  let acumulado = 0;
  const raio = 42, cx = 50, cy = 50, raioInterno = 24;
  const caminhos = fatias.map((f, i) => {
    const inicio = (acumulado / (total || 1)) * 2 * Math.PI;
    acumulado += f.valor;
    const fim = (acumulado / (total || 1)) * 2 * Math.PI;
    const grandeArco = fim - inicio > Math.PI ? 1 : 0;
    const x1 = cx + raio * Math.sin(inicio), y1 = cy - raio * Math.cos(inicio);
    const x2 = cx + raio * Math.sin(fim), y2 = cy - raio * Math.cos(fim);
    const ix1 = cx + raioInterno * Math.sin(inicio), iy1 = cy - raioInterno * Math.cos(inicio);
    const ix2 = cx + raioInterno * Math.sin(fim), iy2 = cy - raioInterno * Math.cos(fim);
    const d = `M ${x1} ${y1} A ${raio} ${raio} 0 ${grandeArco} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${raioInterno} ${raioInterno} 0 ${grandeArco} 0 ${ix1} ${iy1} Z`;
    return { d, cor: CORES_ROSCA[i % CORES_ROSCA.length] };
  });

  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-4">
      <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-3">Mix de recebimento</h4>
      {fatias.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Sem dados de receita no período.</p>
      ) : (
        <div className="flex items-center gap-4 flex-wrap">
          <svg viewBox="0 0 100 100" className="w-28 h-28 shrink-0">
            {caminhos.map((c, i) => (
              <path key={i} d={c.d} fill={c.cor} />
            ))}
          </svg>
          <div className="flex-1 min-w-[160px] space-y-1.5">
            {fatias.map((f, i) => (
              <div key={f.categoria} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-semibold truncate">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CORES_ROSCA[i % CORES_ROSCA.length] }} />
                  {f.categoria}
                </span>
                <span className="font-bold whitespace-nowrap">{total > 0 ? `${((f.valor / total) * 100).toFixed(1)}%` : "0%"} · {fmt(f.valor)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TopFornecedores({ itens }: { itens: ItemMix[] }) {
  const max = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-4">
      <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-3">Maiores fornecedores</h4>
      {itens.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Sem pagamentos a fornecedor no período.</p>
      ) : (
        <div className="space-y-2.5">
          {itens.map((f) => (
            <div key={f.categoria}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-semibold truncate">{f.categoria}</span>
                <span className="text-xs font-bold whitespace-nowrap">{fmt(f.valor)}</span>
              </div>
              <div className="w-full bg-[var(--color-border)] rounded-full h-2">
                <div className="h-2 rounded-full bg-blue-500" style={{ width: `${(f.valor / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VendasPorSemana({ itens }: { itens: SemanaVendas[] }) {
  if (itens.length === 0) return null;
  const max = Math.max(...itens.map((i) => i.valor), 1);
  const br = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  };
  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-4">
      <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-1">Vendas por semana</h4>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">Receita por semana dentro do período analisado (a última semana pode estar incompleta).</p>
      <div className="flex items-end gap-2 h-32">
        {itens.map((s, i) => (
          <div key={s.semanaInicio} className="flex-1 flex flex-col items-center justify-end h-full">
            <span className="text-[10px] font-bold mb-1 whitespace-nowrap">{fmt(s.valor)}</span>
            <div
              className="w-full rounded-t-md"
              style={{
                height: `${Math.max((s.valor / max) * 100, 4)}%`,
                background: i === itens.length - 1 ? "#60a5fa" : "#2563eb",
              }}
            />
            <span className="text-[10px] font-semibold text-[var(--color-text-muted)] mt-1">{br(s.semanaInicio)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetalhamentoRecebimento({ itens }: { itens: DetalheRecebimento[] }) {
  const cartao = itens.filter((i) => i.modalidade.startsWith("Cartão"));
  const pix = itens.filter((i) => i.modalidade.startsWith("Pix"));
  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-4">
      <h4 className="font-bold text-sm uppercase tracking-wide text-[var(--color-text)] mb-1">Detalhamento de cartão e Pix</h4>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">Prazo médio é o tempo real entre a venda e o dinheiro cair na conta, medido nas transações do período.</p>
      {itens.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Sem dado de cartão ou Pix detalhado neste período.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase text-[var(--color-text-muted)] mb-2">Cartão</p>
            {cartao.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">Sem transações de cartão importadas (Conciliação de Cartão) neste período.</p>
            ) : (
              <div className="space-y-2">
                {cartao.map((d) => (
                  <DetalheLinha key={d.modalidade} item={d} />
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase text-[var(--color-text-muted)] mb-2">Pix</p>
            {pix.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">Sem Pix recebido neste período.</p>
            ) : (
              <div className="space-y-2">
                {pix.map((d) => (
                  <DetalheLinha key={d.modalidade} item={d} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetalheLinha({ item }: { item: DetalheRecebimento }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-[var(--color-surface)] rounded-lg px-3 py-2 border border-[var(--color-border)]">
      <div>
        <p className="text-xs font-bold">{item.modalidade}</p>
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {item.pctDoMix.toFixed(1)}% da receita{item.prazoMedioDias !== null ? ` · prazo médio ${item.prazoMedioDias.toFixed(1)} dia(s)` : ""}
        </p>
      </div>
      <p className="text-sm font-extrabold">{fmt(item.valor)}</p>
    </div>
  );
}

function formatarPeriodo(inicio: string, fim: string): string {
  const br = (iso: string) => {
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a}`;
  };
  return inicio === fim ? br(inicio) : `${br(inicio)} a ${br(fim)}`;
}

function corImpressao(classe: ClasseAchado): string {
  if (classe === "critico") return "#dc2626";
  if (classe === "atencao") return "#d97706";
  if (classe === "oportunidade") return "#059669";
  return "#2563eb";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
