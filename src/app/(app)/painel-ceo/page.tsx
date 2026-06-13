"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

interface DiaResumo { data: string; dia: number; semana: string; totalVendas: number; dinheiro: number; cartao: number; pix: number; outros: number; }
interface Meta { meta_mensal: number; meta_diaria: number; }
interface MovResumo { tipo: string; valor: number; categoria_id: string; data: string; }
interface CatInfo { id: string; nome: string; }

export default function PainelCeoPage() {
  const router = useRouter();
  const [acessoPermitido, setAcessoPermitido] = useState<boolean | null>(null);
  const verificouRef = useRef(false);

  const [mes, setMes] = useState(new Date().getMonth() + 1);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [analiseIA, setAnaliseIA] = useState("");
  const [carregandoIA, setCarregandoIA] = useState(false);

  const [caixas, setCaixas] = useState<DiaResumo[]>([]);
  const [meta, setMeta] = useState<Meta>({ meta_mensal: 0, meta_diaria: 0 });
  const [metaEditando, setMetaEditando] = useState(false);
  const [metaMensal, setMetaMensal] = useState("");
  const [metaDiaria, setMetaDiaria] = useState("");
  const [movs, setMovs] = useState<MovResumo[]>([]);
  const [cats, setCats] = useState<CatInfo[]>([]);
  const [contasPendentes, setContasPendentes] = useState(0);
  const [contasVencidas, setContasVencidas] = useState(0);
  const [diasFechados, setDiasFechados] = useState(0);
  const [totalDiasComDados, setTotalDiasComDados] = useState(0);

  const supabase = createClient();

  // Verificar acesso
  useEffect(() => {
    if (verificouRef.current) return;
    verificouRef.current = true;
    async function verificar() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      if (!profile || profile.role !== "master") {
        setAcessoPermitido(false);
      } else {
        setAcessoPermitido(true);
      }
    }
    verificar();
  }, []);

  async function carregarDados() {
    setLoading(true);
    const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const [r1, r2, r3, r4, r5] = await Promise.all([
      supabase.from("fechamento_caixa").select("*").gte("data", inicio).lte("data", fim).order("data"),
      supabase.from("metas_vendas").select("*").eq("mes", mes).eq("ano", ano).limit(1),
      supabase.from("movimentacoes").select("*").gte("data", inicio).lte("data", fim),
      supabase.from("contas_pagar").select("status,data_vencimento,valor").eq("status", "pendente").gte("data_vencimento", inicio).lte("data_vencimento", fim),
      supabase.from("categorias_entrada").select("id,nome").eq("ativo", true),
    ]);

    const caixasData = (r1.data || []) as { data: string; valor_total_vendas: number; dinheiro: number; cartao: number; pix_santander: number; pix_inter: number; rom_card: number; app: number; prefeitura: number; fechado: boolean }[];

    const diasResumo: DiaResumo[] = caixasData.map(c => ({
      data: c.data,
      dia: new Date(c.data + "T12:00:00").getDate(),
      semana: diasSemana[new Date(c.data + "T12:00:00").getDay()],
      totalVendas: c.valor_total_vendas || 0,
      dinheiro: c.dinheiro || 0,
      cartao: c.cartao || 0,
      pix: (c.pix_santander || 0) + (c.pix_inter || 0),
      outros: (c.rom_card || 0) + (c.app || 0) + (c.prefeitura || 0),
    }));

    setCaixas(diasResumo);
    setDiasFechados(caixasData.filter(c => c.fechado).length);
    setTotalDiasComDados(caixasData.length);

    if (r2.data && r2.data.length > 0) {
      const m = r2.data[0] as Meta;
      setMeta(m);
      setMetaMensal(m.meta_mensal.toString().replace(".", ","));
      setMetaDiaria(m.meta_diaria.toString().replace(".", ","));
    } else {
      setMeta({ meta_mensal: 0, meta_diaria: 0 });
      setMetaMensal(""); setMetaDiaria("");
    }

    setMovs((r3.data || []) as MovResumo[]);
    const contas = r4.data || [];
    setContasPendentes(contas.length);
    setContasVencidas(contas.filter(c => c.data_vencimento < new Date().toISOString().split("T")[0]).length);
    setCats((r5.data || []) as CatInfo[]);

    setLoading(false);
  }

  useEffect(() => { if (acessoPermitido) carregarDados(); setAnaliseIA(""); }, [mes, ano, acessoPermitido]);

  async function salvarMeta() {
    const mm = parseFloat(metaMensal.replace(",", "."));
    const md = parseFloat(metaDiaria.replace(",", "."));
    await supabase.from("metas_vendas").upsert({ mes, ano, meta_mensal: mm, meta_diaria: md }, { onConflict: "mes,ano" });
    setMeta({ meta_mensal: mm, meta_diaria: md });
    setMetaEditando(false);
  }

  async function gerarAnalise() {
    setCarregandoIA(true);
    setAnaliseIA("");

    const totalVendido = caixas.reduce((a, c) => a + c.totalVendas, 0);
    const mediaDiaria = caixas.length > 0 ? totalVendido / caixas.length : 0;
    const melhorDia = caixas.length > 0 ? caixas.reduce((a, b) => a.totalVendas > b.totalVendas ? a : b) : null;
    const piorDia = caixas.length > 0 ? caixas.reduce((a, b) => a.totalVendas < b.totalVendas ? a : b) : null;
    const totalDinheiro = caixas.reduce((a, c) => a + c.dinheiro, 0);
    const totalCartao = caixas.reduce((a, c) => a + c.cartao, 0);
    const totalPix = caixas.reduce((a, c) => a + c.pix, 0);
    const totalOutros = caixas.reduce((a, c) => a + c.outros, 0);
    const totalDespesas = movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
    const catDespesas: Record<string, number> = {};
    const catIdToNome: Record<string, string> = {};
    cats.forEach(c => catIdToNome[c.id] = c.nome);
    movs.filter(m => m.tipo === "saida").forEach(m => {
      const nome = catIdToNome[m.categoria_id] || "Outros";
      catDespesas[nome] = (catDespesas[nome] || 0) + m.valor;
    });
    const topDespesa = Object.entries(catDespesas).sort((a, b) => b[1] - a[1])[0];
    const metaAtingida = meta.meta_mensal > 0 ? ((totalVendido / meta.meta_mensal) * 100).toFixed(1) : "N/A";

    const prompt = `Analise os dados financeiros de um mercado para ${mesesNomes[mes - 1]}/${ano} e dê insights estratégicos:

- Total vendido: R$ ${totalVendido.toFixed(2)}
- Média diária: R$ ${mediaDiaria.toFixed(2)}
- Meta mensal: R$ ${meta.meta_mensal.toFixed(2)} (${metaAtingida}% atingida)
- Meta diária: R$ ${meta.meta_diaria.toFixed(2)}
- Melhor dia: ${melhorDia ? `${melhorDia.dia} (${melhorDia.semana}) - R$ ${melhorDia.totalVendas.toFixed(2)}` : "N/A"}
- Pior dia: ${piorDia ? `${piorDia.dia} (${piorDia.semana}) - R$ ${piorDia.totalVendas.toFixed(2)}` : "N/A"}
- Dias com dados: ${caixas.length}, Dias fechados: ${diasFechados}
- Formas de pagamento: Dinheiro R$ ${totalDinheiro.toFixed(2)}, Cartão R$ ${totalCartao.toFixed(2)}, Pix R$ ${totalPix.toFixed(2)}, Outros R$ ${totalOutros.toFixed(2)}
- Despesas totais: R$ ${totalDespesas.toFixed(2)}
- Maior despesa: ${topDespesa ? `${topDespesa[0]} - R$ ${topDespesa[1].toFixed(2)}` : "N/A"}
- Contas pendentes: ${contasPendentes}, Contas vencidas: ${contasVencidas}

Dê 5-7 insights práticos e ações recomendadas para melhorar o resultado. Seja direto, use bullet points. Foque em: performance vs meta, padrão de vendas por dia da semana, mix de pagamento, controle de despesas, e oportunidades de melhoria.`;

    try {
      const res = await fetch("/api/analise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setAnaliseIA(data.result || "Não foi possível gerar a análise.");
    } catch {
      setAnaliseIA("Erro ao conectar com a IA. Verifique se a chave OpenAI está configurada.");
    }
    setCarregandoIA(false);
  }

  function exportarPDF() {
    const conteudo = document.getElementById("painel-ceo-conteudo");
    if (!conteudo) return;

    const janela = window.open("", "_blank");
    if (!janela) return;

    janela.document.write(`
      <html>
        <head>
          <title>Painel CEO - ${mesesNomes[mes - 1]} ${ano}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; color: #1f2937; }
            h1 { font-size: 24px; margin-bottom: 4px; }
            h2 { font-size: 16px; margin-top: 24px; margin-bottom: 8px; }
            table { width: 100%; border-collapse: collapse; margin: 12px 0; }
            th, td { padding: 8px 12px; border: 1px solid #e5e7eb; text-align: left; font-size: 12px; }
            th { background: #f3f4f6; font-weight: 600; }
            .kpi { display: inline-block; width: 15%; text-align: center; padding: 12px; margin: 4px; border: 1px solid #e5e7eb; border-radius: 8px; vertical-align: top; }
            .kpi-label { font-size: 10px; color: #6b7280; text-transform: uppercase; }
            .kpi-value { font-size: 16px; font-weight: 700; margin-top: 4px; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>
          <h1>Painel do CEO</h1>
          <p style="color: #6b7280; font-size: 14px;">${mesesNomes[mes - 1]} de ${ano}</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">

          <div style="text-align: center;">
            <div class="kpi"><div class="kpi-label">Total Vendido</div><div class="kpi-value" style="color: #059669;">${fmt(totalVendido)}</div></div>
            <div class="kpi"><div class="kpi-label">Média Diária</div><div class="kpi-value" style="color: #2563eb;">${fmt(mediaDiaria)}</div></div>
            <div class="kpi"><div class="kpi-label">Meta Mensal</div><div class="kpi-value" style="color: #d97706;">${meta.meta_mensal > 0 ? fmt(meta.meta_mensal) : "—"}</div></div>
            <div class="kpi"><div class="kpi-label">% Meta</div><div class="kpi-value" style="color: ${pctMeta >= 100 ? "var(--brand-strong)" : "var(--amber)"};">${meta.meta_mensal > 0 ? pctMeta.toFixed(1) + "%" : "—"}</div></div>
            <div class="kpi"><div class="kpi-label">Despesas</div><div class="kpi-value" style="color: #dc2626;">${fmt(totalSaidasMov)}</div></div>
            <div class="kpi"><div class="kpi-label">Resultado</div><div class="kpi-value" style="color: ${resultado >= 0 ? "var(--brand-strong)" : "var(--red)"};">${fmt(resultado)}</div></div>
          </div>

          <h2>Formas de Pagamento</h2>
          <table>
            <tr><th>Forma</th><th>Valor</th><th>%</th></tr>
            ${fpDados.map(f => `<tr><td>${f.nome}</td><td>${fmt(f.valor)}</td><td>${f.pct.toFixed(1)}%</td></tr>`).join("")}
          </table>

          <h2>Ranking de Dias</h2>
          <table>
            <tr><th></th><th>Dia</th><th>Valor</th></tr>
            ${melhorDia ? `<tr><td>Melhor</td><td>${melhorDia.dia} (${melhorDia.semana})</td><td>${fmt(melhorDia.totalVendas)}</td></tr>` : ""}
            ${piorDia ? `<tr><td>Pior</td><td>${piorDia.dia} (${piorDia.semana})</td><td>${fmt(piorDia.totalVendas)}</td></tr>` : ""}
          </table>

          <h2>Média por Dia da Semana</h2>
          <table>
            <tr><th>Dia</th><th>Média</th></tr>
            ${mediaPorSemana.map(d => `<tr><td>${d.dia}</td><td>${fmt(d.media)}</td></tr>`).join("")}
          </table>

          <h2>Alertas</h2>
          <div style="padding: 8px 12px; border-radius: 8px; background: ${contasVencidas > 0 ? "var(--red-subtle)" : "var(--brand-subtle)"}; color: ${contasVencidas > 0 ? "var(--red)" : "var(--brand-strong)"}; font-size: 12px;">
            Contas Vencidas: ${contasVencidas} | Pendentes: ${contasPendentes} | Dias Conferidos: ${diasFechados}/${totalDiasComDados}
          </div>

          ${analiseIA ? `
          <h2>Análise Estratégica por IA</h2>
          <div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 8px; padding: 16px; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">${analiseIA}</div>
          ` : ""}

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px;">
          <p style="font-size: 10px; color: #9ca3af; text-align: center;">
            Gerado em ${new Date().toLocaleDateString("pt-BR")} as ${new Date().toLocaleTimeString("pt-BR")} · +Q Financas
          </p>

          <script>window.print();</script>
        </body>
      </html>
    `);
    janela.document.close();
  }

  function mesAnterior() { if (mes === 1) { setMes(12); setAno(ano - 1); } else setMes(mes - 1); }
  function mesProximo() { if (mes === 12) { setMes(1); setAno(ano + 1); } else setMes(mes + 1); }
  function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  // Tela de acesso negado
  if (acessoPermitido === null) {
    return <div className="text-center py-12"><div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>;
  }
  if (acessoPermitido === false) {
    return (
      <div className="text-center py-12">
        <p className="text-4xl mb-3">🔒</p>
        <p className="font-bold text-lg">Acesso restrito</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">O Painel do CEO e exclusivo para administradores.</p>
      </div>
    );
  }

  const totalVendido = caixas.reduce((a, c) => a + c.totalVendas, 0);
  const mediaDiaria = caixas.length > 0 ? totalVendido / caixas.length : 0;
  const melhorDia = caixas.length > 0 ? caixas.reduce((a, b) => a.totalVendas > b.totalVendas ? a : b) : null;
  const piorDia = caixas.length > 0 ? caixas.reduce((a, b) => a.totalVendas < b.totalVendas ? a : b) : null;
  const pctMeta = meta.meta_mensal > 0 ? Math.min((totalVendido / meta.meta_mensal) * 100, 100) : 0;
  const totalDinheiro = caixas.reduce((a, c) => a + c.dinheiro, 0);
  const totalCartao = caixas.reduce((a, c) => a + c.cartao, 0);
  const totalPix = caixas.reduce((a, c) => a + c.pix, 0);
  const totalOutros = caixas.reduce((a, c) => a + c.outros, 0);
  const totalEntradasMov = movs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
  const totalSaidasMov = movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
  const resultado = totalEntradasMov - totalSaidasMov;

  const diasSemanaVendas: Record<string, { total: number; count: number }> = {};
  caixas.forEach(c => {
    if (!diasSemanaVendas[c.semana]) diasSemanaVendas[c.semana] = { total: 0, count: 0 };
    diasSemanaVendas[c.semana].total += c.totalVendas;
    diasSemanaVendas[c.semana].count++;
  });
  const mediaPorSemana = Object.entries(diasSemanaVendas).map(([dia, d]) => ({ dia, media: d.count > 0 ? d.total / d.count : 0 })).sort((a, b) => b.media - a.media);

  const fpTotal = totalDinheiro + totalCartao + totalPix + totalOutros;
  const fpDados = [
    { nome: "Dinheiro", valor: totalDinheiro, pct: fpTotal > 0 ? (totalDinheiro / fpTotal * 100) : 0, cor: "var(--green)" },
    { nome: "Cartao", valor: totalCartao, pct: fpTotal > 0 ? (totalCartao / fpTotal * 100) : 0, cor: "var(--blue)" },
    { nome: "Pix", valor: totalPix, pct: fpTotal > 0 ? (totalPix / fpTotal * 100) : 0, cor: "var(--orange)" },
    { nome: "Outros", valor: totalOutros, pct: fpTotal > 0 ? (totalOutros / fpTotal * 100) : 0, cor: "var(--purple)" },
  ].filter(f => f.valor > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Painel do CEO</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Visao estrategica completa do negocio</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={exportarPDF} className="px-4 py-3 bg-gradient-to-r from-gray-700 to-gray-600 text-white font-semibold rounded-xl hover:from-gray-800 hover:to-gray-700 transition-all text-sm shadow-md">Imprimir / PDF</button>
          <button onClick={gerarAnalise} disabled={carregandoIA} className="px-4 py-3 bg-gradient-to-r from-purple-600 to-purple-500 text-white font-semibold rounded-xl hover:from-purple-700 hover:to-purple-600 transition-all text-sm shadow-md disabled:opacity-50">
            {carregandoIA ? "Analisando..." : "Analise IA"}
          </button>
        </div>
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold text-lg capitalize">{mesesNomes[mes - 1]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Proximo →</button>
      </div>

      {loading && <div className="text-center"><div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>}

      <div id="painel-ceo-conteudo">
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {[
            { l: "Total Vendido", v: fmt(totalVendido), c: "text-emerald-600" },
            { l: "Media Diaria", v: fmt(mediaDiaria), c: "text-blue-600" },
            { l: "Meta Mensal", v: meta.meta_mensal > 0 ? fmt(meta.meta_mensal) : "—", c: "text-amber-600" },
            { l: "% Meta", v: meta.meta_mensal > 0 ? `${pctMeta.toFixed(1)}%` : "—", c: pctMeta >= 100 ? "text-emerald-600" : "text-amber-600" },
            { l: "Despesas", v: fmt(totalSaidasMov), c: "text-red-500" },
            { l: "Resultado", v: fmt(resultado), c: resultado >= 0 ? "text-emerald-600" : "text-red-500" },
          ].map(c => (
            <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
              <p className={`font-bold text-sm ${c.c}`}>{c.v}</p>
            </div>
          ))}
        </div>

        {/* Meta + Formas Pagamento */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Meta */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">🎯 Meta de Vendas</h3>
              <button onClick={() => setMetaEditando(!metaEditando)} className="text-xs text-blue-600 hover:underline">{metaEditando ? "Cancelar" : "Editar"}</button>
            </div>
            {metaEditando ? (
              <div className="space-y-3">
                <div><label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">META MENSAL</label><input type="text" value={metaMensal} onChange={e => setMetaMensal(e.target.value)} placeholder="0,00" className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" /></div>
                <div><label className="block text-[10px] font-semibold text-[var(--color-text-muted)] mb-1">META DIARIA</label><input type="text" value={metaDiaria} onChange={e => setMetaDiaria(e.target.value)} placeholder="0,00" className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" /></div>
                <button onClick={salvarMeta} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700">Salvar Meta</button>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-[var(--color-text-muted)]">Progresso mensal</span>
                  <span className="text-xs font-bold">{pctMeta.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-4 mb-3">
                  <div className="h-4 rounded-full transition-all duration-500" style={{ width: `${Math.min(pctMeta, 100)}%`, background: pctMeta >= 100 ? "linear-gradient(90deg, #059669, #10b981)" : pctMeta >= 70 ? "linear-gradient(90deg, #d97706, #f59e0b)" : "linear-gradient(90deg, #dc2626, #f87171)" }} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center p-2 bg-[var(--color-bg)] rounded-lg"><p className="text-[10px] text-[var(--color-text-muted)]">Vendido</p><p className="font-bold text-sm text-emerald-600">{fmt(totalVendido)}</p></div>
                  <div className="text-center p-2 bg-[var(--color-bg)] rounded-lg"><p className="text-[10px] text-[var(--color-text-muted)]">Meta</p><p className="font-bold text-sm text-amber-600">{meta.meta_mensal > 0 ? fmt(meta.meta_mensal) : "Nao definida"}</p></div>
                </div>
                {meta.meta_diaria > 0 && <p className="text-xs text-[var(--color-text-muted)] mt-2 text-center">Meta diaria: {fmt(meta.meta_diaria)} · Media atual: {fmt(mediaDiaria)}</p>}
              </div>
            )}
          </div>

          {/* Formas de pagamento */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <h3 className="font-bold text-sm mb-3">📊 Mix de Pagamento</h3>
            {fpDados.length === 0 ? <p className="text-sm text-[var(--color-text-muted)] text-center py-6">Sem dados</p> : (
              <div className="space-y-3">
                {fpDados.map(f => (
                  <div key={f.nome}>
                    <div className="flex items-center justify-between mb-1"><span className="text-xs font-medium">{f.nome}</span><span className="text-xs font-bold" style={{ color: f.cor }}>{f.pct.toFixed(1)}% · {fmt(f.valor)}</span></div>
                    <div className="w-full bg-gray-200 rounded-full h-2"><div className="h-2 rounded-full transition-all" style={{ width: `${f.pct}%`, background: f.cor }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Ranking */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <h3 className="font-bold text-sm mb-3">🏆 Melhor Dia</h3>
            {melhorDia ? (
              <div className="text-center">
                <p className="text-3xl font-bold text-emerald-600">{melhorDia.dia}</p>
                <p className="text-sm text-[var(--color-text-muted)]">{melhorDia.semana}</p>
                <p className="text-lg font-bold text-emerald-600 mt-2">{fmt(melhorDia.totalVendas)}</p>
              </div>
            ) : <p className="text-sm text-[var(--color-text-muted)] text-center">Sem dados</p>}
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <h3 className="font-bold text-sm mb-3">📉 Pior Dia</h3>
            {piorDia ? (
              <div className="text-center">
                <p className="text-3xl font-bold text-red-500">{piorDia.dia}</p>
                <p className="text-sm text-[var(--color-text-muted)]">{piorDia.semana}</p>
                <p className="text-lg font-bold text-red-500 mt-2">{fmt(piorDia.totalVendas)}</p>
              </div>
            ) : <p className="text-sm text-[var(--color-text-muted)] text-center">Sem dados</p>}
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
            <h3 className="font-bold text-sm mb-3">📅 Media por Dia da Semana</h3>
            {mediaPorSemana.length === 0 ? <p className="text-sm text-[var(--color-text-muted)] text-center">Sem dados</p> : (
              <div className="space-y-2">{mediaPorSemana.map(d => (<div key={d.dia} className="flex items-center justify-between"><span className="text-xs font-medium">{d.dia}</span><span className="text-xs font-bold">{fmt(d.media)}</span></div>))}</div>
            )}
          </div>
        </div>

        {/* Alertas */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className={`border rounded-2xl p-4 text-center ${contasVencidas > 0 ? "bg-red-50 border-red-200" : "bg-emerald-50 border-emerald-200"}`}>
            <p className="text-2xl font-bold">{contasVencidas}</p>
            <p className="text-xs text-[var(--color-text-muted)]">Contas Vencidas</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
            <p className="text-2xl font-bold text-amber-700">{contasPendentes}</p>
            <p className="text-xs text-[var(--color-text-muted)]">Contas Pendentes</p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-center">
            <p className="text-2xl font-bold text-blue-700">{diasFechados}/{totalDiasComDados}</p>
            <p className="text-xs text-[var(--color-text-muted)]">Dias Conferidos</p>
          </div>
        </div>

        {/* Analise IA */}
        {analiseIA && (
          <div className="bg-gradient-to-br from-purple-50 to-indigo-50 border border-purple-200 rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">🧠</span>
              <h3 className="font-bold text-purple-800">Analise Estrategica por IA</h3>
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{analiseIA}</div>
          </div>
        )}
      </div>
    </div>
  );
}
