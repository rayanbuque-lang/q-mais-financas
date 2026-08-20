// Motor de "isso já foi importado pelo relatório Pix" — evita duplicar, na
// importação do .ofx, um Pix de fim de semana/feriado que o usuário já subiu
// via relatório Pix com a data certa. O banco sempre carimba o "eco" desses
// lançamentos com a data do PRÓXIMO DIA ÚTIL (nunca "algum dia depois") --
// confirmado incidente real de 2026-08-18/19: um Pix recebido de fornecedor A
// no fim de semana e um Pix recebido de fornecedor B numa terça, de valor
// coincidente, foram tratados como o mesmo lançamento e o de terça sumiu da
// importação, silenciosamente. A janela antiga (5 dias corridos) era frouxa
// demais pra esse mecanismo -- casava qualquer coisa parecida perto da data,
// não só o eco de verdade.
//
// Por que não comparar por nome/descrição do pagador, que resolveria o
// problema de forma mais direta: as duas fontes usam formatos SEM nenhum
// campo em comum. O .ofx do Santander só traz "PIX RECEBIDO <CPF/CNPJ>" (sem
// nome); o relatório Pix (Excel) só traz "PIX RECEBIDO <NOME COMPLETO>" (sem
// documento) -- confirmado line a line contra dado real de produção. Exigir
// match de descrição quebraria o próprio caso que este motor existe pra
// resolver, porque o mesmo Pix nunca tem o mesmo texto nas duas fontes.
//
// Só decide QUANTOS descartar (contagem por valor), nunca qual lançamento
// específico corresponde a qual dia — não precisa, porque valores duplicados
// no mesmo lote são fungíveis entre si (confirmado com o usuário).

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

function ehFimDeSemana(data: string): boolean {
  const diaDaSemana = new Date(data + "T00:00:00Z").getUTCDay(); // 0=domingo, 6=sábado
  return diaDaSemana === 0 || diaDaSemana === 6;
}

// Pula fins de semana e qualquer data presente em `feriados` (a tabela
// `feriados` do banco existe pra isso -- hoje pode estar vazia, o que
// degrada bem pra "só pula fim de semana"; cadastrar feriados deixa isso mais
// preciso sem precisar mexer em código de novo). Teto de iterações é só
// defesa contra um bug de data virar loop infinito -- nunca deve ser
// atingido com uso normal.
export function proximoDiaUtil(data: string, feriados: ReadonlySet<string>): string {
  let atual = data;
  for (let i = 0; i < 30; i++) {
    const proximo = new Date(atual + "T00:00:00Z");
    proximo.setUTCDate(proximo.getUTCDate() + 1);
    atual = proximo.toISOString().slice(0, 10);
    if (!ehFimDeSemana(atual) && !feriados.has(atual)) return atual;
  }
  return atual;
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

export function calcularCobertura(
  candidatos: CandidatoOfx[],
  existentes: LancamentoExistentePix[],
  feriados: ReadonlySet<string> = new Set()
): ResultadoCobertura {
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
  // aqui: com o critério de "próximo dia útil" cada existente só pode cobrir
  // UM dia específico, mas manter a ordem crescente evita qualquer dependência
  // de ordem de chegada quando há mais de um candidato empatado em valor.
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
    // Cobre SÓ quando o candidato cai exatamente no próximo dia útil do
    // existente -- é isso, e não "algum dia próximo", que caracteriza o eco
    // do banco. Valores coincidentes de pagadores diferentes em dias
    // distintos (o bug real de 2026-08-18) deixam de casar.
    const posicao = pool.findIndex((e) => candidato.data === proximoDiaUtil(e.data_lancamento, feriados));

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
