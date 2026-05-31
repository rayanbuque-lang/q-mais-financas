import { createClient } from "@/lib/supabase/client";

interface AuditParams {
  acao: "criou" | "editou" | "excluiu" | "pagou" | "fechou" | "reabriu" | "recebeu" | "importou";
  tabela: string;
  registroId?: string;
  dadosAnteriores?: Record<string, unknown> | null;
  dadosNovos?: Record<string, unknown> | null;
  detalhes?: string;
}

export async function registrarLog(params: AuditParams) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  // Buscar nome do usuário
  const { data: profile } = await supabase
    .from("profiles")
    .select("nome")
    .eq("id", user.id)
    .single();

  await supabase.from("audit_log").insert({
    usuario_id: user.id,
    usuario_nome: profile?.nome || user.email || "Desconhecido",
    acao: params.acao,
    tabela: params.tabela,
    registro_id: params.registroId || null,
    dados_anteriores: params.dadosAnteriores || null,
    dados_novos: params.dadosNovos || null,
    detalhes: params.detalhes || null,
  });
}
