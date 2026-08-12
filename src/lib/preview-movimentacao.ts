// Prévia de "o que este lançamento do extrato viraria como movimentação" —
// usado só para exibição dentro do staging /extrato. Não escreve em
// movimentacoes; tipo é sempre derivado do sinal do valor, nunca armazenado.

export type TipoMovimentacao = "entrada" | "saida";

export function calcularTipoMovimentacao(valor: number): TipoMovimentacao {
  return valor >= 0 ? "entrada" : "saida";
}

export interface LancamentoParaResumo {
  id: string;
  data_lancamento: string; // yyyy-mm-dd
  valor: number;
  descricao: string;
  categoria: string | null;
  status: string;
}

export interface LancamentoResumido {
  id: string;
  descricao: string;
  valor: number;
}

export interface ResumoCategoriaDia {
  categoria: string;
  quantidade: number;
  total: number;
  // Categorias amplas (ex.: "Pagamento de boletos") somam vários fornecedores
  // diferentes no mesmo total — o resumo nunca perde essa identidade individual,
  // só a agrupa visualmente; quem precisa saber qual fornecedor foi pago pode
  // abrir esta lista.
  lancamentos: LancamentoResumido[];
}

export interface ResumoDia {
  data: string; // yyyy-mm-dd
  categorias: ResumoCategoriaDia[];
  totalDia: number;
}

export function agruparResumoPorDia(lancamentos: LancamentoParaResumo[]): ResumoDia[] {
  const porDia = new Map<string, Map<string, { quantidade: number; total: number; lancamentos: LancamentoResumido[] }>>();

  for (const l of lancamentos) {
    if (l.status !== "classificado" || !l.categoria) continue;

    if (!porDia.has(l.data_lancamento)) porDia.set(l.data_lancamento, new Map());
    const porCategoria = porDia.get(l.data_lancamento)!;

    const atual = porCategoria.get(l.categoria) ?? { quantidade: 0, total: 0, lancamentos: [] };
    atual.quantidade += 1;
    atual.total += l.valor;
    atual.lancamentos.push({ id: l.id, descricao: l.descricao, valor: l.valor });
    porCategoria.set(l.categoria, atual);
  }

  const dias: ResumoDia[] = Array.from(porDia.entries()).map(([data, porCategoria]) => {
    const categorias = Array.from(porCategoria.entries())
      .map(([categoria, { quantidade, total, lancamentos: itens }]) => ({
        categoria,
        quantidade,
        total,
        lancamentos: [...itens].sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR")),
      }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR"));
    const totalDia = categorias.reduce((soma, c) => soma + c.total, 0);
    return { data, categorias, totalDia };
  });

  return dias.sort((a, b) => b.data.localeCompare(a.data));
}
