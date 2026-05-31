import { createClient } from "@/lib/supabase/client";

interface NotificacaoNova {
  tipo: string;
  titulo: string;
  mensagem: string;
  modulo?: string;
  link?: string;
  prioridade?: string;
}

export async function gerarNotificacoes() {
  const supabase = createClient();
  const hoje = new Date().toISOString().split("T")[0];
  const amanha = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  const semanaQueVem = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  // Verificar notificações já existentes hoje para evitar duplicatas
  const { data: existentes } = await supabase
    .from("notificacoes")
    .select("tipo, titulo")
    .gte("created_at", hoje + "T00:00:00");

  const titulosExistentes = new Set(
    (existentes || []).map((n) => `${n.tipo}:${n.titulo}`)
  );

  const novas: NotificacaoNova[] = [];

  // 1. Contas vencendo HOJE
  const { data: vencendoHoje } = await supabase
    .from("contas_pagar")
    .select("*")
    .eq("status", "pendente")
    .eq("data_vencimento", hoje);

  if (vencendoHoje && vencendoHoje.length > 0) {
    const total = vencendoHoje.reduce((a: number, c: { valor: number }) => a + c.valor, 0);
    const tit = `${vencendoHoje.length} conta(s) vencem hoje`;
    if (!titulosExistentes.has(`conta_vencendo:${tit}`)) {
      novas.push({
        tipo: "conta_vencendo",
        titulo: tit,
        mensagem: `Total: R$ ${total.toFixed(2)}. ${vencendoHoje.map((c: { fornecedor: string }) => c.fornecedor).join(", ")}`,
        modulo: "contas-pagar",
        link: "/contas-pagar",
        prioridade: "alta",
      });
    }
  }

  // 2. Contas vencidas (antes de hoje)
  const { data: vencidas } = await supabase
    .from("contas_pagar")
    .select("*")
    .eq("status", "pendente")
    .lt("data_vencimento", hoje);

  if (vencidas && vencidas.length > 0) {
    const total = vencidas.reduce((a: number, c: { valor: number }) => a + c.valor, 0);
    const tit = `${vencidas.length} conta(s) vencidas!`;
    if (!titulosExistentes.has(`conta_vencida:${tit}`)) {
      novas.push({
        tipo: "conta_vencida",
        titulo: tit,
        mensagem: `Total em atraso: R$ ${total.toFixed(2)}`,
        modulo: "contas-pagar",
        link: "/contas-pagar",
        prioridade: "urgente",
      });
    }
  }

  // 3. Contas vencendo esta semana
  const { data: vencendoSemana } = await supabase
    .from("contas_pagar")
    .select("*")
    .eq("status", "pendente")
    .gt("data_vencimento", hoje)
    .lte("data_vencimento", semanaQueVem);

  if (vencendoSemana && vencendoSemana.length > 0) {
    const total = vencendoSemana.reduce((a: number, c: { valor: number }) => a + c.valor, 0);
    const tit = `${vencendoSemana.length} conta(s) vencem esta semana`;
    if (!titulosExistentes.has(`conta_vencendo:${tit}`)) {
      novas.push({
        tipo: "conta_vencendo",
        titulo: tit,
        mensagem: `Total: R$ ${total.toFixed(2)}. Vencimentos: ${vencendoSemana.map((c: { fornecedor: string; data_vencimento: string }) => `${c.fornecedor} (${new Date(c.data_vencimento + "T12:00:00").toLocaleDateString("pt-BR")})`).join(", ")}`,
        modulo: "contas-pagar",
        link: "/contas-pagar",
        prioridade: "normal",
      });
    }
  }

  // 4. Vendas pendentes na maquininha (mais de 3 dias)
  const tresDiasAtras = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];
  const { data: vendasPendentes } = await supabase
    .from("vendas_maquina")
    .select("*")
    .eq("status", "pendente")
    .lte("data_previsao", tresDiasAtras);

  if (vendasPendentes && vendasPendentes.length > 0) {
    const total = vendasPendentes.reduce((a: number, v: { valor_liquido: number }) => a + v.valor_liquido, 0);
    const tit = `${vendasPendentes.length} venda(s) pendente(s) há mais de 3 dias`;
    if (!titulosExistentes.has(`venda_pendente:${tit}`)) {
      novas.push({
        tipo: "venda_pendente",
        titulo: tit,
        mensagem: `Total pendente: R$ ${total.toFixed(2)}. Verifique se o dinheiro caiu na conta.`,
        modulo: "vendas",
        link: "/vendas",
        prioridade: "normal",
      });
    }
  }

  // 5. Vendas com divergência
  const { data: divergencias } = await supabase
    .from("vendas_maquina")
    .select("*")
    .eq("status", "divergente");

  if (divergencias && divergencias.length > 0) {
    const total = divergencias.reduce((a: number, v: { diferenca: number | null }) => a + Math.abs(v.diferenca || 0), 0);
    const tit = `${divergencias.length} divergência(s) na maquininha`;
    if (!titulosExistentes.has(`divergencia:${tit}`)) {
      novas.push({
        tipo: "divergencia",
        titulo: tit,
        mensagem: `Diferença total: R$ ${total.toFixed(2)}. Compare com o extrato bancário.`,
        modulo: "vendas",
        link: "/vendas",
        prioridade: "alta",
      });
    }
  }

  // 6. Fluxo de caixa projetado negativo (próximos 7 dias)
  const inicio = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  const { data: movsMes } = await supabase
    .from("movimentacoes")
    .select("tipo, valor")
    .gte("data", inicio)
    .lte("data", hoje);

  if (movsMes && movsMes.length > 0) {
    const entradas = movsMes.filter((m: { tipo: string }) => m.tipo === "entrada").reduce((a: number, m: { valor: number }) => a + m.valor, 0);
    const saidas = movsMes.filter((m: { tipo: string }) => m.tipo === "saida").reduce((a: number, m: { valor: number }) => a + m.valor, 0);
    const saldo = entradas - saidas;

    if (saldo < 0) {
      const tit = "Fluxo de caixa negativo este mês";
      if (!titulosExistentes.has(`fluxo_negativo:${tit}`)) {
        novas.push({
          tipo: "fluxo_negativo",
          titulo: tit,
          mensagem: `Saldo atual: R$ ${saldo.toFixed(2)}. Despesas estão superando receitas.`,
          modulo: "fluxo-de-caixa",
          link: "/fluxo-de-caixa",
          prioridade: "urgente",
        });
      }
    }
  }

  // 7. Fevereiro sem fechamento (se já passou dia 5 do mês seguinte)
  const diaAtual = new Date().getDate();
  if (diaAtual >= 5) {
    let mesVerificar = new Date().getMonth(); // mês anterior
    let anoVerificar = new Date().getFullYear();
    if (mesVerificar === 0) { mesVerificar = 12; anoVerificar--; }

    const { data: fechamento } = await supabase
      .from("fechamentos_mensais")
      .select("status")
      .eq("mes", mesVerificar)
      .eq("ano", anoVerificar)
      .single();

    if (!fechamento || fechamento.status !== "fechado") {
      const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
      const nomeMes = mesesNomes[mesVerificar - 1];
      const tit = `${nomeMes}/${anoVerificar} ainda não foi fechado`;
      if (!titulosExistentes.has(`fechamento_pendente:${tit}`)) {
        novas.push({
          tipo: "fechamento_pendente",
          titulo: tit,
          mensagem: `Já estamos no dia ${diaAtual}. Feche o mês anterior para manter os dados organizados.`,
          modulo: "fechamento",
          link: "/fechamento",
          prioridade: "normal",
        });
      }
    }
  }

  // Inserir notificações novas
  if (novas.length > 0) {
    await supabase.from("notificacoes").insert(
      novas.map((n) => ({
        ...n,
        usuario_id: user.id,
        prioridade: n.prioridade || "normal",
      }))
    );
  }

  return novas.length;
}

