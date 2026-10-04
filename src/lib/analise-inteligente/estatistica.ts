// Funções estatísticas robustas para amostra pequena (seção 5.1 da spec):
// mediana + MAD em vez de média + desvio-padrão, porque o histórico confiável
// do sistema hoje é de ~4-5 meses completos, não confiável para média/stddev.

export function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 0 ? (ordenados[meio - 1] + ordenados[meio]) / 2 : ordenados[meio];
}

// Desvio Absoluto Mediano: mediana dos desvios absolutos em relação à mediana.
export function mad(valores: number[]): number {
  if (valores.length === 0) return 0;
  const med = mediana(valores);
  const desvios = valores.map((v) => Math.abs(v - med));
  return mediana(desvios);
}

export function faixaMinMax(valores: number[]): { min: number; max: number } {
  if (valores.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...valores), max: Math.max(...valores) };
}

/** Desvio normalizado em [0,1] frente ao histórico (mediana+MAD, com fallback pra faixa min-máx quando MAD=0). */
export function desvioNormalizado(valorAtual: number, historico: number[]): number {
  if (historico.length === 0) return 0;
  const med = mediana(historico);
  const desvioMad = mad(historico);
  if (desvioMad > 0) {
    return Math.min(Math.abs(valorAtual - med) / (2 * desvioMad), 1);
  }
  const { min, max } = faixaMinMax(historico);
  const amplitude = max - min;
  if (amplitude === 0) return valorAtual === med ? 0 : 1;
  return Math.min(Math.abs(valorAtual - med) / amplitude, 1);
}

export function variacaoPercentual(atual: number, referencia: number): number | null {
  if (referencia === 0) return null;
  return ((atual - referencia) / referencia) * 100;
}
