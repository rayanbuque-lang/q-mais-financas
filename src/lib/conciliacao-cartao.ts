// Motor de conciliação do módulo de cartão: agrupa as transações importadas
// em "recebíveis previstos" e casa contra os lançamentos já importados do
// extrato bancário (Santander). Mesmo espírito de src/lib/baixa-contas-pagar.ts
// -- nunca decide sozinho um empate; sem depósito encontrado é sinalizado,
// nunca silenciosamente ignorado.
//
// Por que agrupar por (data prevista, bandeira, modalidade) em vez de casar
// transação a transação: confirmado no OFX real do Santander que cada
// depósito de cartão chega separado por bandeira+modalidade
// ("PAGAMENTO CARTAO DE CREDITO GETNET-VISA", "...-MASTER", "...-ELO" são 3
// lançamentos distintos no mesmo dia) -- a adquirente liquida em lote por
// bandeira, não por venda individual.

import type { ModalidadeCartao, StatusTransacaoCartao, TotalConsolidado, TransacaoCartao } from "@/lib/cartao-vendas-parser";

/** Só os campos que agruparRecebiveis realmente usa -- deixa quem chama (a
 * tela, lendo direto do banco) montar o objeto sem precisar forjar uma
 * TransacaoCartao completa com campos que não existem naquela consulta. */
export interface TransacaoParaProvisao {
  bandeira: string;
  modalidade: ModalidadeCartao;
  statusTransacao: StatusTransacaoCartao;
  valorBruto: number;
  valorLiquido: number | null;
  dataVenda: string; // yyyy-mm-dd -- pra mostrar o período de venda que compõe o bucket
  dataPrevistaPagamento: string | null;
}

export interface BucketRecebivel {
  dataPrevista: string; // yyyy-mm-dd
  bandeira: string;
  modalidade: ModalidadeCartao;
  valorPrevisto: number; // líquido
  valorBrutoPrevisto: number;
  dataVendaInicio: string; // menor data de venda que compõe este bucket
  dataVendaFim: string; // maior data de venda que compõe este bucket
  quantidadeTransacoes: number;
}

export type StatusConciliacao =
  | "conciliado"
  | "divergente"
  | "sem_deposito_encontrado"
  | "multiplos_candidatos"
  | "aguardando"
  | "descartada";

export interface CandidatoExtrato {
  id: string;
  data: string; // yyyy-mm-dd
  valor: number;
}

export interface ResultadoConciliacaoBucket extends BucketRecebivel {
  status: StatusConciliacao;
  extratoLancamentoId: string | null;
  valorRecebido: number | null;
  diferenca: number | null;
  candidatosIds: string[];
}

const STATUS_PROVISIONAVEL: StatusTransacaoCartao[] = ["aprovada", "paga"];
const TOLERANCIA_CENTAVOS = 0.01;

/**
 * Agrupa transações aprovadas/pagas por (data prevista, bandeira, modalidade).
 * Transações sem data prevista (ex.: Voucher sem taxa/prazo cadastrado ainda)
 * voltam separadas em `semDataPrevista` -- nunca entram num bucket com data
 * inventada.
 */
export function agruparRecebiveis(transacoes: TransacaoParaProvisao[]): {
  buckets: BucketRecebivel[];
  semDataPrevista: TransacaoParaProvisao[];
} {
  const buckets = new Map<string, BucketRecebivel>();
  const semDataPrevista: TransacaoParaProvisao[] = [];

  for (const t of transacoes) {
    if (!STATUS_PROVISIONAVEL.includes(t.statusTransacao)) continue;
    if (!t.dataPrevistaPagamento || t.valorLiquido === null) {
      semDataPrevista.push(t);
      continue;
    }
    const chave = `${t.dataPrevistaPagamento}|${t.bandeira}|${t.modalidade}`;
    const existente = buckets.get(chave);
    if (existente) {
      existente.valorPrevisto += t.valorLiquido;
      existente.valorBrutoPrevisto += t.valorBruto;
      existente.quantidadeTransacoes += 1;
      if (t.dataVenda < existente.dataVendaInicio) existente.dataVendaInicio = t.dataVenda;
      if (t.dataVenda > existente.dataVendaFim) existente.dataVendaFim = t.dataVenda;
    } else {
      buckets.set(chave, {
        dataPrevista: t.dataPrevistaPagamento,
        bandeira: t.bandeira,
        modalidade: t.modalidade,
        valorPrevisto: t.valorLiquido,
        valorBrutoPrevisto: t.valorBruto,
        dataVendaInicio: t.dataVenda,
        dataVendaFim: t.dataVenda,
        quantidadeTransacoes: 1,
      });
    }
  }

  // Soma em ponto flutuante ao longo de milhares de transações acumula erro
  // (ex.: 839.5699999999998) -- arredonda só no fechamento do bucket, nunca
  // durante o acúmulo, pra não mascarar centavo real perdido em cada soma.
  for (const bucket of buckets.values()) {
    bucket.valorPrevisto = arredondar(bucket.valorPrevisto);
    bucket.valorBrutoPrevisto = arredondar(bucket.valorBrutoPrevisto);
  }

  return { buckets: [...buckets.values()], semDataPrevista };
}

