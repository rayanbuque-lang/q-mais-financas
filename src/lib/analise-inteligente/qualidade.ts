// Selo de qualidade de dados por mês — seção 4 da spec.
import type { SeloMes, SeloQualidade } from "./tipos";

function diasNoMes(ano: number, mes: number): number {
  return new Date(ano, mes, 0).getDate();
}

export function calcularSeloMes(params: {
  ano: number;
  mes: number;
  diasComFechamentoCaixa: number;
  fechadoFormalmente: boolean;
  temMovimentacaoEntrada: boolean;
  ehMesCorrente: boolean;
}): SeloMes {
  const { ano, mes, diasComFechamentoCaixa, fechadoFormalmente, temMovimentacaoEntrada, ehMesCorrente } = params;
  const total = diasNoMes(ano, mes);
  const coberturaPct = total > 0 ? diasComFechamentoCaixa / total : 0;

  let selo: SeloQualidade;
  if (coberturaPct < 0.5 || !temMovimentacaoEntrada) {
    selo = "insuficiente";
  } else if (!fechadoFormalmente || ehMesCorrente || coberturaPct < 0.9) {
    selo = "parcial";
  } else {
    selo = "completo";
  }

  return {
    ano,
    mes,
    chave: `${ano}-${String(mes).padStart(2, "0")}`,
    selo,
    diasComFechamentoCaixa,
    diasNoMes: total,
    fechadoFormalmente,
    temMovimentacaoEntrada,
  };
}

/** Multiplicador de confiança (C na fórmula de score) a partir dos selos envolvidos num achado. */
export function confiancaPorSelos(selos: SeloQualidade[]): number {
  if (selos.includes("insuficiente")) return 0.4;
  if (selos.includes("parcial")) return 0.7;
  return 1.0;
}
