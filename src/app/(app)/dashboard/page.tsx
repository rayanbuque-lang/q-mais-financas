"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import EmptyState from "@/components/empty-state";

interface Movimentacao {
  id: string; tipo: string; data: string; valor: number;
  categoria_id: string; observacao: string; revisar: boolean; created_at: string;
}
interface MesGrafico { nome: string; entradas: number; saidas: number; }
interface ContaPendente { id: string; fornecedor: string; valor: number; data_vencimento: string; }

/* ─── DonutRing ──────────────────────────────────────────────── */
function DonutRing({ pct, color, size = 52 }: { pct: number; color: string; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(pct, 100) / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={6} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.8s ease" }} />
    </svg>
  );
}

/* ─── Sparkline ──────────────────────────────────────────────── */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const W = 80, H = 24;
  const max = Math.max(...data, 0.001);
  const min = Math.min(...data, 0);
  const range = max - min || 0.001;
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - 2 - ((v - min) / range) * (H - 6),
  }));
  const line = pts.map(p => `${p.x},${p.y}`).join(" ");
  const fill = `M${pts[0].x},${H} ${pts.map(p => `L${p.x},${p.y}`).join(" ")} L${pts[pts.length - 1].x},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: W, height: H, display: "block" }}>
      <path d={fill} fill={color} fillOpacity={0.15} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Bar+Area Chart (6 months) ──────────────────────────────── */
function BarAreaChart({ data, fmtBRL }: { data: MesGrafico[]; fmtBRL: (v: number) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (!data.length) return null;

  const VW = 520, VH = 180;
  const ML = 50, MR = 8, MT = 14, MB = 28;
  const cW = VW - ML - MR, cH = VH - MT - MB;
  const maxVal = Math.max(...data.flatMap(g => [g.entradas, g.saidas]), 1);
  const gW = cW / data.length;
  const bW = Math.min(gW * 0.28, 22);

  const gx = (i: number) => ML + i * gW + gW / 2;
  const gy = (v: number) => MT + cH - (v / maxVal) * cH;
  const gh = (v: number) => (v / maxVal) * cH;

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  function fmtTick(t: number) {
    const n = maxVal * t;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return n.toFixed(0);
  }

  const areaFill = `M${ML},${MT + cH} ${data.map((g, i) => `L${gx(i)},${gy(g.entradas)}`).join(" ")} L${VW - MR},${MT + cH} Z`;
  const areaLine = data.map((g, i) => `${i === 0 ? "M" : "L"}${gx(i)},${gy(g.entradas)}`).join(" ");

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", overflow: "visible" }}>
        {/* Grid */}
        {ticks.map(t => {
          const y = MT + cH * (1 - t);
          return (
            <g key={t}>
              <line x1={ML} y1={y} x2={VW - MR} y2={y}
                stroke="var(--border)" strokeWidth={t === 0 ? 1.5 : 0.8}
                strokeDasharray={t === 0 ? undefined : "3,3"} />
              <text x={ML - 6} y={y + 4} textAnchor="end" fill="var(--text-muted)" fontSize={9}>
                {fmtTick(t)}
              </text>
            </g>
          );
        })}

        {/* Area fill + line */}
        <path d={areaFill} fill="var(--green)" fillOpacity={0.06} />
        <path d={areaLine} fill="none" stroke="var(--green)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.35} />

        {/* Bars */}
        {data.map((g, i) => {
          const x = gx(i);
          const hot = hovered === i;
          return (
            <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style={{ cursor: "default" }}>
              <rect x={ML + i * gW} y={MT} width={gW} height={cH} fill="transparent" />
              {g.entradas > 0 && (
                <rect x={x - bW - 2} y={gy(g.entradas)} width={bW} height={gh(g.entradas)}
                  rx={3} fill={hot ? "var(--green)" : "var(--green-border)"} style={{ transition: "fill 0.15s" }} />
              )}
              {g.saidas > 0 && (
                <rect x={x + 2} y={gy(g.saidas)} width={bW} height={gh(g.saidas)}
                  rx={3} fill={hot ? "var(--red)" : "var(--red-border)"} style={{ transition: "fill 0.15s" }} />
              )}
              <circle cx={x} cy={gy(g.entradas)} r={hot ? 4 : 2.5}
                fill="var(--surface)" stroke="var(--green)" strokeWidth={1.5}
                style={{ transition: "r 0.15s" }} />
              <text x={x} y={VH - 5} textAnchor="middle"
                fill={hot ? "var(--text)" : "var(--text-muted)"}
                fontSize={10} fontWeight={hot ? "600" : "400"}>
                {g.nome}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hovered !== null && (
        <div style={{
          position: "absolute", top: 8,
          left: `${((hovered + 0.5) / data.length) * 100}%`,
          transform: `translateX(${hovered >= data.length - 2 ? "-105%" : "-5%"})`,
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "10px 14px",
          boxShadow: "var(--shadow)", minWidth: 152, zIndex: 10, pointerEvents: "none",
        }}>
          <p style={{ fontWeight: 700, fontSize: 12, color: "var(--text)", marginBottom: 7, textTransform: "capitalize" }}>
            {data[hovered].nome}
          </p>
          {[
            { label: "Entrada", val: data[hovered].entradas, color: "var(--green)" },
            { label: "Saída", val: data[hovered].saidas, color: "var(--red)" },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 3 }}>
              <span style={{ fontSize: 11, color }}>{label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{fmtBRL(val)}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Saldo</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: data[hovered].entradas - data[hovered].saidas >= 0 ? "var(--green)" : "var(--red)" }}>
              {fmtBRL(data[hovered].entradas - data[hovered].saidas)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Waterfall Chart ────────────────────────────────────────── */
function WaterfallChart({ receita, saidas, fmtBRL }: { receita: number; saidas: number; fmtBRL: (v: number) => string }) {
  const saldo = receita - saidas;
  if (receita === 0 && saidas === 0) return (
    <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted)", padding: "24px 0" }}>Nenhum dado neste mês</p>
  );

  const W = 300, H = 160;
  const ML = 6, MR = 6, MT = 36, MB = 28;
  const cW = W - ML - MR, cH = H - MT - MB;
  const maxVal = Math.max(receita, 1);
  const bW = cW * 0.18;
  const sp = cW / 3;

  const x0 = ML + sp * 0.5 - bW / 2;
  const x1 = ML + sp * 1.5 - bW / 2;
  const x2 = ML + sp * 2.5 - bW / 2;
  const cx = (x: number) => x + bW / 2;

  const baseY = MT + cH;
  const rH = (receita / maxVal) * cH;
  const sH = (saidas / maxVal) * cH;
  const salH = (Math.abs(saldo) / maxVal) * cH;

  const rTopY = baseY - rH;
  const sTopY = rTopY;
  const salTopY = saldo >= 0 ? baseY - salH : baseY;

  function fmtK(v: number) {
    if (v >= 1e6) return `R$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return `R$${v.toFixed(0)}`;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%" }}>
      <line x1={ML} y1={baseY} x2={W - MR} y2={baseY} stroke="var(--border)" strokeWidth={1.5} />

      {/* Receita */}
      <rect x={x0} y={rTopY} width={bW} height={rH} rx={4} fill="var(--green)" />
      <line x1={x0 + bW} y1={rTopY} x2={x1} y2={rTopY} stroke="var(--border-strong)" strokeWidth={1.5} strokeDasharray="4,3" />

      {/* Saídas (floating) */}
      <rect x={x1} y={sTopY} width={bW} height={sH} rx={4} fill="var(--red)" />
      <line x1={x1 + bW} y1={sTopY + sH} x2={x2} y2={sTopY + sH} stroke="var(--border-strong)" strokeWidth={1.5} strokeDasharray="4,3" />

      {/* Saldo */}
      <rect x={x2} y={salTopY} width={bW} height={Math.max(salH, 4)} rx={4} fill={saldo >= 0 ? "var(--brand)" : "var(--red-muted)"} />

      {/* Labels */}
      <text x={cx(x0)} y={rTopY - 7} textAnchor="middle" fill="var(--green-strong)" fontSize={9} fontWeight="700">{fmtK(receita)}</text>
      <text x={cx(x1)} y={sTopY - 7} textAnchor="middle" fill="var(--red-strong)" fontSize={9} fontWeight="700">-{fmtK(saidas)}</text>
      <text x={cx(x2)} y={salTopY - 7} textAnchor="middle" fill={saldo >= 0 ? "var(--brand-strong)" : "var(--red-strong)"} fontSize={9} fontWeight="700">
        {saldo < 0 ? "-" : ""}{fmtK(Math.abs(saldo))}
      </text>

      <text x={cx(x0)} y={H - 4} textAnchor="middle" fill="var(--text-muted)" fontSize={10}>Receita</text>
      <text x={cx(x1)} y={H - 4} textAnchor="middle" fill="var(--text-muted)" fontSize={10}>Saídas</text>
      <text x={cx(x2)} y={H - 4} textAnchor="middle" fill="var(--text-muted)" fontSize={10}>Saldo</text>
    </svg>
  );
}

