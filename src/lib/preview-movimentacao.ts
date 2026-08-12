// Prévia de "o que este lançamento do extrato viraria como movimentação" —
// usado só para exibição dentro do staging /extrato. Não escreve em
// movimentacoes; tipo é sempre derivado do sinal do valor, nunca armazenado.

export type TipoMovimentacao = "entrada" | "saida";

export function calcularTipoMovimentacao(valor: number): TipoMovimentacao {
  return valor >= 0 ? "entrada" : "saida";
}

export interface LancamentoParaResumo {
  data_lancamento: string; // yyyy-mm-dd
  valor: number;
  categoria: string | null;
  status: string;
}

export interface ResumoCategoriaDia {
  categoria: string;
  quantidade: number;
  total: number;
}

export interface ResumoDia {
  data: string; // yyyy-mm-dd
  categorias: ResumoCategoriaDia[];
  totalDia: number;
}

export function agruparResumoPorDia(lancamentos: LancamentoParaResumo[]): ResumoDia[] {
  const porDia = new Map<string, Map<string, { quantidade: number; total: number }>>();

  for (const l of lancamentos) {
    if (l.status !== "classificado" || !l.categoria) continue;

    if (!porDia.has(l.data_lancamento)) porDia.set(l.data_lancamento, new Map());
    const porCategoria = porDia.get(l.data_lancamento)!;

    const atual = porCategoria.get(l.categoria) ?? { quantidade: 0, total: 0 };
    atual.quantidade += 1;
    atual.total += l.valor;
    porCategoria.set(l.categoria, atual);
  }

  const dias: ResumoDia[] = Array.from(porDia.entries()).map(([data, porCategoria]) => {
    const categorias = Array.from(porCategoria.entries())
      .map(([categoria, { quantidade, total }]) => ({ categoria, quantidade, total }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR"));
    const totalDia = categorias.reduce((soma, c) => soma + c.total, 0);
    return { data, categorias, totalDia };
  });

  return dias.sort((a, b) => b.data.localeCompare(a.data));
}
