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

// Tem que ser `startsWith`, não `includes`: o extrato real traz linhas como
// "TARIFA PIX RECEBIDO QR CHECKOUT" (tarifa do banco, valor negativo, NÃO é
// receita recebida) que *contêm* "pix recebido" no meio. Com `includes`, uma
// tarifa podia cobrir outra tarifa de mesmo valor em outro dia da janela e
// sumir do extrato. As duas formas legítimas começam com o padrão: o .ofx traz
// "pix recebido 13020501402" e o relatório Pix sintetiza "pix recebido fulano".
export function ehPixRecebido(descricaoNormalizada: string): boolean {
  return descricaoNormalizada.startsWith(PADRAO_PIX_RECEBIDO);
}

function compararTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function calcularCobertura(candidatos: CandidatoOfx[], existentes: LancamentoExistentePix[]): ResultadoCobertura {
  const poolPorValor = new Map<number, LancamentoExistentePix[]>();
  for (const e of existentes) {
    if (!ehPixRecebido(e.descricao_normalizada)) continue;
    const lista = poolPorValor.get(e.valor) ?? [];
    lista.push(e);
    poolPorValor.set(e.valor, lista);
  }

  // O resultado não pode depender da ordem em que as linhas chegaram do banco
  // (a consulta não garante ordem) nem da ordem do array de candidatos. Ordena
  // os dois lados por data crescente (desempate estável por id/índice) para que
  // a saída seja função pura dos *valores* da entrada.
  //
  // Casar sempre o existente mais antigo disponível é a estratégia gulosa certa
  // aqui: como um existente cobre qualquer candidato com data >= a sua dentro da
  // janela, consumir o mais antigo primeiro preserva os mais recentes — que são
  // os únicos capazes de atender candidatos mais tardios.
  for (const lista of poolPorValor.values()) {
    lista.sort((a, b) => compararTexto(a.data_lancamento, b.data_lancamento) || compararTexto(a.id, b.id));
  }

  const candidatosOrdenados = [...candidatos].sort((a, b) => compararTexto(a.data, b.data) || a.indice - b.indice);

  const indicesParaImportar: number[] = [];
  const indicesCobertos: number[] = [];

  for (const candidato of candidatosOrdenados) {
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

  // Devolve sempre na ordem original dos candidatos, não na ordem de processamento.
  indicesParaImportar.sort((a, b) => a - b);
  indicesCobertos.sort((a, b) => a - b);

  return { indicesParaImportar, indicesCobertos };
}
