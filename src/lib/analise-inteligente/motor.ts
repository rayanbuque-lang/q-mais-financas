// Motor determinístico — orquestra as queries e monta o RelatorioAnaliseInteligente.
// Roda server-side (route handler), nunca no navegador (seção 2/8 da spec).
// Nenhuma chamada a IA aqui — Fase 1 é 100% template (seção 11, decisão 4).
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import type { Achado, RelatorioAnaliseInteligente, SeloMes } from "./tipos";
import { calcularSeloMes, confiancaPorSelos } from "./qualidade";
import { calcularScore, classificarAchado, SCORE_MINIMO_RELEVANTE } from "./score";
import { desvioNormalizado, mediana, variacaoPercentual } from "./estatistica";
import {
  fmtMoeda as fmtMoedaMotor,
  textoComoFoiOMes,
  textoConclusao,
  textoConcentracaoFornecedores,
  textoConcentracaoVencimentos,
  textoDescasamentoCartao,
  textoDespesaSumiu,
  textoFornecedor,
  textoQualidadeFornecedorDuplicado,
  textoQualidadeMesParcial,
  textoRealizadoVsMeta,
  textoVariacaoCategoria,
} from "./templates";
import { VERSAO_MOTOR } from "./tipos";

const PISO_CATEGORIA = 500;
const PISO_FORNECEDOR = 300;
const PISO_RECEITA = 2000;
const MIN_CARACTERES_MATCH = 4;

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(ano, mes, 0).getDate();
}

