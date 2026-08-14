// Matching de "fornecedor do XML de NF-e" -- usado tanto pra resolver
// categoria automaticamente (regra fornecedor -> categoria) quanto pra
// detectar se uma duplicata do XML já tem uma conta a pagar parecida
// lançada manualmente antes do XML chegar (nunca decide sozinho um empate,
// só sinaliza -- mesmo espírito de src/lib/baixa-contas-pagar.ts).

import { normalizarDescricao } from "@/lib/ofx";

// Mesmo piso já usado na baixa automática do extrato: abaixo disso o nome
// não é evidência confiável o suficiente pra um match "contém".
export const TAMANHO_MINIMO_FORNECEDOR_XML = 4;

export interface RegraFornecedor {
  id: string;
  fornecedor_padrao: string;
  categoria_id: string;
  ativa: boolean;
}

export interface ContaPagarPendenteParaComparar {
  id: string;
  fornecedor: string;
  valor: number;
}

// Fornecedor do XML (xNome da NF-e) é o nome legal completo -- por isso o
// padrão da regra (tipicamente mais curto, digitado por humano) precisa
// estar CONTIDO no nome do XML, não o contrário.
export function encontrarCategoriaPorFornecedor(fornecedorNomeXml: string, regras: RegraFornecedor[]): string | null {
  const fornecedorNormalizado = normalizarDescricao(fornecedorNomeXml);
  for (const regra of regras) {
    if (!regra.ativa) continue;
    const padraoNormalizado = normalizarDescricao(regra.fornecedor_padrao);
    if (padraoNormalizado.length < TAMANHO_MINIMO_FORNECEDOR_XML) continue;
    if (fornecedorNormalizado.includes(padraoNormalizado)) return regra.categoria_id;
  }
  return null;
}

// Mesmo sentido de comparação: o nome do fornecedor cadastrado manualmente
// na conta a pagar (mais curto) deve estar contido no nome legal do XML.
export function encontrarContasPagarCandidatas(
  fornecedorNomeXml: string,
  valorDuplicata: number,
  contasPendentes: ContaPagarPendenteParaComparar[]
): string[] {
  const fornecedorNormalizado = normalizarDescricao(fornecedorNomeXml);
  return contasPendentes
    .filter((c) => {
      if (c.valor !== valorDuplicata) return false;
      const contaNormalizada = normalizarDescricao(c.fornecedor);
      if (contaNormalizada.length < TAMANHO_MINIMO_FORNECEDOR_XML) return false;
      return fornecedorNormalizado.includes(contaNormalizada);
    })
    .map((c) => c.id);
}
