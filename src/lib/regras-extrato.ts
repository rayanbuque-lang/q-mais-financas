// Motor de regras do extrato bancário (staging /extrato).
// Roda após cada importação e sob demanda ("reprocessar regras").
// Garantia crítica: só classifica lançamentos com status "nao_classificado" —
// nunca toca em algo que já tem categoria (manual ou automática), então uma
// classificação manual jamais é sobrescrita por um reprocessamento.

import { normalizarDescricao } from "@/lib/ofx";

export type TipoMatchRegra = "contem" | "comeca_com" | "regex";

export interface RegraExtrato {
  id: string;
  tipo_match: TipoMatchRegra;
  padrao: string;
  conta_id: string | null;
  valor_min: number | null;
  valor_max: number | null;
  categoria: string;
  prioridade: number;
  ativa: boolean;
}

export interface LancamentoClassificavel {
  id: string;
  conta_id: string;
  descricao_normalizada: string;
  valor: number;
  status: string;
}

export interface ResultadoClassificacao {
  lancamentoId: string;
  categoria: string;
  regraId: string;
}

function regraCasa(regra: RegraExtrato, lancamento: LancamentoClassificavel): boolean {
  if (!regra.ativa) return false;
  if (regra.conta_id && regra.conta_id !== lancamento.conta_id) return false;
  if (regra.valor_min != null && lancamento.valor < regra.valor_min) return false;
  if (regra.valor_max != null && lancamento.valor > regra.valor_max) return false;

  if (regra.tipo_match === "regex") {
    try {
      return new RegExp(regra.padrao, "i").test(lancamento.descricao_normalizada);
    } catch {
      return false; // regex inválida numa regra não pode derrubar o reprocessamento inteiro
    }
  }

  const padraoNormalizado = normalizarDescricao(regra.padrao);
  if (regra.tipo_match === "comeca_com") {
    return lancamento.descricao_normalizada.startsWith(padraoNormalizado);
  }
  return lancamento.descricao_normalizada.includes(padraoNormalizado);
}

export function aplicarRegras(
  lancamentos: LancamentoClassificavel[],
  regras: RegraExtrato[]
): ResultadoClassificacao[] {
  const regrasOrdenadas = [...regras]
    .filter((r) => r.ativa)
    .sort((a, b) => a.prioridade - b.prioridade);

  const resultados: ResultadoClassificacao[] = [];

  for (const lancamento of lancamentos) {
    if (lancamento.status !== "nao_classificado") continue;

    const regra = regrasOrdenadas.find((r) => regraCasa(r, lancamento));
    if (regra) {
      resultados.push({ lancamentoId: lancamento.id, categoria: regra.categoria, regraId: regra.id });
    }
  }

  return resultados;
}