function diferencaDias(dataA: string, dataB: string): number {
  const a = new Date(dataA + "T00:00:00Z").getTime();
  const b = new Date(dataB + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}

function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Casa um bucket de recebível contra os lançamentos candidatos do extrato.
 * Janela de tolerância [-1, +3] dias em torno da data prevista -- cobre o
 * mesmo tipo de ajuste de fim de semana/feriado que o banco pode aplicar de
 * forma diferente da adquirente (mesmo raciocínio de cobertura-pix.ts).
 */
export function conciliarBucket(bucket: BucketRecebivel, candidatos: CandidatoExtrato[], dataLimiteCobertura: string): ResultadoConciliacaoBucket {
  const naJanela = candidatos.filter((c) => {
    const d = diferencaDias(c.data, bucket.dataPrevista);
    return d >= -1 && d <= 3;
  });

  const exatos = naJanela.filter((c) => Math.abs(c.valor - bucket.valorPrevisto) < TOLERANCIA_CENTAVOS);

  if (exatos.length === 1) {
    return {
      ...bucket,
      status: "conciliado",
      extratoLancamentoId: exatos[0].id,
      valorRecebido: exatos[0].valor,
      diferenca: 0,
      candidatosIds: [exatos[0].id],
    };
  }
  if (exatos.length > 1) {
    return {
      ...bucket,
      status: "multiplos_candidatos",
      extratoLancamentoId: null,
      valorRecebido: null,
      diferenca: null,
      candidatosIds: exatos.map((c) => c.id),
    };
  }

  const naDataExata = naJanela.filter((c) => c.data === bucket.dataPrevista);
  if (naDataExata.length === 1) {
    const candidato = naDataExata[0];
    return {
      ...bucket,
      status: "divergente",
      extratoLancamentoId: candidato.id,
      valorRecebido: candidato.valor,
      diferenca: arredondar(candidato.valor - bucket.valorPrevisto),
      candidatosIds: [candidato.id],
    };
  }

  if (naJanela.length === 0) {
    // `dataLimiteCobertura` é o menor entre "hoje" e a última data que o
    // extrato bancário realmente tem importada -- nunca só "hoje". Sem essa
    // segunda condição, um extrato importado só até 03/09 faria qualquer
    // bucket previsto pra 04-07/09 (passado em relação a "hoje", mas nunca
    // sequer conferido porque o extrato não chega lá) virar alarme vermelho
    // de "sem depósito" por engano -- quando na verdade é só falta importar
    // extrato mais recente, não dinheiro perdido. Só é alarme de verdade
    // quando a data prevista está dentro do que o extrato já cobre.
    if (bucket.dataPrevista > dataLimiteCobertura) {
      return { ...bucket, status: "aguardando", extratoLancamentoId: null, valorRecebido: null, diferenca: null, candidatosIds: [] };
    }
    return {
      ...bucket,
      status: "sem_deposito_encontrado",
      extratoLancamentoId: null,
      valorRecebido: null,
      diferenca: arredondar(-bucket.valorPrevisto),
      candidatosIds: [],
    };
  }

  // Sobrou mais de um candidato na janela e nenhum critério acima decidiu
  // sozinho -- exige escolha manual, nunca chuta.
  return {
    ...bucket,
    status: "multiplos_candidatos",
    extratoLancamentoId: null,
    valorRecebido: null,
    diferenca: null,
    candidatosIds: naJanela.map((c) => c.id),
  };
}

/**
 * Conciliar todos os buckets contra o mesmo pool de candidatos exige cuidado:
 * dois buckets diferentes cuja janela se sobrepõe (ex.: mesma bandeira,
 * datas previstas adjacentes) podem ambos "bater exato" contra o MESMO
 * lançamento do extrato se ele não for retirado do pool depois de usado --
 * isso faria os dois aparecerem como "conciliado" quando só um deles tem
 * depósito de verdade, escondendo exatamente a falta de valor que este
 * módulo existe para achar. Por isso processa em ordem determinística (data
 * prevista mais antiga primeiro) e remove do pool todo lançamento já
 * reivindicado (conciliado ou divergente) antes de seguir pro próximo bucket
 * -- mesmo espírito "guloso, do mais antigo primeiro" de calcularCobertura em
 * cobertura-pix.ts. "multiplos_candidatos" não consome nada do pool: nada
 * foi decidido, e os mesmos candidatos continuam disponíveis pra escolha
 * manual em qualquer bucket que os ofereça.
 */
export function conciliarBuckets(buckets: BucketRecebivel[], candidatos: CandidatoExtrato[], dataLimiteCobertura: string): ResultadoConciliacaoBucket[] {
  const poolDisponivel = [...candidatos];
  const ordenados = [...buckets].sort((a, b) => a.dataPrevista.localeCompare(b.dataPrevista));

  const resultados: ResultadoConciliacaoBucket[] = [];
  for (const bucket of ordenados) {
    const resultado = conciliarBucket(bucket, poolDisponivel, dataLimiteCobertura);
    resultados.push(resultado);
    if (resultado.status === "conciliado" || resultado.status === "divergente") {
      const indice = poolDisponivel.findIndex((c) => c.id === resultado.extratoLancamentoId);
      if (indice !== -1) poolDisponivel.splice(indice, 1);
    }
  }
  // Ordem de retorno não importa pro chamador (cada resultado carrega sua
  // própria chave data_prevista+bandeira+modalidade e é gravado via upsert),
  // só a ordenação acima (mais antigo primeiro) importa, e é interna.
  return resultados;
}

export interface TransacaoParaAuditoriaTaxa {
  bandeira: string;
  modalidade: ModalidadeCartao;
  valorBruto: number;
  valorTaxa: number | null;
}

export interface TaxaContratadaParaAuditoria {
  bandeira: string;
  modalidade: ModalidadeCartao;
  taxaPercentual: number | null;
}

export interface AuditoriaTaxa {
  bandeira: string;
  modalidade: ModalidadeCartao;
  taxaContratada: number;
  taxaEfetivaMedia: number;
  diferencaPontos: number; // efetiva − contratada, em pontos percentuais
  totalBruto: number;
  qtdTransacoes: number;
  valorExcedente: number; // quanto foi cobrado a mais que o contratado, em R$ (0 se dentro do combinado)
  status: "dentro_do_contrato" | "acima_do_contrato";
}

// Ruído de arredondamento por transação é real (uma taxa de 1,5% num Pix de
// R$6 já varia 1,33%-1,67% só de arredondar centavo) -- comparar a MÉDIA
// PONDERADA (soma da taxa / soma do bruto) contra o contratado, nunca
// transação a transação, e ainda assim aplicar uma tolerância pequena antes
// de acusar cobrança acima do combinado.
const TOLERANCIA_PONTOS_PERCENTUAIS = 0.03;

/**
 * Compara a taxa contratada (cadastrada manualmente -- o sistema não tem como
 * saber sozinho o que foi negociado com a adquirente) contra a taxa média
 * efetivamente cobrada nas transações já importadas. Isso não pode ser feito
 * comparando "cobrado" com "cobrado" (por isso a taxa contratada tem que vir
 * de fora, nunca é inferida a partir do próprio arquivo).
 */
export function auditarTaxas(
  transacoes: TransacaoParaAuditoriaTaxa[],
  taxasContratadas: TaxaContratadaParaAuditoria[]
): AuditoriaTaxa[] {
  const agregados = new Map<string, { totalBruto: number; totalTaxa: number; qtd: number }>();
  for (const t of transacoes) {
    if (t.valorTaxa === null) continue;
    const chave = `${t.bandeira}|${t.modalidade}`;
    const atual = agregados.get(chave) ?? { totalBruto: 0, totalTaxa: 0, qtd: 0 };
    atual.totalBruto += t.valorBruto;
    atual.totalTaxa += t.valorTaxa;
    atual.qtd += 1;
    agregados.set(chave, atual);
  }

  const resultado: AuditoriaTaxa[] = [];
  for (const contratada of taxasContratadas) {
    if (contratada.taxaPercentual === null) continue;
    const agregado = agregados.get(`${contratada.bandeira}|${contratada.modalidade}`);
    if (!agregado || agregado.totalBruto === 0) continue;

    const taxaEfetivaMedia = (agregado.totalTaxa / agregado.totalBruto) * 100;
    const diferencaPontos = taxaEfetivaMedia - contratada.taxaPercentual;
    const acimaDoContrato = diferencaPontos > TOLERANCIA_PONTOS_PERCENTUAIS;
    const valorExcedente = acimaDoContrato ? arredondar(agregado.totalBruto * (diferencaPontos / 100)) : 0;

    resultado.push({
      bandeira: contratada.bandeira,
      modalidade: contratada.modalidade,
      taxaContratada: contratada.taxaPercentual,
      taxaEfetivaMedia: Math.round(taxaEfetivaMedia * 1000) / 1000,
      diferencaPontos: Math.round(diferencaPontos * 1000) / 1000,
      totalBruto: arredondar(agregado.totalBruto),
      qtdTransacoes: agregado.qtd,
      valorExcedente,
      status: acimaDoContrato ? "acima_do_contrato" : "dentro_do_contrato",
    });
  }
  return resultado.sort((a, b) => b.valorExcedente - a.valorExcedente);
}

export interface ComparacaoSoma {
  bandeira: string;
  modalidade: string;
  somaDetalhado: number;
  somaConsolidado: number;
  diferenca: number;
  ok: boolean;
}

/**
 * "Prova de soma" entre os dois arquivos do mesmo período -- mesmo padrão já
 * usado na importação do extrato (comparar lido vs. gravado e alertar em vez
 * de assumir que bateu). Soma só transações aprovadas/pagas: confirmado com
 * os arquivos reais que o resumo do Consolidado reflete apenas vendas
 * efetivadas -- uma "Negada" nunca foi dinheiro, o relatório agregado não a
 * conta (diferença de R$228,68 em Voucher no período de teste sumiu ao
 * excluir negadas do lado Detalhado).
 */
export function compararSomas(transacoesDetalhado: TransacaoCartao[], totaisConsolidado: TotalConsolidado[]): ComparacaoSoma[] {
  const somaDetalhado = new Map<string, number>();
  for (const t of transacoesDetalhado) {
    if (!STATUS_PROVISIONAVEL.includes(t.statusTransacao)) continue;
    const chave = `${t.bandeira}|${t.modalidade}`;
    somaDetalhado.set(chave, (somaDetalhado.get(chave) ?? 0) + t.valorBruto);
  }

  const somaConsolidado = new Map<string, number>();
  for (const c of totaisConsolidado) {
    const chave = `${c.bandeira}|${c.modalidade}`;
    somaConsolidado.set(chave, (somaConsolidado.get(chave) ?? 0) + c.totalBruto);
  }

  const chaves = new Set([...somaDetalhado.keys(), ...somaConsolidado.keys()]);
  const resultado: ComparacaoSoma[] = [];
  for (const chave of chaves) {
    const [bandeira, modalidade] = chave.split("|");
    const a = somaDetalhado.get(chave) ?? 0;
    const b = somaConsolidado.get(chave) ?? 0;
    const diferenca = arredondar(a - b);
    resultado.push({ bandeira, modalidade, somaDetalhado: arredondar(a), somaConsolidado: arredondar(b), diferenca, ok: Math.abs(diferenca) < TOLERANCIA_CENTAVOS });
  }
  return resultado.sort((x, y) => (x.bandeira + x.modalidade).localeCompare(y.bandeira + y.modalidade));
}