function addMeses(ano: number, mes: number, delta: number): { ano: number; mes: number } {
  const total = (ano * 12 + (mes - 1)) + delta;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

function formatarPeriodoMes(ano: number, mes: number): string {
  const nomes = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  return `${nomes[mes - 1]}/${ano}`;
}

function mesesNoIntervalo(inicio: string, fim: string): { ano: number; mes: number }[] {
  const [anoIni, mesIni] = inicio.split("-").map(Number);
  const [anoFim, mesFim] = fim.split("-").map(Number);
  const lista: { ano: number; mes: number }[] = [];
  let a = anoIni, m = mesIni;
  while (a < anoFim || (a === anoFim && m <= mesFim)) {
    lista.push({ ano: a, mes: m });
    if (m === 12) { m = 1; a++; } else m++;
  }
  return lista;
}

async function buscarSelosDoIntervalo(supabase: SupabaseClient, inicio: string, fim: string): Promise<SeloMes[]> {
  const meses = mesesNoIntervalo(inicio, fim);
  const hoje = new Date();
  const mesCorrenteChave = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;

  const selos: SeloMes[] = [];
  for (const { ano, mes } of meses) {
    const ini = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const fimMes = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDiaDoMes(ano, mes)).padStart(2, "0")}`;
    const [{ count: diasFechamento }, { data: fechamentoFormal }, { count: qtdEntrada }] = await Promise.all([
      supabase.from("fechamento_caixa").select("id", { count: "exact", head: true }).gte("data", ini).lte("data", fimMes),
      supabase.from("fechamentos_mensais").select("status").eq("ano", ano).eq("mes", mes).maybeSingle(),
      supabase.from("movimentacoes").select("id", { count: "exact", head: true }).eq("tipo", "entrada").gte("data", ini).lte("data", fimMes),
    ]);
    selos.push(
      calcularSeloMes({
        ano,
        mes,
        diasComFechamentoCaixa: diasFechamento ?? 0,
        fechadoFormalmente: (fechamentoFormal as { status?: string } | null)?.status === "fechado",
        temMovimentacaoEntrada: (qtdEntrada ?? 0) > 0,
        ehMesCorrente: `${ano}-${String(mes).padStart(2, "0")}` === mesCorrenteChave,
      })
    );
  }
  return selos;
}

async function somaMovimentacoes(supabase: SupabaseClient, tipo: "entrada" | "saida", inicio: string, fim: string): Promise<number> {
  const data = await fetchAllRows<{ valor: number }>((from, to) =>
    supabase.from("movimentacoes").select("valor").eq("tipo", tipo).gte("data", inicio).lte("data", fim).range(from, to)
  );
  return data.reduce((acc: number, r: { valor: number }) => acc + Number(r.valor), 0);
}

// Sem FK de movimentacoes.categoria_id pra categorias_saida (a coluna é
// genérica: aponta pra categorias_entrada OU categorias_saida dependendo do
// tipo) -- o join embutido do PostgREST (select("valor, categorias_saida(nome)"))
// não tem relação pra inferir e falha. Busca categoria_id bruto e resolve o
// nome por um mapa à parte, mesmo padrão que painel-ceo/page.tsx já usa.
function inicioDaSemana(dataIso: string): string {
  const d = new Date(dataIso + "T12:00:00");
  const diaSemana = d.getDay(); // 0=domingo
  const deslocamento = diaSemana === 0 ? 6 : diaSemana - 1; // volta até segunda-feira
  const segunda = new Date(d);
  segunda.setDate(d.getDate() - deslocamento);
  return segunda.toISOString().slice(0, 10);
}

/**
 * Despesa paga (movimentacoes saida) por semana, nas `semanasLookback` semanas
 * ANTES de hoje -- baseline pra saber se uma semana futura de vencimentos é
 * mais pesada, mais leve, ou normal perto do que a empresa já costuma pagar
 * por semana. Sem isso, "semana concentra 42% dos vencimentos" não diz nada
 * sozinho: pode ser pesado ou pode ser menos do que o normal (sinal bom).
 */
async function despesaSemanalHistorico(supabase: SupabaseClient, semanasLookback = 8): Promise<number[]> {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() - semanasLookback * 7);
  const linhas = await fetchAllRows<{ valor: number; data: string }>((from, to) =>
    supabase
      .from("movimentacoes")
      .select("valor, data")
      .eq("tipo", "saida")
      .gte("data", inicio.toISOString().slice(0, 10))
      .lt("data", hoje.toISOString().slice(0, 10))
      .range(from, to)
  );
  const porSemana = new Map<string, number>();
  for (const l of linhas) {
    const semana = inicioDaSemana(l.data);
    porSemana.set(semana, (porSemana.get(semana) ?? 0) + Number(l.valor));
  }
  return Array.from(porSemana.values());
}

/** Receita (fonte oficial = movimentacoes entrada) somada por semana, pra ver tendência dentro do período. */
async function vendasPorSemana(supabase: SupabaseClient, inicio: string, fim: string): Promise<{ semanaInicio: string; valor: number }[]> {
  const linhas = await fetchAllRows<{ valor: number; data: string }>((from, to) =>
    supabase.from("movimentacoes").select("valor, data").eq("tipo", "entrada").gte("data", inicio).lte("data", fim).range(from, to)
  );
  const mapa = new Map<string, number>();
  for (const l of linhas) {
    const semana = inicioDaSemana(l.data);
    mapa.set(semana, (mapa.get(semana) ?? 0) + Number(l.valor));
  }
  return Array.from(mapa.entries())
    .map(([semanaInicio, valor]) => ({ semanaInicio, valor }))
    .sort((a, b) => a.semanaInicio.localeCompare(b.semanaInicio));
}

async function despesaPorCategoria(supabase: SupabaseClient, inicio: string, fim: string): Promise<Map<string, number>> {
  const [linhas, { data: categorias }] = await Promise.all([
    fetchAllRows<{ valor: number; categoria_id: string | null }>((from, to) =>
      supabase.from("movimentacoes").select("valor, categoria_id").eq("tipo", "saida").gte("data", inicio).lte("data", fim).range(from, to)
    ),
    supabase.from("categorias_saida").select("id, nome"),
  ]);
  const nomePorId = new Map((categorias ?? []).map((c: { id: string; nome: string }) => [c.id, c.nome]));
  const mapa = new Map<string, number>();
  for (const r of linhas) {
    const nome = (r.categoria_id && nomePorId.get(r.categoria_id)) ?? "Sem categoria";
    mapa.set(nome, (mapa.get(nome) ?? 0) + Number(r.valor));
  }
  return mapa;
}

// Mesmo problema do despesaPorCategoria (sem FK pra inferir o join embutido),
// aqui pro lado de entrada -- usado pro mix de recebimento (seção 8 da spec).
async function receitaPorCategoria(supabase: SupabaseClient, inicio: string, fim: string): Promise<Map<string, number>> {
  const [linhas, { data: categorias }] = await Promise.all([
    fetchAllRows<{ valor: number; categoria_id: string | null }>((from, to) =>
      supabase.from("movimentacoes").select("valor, categoria_id").eq("tipo", "entrada").gte("data", inicio).lte("data", fim).range(from, to)
    ),
    supabase.from("categorias_entrada").select("id, nome"),
  ]);
  const nomePorId = new Map((categorias ?? []).map((c: { id: string; nome: string }) => [c.id, c.nome]));
  const mapa = new Map<string, number>();
  for (const r of linhas) {
    const nome = (r.categoria_id && nomePorId.get(r.categoria_id)) ?? "Sem categoria";
    mapa.set(nome, (mapa.get(nome) ?? 0) + Number(r.valor));
  }
  return mapa;
}

interface FornecedorAgregado { chave: string; nome: string; valor: number; }

async function fornecedoresPagos(supabase: SupabaseClient, inicio: string, fim: string): Promise<FornecedorAgregado[]> {
  const data = await fetchAllRows<{
    fornecedor: string;
    valor: number;
    fornecedor_canonico_id: string | null;
    fornecedor_canonico: { nome_exibicao: string } | { nome_exibicao: string }[] | null;
  }>((from, to) =>
    supabase
      .from("contas_pagar")
      .select("fornecedor, valor, fornecedor_canonico_id, fornecedor_canonico(nome_exibicao)")
      .eq("status", "pago")
      .gte("data_pagamento", inicio)
      .lte("data_pagamento", fim)
      .range(from, to)
  );
  const mapa = new Map<string, FornecedorAgregado>();
  for (const r of data) {
    const canonico = Array.isArray(r.fornecedor_canonico) ? r.fornecedor_canonico[0] : r.fornecedor_canonico;
    const chave = r.fornecedor_canonico_id ?? `nome:${r.fornecedor.trim().toUpperCase()}`;
    const nome = canonico?.nome_exibicao ?? r.fornecedor.trim();
    const atual = mapa.get(chave);
    if (atual) atual.valor += Number(r.valor);
    else mapa.set(chave, { chave, nome, valor: Number(r.valor) });
  }
  return Array.from(mapa.values()).sort((a, b) => b.valor - a.valor);
}

/** Período imediatamente anterior, do mesmo tamanho em dias, usado quando nenhuma comparação é informada. */
function periodoAnteriorPadrao(inicio: string, fim: string): { inicio: string; fim: string; label: string } {
  const dIni = new Date(inicio + "T12:00:00");
  const dFim = new Date(fim + "T12:00:00");
  const diasPeriodo = Math.round((dFim.getTime() - dIni.getTime()) / 86400000) + 1;
  const fimAnt = new Date(dIni.getTime() - 86400000);
  const iniAnt = new Date(fimAnt.getTime() - (diasPeriodo - 1) * 86400000);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { inicio: toIso(iniAnt), fim: toIso(fimAnt), label: "período anterior" };
}

export async function gerarRelatorioAnalise(
  supabase: SupabaseClient,
  periodoInicio: string,
  periodoFim: string,
  periodoComparacaoInicioParam?: string | null,
  periodoComparacaoFimParam?: string | null
): Promise<RelatorioAnaliseInteligente> {
  const comparacaoAuto = !periodoComparacaoInicioParam || !periodoComparacaoFimParam;
  const comparacao = comparacaoAuto
    ? periodoAnteriorPadrao(periodoInicio, periodoFim)
    : { inicio: periodoComparacaoInicioParam!, fim: periodoComparacaoFimParam!, label: "período de comparação selecionado" };

  const selosAtual = await buscarSelosDoIntervalo(supabase, periodoInicio, periodoFim);
  const selosComparacao = await buscarSelosDoIntervalo(supabase, comparacao.inicio, comparacao.fim);
  const confianca = confiancaPorSelos([...selosAtual, ...selosComparacao].map((s) => s.selo));

  const limitacoesDados: string[] = [];
  for (const s of [...selosAtual, ...selosComparacao]) {
    if (s.selo === "parcial") {
      limitacoesDados.push(
        textoQualidadeMesParcial(formatarPeriodoMes(s.ano, s.mes), s.fechadoFormalmente ? "mês corrente ou cobertura incompleta" : "mês ainda não fechado formalmente")
      );
    } else if (s.selo === "insuficiente") {
      limitacoesDados.push(`${formatarPeriodoMes(s.ano, s.mes)} tem dado insuficiente para entrar em comparações — excluído de médias/tendência.`);
    }
  }

  // KPIs — fonte oficial = movimentacoes (seção 2 da spec).
  const [receita, despesa, receitaRef, despesaRef, mixAtual, fornAtualGlobal, semanas] = await Promise.all([
    somaMovimentacoes(supabase, "entrada", periodoInicio, periodoFim),
    somaMovimentacoes(supabase, "saida", periodoInicio, periodoFim),
    somaMovimentacoes(supabase, "entrada", comparacao.inicio, comparacao.fim),
    somaMovimentacoes(supabase, "saida", comparacao.inicio, comparacao.fim),
    receitaPorCategoria(supabase, periodoInicio, periodoFim),
    fornecedoresPagos(supabase, periodoInicio, periodoFim),
    vendasPorSemana(supabase, periodoInicio, periodoFim),
  ]);
  const mixRecebimento = Array.from(mixAtual.entries())
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);
  const topFornecedores = fornAtualGlobal.slice(0, 8).map((f) => ({ categoria: f.nome, valor: f.valor }));
  const resultado = receita - despesa;
  const resultadoRef = receitaRef - despesaRef;

  const achados: Achado[] = [];

  // ---------- Insight #1: variação de receita total ----------
  {
    const deltaAbs = receita - receitaRef;
    const deltaPct = variacaoPercentual(receita, receitaRef);
    const score = calcularScore({
      deltaAbsoluto: deltaAbs,
      pisoReais: PISO_RECEITA,
      receitaDoMes: receita,
      desvioNormalizado: receitaRef > 0 ? Math.min(Math.abs(deltaAbs) / (2 * receitaRef * 0.1 || 1), 1) : 0,
      mesesConsecutivos: 0,
      confianca,
    });
    if (score >= SCORE_MINIMO_RELEVANTE && receitaRef > 0) {
      const favoravel = deltaAbs >= 0;
      achados.push({
        id: `receita-total-${periodoInicio}`,
        dimensao: "receita",
        titulo: `Receita total ${favoravel ? "subiu" : "caiu"} ${Math.abs(deltaPct ?? 0).toFixed(1)}%`,
        valorAtual: receita,
        valorReferencia: receitaRef,
        deltaAbsoluto: deltaAbs,
        deltaPercentual: deltaPct,
        comparadoCom: comparacao.label,
        score,
        classe: classificarAchado(score, favoravel),
        confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
        fatoOuHipotese: "fato",
        explicacao: null,
        origemTabela: "movimentacoes",
        origemIds: [],
        acaoSugerida: favoravel ? null : "Conferir o mix de recebimento do período (insight de forma de recebimento) e se alguma categoria específica puxou a queda.",
        texto: textoVariacaoCategoria({ categoria: "Receita total", valorAtual: receita, valorReferencia: receitaRef, deltaPct, comparadoCom: comparacao.label }),
      });
    }
  }

  // ---------- Tendência semanal de vendas dentro do período ----------
  {
    if (semanas.length >= 3) {
      const valores = semanas.map((s) => s.valor);
      let semanasConsecutivasSubindo = 1;
      for (let i = valores.length - 1; i > 0; i--) {
        if (valores[i] > valores[i - 1]) semanasConsecutivasSubindo++;
        else break;
      }
      let semanasConsecutivasCaindo = 1;
      for (let i = valores.length - 1; i > 0; i--) {
        if (valores[i] < valores[i - 1]) semanasConsecutivasCaindo++;
        else break;
      }
      const crescente = semanasConsecutivasSubindo >= 3;
      const decrescente = semanasConsecutivasCaindo >= 3;
      if (crescente || decrescente) {
        const primeiraValor = valores[valores.length - (crescente ? semanasConsecutivasSubindo : semanasConsecutivasCaindo)];
        const ultimaValor = valores[valores.length - 1];
        const deltaAbs = ultimaValor - primeiraValor;
        const nSemanas = crescente ? semanasConsecutivasSubindo : semanasConsecutivasCaindo;
        achados.push({
          id: `tendencia-semanal-${periodoInicio}`,
          dimensao: "receita",
          titulo: `Vendas em ${crescente ? "alta" : "queda"} há ${nSemanas} semanas seguidas`,
          valorAtual: ultimaValor,
          valorReferencia: primeiraValor,
          deltaAbsoluto: deltaAbs,
          deltaPercentual: variacaoPercentual(ultimaValor, primeiraValor),
          comparadoCom: `início da sequência de ${nSemanas} semanas`,
          score: Math.min(35 + nSemanas * 5, 65),
          classe: crescente ? "oportunidade" : "atencao",
          confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
          fatoOuHipotese: "fato",
          explicacao: null,
          origemTabela: "movimentacoes",
          origemIds: [],
          acaoSugerida: decrescente ? "Conferir se é sazonalidade esperada ou queda real de demanda — ver o gráfico de vendas por semana." : null,
          texto: `As vendas por semana estão em ${crescente ? "alta" : "queda"} há ${nSemanas} semanas seguidas dentro do período: de ${semanas[valores.length - nSemanas].semanaInicio.split("-").reverse().join("/")} (${fmtMoedaMotor(primeiraValor)}) até a última semana (${fmtMoedaMotor(ultimaValor)}).`,
        });
      }
    }
  }

  // ---------- Insight #3: despesa por categoria fora do padrão ----------
  {
    const [catsAtual, catsRef] = await Promise.all([
      despesaPorCategoria(supabase, periodoInicio, periodoFim),
      despesaPorCategoria(supabase, comparacao.inicio, comparacao.fim),
    ]);
    // Histórico de 3 meses anteriores ao início do período, pra mediana/MAD —
    // só calculado quando o período analisado é exatamente um mês (caso mais comum via atalho).
    const [anoIni, mesIni] = periodoInicio.split("-").map(Number);
    const ehUmMes = periodoFim === `${anoIni}-${String(mesIni).padStart(2, "0")}-${String(ultimoDiaDoMes(anoIni, mesIni)).padStart(2, "0")}`;
    const historicoPorCategoria = new Map<string, number[]>();
    if (ehUmMes) {
      for (let i = 3; i >= 1; i--) {
        const { ano, mes } = addMeses(anoIni, mesIni, -i);
        const ini = `${ano}-${String(mes).padStart(2, "0")}-01`;
        const fimM = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDiaDoMes(ano, mes)).padStart(2, "0")}`;
        const cats = await despesaPorCategoria(supabase, ini, fimM);
        for (const [nome, valor] of cats) {
          const lista = historicoPorCategoria.get(nome) ?? [];
          lista.push(valor);
          historicoPorCategoria.set(nome, lista);
        }
      }
    }

    for (const [categoria, valorAtual] of catsAtual) {
      const valorRef = catsRef.get(categoria) ?? 0;
      const historico = historicoPorCategoria.get(categoria) ?? [];
      const medHist = historico.length > 0 ? mediana(historico) : valorRef;
      const deltaAbs = valorAtual - medHist;
      const deltaPctVsRef = variacaoPercentual(valorAtual, valorRef);
      const score = calcularScore({
        deltaAbsoluto: deltaAbs,
        pisoReais: PISO_CATEGORIA,
        receitaDoMes: receita,
        desvioNormalizado: desvioNormalizado(valorAtual, historico),
        mesesConsecutivos: 0,
        confianca,
      });
      if (score >= SCORE_MINIMO_RELEVANTE) {
        const favoravel = deltaAbs < 0;
        achados.push({
          id: `despesa-categoria-${categoria}-${periodoInicio}`,
          dimensao: "categoria",
          titulo: `Despesa "${categoria}" ${deltaAbs >= 0 ? "acima" : "abaixo"} do padrão`,
          valorAtual,
          valorReferencia: medHist,
          deltaAbsoluto: deltaAbs,
          deltaPercentual: deltaPctVsRef,
          comparadoCom: historico.length > 0 ? "mediana dos 3 meses anteriores" : comparacao.label,
          score,
          classe: classificarAchado(score, favoravel),
          confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
          fatoOuHipotese: "hipotese",
          explicacao: "O valor está fora do padrão histórico da categoria; a causa (reajuste, compra pontual, erro de lançamento) não pode ser determinada só pelo número.",
          origemTabela: "movimentacoes",
          origemIds: [],
          acaoSugerida: favoravel ? null : `Revisar os lançamentos de "${categoria}" no período — valor ${fmtDif(deltaAbs)} frente ao padrão.`,
          texto: textoVariacaoCategoria({ categoria, valorAtual, valorReferencia: medHist, deltaPct: medHist > 0 ? variacaoPercentual(valorAtual, medHist) : null, comparadoCom: historico.length > 0 ? "a mediana dos 3 meses anteriores" : comparacao.label }),
        });
      }
    }

    // Despesa recorrente que sumiu (padrão #5): categoria com histórico estável nos 3 meses
    // anteriores (desvio < 10% da mediana) e zero neste período.
    for (const [categoria, historico] of historicoPorCategoria) {
      if (historico.length < 3) continue;
      if (catsAtual.has(categoria)) continue;
      const med = mediana(historico);
      if (med <= 0) continue;
      const estavel = historico.every((v) => Math.abs(v - med) / med < 0.1);
      if (!estavel) continue;
      achados.push({
        id: `despesa-sumiu-${categoria}-${periodoInicio}`,
        dimensao: "categoria",
        titulo: `Despesa "${categoria}" não aparece neste período`,
        valorAtual: 0,
        valorReferencia: med,
        deltaAbsoluto: -med,
        deltaPercentual: null,
        comparadoCom: "histórico estável dos 3 meses anteriores",
        score: 55,
        classe: "atencao",
        confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
        fatoOuHipotese: "hipotese",
        explicacao: "Pode ser quitação normal (ex.: fim de um empréstimo parcelado), pagamento por outro meio, ou um lançamento esquecido.",
        origemTabela: "movimentacoes",
        origemIds: [],
        acaoSugerida: `Confirmar se "${categoria}" realmente não teve movimento neste período.`,
        texto: textoDespesaSumiu(categoria, med, historico.length),
      });
    }
  }

  // ---------- Insight #6 e #7: fornecedor ----------
  {
    const fornAtual = fornAtualGlobal;
    const fornRef = await fornecedoresPagos(supabase, comparacao.inicio, comparacao.fim);
    const totalAtual = fornAtual.reduce((a, f) => a + f.valor, 0);
    const mapaRef = new Map(fornRef.map((f) => [f.chave, f.valor]));

    for (const f of fornAtual.slice(0, 15)) {
      const valorRef = mapaRef.get(f.chave) ?? 0;
      const deltaAbs = f.valor - valorRef;
      const deltaPct = variacaoPercentual(f.valor, valorRef);
      const score = calcularScore({
        deltaAbsoluto: deltaAbs,
        pisoReais: PISO_FORNECEDOR,
        receitaDoMes: receita,
        desvioNormalizado: valorRef > 0 ? Math.min(Math.abs(deltaAbs) / (valorRef || 1), 1) : 1,
        mesesConsecutivos: 0,
        confianca,
      });
      if (score >= SCORE_MINIMO_RELEVANTE) {
        const favoravel = deltaAbs < 0;
        achados.push({
          id: `fornecedor-${f.chave}-${periodoInicio}`,
          dimensao: "fornecedor",
          titulo: `Fornecedor ${f.nome} ${valorRef === 0 ? "é novo" : deltaAbs >= 0 ? "cresceu" : "caiu"}`,
          valorAtual: f.valor,
          valorReferencia: valorRef,
          deltaAbsoluto: deltaAbs,
          deltaPercentual: deltaPct,
          comparadoCom: comparacao.label,
          score,
          classe: classificarAchado(score, favoravel),
          confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
          fatoOuHipotese: "hipotese",
          explicacao: "O valor pago mudou; o motivo (volume de compra, preço, atraso de pagamento) não pode ser determinado só pelo número.",
          origemTabela: "contas_pagar",
          origemIds: [],
          acaoSugerida: null,
          texto: textoFornecedor({ nome: f.nome, valorAtual: f.valor, valorReferencia: valorRef, deltaPct, comparadoCom: comparacao.label }),
        });
      }
    }

    if (totalAtual > 0 && fornAtual.length > 0) {
      const top5 = fornAtual.slice(0, 5).reduce((a, f) => a + f.valor, 0);
      const top5Pct = (top5 / totalAtual) * 100;
      if (top5Pct >= 40) {
        achados.push({
          id: `concentracao-fornecedores-${periodoInicio}`,
          dimensao: "fornecedor",
          titulo: `Top 5 fornecedores concentram ${top5Pct.toFixed(1)}% das compras`,
          valorAtual: top5,
          valorReferencia: totalAtual,
          deltaAbsoluto: top5,
          deltaPercentual: top5Pct,
          comparadoCom: "total pago no período",
          score: Math.min(30 + top5Pct / 2, 80),
          classe: top5Pct >= 60 ? "atencao" : "observacao",
          confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
          fatoOuHipotese: "fato",
          explicacao: null,
          origemTabela: "contas_pagar",
          origemIds: [],
          acaoSugerida: top5Pct >= 60 ? "Avaliar risco de concentração — negociar condições com os maiores fornecedores ou diversificar." : null,
          texto: textoConcentracaoFornecedores(top5Pct, fornAtual[0].nome, (fornAtual[0].valor / totalAtual) * 100),
        });
      }
    }
  }

  // ---------- Insight #9: concentração de vencimentos (pressão de caixa, sempre dado vivo) ----------
  // Fica FORA da lista `achados` de propósito: é sobre os próximos 35 dias a
  // partir de HOJE, não sobre o período selecionado -- competir por score e
  // aparecer misturado com achados do período (ex.: analisando agosto/setembro
  // e aparecer "semana de outubro" no topo) confunde o que está sendo mostrado.
  // Vira uma seção própria, sempre rotulada como "sempre atual".
  const pressaoCaixa: Achado[] = [];
  {
    const hoje = new Date().toISOString().slice(0, 10);
    const limite = new Date();
    limite.setDate(limite.getDate() + 35);
    const limiteIso = limite.toISOString().slice(0, 10);
    const linhas = await fetchAllRows<{ valor: number; data_vencimento: string }>((from, to) =>
      supabase
        .from("contas_pagar")
        .select("valor, data_vencimento")
        .eq("status", "pendente")
        .gte("data_vencimento", hoje)
        .lte("data_vencimento", limiteIso)
        .range(from, to)
    );
    const totalPendente = linhas.reduce((a, l) => a + Number(l.valor), 0);
    const porSemana = new Map<string, { total: number; qtd: number }>();
    for (const l of linhas) {
      const d = new Date(l.data_vencimento + "T12:00:00");
      const diaSemana = d.getDay();
      const inicioSemana = new Date(d);
      inicioSemana.setDate(d.getDate() - diaSemana);
      const chave = inicioSemana.toISOString().slice(0, 10);
      const atual = porSemana.get(chave) ?? { total: 0, qtd: 0 };
      atual.total += Number(l.valor);
      atual.qtd += 1;
      porSemana.set(chave, atual);
    }
    if (totalPendente > 0) {
      const piorSemana = Array.from(porSemana.entries()).sort((a, b) => b[1].total - a[1].total)[0];
      if (piorSemana) {
        const pct = (piorSemana[1].total / totalPendente) * 100;
        const historicoSemanal = await despesaSemanalHistorico(supabase);
        const medHistorico = historicoSemanal.length >= 3 ? mediana(historicoSemanal) : null;
        const razao = medHistorico && medHistorico > 0 ? piorSemana[1].total / medHistorico : null;

        // Só vira achado se: (a) concentra bastante dentro da própria janela de
        // 35 dias, E (b) comparado ao que a empresa normalmente paga por
        // semana (histórico), está genuinamente alta -- ou genuinamente baixa,
        // o que também é digno de nota (sinal positivo), não só alerta.
        if (pct >= 35 && medHistorico !== null && razao !== null) {
          if (razao >= 1.2) {
            pressaoCaixa.push({
              id: `pressao-caixa-${piorSemana[0]}`,
              dimensao: "pressao_caixa",
              titulo: `Semana de ${formatarDataBr(piorSemana[0])} acima do normal em vencimentos`,
              valorAtual: piorSemana[1].total,
              valorReferencia: medHistorico,
              deltaAbsoluto: piorSemana[1].total - medHistorico,
              deltaPercentual: variacaoPercentual(piorSemana[1].total, medHistorico),
              comparadoCom: "mediana do que a empresa paga por semana (últimas 8 semanas)",
              score: Math.min(40 + pct / 2, 85),
              classe: "atencao",
              confianca: "alta",
              fatoOuHipotese: "fato",
              explicacao: null,
              origemTabela: "contas_pagar",
              origemIds: [],
              acaoSugerida: "Confirmar que há caixa suficiente previsto para essa semana, ou negociar prazos com fornecedores dessa janela.",
              texto: `${textoConcentracaoVencimentos({ semanaInicio: formatarDataBr(piorSemana[0]), totalSemana: piorSemana[1].total, totalPeriodo: totalPendente, qtdContas: piorSemana[1].qtd })} Isso é ${razao.toFixed(1)}x o que a empresa costuma pagar numa semana normal (mediana de ${fmtMoedaMotor(medHistorico)}) — acima do padrão.`,
            });
          } else if (razao <= 0.7) {
            pressaoCaixa.push({
              id: `pressao-caixa-${piorSemana[0]}`,
              dimensao: "pressao_caixa",
              titulo: `Semana de ${formatarDataBr(piorSemana[0])} abaixo do normal em vencimentos`,
              valorAtual: piorSemana[1].total,
              valorReferencia: medHistorico,
              deltaAbsoluto: piorSemana[1].total - medHistorico,
              deltaPercentual: variacaoPercentual(piorSemana[1].total, medHistorico),
              comparadoCom: "mediana do que a empresa paga por semana (últimas 8 semanas)",
              score: 35,
              classe: "oportunidade",
              confianca: "alta",
              fatoOuHipotese: "fato",
              explicacao: null,
              origemTabela: "contas_pagar",
              origemIds: [],
              acaoSugerida: null,
              texto: `A semana de ${formatarDataBr(piorSemana[0])} concentra o maior volume de vencimentos dos próximos 35 dias (${fmtMoedaMotor(piorSemana[1].total)}), mas isso é só ${razao.toFixed(1)}x o que a empresa costuma pagar numa semana normal (mediana de ${fmtMoedaMotor(medHistorico)}) — semana mais tranquila que o normal, não é sinal de alerta.`,
            });
          }
          // Entre 0,7x e 1,2x do normal: dentro do esperado, não vira achado.
        }
      }
    }
  }

  // ---------- Insight #10: realizado vs meta ----------
  {
    const [anoIni, mesIni] = periodoInicio.split("-").map(Number);
    const ehUmMes = periodoFim === `${anoIni}-${String(mesIni).padStart(2, "0")}-${String(ultimoDiaDoMes(anoIni, mesIni)).padStart(2, "0")}`;
    if (ehUmMes) {
      const { data: metaVendas } = await supabase.from("metas_vendas").select("meta_mensal").eq("ano", anoIni).eq("mes", mesIni).maybeSingle();
      const meta = (metaVendas as { meta_mensal?: number } | null)?.meta_mensal;
      if (meta && meta > 0) {
        const deltaAbs = receita - meta;
        const pct = (receita / meta) * 100;
        const score = calcularScore({
          deltaAbsoluto: deltaAbs,
          pisoReais: PISO_RECEITA,
          receitaDoMes: receita,
          desvioNormalizado: 0,
          mesesConsecutivos: 0,
          confianca,
        });
        if (score >= SCORE_MINIMO_RELEVANTE) {
          achados.push({
            id: `meta-${periodoInicio}`,
            dimensao: "meta",
            titulo: `Realizado em ${pct.toFixed(1)}% da meta`,
            valorAtual: receita,
            valorReferencia: meta,
            deltaAbsoluto: deltaAbs,
            deltaPercentual: pct - 100,
            comparadoCom: "meta de vendas cadastrada",
            score,
            classe: classificarAchado(score, deltaAbs >= 0),
            confianca: confianca >= 1 ? "alta" : confianca >= 0.7 ? "media" : "baixa",
            fatoOuHipotese: "fato",
            explicacao: null,
            origemTabela: "metas_vendas",
            origemIds: [],
            acaoSugerida: deltaAbs < 0 ? "Revisar se a meta continua realista ou se há ação possível nas semanas restantes." : null,
            texto: textoRealizadoVsMeta(receita, meta),
          });
        }
      }
    }
  }

  // ---------- Insight #14: descasamento de prazo cartão ----------
  const porModalidadeCartao = new Map<string, { valor: number; qtd: number; somaPrazo: number; comPrazo: number }>();
  {
    const linhas = await fetchAllRows<{ modalidade: string; valor_bruto: number; data_hora_venda: string; data_prevista_calculada: string | null; data_prevista_pagamento: string | null }>((from, to) =>
      supabase
        .from("cartao_transacao")
        .select("modalidade, valor_bruto, data_hora_venda, data_prevista_calculada, data_prevista_pagamento")
        .gte("data_hora_venda", periodoInicio)
        .lte("data_hora_venda", periodoFim + "T23:59:59")
        .range(from, to)
    );
    if (linhas.length > 0) {
      const porModalidade = porModalidadeCartao;
      for (const l of linhas) {
        const atual = porModalidade.get(l.modalidade) ?? { valor: 0, qtd: 0, somaPrazo: 0, comPrazo: 0 };
        atual.valor += Number(l.valor_bruto);
        atual.qtd += 1;
        const prevista = l.data_prevista_calculada ?? l.data_prevista_pagamento;
        if (prevista) {
          const dVenda = new Date(l.data_hora_venda).getTime();
          const dPrev = new Date(prevista).getTime();
          const dias = Math.round((dPrev - dVenda) / 86400000);
          if (dias >= 0) { atual.somaPrazo += dias; atual.comPrazo += 1; }
        }
        porModalidade.set(l.modalidade, atual);
      }
      const totalValor = Array.from(porModalidade.values()).reduce((a, v) => a + v.valor, 0);
      const credito = porModalidade.get("credito");
      const debito = porModalidade.get("debito");
      if (totalValor > 0 && credito && debito) {
        const prazoCredito = credito.comPrazo > 0 ? credito.somaPrazo / credito.comPrazo : 0;
        const prazoDebito = debito.comPrazo > 0 ? debito.somaPrazo / debito.comPrazo : 0;
        const [anoIni, mesIni] = periodoInicio.split("-").map(Number);
        achados.push({
          id: `descasamento-cartao-${periodoInicio}`,
          dimensao: "forma_recebimento",
          titulo: "Descasamento de prazo entre venda e recebimento no cartão",
          valorAtual: credito.valor,
          valorReferencia: totalValor,
          deltaAbsoluto: credito.valor,
          deltaPercentual: (credito.valor / totalValor) * 100,
          comparadoCom: "composição crédito/débito do próprio período",
          score: 45,
          classe: "observacao",
          confianca: "alta",
          fatoOuHipotese: "fato",
          explicacao: null,
          origemTabela: "cartao_transacao",
          origemIds: [],
          acaoSugerida: null,
          texto: textoDescasamentoCartao({
            mesLabel: formatarPeriodoMes(anoIni, mesIni),
            pctCredito: (credito.valor / totalValor) * 100,
            valorCredito: credito.valor,
            valorTotal: totalValor,
            prazoMedioCredito: prazoCredito,
            pctDebito: (debito.valor / totalValor) * 100,
            valorDebito: debito.valor,
            prazoMedioDebito: prazoDebito,
          }),
        });
      }
    }
  }

  // ---------- Insight #13: qualidade de dados (fornecedor fragmentado) ----------
  // Importante: "sem fornecedor_canonico_id" sozinho NÃO é sinal de problema --
  // boa parte de contas_pagar é imposto/convênio/serviço (Simples Nacional,
  // Unimed, FGTS...), que nunca vai ter nota fiscal de produto (xml_nota) pra
  // casar por CNPJ, e não é duplicidade nenhuma. O sinal real é quando DUAS OU
  // MAIS grafias diferentes, ainda sem vínculo, parecem ser o mesmo fornecedor
  // (uma contém a outra, mesmo "contém" usado na normalização da seção 3) --
  // aí sim é fragmentação de ranking, não um nome isolado que só não tem CNPJ.
  {
    const linhas = await fetchAllRows<{ fornecedor: string; valor: number }>((from, to) =>
      supabase
        .from("contas_pagar")
        .select("fornecedor, valor")
        .is("fornecedor_canonico_id", null)
        .eq("status", "pago")
        .gte("data_pagamento", periodoInicio)
        .lte("data_pagamento", periodoFim)
        .range(from, to)
    );
    const mapa = new Map<string, { nome: string; valor: number }>();
    for (const l of linhas) {
      const chave = l.fornecedor.trim().toUpperCase();
      const atual = mapa.get(chave);
      if (atual) atual.valor += Number(l.valor);
      else mapa.set(chave, { nome: l.fornecedor.trim(), valor: Number(l.valor) });
    }
    const nomes = Array.from(mapa.entries());
    const grupos = new Map<number, Set<number>>();
    for (let i = 0; i < nomes.length; i++) grupos.set(i, new Set([i]));
    for (let i = 0; i < nomes.length; i++) {
      const [chaveA] = nomes[i];
      if (chaveA.length < MIN_CARACTERES_MATCH) continue;
      for (let j = i + 1; j < nomes.length; j++) {
        const [chaveB] = nomes[j];
        if (chaveB.length < MIN_CARACTERES_MATCH) continue;
        if (chaveA.includes(chaveB) || chaveB.includes(chaveA)) {
          const uniao = new Set([...grupos.get(i)!, ...grupos.get(j)!]);
          for (const idx of uniao) grupos.set(idx, uniao);
        }
      }
    }
    const candidatos = Array.from(new Set(Array.from(grupos.values())))
      .filter((g) => g.size >= 2)
      .map((g) => {
        const membros = Array.from(g).map((i) => nomes[i]);
        const soma = membros.reduce((a, [, v]) => a + v.valor, 0);
        const rotulos = membros.sort((a, b) => b[1].valor - a[1].valor).map(([, v]) => v.nome);
        return { rotulos, soma };
      })
      .sort((a, b) => b.soma - a.soma);

    if (candidatos.length > 0) {
      const top = candidatos[0];
      achados.push({
        id: `qualidade-fornecedor-fragmentado-${periodoInicio}`,
        dimensao: "qualidade_dados",
        titulo: "Possível fornecedor fragmentado em grafias diferentes",
        valorAtual: top.soma,
        valorReferencia: 0,
        deltaAbsoluto: top.soma,
        deltaPercentual: null,
        comparadoCom: "—",
        score: 25,
        classe: "observacao",
        confianca: "media",
        fatoOuHipotese: "hipotese",
        explicacao: "Os nomes parecem a mesma empresa (um contém o outro), mas nenhum tem nota fiscal (xml_nota) confirmando o CNPJ ainda — pode ser confirmado manualmente na normalização de fornecedor.",
        origemTabela: "contas_pagar",
        origemIds: [],
        acaoSugerida: "Confirmar manualmente se são o mesmo fornecedor e normalizar juntos.",
        texto: textoQualidadeFornecedorDuplicado(top.rotulos, top.soma),
      });
    }
  }

  // Detalhamento de recebimento (pedido explícito: "esmiuação de cartão
  // crédito/débito e Pix") -- combina cartao_transacao (prazo real medido)
  // com Pix Santander/Pix Inter (de mixAtual, já em movimentacoes).
  const totalMixParaPct = receita > 0 ? receita : 1;
  const detalhamentoRecebimento: { modalidade: string; valor: number; pctDoMix: number; prazoMedioDias: number | null }[] = [];
  const rotuloModalidade: Record<string, string> = { credito: "Cartão Crédito", debito: "Cartão Débito", voucher: "Cartão Voucher" };
  if (porModalidadeCartao.size > 0) {
    // Fonte detalhada (crédito/débito/voucher com prazo real medido) -- só
    // existe quando o módulo de Conciliação de Cartão tem importação no
    // período (hoje, só agosto/2026).
    for (const [modalidade, dado] of porModalidadeCartao) {
      detalhamentoRecebimento.push({
        modalidade: rotuloModalidade[modalidade] ?? modalidade,
        valor: dado.valor,
        pctDoMix: (dado.valor / totalMixParaPct) * 100,
        prazoMedioDias: dado.comPrazo > 0 ? dado.somaPrazo / dado.comPrazo : null,
      });
    }
  } else {
    // Sem Conciliação de Cartão no período: cai pro que o extrato bancário já
    // traz todo mês (repasse de cartão/VR classificado em movimentacoes) --
    // sem a quebra crédito/débito nem o prazo real, mas é o dado que sempre
    // existe, então não pode sumir da tela só porque a fonte mais detalhada
    // não foi importada neste mês.
    for (const nomeCartao of ["Cartão", "Cartão VR"]) {
      const valor = mixAtual.get(nomeCartao) ?? 0;
      if (valor > 0) detalhamentoRecebimento.push({ modalidade: nomeCartao, valor, pctDoMix: (valor / totalMixParaPct) * 100, prazoMedioDias: null });
    }
  }
  for (const nomePix of ["Pix Santander", "Pix Inter"]) {
    const valor = mixAtual.get(nomePix) ?? 0;
    if (valor > 0) detalhamentoRecebimento.push({ modalidade: nomePix, valor, pctDoMix: (valor / totalMixParaPct) * 100, prazoMedioDias: null });
  }
  detalhamentoRecebimento.sort((a, b) => b.valor - a.valor);

  achados.sort((a, b) => b.score - a.score);
  const topAchados = achados.slice(0, 8);
  const ocultos = achados.slice(8);

  const qtdCriticos = topAchados.filter((a) => a.classe === "critico").length;
  const qtdAtencao = topAchados.filter((a) => a.classe === "atencao").length;
  const qtdOportunidades = topAchados.filter((a) => a.classe === "oportunidade").length;

  const periodoLabel = periodoInicio === periodoFim ? formatarDataBr(periodoInicio) : `${formatarDataBr(periodoInicio)} a ${formatarDataBr(periodoFim)}`;

  return {
    periodoInicio,
    periodoFim,
    periodoComparacaoInicio: comparacao.inicio,
    periodoComparacaoFim: comparacao.fim,
    comparadoCom: comparacao.label,
    kpis: {
      receita,
      despesa,
      resultado,
      margemCaixa: receita > 0 ? resultado / receita : null,
      varReceitaPct: variacaoPercentual(receita, receitaRef),
      varDespesaPct: variacaoPercentual(despesa, despesaRef),
      varResultadoPct: variacaoPercentual(resultado, resultadoRef),
    },
    mixRecebimento,
    topFornecedores,
    vendasPorSemana: semanas,
    detalhamentoRecebimento,
    pressaoCaixa,
    achados: topAchados,
    achadosOcultos: ocultos,
    selos: [...selosAtual, ...selosComparacao],
    comoFoiOMes: textoComoFoiOMes({
      periodoLabel,
      receita,
      despesa,
      resultado,
      varReceitaPct: variacaoPercentual(receita, receitaRef),
      comparadoCom: comparacao.label,
      qtdAchadosCriticos: qtdCriticos,
      qtdAchadosAtencao: qtdAtencao,
    }),
    conclusao: textoConclusao({ resultado, qtdOportunidades }),
    limitacoesDados,
    versaoMotor: VERSAO_MOTOR,
    geradoEm: new Date().toISOString(),
  };
}

function fmtDif(v: number): string {
  const sinal = v >= 0 ? "+" : "";
  return `${sinal}${v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`;
}

function formatarDataBr(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}
