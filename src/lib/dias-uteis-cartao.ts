// Cálculo de dia útil (fins de semana + feriados) para o módulo de
// conciliação de cartão. Cópia independente do mesmo algoritmo usado em
// src/lib/cobertura-pix.ts -- deliberadamente não compartilhada, para este
// módulo novo nunca correr risco de alterar o comportamento do /extrato.

export function ehFimDeSemana(data: string): boolean {
  const diaDaSemana = new Date(data + "T00:00:00Z").getUTCDay();
  return diaDaSemana === 0 || diaDaSemana === 6;
}

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

function somarDiasCorridos(data: string, dias: number): string {
  const d = new Date(data + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function somarDiasUteis(data: string, dias: number, feriados: ReadonlySet<string>): string {
  let atual = data;
  for (let i = 0; i < dias; i++) atual = proximoDiaUtil(atual, feriados);
  return atual;
}

/**
 * Data prevista de recebimento calculada por nós, para conferência contra a
 * data que a própria adquirente já manda no arquivo (crédito/débito) ou para
 * calcular o prazo do Voucher, que o arquivo não informa.
 */
export function calcularDataPrevista(
  dataVenda: string,
  modalidade: "credito" | "debito" | "pix" | "voucher",
  feriados: ReadonlySet<string>,
  opcoesVoucher?: { prazoDias: number; prazoTipo: "uteis" | "corridos" }
): string | null {
  if (modalidade === "pix") return dataVenda;
  if (modalidade === "debito") return proximoDiaUtil(dataVenda, feriados);
  if (modalidade === "credito") return proximoDiaUtil(somarDiasCorridos(dataVenda, 30), feriados);
  if (modalidade === "voucher") {
    if (!opcoesVoucher) return null;
    return opcoesVoucher.prazoTipo === "uteis"
      ? somarDiasUteis(dataVenda, opcoesVoucher.prazoDias, feriados)
      : proximoDiaUtil(somarDiasCorridos(dataVenda, opcoesVoucher.prazoDias - 1), feriados);
  }
  return null;
}