/* ─── Heatmap Calendar ───────────────────────────────────────── */
function HeatmapCalendar({ movimentos, fmtBRL }: { movimentos: Movimentacao[]; fmtBRL: (v: number) => string }) {
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth(), today = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();

  const byDay = new Map<number, { e: number; s: number }>();
  movimentos.forEach(m => {
    const d = parseInt(m.data.split("-")[2]);
    const prev = byDay.get(d) || { e: 0, s: 0 };
    byDay.set(d, m.tipo === "entrada"
      ? { ...prev, e: prev.e + m.valor }
      : { ...prev, s: prev.s + m.valor });
  });

  const maxTotal = Math.max(...Array.from(byDay.values()).map(d => d.e + d.s), 1);
  const offset = firstDow === 0 ? 6 : firstDow - 1;
  const total = offset + daysInMonth;
  const days = Array.from({ length: Math.ceil(total / 7) * 7 }, (_, i) => {
    const d = i - offset + 1;
    return d >= 1 && d <= daysInMonth ? d : null;
  });

  const CELL = 26, GAP = 3;
  const DOW = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

  function getBg(day: number | null): string {
    if (!day) return "transparent";
    const d = byDay.get(day);
    if (!d) return "var(--border-subtle)";
    const intensity = (d.e + d.s) / maxTotal;
    const net = d.e - d.s;
    if (net >= 0) {
      if (intensity < 0.2) return "var(--green-subtle)";
      if (intensity < 0.55) return "var(--green-muted)";
      return "var(--green-border)";
    }
    return intensity < 0.4 ? "var(--red-subtle)" : "var(--red-muted)";
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP, marginBottom: GAP }}>
        {DOW.map(d => (
          <div key={d} style={{ width: CELL, textAlign: "center", fontSize: 9, color: "var(--text-placeholder)", fontWeight: 500 }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP }}>
        {days.map((day, i) => {
          if (!day) return <div key={i} style={{ width: CELL, height: CELL }} />;
          const d = byDay.get(day);
          const isToday = day === today;
          return (
            <div key={i}
              title={d ? `Dia ${day}: E ${fmtBRL(d.e)} / S ${fmtBRL(d.s)}` : `Dia ${day}`}
              style={{
                width: CELL, height: CELL, borderRadius: 5,
                background: getBg(day),
                border: isToday ? "2px solid var(--brand)" : "1px solid var(--border-subtle)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: isToday ? 700 : 500,
                color: d ? "var(--text)" : "var(--text-placeholder)",
              }}>
              {day}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
        {[
          { bg: "var(--green-muted)", label: "Saldo +" },
          { bg: "var(--red-muted)", label: "Saldo –" },
          { bg: "var(--border-subtle)", label: "Sem mov." },
        ].map(({ bg, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: bg }} />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Main ───────────────────────────────────────────────────── */
export default function DashboardPage() {
  const [movAtual, setMovAtual] = useState<Movimentacao[]>([]);
  const [movAnterior, setMovAnterior] = useState<Movimentacao[]>([]);
  const [movRecentes, setMovRecentes] = useState<Movimentacao[]>([]);
  const [grafico, setGrafico] = useState<MesGrafico[]>([]);
  const [contasPendentes, setContasPendentes] = useState<ContaPendente[]>([]);
  const [loading, setLoading] = useState(true);
  const [recentesNomes, setRecentesNomes] = useState<Record<string, string>>({});
  const [metaMensal, setMetaMensal] = useState(0);
  const [metaId, setMetaId] = useState<string | null>(null);
  const [editandoMeta, setEditandoMeta] = useState(false);
  const [inputMeta, setInputMeta] = useState("");
  const supabase = createClient();

  const now = new Date();
  const mesAtual = now.getMonth();
  const anoAtual = now.getFullYear();
  const hoje = now.toISOString().split("T")[0];
  const saudacao = now.getHours() < 12 ? "Bom dia" : now.getHours() < 18 ? "Boa tarde" : "Boa noite";
  const nomeMes = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const dataCompleta = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  function fmt(v: number) {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function variacao(atual: number, anterior: number) {
    if (anterior === 0) return null;
    return ((atual - anterior) / anterior) * 100;
  }

  async function carregarDados() {
    setLoading(true);
    const pad = (n: number) => String(n).padStart(2, "0");
    const inicioAtual = `${anoAtual}-${pad(mesAtual + 1)}-01`;
    const fimAtual = `${anoAtual}-${pad(mesAtual + 1)}-${pad(new Date(anoAtual, mesAtual + 1, 0).getDate())}`;
    let mesAnt = mesAtual - 1, anoAnt = anoAtual;
    if (mesAnt < 0) { mesAnt = 11; anoAnt--; }
    const inicioAnt = `${anoAnt}-${pad(mesAnt + 1)}-01`;
    const fimAnt = `${anoAnt}-${pad(mesAnt + 1)}-${pad(new Date(anoAnt, mesAnt + 1, 0).getDate())}`;

    const [r1, r2, r3, r4, r5, r6] = await Promise.all([
      supabase.from("movimentacoes").select("*").gte("data", inicioAtual).lte("data", fimAtual),
      supabase.from("movimentacoes").select("*").gte("data", inicioAnt).lte("data", fimAnt),
      supabase.from("movimentacoes").select("*").order("created_at", { ascending: false }).limit(5),
      supabase.from("contas_pagar").select("*").eq("status", "pendente").order("data_vencimento"),
      supabase.from("movimentacoes").select("tipo,valor,data"),
      supabase.from("metas").select("id,valor_meta").eq("tipo", "receita").eq("mes", mesAtual + 1).eq("ano", anoAtual).maybeSingle(),
    ]);

    if (r1.data) setMovAtual(r1.data);
    if (r2.data) setMovAnterior(r2.data);
    if (r3.data) setMovRecentes(r3.data);
    if (r4.data) setContasPendentes(r4.data);
    if (r6.data) { setMetaMensal(r6.data.valor_meta); setMetaId(r6.data.id); }

    const todosMovs = r5.data || [];
    const graficoData: MesGrafico[] = [];
    for (let i = 5; i >= 0; i--) {
      let gMes = mesAtual - i, gAno = anoAtual;
      if (gMes < 0) { gMes += 12; gAno--; }
      const gInicio = `${gAno}-${pad(gMes + 1)}-01`;
      const gFim = `${gAno}-${pad(gMes + 1)}-${pad(new Date(gAno, gMes + 1, 0).getDate())}`;
      const gMovs = todosMovs.filter(m => m.data >= gInicio && m.data <= gFim);
      graficoData.push({
        nome: new Date(gAno, gMes).toLocaleDateString("pt-BR", { month: "short" }),
        entradas: gMovs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0),
        saidas: gMovs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0),
      });
    }
    setGrafico(graficoData);
    setLoading(false);
  }

  async function carregarNomesRecentes() {
    const nomes: Record<string, string> = {};
    for (const mov of movRecentes) {
      const tabela = mov.tipo === "entrada" ? "categorias_entrada" : "categorias_saida";
      const { data } = await supabase.from(tabela).select("nome").eq("id", mov.categoria_id).single();
      nomes[mov.id] = data?.nome || "Sem categoria";
    }
    setRecentesNomes(nomes);
  }

  useEffect(() => { carregarDados(); }, []);
  useEffect(() => { if (movRecentes.length > 0) carregarNomesRecentes(); }, [movRecentes]);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 320 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 36, height: 36, border: "3px solid var(--brand-muted)", borderTopColor: "var(--brand)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 10px" }} />
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Carregando...</p>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );

  /* ── Cálculos base ── */
  const eAtual = movAtual.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
  const sAtual = movAtual.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
  const lucro = eAtual - sAtual;
  const margem = eAtual > 0 ? (lucro / eAtual) * 100 : 0;
  const eAnterior = movAnterior.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
  const sAnterior = movAnterior.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
  const varReceita = variacao(eAtual, eAnterior);
  const varDespesa = variacao(sAtual, sAnterior);
  const revisaoCount = movAtual.filter(m => m.revisar).length;
  const contasHoje = contasPendentes.filter(c => c.data_vencimento === hoje);
  const totalContasHoje = contasHoje.reduce((a, c) => a + c.valor, 0);
  const contasVencidas = contasPendentes.filter(c => c.data_vencimento < hoje);

  /* ── Sparklines ── */
  const spEntradas = grafico.map(g => g.entradas);
  const spSaidas = grafico.map(g => g.saidas);
  const spLucro = grafico.map(g => g.entradas - g.saidas);
  const spMargem = grafico.map(g => g.entradas > 0 ? (g.entradas - g.saidas) / g.entradas * 100 : 0);

  /* ── Saúde ── */
  let saude = { cor: "var(--green)", bg: "var(--green-subtle)", bdr: "var(--green-border)", label: "Excelente", icon: "🟢" };
  if (margem < 0) saude = { cor: "var(--red)", bg: "var(--red-subtle)", bdr: "var(--red-border)", label: "Crítica", icon: "🔴" };
  else if (margem < 10) saude = { cor: "var(--amber)", bg: "var(--amber-subtle)", bdr: "var(--amber-border)", label: "Atenção", icon: "🟡" };
  else if (margem < 20) saude = { cor: "var(--green)", bg: "var(--green-subtle)", bdr: "var(--green-border)", label: "Boa", icon: "🟢" };

  let resumoTexto = movAtual.length === 0
    ? "Nenhuma movimentação registrada este mês. Comece cadastrando entradas e saídas."
    : lucro > 0 && varReceita !== null && varReceita > 0
      ? `Receita cresceu ${varReceita.toFixed(1)}%. Lucro de ${fmt(lucro)} com margem de ${margem.toFixed(1)}%.`
      : lucro > 0 ? `Lucro de ${fmt(lucro)} com margem de ${margem.toFixed(1)}%.`
        : lucro < 0 ? `Atenção: despesas superaram receita em ${fmt(Math.abs(lucro))}.`
          : "Receita e despesas empatadas.";

  /* ── Novos cálculos ── */
  const diaAtual = now.getDate();
  const diasNoMes = new Date(anoAtual, mesAtual + 1, 0).getDate();
  const percMes = (diaAtual / diasNoMes) * 100;

  const percMeta = metaMensal > 0 ? Math.min((eAtual / metaMensal) * 100, 100) : 0;

  const receitaProjetada = percMes > 0 ? (eAtual / percMes) * 100 : 0;

  const hoje7 = new Date(); hoje7.setDate(hoje7.getDate() + 7);
  const hoje7Str = hoje7.toISOString().split("T")[0];
  const contasProximas7 = contasPendentes.filter(c => c.data_vencimento >= hoje && c.data_vencimento <= hoje7Str);
  const totalProximas7 = contasProximas7.reduce((a, c) => a + c.valor, 0);

  const ticketMedio = movAtual.filter(m => m.tipo === "entrada").length > 0
    ? eAtual / movAtual.filter(m => m.tipo === "entrada").length : 0;

  /* ── Totais do mês para heatmap ── */
  const totalEntradasMes = movAtual.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
  const totalSaidasMes = movAtual.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);

  /* ── KPI card helper ── */
  const card = (
    label: string, valor: string, icon: string,
    color: string, subtle: string,
    trend: number | null, ehDespesa: boolean,
    spData: number[], spColor: string
  ) => (
    <Link href={`/movimentacoes?mes=${mesAtual + 1}&ano=${anoAtual}`}
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "16px 18px", display: "block", textDecoration: "none", transition: "box-shadow 0.2s, border-color 0.2s" }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--brand-border)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = ""; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>{label}</span>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: subtle, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>{icon}</div>
      </div>
      <p style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em", color, margin: 0 }}>{valor}</p>
      {trend !== null && (
        <p style={{ fontSize: 10, marginTop: 2, fontWeight: 500, color: ehDespesa ? (trend > 0 ? "var(--red)" : "var(--green)") : (trend > 0 ? "var(--green)" : "var(--red)") }}>
          {trend > 0 ? "↑" : "↓"} {Math.abs(trend).toFixed(1)}% vs mês anterior
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <Sparkline data={spData} color={spColor} />
      </div>
    </Link>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* ── HEADER ── */}
      <div className="animate-fade-up" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text)", margin: 0 }}>{saudacao}!</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 3, textTransform: "capitalize" }}>{dataCompleta}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, fontWeight: 600 }}>DIA {diaAtual} DE {diasNoMes}</p>
          <div style={{ height: 4, width: 120, background: "var(--border)", borderRadius: 99, overflow: "hidden", marginTop: 5 }}>
            <div style={{ height: "100%", width: `${percMes}%`, background: "var(--brand)", borderRadius: 99, transition: "width 0.8s ease" }} />
          </div>
          <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3, margin: "3px 0 0" }}>{percMes.toFixed(0)}% do mês concluído</p>
        </div>
      </div>

      {/* ── ALERTAS (tira compacta) ── */}
      {(contasVencidas.length > 0 || contasHoje.length > 0 || revisaoCount > 0) && (
        <div className="animate-fade-up delay-1" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {contasVencidas.length > 0 && (
            <div style={{ background: "var(--red-subtle)", border: "1px solid var(--red-border)", borderRadius: "var(--radius)", padding: "10px 14px", flex: 1, minWidth: 160 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--red)", margin: 0 }}>🚨 {contasVencidas.length} vencida{contasVencidas.length > 1 ? "s" : ""}</p>
              <p style={{ fontSize: 11, color: "var(--red-strong)", margin: "2px 0 0" }}>{fmt(contasVencidas.reduce((a, c) => a + c.valor, 0))}</p>
            </div>
          )}
          {contasHoje.length > 0 && (
            <div style={{ background: "var(--blue-subtle)", border: "1px solid var(--blue-border)", borderRadius: "var(--radius)", padding: "10px 14px", flex: 1, minWidth: 160 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--blue-strong)", margin: 0 }}>📅 {contasHoje.length} vence{contasHoje.length > 1 ? "m" : ""} hoje</p>
              <p style={{ fontSize: 11, color: "var(--blue)", margin: "2px 0 0" }}>{fmt(totalContasHoje)}</p>
            </div>
          )}
          {revisaoCount > 0 && (
            <Link href="/movimentacoes" style={{ background: "var(--amber-subtle)", border: "1px solid var(--amber-border)", borderRadius: "var(--radius)", padding: "10px 14px", flex: 1, minWidth: 160, textDecoration: "none", display: "block" }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--amber-strong)", margin: 0 }}>⚠️ {revisaoCount} para revisar</p>
              <p style={{ fontSize: 11, color: "var(--amber)", margin: "2px 0 0" }}>Movimentações</p>
            </Link>
          )}
        </div>
      )}

      {/* ── SAÚDE + KPIs ── */}
      <div className="animate-fade-up delay-1" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 14 }}>
        {/* Saúde */}
        <div style={{ background: saude.bg, border: `1px solid ${saude.bdr}`, borderRadius: "var(--radius-lg)", padding: "20px 18px", minWidth: 148, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 8 }}>
          <DonutRing pct={margem < 0 ? 0 : Math.min(margem * 3, 100)} color={saude.cor} size={64} />
          <p style={{ fontSize: 18, margin: 0 }}>{saude.icon}</p>
          <p style={{ fontSize: 11, fontWeight: 700, color: saude.cor, textAlign: "center", margin: 0 }}>Saúde {saude.label}</p>
          <p style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", margin: 0 }}>Margem {margem.toFixed(1)}%</p>
          <p style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", margin: 0, maxWidth: 120 }}>{resumoTexto}</p>
        </div>

        {/* KPI 2x2 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {card("Receita", fmt(eAtual), "📈", "var(--green)", "var(--green-subtle)", varReceita, false, spEntradas, "var(--green)")}
          {card("Despesas", fmt(sAtual), "📉", "var(--red)", "var(--red-subtle)", varDespesa, true, spSaidas, "var(--red)")}
          {card("Saldo Líquido", fmt(lucro), "💰", lucro >= 0 ? "var(--green)" : "var(--red)", lucro >= 0 ? "var(--green-subtle)" : "var(--red-subtle)", null, false, spLucro, lucro >= 0 ? "var(--green)" : "var(--red)")}
          {card("Ticket Médio", fmt(ticketMedio), "🎯", "var(--brand)", "var(--purple-subtle)", null, false, spEntradas, "var(--brand)")}
        </div>
      </div>

      {/* ── GRÁFICOS ── */}
      <div className="animate-fade-up delay-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Esquerdo: 6 meses */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "20px 20px 14px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: 0 }}>Últimos 6 Meses</p>
              <p style={{ fontSize: 10, color: "var(--text-placeholder)", margin: "2px 0 0" }}>Passe o mouse sobre os meses</p>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              {[{ color: "var(--green-border)", label: "Entradas" }, { color: "var(--red-border)", label: "Saídas" }].map(({ color, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
          {movAtual.length === 0 && grafico.every(g => g.entradas === 0 && g.saidas === 0) ? (
            <EmptyState variant="movements" title="Sem dados ainda" description="Lance suas primeiras movimentações para ver o histórico." compact />
          ) : (
            <BarAreaChart data={grafico} fmtBRL={fmt} />
          )}
        </div>

        {/* Direito: Fluxo do mês + projeção */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "20px", flex: 1 }}>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: "0 0 14px" }}>Fluxo do Mês</p>
            <WaterfallChart receita={eAtual} saidas={sAtual} fmtBRL={fmt} />

            {/* Variações */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              {[
                { label: "vs Mês (Receita)", val: varReceita, ehDespesa: false },
                { label: "vs Mês (Despesa)", val: varDespesa, ehDespesa: true },
              ].map(({ label, val, ehDespesa }) => (
                <div key={label}>
                  <p style={{ fontSize: 10, color: "var(--text-muted)", margin: "0 0 2px" }}>{label}</p>
                  {val !== null ? (
                    <p style={{ fontSize: 12, fontWeight: 700, margin: 0, color: ehDespesa ? (val > 0 ? "var(--red)" : "var(--green)") : (val > 0 ? "var(--green)" : "var(--red)") }}>
                      {val > 0 ? "↑" : "↓"} {Math.abs(val).toFixed(1)}%
                    </p>
                  ) : <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>—</p>}
                </div>
              ))}
            </div>

            {/* Projeção */}
            <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--hover-bg)", borderRadius: "var(--radius)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0 }}>Projeção do mês</p>
                <p style={{ fontSize: 14, fontWeight: 700, margin: 0, color: receitaProjetada > eAtual ? "var(--green)" : "var(--text)" }}>
                  {fmt(receitaProjetada)}
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0 }}>Dia {diaAtual}/{diasNoMes}</p>
                <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: 0 }}>{percMes.toFixed(0)}% concluído</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── PRÓXIMOS 7 DIAS + ATIVIDADE RECENTE ── */}
      <div className="animate-fade-up delay-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Próximos 7 dias */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: 0 }}>
              Próximos 7 Dias — A Pagar
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: totalProximas7 > 0 ? "var(--red)" : "var(--text-muted)" }}>{fmt(totalProximas7)}</span>
              <Link href="/contas-pagar" style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", textDecoration: "none" }}>Ver →</Link>
            </div>
          </div>
          {contasProximas7.length === 0 ? (
            <div style={{ padding: "24px 20px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>✓ Nenhuma conta nos próximos 7 dias</p>
            </div>
          ) : (
            <div>
              {contasProximas7.slice(0, 5).map(c => {
                const d = new Date(c.data_vencimento + "T12:00:00");
                const isHoje = c.data_vencimento === hoje;
                return (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderBottom: "1px solid var(--border-subtle)", transition: "background 0.15s" }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--hover-bg)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ""}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: isHoje ? "var(--red-subtle)" : "var(--amber-subtle)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: isHoje ? "var(--red)" : "var(--amber-strong)", lineHeight: 1 }}>{d.getDate()}</span>
                        <span style={{ fontSize: 8, color: isHoje ? "var(--red)" : "var(--amber)", lineHeight: 1 }}>{d.toLocaleDateString("pt-BR", { month: "short" })}</span>
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>{c.fornecedor}</p>
                        {isHoje && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--red)" }}>HOJE</span>}
                      </div>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: isHoje ? "var(--red)" : "var(--text)" }}>{fmt(c.valor)}</span>
                  </div>
                );
              })}
              {contasProximas7.length > 5 && (
                <div style={{ padding: "10px 20px", textAlign: "center" }}>
                  <Link href="/contas-pagar" style={{ fontSize: 12, color: "var(--brand)", fontWeight: 600, textDecoration: "none" }}>
                    +{contasProximas7.length - 5} mais →
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Atividade recente */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: 0 }}>Atividade Recente</p>
            <Link href="/movimentacoes" style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", textDecoration: "none" }}>Ver todas →</Link>
          </div>
          {movRecentes.length === 0 ? (
            <EmptyState variant="movements" title="Sem movimentações" description="Nenhuma movimentação registrada ainda." compact
              action={{ label: "Registrar agora", href: "/movimentacoes" }} />
          ) : (
            <div>
              {movRecentes.map(mov => (
                <div key={mov.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--border-subtle)", transition: "background 0.15s" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--hover-bg)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ""}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0, background: mov.tipo === "entrada" ? "var(--green-subtle)" : "var(--red-subtle)", color: mov.tipo === "entrada" ? "var(--green)" : "var(--red)" }}>
                      {mov.tipo === "entrada" ? "▲" : "▼"}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                        {recentesNomes[mov.id] || "..."}
                      </p>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                        {new Date(mov.data + "T12:00:00").toLocaleDateString("pt-BR")}
                        {mov.observacao && ` · ${mov.observacao}`}
                      </p>
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, flexShrink: 0, color: mov.tipo === "entrada" ? "var(--green)" : "var(--red)" }}>
                    {mov.tipo === "entrada" ? "+" : "–"} {fmt(mov.valor)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── HEATMAP ── */}
      <div className="animate-fade-up delay-3" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: 0 }}>
            Atividade do Mês — <span style={{ textTransform: "capitalize" }}>{nomeMes}</span>
          </p>
          <div style={{ display: "flex", gap: 16 }}>
            <div>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Entradas </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--green)" }}>{fmt(totalEntradasMes)}</span>
            </div>
            <div>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Saídas </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--red)" }}>{fmt(totalSaidasMes)}</span>
            </div>
          </div>
        </div>
        {movAtual.length === 0 ? (
          <EmptyState variant="default" title="Sem atividade" compact />
        ) : (
          <HeatmapCalendar movimentos={movAtual} fmtBRL={fmt} />
        )}
      </div>

      {/* ── META + AÇÕES RÁPIDAS ── */}
      <div className="animate-fade-up delay-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Meta mensal */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: 0 }}>Meta de Receita</p>
              {metaMensal > 0 ? (
                <p style={{ fontSize: 13, fontWeight: 700, margin: "3px 0 0", color: "var(--text)" }}>
                  {fmt(eAtual)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>de {fmt(metaMensal)}</span>
                </p>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "3px 0 0" }}>Nenhuma meta definida</p>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {metaMensal > 0 && (
                <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <DonutRing pct={percMeta} color={eAtual >= metaMensal ? "var(--green)" : "var(--amber)"} size={48} />
                  <span style={{ position: "absolute", fontSize: 9, fontWeight: 800, color: eAtual >= metaMensal ? "var(--green)" : "var(--amber)" }}>
                    {Math.round(percMeta)}%
                  </span>
                </div>
              )}
              <button
                onClick={() => { setEditandoMeta(true); setInputMeta(metaMensal > 0 ? metaMensal.toFixed(2) : ""); }}
                style={{ fontSize: 12, padding: "6px 14px", borderRadius: "var(--radius-sm)", background: "var(--hover-bg)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text)", fontWeight: 500 }}>
                {metaMensal > 0 ? "Editar" : "Definir meta"}
              </button>
            </div>
          </div>
          {metaMensal > 0 && (
            <>
              <div style={{ width: "100%", height: 8, background: "var(--hover-bg)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min((eAtual / metaMensal) * 100, 100)}%`, background: eAtual >= metaMensal ? "var(--green)" : "var(--amber)", borderRadius: 99, transition: "width 0.7s ease" }} />
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                {eAtual >= metaMensal ? "✓ Meta atingida!" : `Faltam ${fmt(metaMensal - eAtual)} para a meta`}
              </p>
            </>
          )}
          {editandoMeta && (
            <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" step="0.01" placeholder="Valor da meta (R$)" value={inputMeta}
                onChange={e => setInputMeta(e.target.value)}
                style={{ flex: 1, padding: "8px 12px", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--input-bg)", fontSize: 13, color: "var(--text)" }} />
              <button onClick={async () => {
                const v = parseFloat(inputMeta.replace(",", "."));
                if (isNaN(v) || v <= 0) return;
                if (metaId) {
                  await supabase.from("metas").update({ valor_meta: v }).eq("id", metaId);
                } else {
                  const { data } = await supabase.from("metas").insert({ tipo: "receita", categoria_id: null, mes: mesAtual + 1, ano: anoAtual, valor_meta: v }).select("id").single();
                  if (data) setMetaId(data.id);
                }
                setMetaMensal(v); setEditandoMeta(false);
              }} style={{ padding: "8px 16px", background: "var(--brand)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Salvar
              </button>
              <button onClick={() => setEditandoMeta(false)}
                style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: 13, cursor: "pointer", background: "var(--hover-bg)", color: "var(--text)" }}>✕</button>
            </div>
          )}
        </div>

        {/* Ações rápidas */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "20px" }}>
          <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", margin: "0 0 16px" }}>Ações Rápidas</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { href: "/movimentacoes", icon: "💰", label: "Nova Entrada", bg: "var(--green-subtle)", color: "var(--green-strong)", hbg: "var(--green-muted)" },
              { href: "/movimentacoes", icon: "📤", label: "Nova Saída", bg: "var(--red-subtle)", color: "var(--red-strong)", hbg: "var(--red-muted)" },
              { href: "/contas-pagar", icon: "📋", label: "Contas a Pagar", bg: "var(--amber-subtle)", color: "var(--amber-strong)", hbg: "var(--amber-muted)" },
              { href: "/analise", icon: "🧠", label: "Análise IA", bg: "var(--purple-subtle)", color: "var(--purple)", hbg: "var(--purple-muted)" },
              { href: "/fechamento-caixa", icon: "🧮", label: "Fechamento", bg: "var(--cyan-subtle)", color: "var(--cyan)", hbg: "var(--cyan-border)" },
              { href: "/relatorios", icon: "📄", label: "Relatórios", bg: "var(--blue-subtle)", color: "var(--blue-strong)", hbg: "var(--blue-muted)" },
            ].map(({ href, icon, label, bg, color, hbg }) => (
              <Link key={href + label} href={href}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 10px", borderRadius: "var(--radius)", background: bg, textDecoration: "none", transition: "background 0.2s" }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = hbg}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = bg}>
                <span style={{ fontSize: 22 }}>{icon}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color, textAlign: "center", lineHeight: 1.2 }}>{label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
