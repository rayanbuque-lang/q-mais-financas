// Contrato do motor de Análise Inteligente Financeira.
// Ver docs/superpowers/specs/2026-10-03-analise-inteligente-design.md, seções 4 e 6.

export type DimensaoAchado =
  | "receita"
  | "despesa"
  | "categoria"
  | "fornecedor"
  | "forma_recebimento"
  | "meta"
  | "pressao_caixa"
  | "qualidade_dados";

export type ClasseAchado = "critico" | "atencao" | "observacao" | "oportunidade";
export type ConfiancaAchado = "alta" | "media" | "baixa";
export type SeloQualidade = "completo" | "parcial" | "insuficiente";

export interface Achado {
  id: string;
  dimensao: DimensaoAchado;
  titulo: string;
  valorAtual: number;
  valorReferencia: number;
  deltaAbsoluto: number;
  deltaPercentual: number | null;
  comparadoCom: string;
  score: number;
  classe: ClasseAchado;
  confianca: ConfiancaAchado;
  fatoOuHipotese: "fato" | "hipotese";
  explicacao: string | null;
  origemTabela: string;
  origemIds: string[];
  acaoSugerida: string | null;
  texto: string;
}

export interface SeloMes {
  ano: number;
  mes: number;
  chave: string; // "YYYY-MM"
  selo: SeloQualidade;
  diasComFechamentoCaixa: number;
  diasNoMes: number;
  fechadoFormalmente: boolean;
  temMovimentacaoEntrada: boolean;
}

export interface KpiResumo {
  receita: number;
  despesa: number;
  resultado: number;
  margemCaixa: number | null; // resultado / receita, null se receita = 0
  varReceitaPct: number | null;
  varDespesaPct: number | null;
  varResultadoPct: number | null;
}

export interface ItemMix {
  categoria: string;
  valor: number;
}

export interface SemanaVendas {
  semanaInicio: string; // YYYY-MM-DD, sempre uma segunda-feira
  valor: number;
}

export interface DetalheRecebimento {
  modalidade: string; // "Crédito" | "Débito" | "Voucher" | "Pix Santander" | "Pix Inter"
  valor: number;
  pctDoMix: number;
  prazoMedioDias: number | null; // só preenchido pra cartão (crédito/débito/voucher), null pra Pix
}

export interface RelatorioAnaliseInteligente {
  periodoInicio: string;
  periodoFim: string;
  periodoComparacaoInicio: string | null;
  periodoComparacaoFim: string | null;
  comparadoCom: string;
  kpis: KpiResumo;
  mixRecebimento: ItemMix[];
  topFornecedores: ItemMix[];
  vendasPorSemana: SemanaVendas[];
  detalhamentoRecebimento: DetalheRecebimento[];
  // Sempre atual (próximos 35 dias a partir de hoje) -- independente do
  // período selecionado, por isso fica fora de `achados` (ver motor.ts).
  pressaoCaixa: Achado[];
  achados: Achado[];
  achadosOcultos: Achado[]; // fora do top 8, mas calculados (seção 4 do pedido original: "ver todos")
  selos: SeloMes[];
  comoFoiOMes: string;
  conclusao: string;
  limitacoesDados: string[];
  versaoMotor: string;
  geradoEm: string;
}

export const VERSAO_MOTOR = "1.0.0";
