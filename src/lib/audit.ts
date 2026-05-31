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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from("profiles").select("nome").eq("id", user.id).single();

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

export async function verificarMesFechado(data: string): Promise<{ fechado: boolean; nomeMes: string }> {
  const supabase = createClient();
  const d = new Date(data + "T12:00:00");
  const mes = d.getMonth() + 1;
  const ano = d.getFullYear();
  const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

  const { data: fechamento } = await supabase
    .from("fechamentos_mensais")
    .select("status")
    .eq("mes", mes)
    .eq("ano", ano)
    .single();

  return {
    fechado: fechamento?.status === "fechado",
    nomeMes: `${mesesNomes[mes - 1]}/${ano}`,
  };
}

export async function verificarAdmin(): Promise<boolean> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  return profile?.role === "master";
}
