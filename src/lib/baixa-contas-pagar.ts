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

// Tamanho mínimo do nome do fornecedor normalizado para que o casamento por
// nome valha alguma coisa. Existem contas_pagar reais com fornecedor de 2-3
// caracteres ("jj", "pp", "sdb", "arc", "yes"); um includes() com trecho tão
// curto bate com quase qualquer descrição de extrato, o que degradaria o
// critério "valor E nome" para "só valor" -- exatamente o que a spec diz que
// não é seguro o suficiente para baixar sozinho.
export const TAMANHO_MINIMO_FORNECEDOR = 4;

// "Contém", não prefixo: o banco antepõe texto variável antes do nome do
// fornecedor (ex.: "P SEVERINI NETTO COMERCIA" para o fornecedor cadastrado
// como "Severini") -- confirmado com dado real de produção.
function contaCasaComCandidato(conta: ContaPagarPendente, candidato: CandidatoBaixa): boolean {
  if (conta.valor !== candidato.valor) return false;
  const fornecedorNormalizado = normalizarDescricao(conta.fornecedor);
  // Abaixo do mínimo o nome não é evidência: trata como "não bate" (nem baixa,
  // nem ambiguidade -- mesmo comportamento de zero candidatos).
  if (fornecedorNormalizado.length < TAMANHO_MINIMO_FORNECEDOR) return false;
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
