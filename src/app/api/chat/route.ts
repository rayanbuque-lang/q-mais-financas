import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401 });
  }

  const { messages, contexto } = await request.json() as {
    messages: { role: "user" | "assistant"; content: string }[];
    contexto?: {
      receita: number;
      despesa: number;
      resultado: number;
      contasPendentes: number;
      totalPendente: number;
      contasVencidas: number;
    };
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }), { status: 500 });
  }

  const cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  const mesAtual = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const sistemPrompt = `Você é o Assistente Financeiro do +Q Finanças, um sistema de gestão financeira empresarial brasileiro. Responda sempre em português brasileiro, de forma clara, objetiva e prática.

**Sobre você:**
- Nome: Assistente +Q
- Especialidade: finanças empresariais, fluxo de caixa, análise de resultados, contas a pagar
- Tom: profissional mas acessível, direto ao ponto

**Dados financeiros atuais (${mesAtual}):**
- Receita: R$ ${contexto?.receita?.toFixed(2) ?? "0,00"}
- Despesa: R$ ${contexto?.despesa?.toFixed(2) ?? "0,00"}
- Resultado: R$ ${contexto?.resultado?.toFixed(2) ?? "0,00"}
- Margem: ${contexto?.receita ? (((contexto.resultado ?? 0) / contexto.receita) * 100).toFixed(1) : 0}%
- Contas a pagar pendentes: ${contexto?.contasPendentes ?? 0} contas (Total: R$ ${contexto?.totalPendente?.toFixed(2) ?? "0,00"})
- Contas vencidas: ${contexto?.contasVencidas ?? 0}

**Data de hoje:** ${hoje}

**Diretrizes:**
- Use os dados financeiros acima para contextualizar suas respostas
- Dê conselhos práticos e actionáveis
- Se perguntado sobre como usar o sistema, explique as funcionalidades disponíveis: Movimentações, Contas a Pagar, DRE, Relatórios, Painel Comparativo, etc.
- Mantenha respostas concisas (máximo 3 parágrafos)
- Use emojis com moderação para destacar pontos importantes
- Nunca invente dados que não foram fornecidos`;

  const stream = await cliente.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: sistemPrompt,
    messages,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
