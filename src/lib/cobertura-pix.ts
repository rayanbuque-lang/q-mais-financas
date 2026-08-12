// Motor de "isso já foi importado pelo relatório Pix" — evita duplicar, na
// importação do .ofx, um Pix de fim de semana/feriado que o usuário já subiu
// via relatório Pix com a data certa. O banco sempre carimba o "eco" desses
// lançamentos com a data do próximo dia útil.
//
// Só decide QUANTOS descartar (contagem por valor), nunca qual lançamento
// específico corresponde a qual dia — não precisa, porque valores duplicados
// no mesmo lote são fungíveis entre si (confirmado com o usuário).

const JANELA_DIAS = 5;
const PADRAO_PIX_RECEBIDO = "pix recebido";

export interface LancamentoExistentePix {
  id: string;
  data_lancamento: string; // yyyy-mm-dd
  valor: number;
  descricao_normalizada: string;
}

export interface CandidatoOfx {
  indice: number;
  data: string; // yyyy-mm-dd
  valor: number;
  descricaoNormalizada: string;
}

export interface ResultadoCobertura {
  indicesParaImportar: number[];
  indicesCobertos: number[];
}

function diasEntre(dataMenor: string, dataMaior: string): number {
  const a = new Date(dataMenor + "T00:00:00Z").getTime();
  const b = new Date(dataMaior + "T00:00:00Z").getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function ehPixRecebido(descricaoNormalizada: string): boolean {
  return descricaoNormalizada.includes(PADRAO_PIX_RECEBIDO);
}

export function calcularCobertura(candidatos: CandidatoOfx[], existentes: LancamentoExistentePix[]): ResultadoCobertura {
  const poolPorValor = new Map<number, LancamentoExistentePix[]>();
  for (const e of existentes) {
    if (!ehPixRecebido(e.descricao_normalizada)) continue;
    const lista = poolPorValor.get(e.valor) ?? [];
    lista.push(e);
    poolPorValor.set(e.valor, lista);
  }

  const indicesParaImportar: number[] = [];
  const indicesCobertos: number[] = [];

  for (const candidato of candidatos) {
    if (!ehPixRecebido(candidato.descricaoNormalizada)) {
      indicesParaImportar.push(candidato.indice);
      continue;
    }

    const pool = poolPorValor.get(candidato.valor) ?? [];
    const posicao = pool.findIndex((e) => {
      const diferenca = diasEntre(e.data_lancamento, candidato.data);
      return diferenca >= 0 && diferenca <= JANELA_DIAS;
    });

    if (posicao === -1) {
      indicesParaImportar.push(candidato.indice);
    } else {
      pool.splice(posicao, 1);
      indicesCobertos.push(candidato.indice);
    }
  }

  return { indicesParaImportar, indicesCobertos };
}
