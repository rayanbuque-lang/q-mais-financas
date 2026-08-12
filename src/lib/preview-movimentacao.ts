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
  revisado: boolean;
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
  pendentes: number; // lançamentos do dia ainda não classificados/ignorados
  classificadosIds: string[]; // ids dos lançamentos classificados do dia (para o "confirmar dia")
  revisado: boolean; // true só quando existe ao menos 1 classificado e todos já foram confirmados
}

export function agruparResumoPorDia(lancamentos: LancamentoParaResumo[]): ResumoDia[] {
  interface AcumuladorDia {
    categorias: Map<string, { quantidade: number; total: number; lancamentos: LancamentoResumido[] }>;
    pendentes: number;
    classificadosIds: string[];
    todosRevisados: boolean;
  }

  const porDia = new Map<string, AcumuladorDia>();

  for (const l of lancamentos) {
    if (!porDia.has(l.data_lancamento)) {
      porDia.set(l.data_lancamento, { categorias: new Map(), pendentes: 0, classificadosIds: [], todosRevisados: true });
    }
    const dia = porDia.get(l.data_lancamento)!;

    if (l.status === "nao_classificado") {
      dia.pendentes += 1;
      continue;
    }
    if (l.status !== "classificado" || !l.categoria) continue;

    dia.classificadosIds.push(l.id);
    if (!l.revisado) dia.todosRevisados = false;

    const atual = dia.categorias.get(l.categoria) ?? { quantidade: 0, total: 0, lancamentos: [] };
    atual.quantidade += 1;
    atual.total += l.valor;
    atual.lancamentos.push({ id: l.id, descricao: l.descricao, valor: l.valor });
    dia.categorias.set(l.categoria, atual);
  }

  const dias: ResumoDia[] = Array.from(porDia.entries()).map(([data, acumulado]) => {
    const categorias = Array.from(acumulado.categorias.entries())
      .map(([categoria, { quantidade, total, lancamentos: itens }]) => ({
        categoria,
        quantidade,
        total,
        lancamentos: [...itens].sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR")),
      }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR"));
    const totalDia = categorias.reduce((soma, c) => soma + c.total, 0);
    return {
      data,
      categorias,
      totalDia,
      pendentes: acumulado.pendentes,
      classificadosIds: acumulado.classificadosIds,
      revisado: acumulado.classificadosIds.length > 0 && acumulado.todosRevisados,
    };
  });

  // Todo dia com pelo menos um lançamento vira um bloco — inclusive os 100%
  // pendentes, sem isso o usuário não teria como alcançar esses lançamentos
  // pra classificar (a lista corrida separada foi removida da tela).
  return dias.sort((a, b) => b.data.localeCompare(a.data));
}
