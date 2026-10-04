// Texto determinístico por achado — seção 6 da spec ("o relatório funciona
// 100% sem IA"). Nenhuma função aqui chama API nenhuma; são apenas frases
// condicionais montadas a partir de números já calculados.

export function fmtMoeda(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function fmtPct(v: number, casas = 1): string {
  return `${v.toFixed(casas)}%`;
}

export function textoVariacaoCategoria(params: {
  categoria: string;
  valorAtual: number;
  valorReferencia: number;
  deltaPct: number | null;
  comparadoCom: string;
}): string {
  const { categoria, valorAtual, valorReferencia, deltaPct, comparadoCom } = params;
  if (valorReferencia === 0 && valorAtual > 0) {
    return `"${categoria}" é uma despesa nova em relação a ${comparadoCom}: ${fmtMoeda(valorAtual)} neste período, sem lançamento equivalente antes.`;
  }
  const direcao = (deltaPct ?? 0) >= 0 ? "subiu" : "caiu";
  return `A categoria "${categoria}" ${direcao} ${fmtPct(Math.abs(deltaPct ?? 0))} em relação a ${comparadoCom} (de ${fmtMoeda(valorReferencia)} para ${fmtMoeda(valorAtual)}).`;
}

export function textoDespesaSumiu(categoria: string, valorHistorico: number, mesesEstaveis: number): string {
  return `"${categoria}" teve lançamento estável por ${mesesEstaveis} meses seguidos (em torno de ${fmtMoeda(valorHistorico)}) e não aparece neste período. Pode ser quitação normal, pagamento por outro meio, ou um lançamento esquecido — vale conferir.`;
}

export function textoFornecedor(params: {
  nome: string;
  valorAtual: number;
  valorReferencia: number;
  deltaPct: number | null;
  comparadoCom: string;
}): string {
  const { nome, valorAtual, valorReferencia, deltaPct, comparadoCom } = params;
  if (valorReferencia === 0) {
    return `Novo fornecedor no período: ${nome}, ${fmtMoeda(valorAtual)} pagos, sem histórico em ${comparadoCom}.`;
  }
  if (valorAtual === 0) {
    return `${nome} não recebeu nenhum pagamento neste período (tinha ${fmtMoeda(valorReferencia)} em ${comparadoCom}).`;
  }
  const direcao = (deltaPct ?? 0) >= 0 ? "cresceu" : "caiu";
  return `Pagamentos a ${nome} ${direcao} ${fmtPct(Math.abs(deltaPct ?? 0))} frente a ${comparadoCom} (${fmtMoeda(valorReferencia)} → ${fmtMoeda(valorAtual)}).`;
}

export function textoConcentracaoFornecedores(top5Pct: number, top1Nome: string, top1Pct: number): string {
  return `Os 5 maiores fornecedores do período respondem por ${fmtPct(top5Pct)} do total pago. O maior sozinho (${top1Nome}) é ${fmtPct(top1Pct)}.`;
}

export function textoConcentracaoVencimentos(params: {
  semanaInicio: string;
  totalSemana: number;
  totalPeriodo: number;
  qtdContas: number;
}): string {
  const { semanaInicio, totalSemana, totalPeriodo, qtdContas } = params;
  const pct = totalPeriodo > 0 ? (totalSemana / totalPeriodo) * 100 : 0;
  return `A semana de ${semanaInicio} concentra ${fmtMoeda(totalSemana)} em ${qtdContas} conta(s) a pagar — ${fmtPct(pct)} de tudo que está pendente no período analisado.`;
}

export function textoRealizadoVsMeta(realizado: number, meta: number): string {
  const pct = meta > 0 ? (realizado / meta) * 100 : 0;
  const texto = pct >= 100 ? "superou" : "ficou abaixo de";
  return `O resultado ${texto} a meta: ${fmtMoeda(realizado)} de ${fmtMoeda(meta)} (${fmtPct(pct)} da meta), medido pelo dinheiro que realmente entrou na conta.`;
}

export function textoDescasamentoCartao(params: {
  mesLabel: string;
  pctCredito: number;
  valorCredito: number;
  valorTotal: number;
  prazoMedioCredito: number;
  pctDebito: number;
  valorDebito: number;
  prazoMedioDebito: number;
}): string {
  const { mesLabel, pctCredito, valorCredito, valorTotal, prazoMedioCredito, pctDebito, valorDebito, prazoMedioDebito } = params;
  return (
    `Em ${mesLabel}, ${fmtPct(pctCredito)} do valor vendido no cartão (${fmtMoeda(valorCredito)} de ${fmtMoeda(valorTotal)}) foi em crédito, ` +
    `com prazo médio de liquidação de ${prazoMedioCredito.toFixed(1)} dias — boa parte desse valor só entra efetivamente na conta nas semanas seguintes, não em ${mesLabel}. ` +
    `Já o débito (${fmtPct(pctDebito)} do valor, ${fmtMoeda(valorDebito)}) tem prazo médio de ${prazoMedioDebito.toFixed(1)} dia(s) e cai quase integralmente dentro do próprio mês. ` +
    `Isso significa que o valor recebido na conta num mês reflete principalmente a mistura de crédito/débito vendida no(s) mês(es) anterior(es), não as vendas do mês corrente.`
  );
}

export function textoQualidadeFornecedorDuplicado(nomes: string[], somaTotal: number): string {
  return `${nomes.join(" / ")} aparecem como fornecedores diferentes, mas ainda não têm identidade canônica confirmada — somados, representam ${fmtMoeda(somaTotal)} no período. Revise a normalização de fornecedor para esses nomes.`;
}

export function textoQualidadeMesParcial(mesLabel: string, motivo: string): string {
  return `${mesLabel} está marcado como dado parcial (${motivo}) — os números desse mês entram no cálculo, mas com confiança reduzida.`;
}

export function textoComoFoiOMes(params: {
  periodoLabel: string;
  receita: number;
  despesa: number;
  resultado: number;
  varReceitaPct: number | null;
  comparadoCom: string;
  qtdAchadosCriticos: number;
  qtdAchadosAtencao: number;
}): string {
  const { periodoLabel, receita, despesa, resultado, varReceitaPct, comparadoCom, qtdAchadosCriticos, qtdAchadosAtencao } = params;
  const sinalResultado = resultado >= 0 ? "positivo" : "negativo";
  const fraseReceita =
    varReceitaPct === null
      ? `A receita de ${periodoLabel} foi ${fmtMoeda(receita)}, sem base de comparação disponível.`
      : `A receita de ${periodoLabel} foi ${fmtMoeda(receita)}, ${varReceitaPct >= 0 ? "uma alta" : "uma queda"} de ${fmtPct(Math.abs(varReceitaPct))} frente a ${comparadoCom}.`;
  const fraseAlerta =
    qtdAchadosCriticos + qtdAchadosAtencao === 0
      ? "Nenhum ponto crítico ou de atenção identificado neste período."
      : `Foram identificados ${qtdAchadosCriticos} ponto(s) crítico(s) e ${qtdAchadosAtencao} de atenção, detalhados abaixo.`;
  return `${fraseReceita} As saídas somaram ${fmtMoeda(despesa)}, resultado de caixa ${sinalResultado} de ${fmtMoeda(resultado)}. ${fraseAlerta}`;
}

export function textoConclusao(params: { resultado: number; qtdOportunidades: number }): string {
  const { resultado, qtdOportunidades } = params;
  const base = resultado >= 0 ? "O período fechou com resultado de caixa positivo." : "O período fechou com resultado de caixa negativo — vale revisar os pontos de atenção acima antes do próximo fechamento.";
  const oportunidade = qtdOportunidades > 0 ? ` Há ${qtdOportunidades} oportunidade(s) identificada(s) que não exigem ação urgente, mas valem acompanhamento.` : "";
  return base + oportunidade;
}
