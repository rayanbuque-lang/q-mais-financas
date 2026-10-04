import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { gerarRelatorioAnalise } from "@/lib/analise-inteligente/motor";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function dataValida(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  // Mesma regra de acesso do Painel CEO (seção 1/8 da spec): só master.
  const { data: profile } = await supabaseAdmin.from("profiles").select("role, nome").eq("id", user.id).single();
  if (!profile || profile.role !== "master") {
    return Response.json({ error: "Acesso restrito a administradores" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const periodoInicio = body?.periodoInicio;
  const periodoFim = body?.periodoFim;
  const periodoComparacaoInicio = body?.periodoComparacaoInicio ?? null;
  const periodoComparacaoFim = body?.periodoComparacaoFim ?? null;

  if (!dataValida(periodoInicio) || !dataValida(periodoFim) || periodoInicio > periodoFim) {
    return Response.json({ error: "Período inválido" }, { status: 400 });
  }
  if ((periodoComparacaoInicio && !dataValida(periodoComparacaoInicio)) || (periodoComparacaoFim && !dataValida(periodoComparacaoFim))) {
    return Response.json({ error: "Período de comparação inválido" }, { status: 400 });
  }

  try {
    const relatorio = await gerarRelatorioAnalise(supabaseAdmin, periodoInicio, periodoFim, periodoComparacaoInicio, periodoComparacaoFim);

    const { data: salvo, error: erroSalvar } = await supabaseAdmin
      .from("analise_inteligente")
      .insert({
        periodo_inicio: relatorio.periodoInicio,
        periodo_fim: relatorio.periodoFim,
        periodo_comparacao_inicio: relatorio.periodoComparacaoInicio,
        periodo_comparacao_fim: relatorio.periodoComparacaoFim,
        versao_motor: relatorio.versaoMotor,
        achados: relatorio.achados,
        texto_final: null,
        gerado_por: user.id,
      })
      .select("id")
      .single();

    await supabaseAdmin.from("audit_log").insert({
      usuario_id: user.id,
      usuario_nome: profile.nome || user.email || "Desconhecido",
      acao: "analisou",
      tabela: "analise_inteligente",
      registro_id: salvo?.id ?? null,
      detalhes: `Análise Inteligente gerada para ${relatorio.periodoInicio} a ${relatorio.periodoFim}${erroSalvar ? " (aviso: não foi possível salvar o histórico)" : ""}`,
    });

    return Response.json({ relatorio, analiseId: salvo?.id ?? null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Erro inesperado ao gerar a análise." }, { status: 500 });
  }
}
