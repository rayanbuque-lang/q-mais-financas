// Fórmula de "dinheiro" do Fechamento de Caixa: o que sobra depois de
// descontar do total de vendas todos os outros meios de pagamento já
// contabilizados no dia. Extraída de fechamento-caixa/page.tsx para ser
// reaproveitada também por fechamento-caixa-pix.ts (evita duas fórmulas
// divergindo com o tempo).

export interface CamposPagamento {
  valor_total_vendas: number;
  cartao: number;
  pix_santander: number;
  pix_inter: number;
  rom_card: number;
  app: number;
  prefeitura: number;
  compras_prazo: number;
}

export function calcularDinheiro(f: CamposPagamento): number {
  const sub = f.cartao + f.pix_santander + f.pix_inter + f.rom_card + f.app + f.prefeitura + f.compras_prazo;
  return Math.max(f.valor_total_vendas - sub, 0);
}
