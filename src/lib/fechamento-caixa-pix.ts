// Ponte entre Pix recebidos no Extrato Bancário e o Fechamento de Caixa: o
// usuário decidiu que os campos pix_santander/pix_inter deixam de ser
// digitados manualmente e passam a ser preenchidos SÓ por aqui, agrupados
// por dia (soma de todos os Pix recebidos daquele dia, por banco).

import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";
import { calcularDinheiro } from "@/lib/fechamento-caixa-calc";

export type CampoPix = "pix_santander" | "pix_inter";
export type ResultadoAplicarPix = "ok" | "dia_fechado" | "falhou";

export function bancoParaCampoPix(banco: string): CampoPix | null {
  const b = banco.trim().toLowerCase();
  if (b === "santander") return "pix_santander";
  if (b === "inter") return "pix_inter";
  return null;
}

export async function verificarDiaFechadoCaixa(data: string): Promise<boolean> {
  const supabase = createClient();
  const { data: row } = await supabase.from("fechamento_caixa").select("fechado").eq("data", data).maybeSingle();
  return row?.fechado === true;
}

// delta positivo = soma (Pix lançado a partir do extrato), negativo = subtrai
// (Pix desfeito/excluído em Movimentações). "dia_fechado": o dia já está
// fechado -- tanto na checagem prévia do chamador quanto na condição do
// UPDATE abaixo (.eq("fechado", false)), que cobre a corrida rara em que o
// dia fecha entre a pré-checagem do chamador e esta escrita.
export async function aplicarPixNoFechamentoCaixa(data: string, campo: CampoPix, delta: number): Promise<ResultadoAplicarPix> {
  const supabase = createClient();
  const { data: existente, error: erroLeitura } = await supabase
    .from("fechamento_caixa")
    .select("*")
    .eq("data", data)
    .maybeSingle();
  if (erroLeitura) return "falhou";

  if (existente) {
    const novoValor = Math.max((existente[campo] ?? 0) + delta, 0);
    const base = {
      valor_total_vendas: existente.valor_total_vendas ?? 0,
      cartao: existente.cartao ?? 0,
      pix_santander: existente.pix_santander ?? 0,
      pix_inter: existente.pix_inter ?? 0,
      rom_card: existente.rom_card ?? 0,
      app: existente.app ?? 0,
      prefeitura: existente.prefeitura ?? 0,
      compras_prazo: existente.compras_prazo ?? 0,
      [campo]: novoValor,
    };
    const dinheiro = calcularDinheiro(base);
    const { data: linhas, error: erroUpdate } = await supabase
      .from("fechamento_caixa")
      .update({ [campo]: novoValor, dinheiro, total: dinheiro })
      .eq("id", existente.id)
      .eq("fechado", false)
      .select("id");
    if (erroUpdate) return "falhou";
    if (!linhas || linhas.length === 0) return "dia_fechado";
    await registrarLog({
      acao: "editou",
      tabela: "fechamento_caixa",
      registroId: existente.id,
      detalhes: `Pix (${campo}) ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} via extrato`,
    });
    return "ok";
  }

  if (delta <= 0) return "ok"; // nada a subtrair de um dia que não existe (não deveria acontecer)

  const base = { valor_total_vendas: 0, cartao: 0, pix_santander: 0, pix_inter: 0, rom_card: 0, app: 0, prefeitura: 0, compras_prazo: 0, [campo]: delta };
  const dinheiro = calcularDinheiro(base);
  const { error: erroInsert } = await supabase.from("fechamento_caixa").insert({
    data,
    turnos: 1,
    ...base,
    sobras_faltas: 0,
    dinheiro,
    total: dinheiro,
    rascunho: true,
    fechado: false,
  });
  if (erroInsert) {
    // Corrida: outro processo criou o dia entre nossa leitura e nossa
    // escrita -- tenta de novo, agora encontra o registro e faz UPDATE.
    if (erroInsert.code === "23505") return aplicarPixNoFechamentoCaixa(data, campo, delta);
    return "falhou";
  }
  await registrarLog({
    acao: "criou",
    tabela: "fechamento_caixa",
    detalhes: `Dia criado automaticamente por Pix (${campo}) via extrato: ${delta.toFixed(2)}`,
  });
  return "ok";
}
