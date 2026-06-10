"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

interface Mensagem {
  role: "user" | "assistant";
  content: string;
}

const PERGUNTAS_RAPIDAS = [
  "Como está meu resultado financeiro este mês?",
  "Tenho contas a pagar vencidas?",
  "Como posso melhorar minha margem de lucro?",
  "O que é DRE e como interpretar?",
  "Como registrar uma movimentação?",
  "Como categorizar minhas despesas?",
];

function fmt(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function AssistentePage() {
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [input, setInput] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [contexto, setContexto] = useState<{
    receita: number; despesa: number; resultado: number;
    contasPendentes: number; totalPendente: number; contasVencidas: number;
  } | null>(null);
  const [semChave, setSemChave] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => {
    carregarContexto();
    // Mensagem de boas-vindas
    setMensagens([{
      role: "assistant",
      content: "Olá! Sou o Assistente Financeiro do +Q Finanças. 👋\n\nPosso ajudar você a analisar seus números, entender seu fluxo de caixa, interpretar relatórios e tirar dúvidas sobre o sistema. O que você gostaria de saber?",
    }]);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensagens, carregando]);

  async function carregarContexto() {
    const now = new Date();
    const mes = now.getMonth();
    const ano = now.getFullYear();
    const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const fim = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(new Date(ano, mes + 1, 0).getDate()).padStart(2, "0")}`;
    const hoje = now.toISOString().split("T")[0];

    const [r1, r2] = await Promise.all([
      supabase.from("movimentacoes").select("tipo,valor").gte("data", inicio).lte("data", fim),
      supabase.from("contas_pagar").select("valor,data_vencimento,status").eq("status", "pendente"),
    ]);

    const movs = r1.data || [];
    const receita = movs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
    const despesa = movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);
    const pendentes = r2.data || [];
    const vencidas = pendentes.filter(c => c.data_vencimento < hoje);

    setContexto({
      receita,
      despesa,
      resultado: receita - despesa,
      contasPendentes: pendentes.length,
      totalPendente: pendentes.reduce((a, c) => a + c.valor, 0),
      contasVencidas: vencidas.length,
    });
  }

  async function enviar(texto?: string) {
    const msg = (texto || input).trim();
    if (!msg || carregando) return;

    setInput("");
    setSemChave(false);
    const novasMensagens: Mensagem[] = [...mensagens, { role: "user", content: msg }];
    setMensagens(novasMensagens);
    setCarregando(true);

    // Adiciona placeholder para streaming
    setMensagens(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      // Envia apenas últimas 10 mensagens (excluindo a boas-vindas fixa)
      const historico = novasMensagens.slice(-10);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messages: historico, contexto }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error?.includes("ANTHROPIC_API_KEY")) {
          setSemChave(true);
          setMensagens(prev => prev.slice(0, -1));
        } else {
          setMensagens(prev => [
            ...prev.slice(0, -1),
            { role: "assistant", content: `Erro: ${err.error || "Tente novamente."}` },
          ]);
        }
        setCarregando(false);
        return;
      }

      // Streaming — lê chunks e atualiza a última mensagem
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let acumulado = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acumulado += decoder.decode(value, { stream: true });
          setMensagens(prev => [
            ...prev.slice(0, -1),
            { role: "assistant", content: acumulado },
          ]);
        }
      }
    } catch {
      setMensagens(prev => [
        ...prev.slice(0, -1),
        { role: "assistant", content: "Erro de conexão. Tente novamente." },
      ]);
    } finally {
      setCarregando(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] max-h-[800px]">
      {/* Cabeçalho */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Assistente Financeiro</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">Tire dúvidas sobre seus dados e o sistema</p>
      </div>

      {/* Aviso sem chave */}
      {semChave && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <p className="text-sm font-bold text-amber-800 mb-1">⚙️ Chave de API necessária</p>
          <p className="text-sm text-amber-700">
            Para usar o assistente, adicione sua chave da Anthropic ao <code className="bg-amber-100 px-1 rounded">.env.local</code> e às variáveis de ambiente do Vercel:
          </p>
          <code className="block mt-2 text-xs bg-white border border-amber-200 rounded-lg px-3 py-2 font-mono text-amber-900 select-all">
            ANTHROPIC_API_KEY=sk-ant-api03-...
          </code>
          <p className="text-xs text-amber-600 mt-2">
            Obtenha sua chave em <strong>console.anthropic.com</strong> → API Keys
          </p>
        </div>
      )}

      {/* Contexto financeiro */}
      {contexto && (
        <div className="mb-4 p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Contexto carregado automaticamente</p>
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-emerald-600 font-semibold">📈 Receita: {fmt(contexto.receita)}</span>
            <span className="text-red-500 font-semibold">📉 Despesa: {fmt(contexto.despesa)}</span>
            <span className={`font-semibold ${contexto.resultado >= 0 ? "text-emerald-700" : "text-red-600"}`}>💰 Resultado: {fmt(contexto.resultado)}</span>
            {contexto.contasVencidas > 0 && <span className="text-red-600 font-semibold">🚨 {contexto.contasVencidas} vencidas</span>}
          </div>
        </div>
      )}

      {/* Mensagens */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {mensagens.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "assistant" && (
              <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center text-base shrink-0 mr-2 mt-0.5">🤖</div>
            )}
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed ${
                m.role === "user"
                  ? "bg-emerald-600 text-white rounded-tr-sm"
                  : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded-tl-sm"
              }`}
            >
              {m.content || (carregando && i === mensagens.length - 1 && (
                <span className="inline-flex gap-1">
                  <span className="animate-bounce" style={{ animationDelay: "0ms" }}>●</span>
                  <span className="animate-bounce" style={{ animationDelay: "150ms" }}>●</span>
                  <span className="animate-bounce" style={{ animationDelay: "300ms" }}>●</span>
                </span>
              ))}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Perguntas rápidas */}
      {mensagens.length <= 1 && !carregando && (
        <div className="mt-4 mb-3">
          <p className="text-xs text-[var(--color-text-muted)] mb-2">Perguntas frequentes:</p>
          <div className="flex flex-wrap gap-2">
            {PERGUNTAS_RAPIDAS.map((p) => (
              <button key={p} onClick={() => enviar(p)}
                className="px-3 py-1.5 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded-full hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 transition">
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="mt-3 flex gap-2 items-end">
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Digite sua pergunta..."
            disabled={carregando}
            className="w-full px-4 py-3.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-50 pr-12"
          />
          {input && (
            <button onClick={() => setInput("")}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm">
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => enviar()}
          disabled={!input.trim() || carregando}
          className="w-12 h-12 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 transition disabled:opacity-40 flex items-center justify-center text-lg shrink-0"
        >
          {carregando ? (
            <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin block" />
          ) : "➤"}
        </button>
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)] text-center mt-2">
        Powered by Claude · Enter para enviar
      </p>
    </div>
  );
}
