// Motor de "esse pagamento no extrato bate com uma conta a pagar pendente" --
// usado pela automação de baixa em /extrato. Decide só QUEM baixa e QUEM fica
// ambíguo; nunca decide sozinho um empate (duas contas do mesmo fornecedor e
// mesmo valor pendentes ao mesmo tempo é um caso real, confirmado em produção).

import { normalizarDescricao } from "@/lib/ofx";

export interface ContaPagarPendente {
  id: string;
  fornecedor: string;
  valor: number;
}

export interface CandidatoBaixa {
  indice: number;
  valor: number; // valor absoluto (positivo) do lançamento de saída
  descricaoNormalizada: string;
}

export interface ResultadoBaixa {
  baixados: { indice: number; contaPagarId: string }[];
  ambiguos: { indice: number; candidatosIds: string[] }[];
}

// "Contém", não prefixo: o banco antepõe texto variável antes do nome do
// fornecedor (ex.: "P SEVERINI NETTO COMERCIA" para o fornecedor cadastrado
// como "Severini") -- confirmado com dado real de produção.
function contaCasaComCandidato(conta: ContaPagarPendente, candidato: CandidatoBaixa): boolean {
  if (conta.valor !== candidato.valor) return false;
  const fornecedorNormalizado = normalizarDescricao(conta.fornecedor);
  if (fornecedorNormalizado.length === 0) return false;
  return candidato.descricaoNormalizada.includes(fornecedorNormalizado);
}

export function calcularBaixasAutomaticas(
  candidatos: CandidatoBaixa[],
  contasPendentes: ContaPagarPendente[]
): ResultadoBaixa {
  const baixados: ResultadoBaixa["baixados"] = [];
  const ambiguos: ResultadoBaixa["ambiguos"] = [];

  for (const candidato of candidatos) {
    const casadas = contasPendentes.filter((conta) => contaCasaComCandidato(conta, candidato));
    if (casadas.length === 1) {
      baixados.push({ indice: candidato.indice, contaPagarId: casadas[0].id });
    } else if (casadas.length >= 2) {
      ambiguos.push({ indice: candidato.indice, candidatosIds: casadas.map((c) => c.id) });
    }
  }

  return { baixados, ambiguos };
}
