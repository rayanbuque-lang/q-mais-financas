"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

interface Mensagem {
  role: "user" | "assistant";
  content: string;
}

const PERGUNTAS_RAPIDAS = [
  "Como está meu resultado este mês?",
  "Tenho contas a pagar vencidas?",
  "Como melhorar minha margem de lucro?",
  "O que é DRE?",
];

function fmt(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function ChatWidget() {
  const [aberto, setAberto] = useState(false);
  const [mensagens, setMensagens] = useState<Mensagem[]>([{
    role: "assistant",
    content: "Olá! Sou o Assistente Financeiro do +Q Finanças. 👋\n\nO que você gostaria de saber?",
  }]);
  const [input, setInput] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [semChave, setSemChave] = useState(false);
  const [contexto, setContexto] = useState<{
    receita: number; despesa: number; resultado: number;
    contasVencidas: number; totalPendente: number;
  } | null>(null);
  const [contextoCarregado, setContextoCarregado] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => {
    if (aberto && !contextoCarregado) {
      carregarContexto();
      setContextoCarregado(true);
    }
    if (aberto) setTimeout(() => inputRef.current?.focus(), 150);
  }, [aberto]);

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

    const movs = r1.data ?? [];
    const pendentes = r2.data ?? [];
    const receita = movs.filter(m => m.tipo === "entrada").reduce((a, m) => a + m.valor, 0);
    const despesa = movs.filter(m => m.tipo === "saida").reduce((a, m) => a + m.valor, 0);

    setContexto({
      receita,
      despesa,
      resultado: receita - despesa,
      contasVencidas: pendentes.filter(c => c.data_vencimento < hoje).length,
      totalPendente: pendentes.reduce((a, c) => a + c.valor, 0),
    });
  }

  async function enviar(texto?: string) {
    const msg = (texto ?? input).trim();
    if (!msg || carregando) return;

    setInput("");
    setSemChave(false);
    const novas: Mensagem[] = [...mensagens, { role: "user", content: msg }];
    setMensagens(novas);
    setCarregando(true);
    setMensagens(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ messages: novas.slice(-10), contexto }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error?.includes("ANTHROPIC_API_KEY")) {
          setSemChave(true);
          setMensagens(prev => prev.slice(0, -1));
        } else {
          setMensagens(prev => [
            ...prev.slice(0, -1),
            { role: "assistant", content: `Erro: ${err.error ?? "Tente novamente."}` },
          ]);
        }
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let acumulado = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acumulado += decoder.decode(value, { stream: true });
          setMensagens(prev => [...prev.slice(0, -1), { role: "assistant", content: acumulado }]);
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

  return (
    <>
      {/* Botão flutuante */}
      <button
        onClick={() => setAberto(v => !v)}
        title="Assistente IA"
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 9999,
          width: 52, height: 52, borderRadius: "50%",
          background: aberto ? "#374151" : "#16a34a",
          color: "white", border: "none", cursor: "pointer",
          boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.2s, transform 0.2s",
          transform: aberto ? "rotate(45deg)" : "none",
        }}
      >
        {aberto ? "✕" : "🤖"}
      </button>

      {/* Painel do chat */}
      {aberto && (
        <div
          style={{
            position: "fixed", bottom: 88, right: 24, zIndex: 9998,
            width: "min(380px, calc(100vw - 32px))",
            height: "min(540px, calc(100dvh - 110px))",
            background: "#fff", borderRadius: 20,
            boxShadow: "0 12px 48px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
            border: "1px solid #e5e7eb",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            animation: "widget-in 0.2s ease-out",
          }}
        >
          <style>{`
            @keyframes widget-in {
              from { opacity: 0; transform: translateY(12px) scale(0.97); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>

          {/* Header */}
          <div style={{
            background: "linear-gradient(135deg,#16a34a,#15803d)",
            padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "rgba(255,255,255,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}>🤖</div>
            <div style={{ flex: 1 }}>
              <p style={{ color: "#fff", margin: 0, fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>
                Assistente Financeiro
              </p>
              <p style={{ color: "#bbf7d0", margin: 0, fontSize: 11 }}>Powered by Claude</p>
            </div>
            {contexto && (
              <div style={{ textAlign: "right" }}>
                <p style={{ color: "#bbf7d0", margin: 0, fontSize: 10, lineHeight: 1.4 }}>
                  Receita {fmt(contexto.receita)}
                </p>
                <p style={{ color: contexto.resultado >= 0 ? "#bbf7d0" : "#fca5a5", margin: 0, fontSize: 10, lineHeight: 1.4 }}>
                  Resultado {fmt(contexto.resultado)}
                </p>
              </div>
            )}
          </div>

          {/* Aviso sem chave */}
          {semChave && (
            <div style={{
              margin: "10px 12px 0",
              padding: "10px 12px",
              background: "#fffbeb", borderRadius: 10,
              border: "1px solid #fde68a", flexShrink: 0,
            }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: "#92400e" }}>
                ⚙️ Assistente não configurado
              </p>
              <p style={{ margin: 0, fontSize: 11, color: "#78350f", lineHeight: 1.5 }}>
                A chave da API Anthropic ainda não foi adicionada ao servidor. Entre em contato com o administrador.
              </p>
            </div>
          )}

          {/* Mensagens */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 0" }}>
            {mensagens.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                  marginBottom: 10,
                  alignItems: "flex-end",
                  gap: 6,
                }}
              >
                {m.role === "assistant" && (
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: "#dcfce7", fontSize: 14,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>🤖</div>
                )}
                <div
                  style={{
                    maxWidth: "78%",
                    padding: "8px 12px",
                    borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                    background: m.role === "user" ? "#16a34a" : "#f3f4f6",
                    color: m.role === "user" ? "#fff" : "#1f2937",
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.content || (carregando && i === mensagens.length - 1 && (
                    <span style={{ display: "inline-flex", gap: 3 }}>
                      {[0, 150, 300].map(d => (
                        <span key={d} style={{
                          width: 6, height: 6, borderRadius: "50%",
                          background: "#9ca3af", display: "inline-block",
                          animation: "bounce 1s infinite",
                          animationDelay: `${d}ms`,
                        }} />
                      ))}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <div ref={bottomRef} style={{ height: 4 }} />
          </div>

          {/* Perguntas rápidas */}
          {mensagens.length <= 1 && !carregando && (
            <div style={{ padding: "8px 12px", display: "flex", flexWrap: "wrap", gap: 5, flexShrink: 0 }}>
              {PERGUNTAS_RAPIDAS.map(p => (
                <button
                  key={p}
                  onClick={() => enviar(p)}
                  style={{
                    padding: "5px 10px", fontSize: 11,
                    background: "#f9fafb", border: "1px solid #e5e7eb",
                    borderRadius: 20, cursor: "pointer", color: "#374151",
                    transition: "all 0.15s",
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{
            padding: "10px 12px", borderTop: "1px solid #f3f4f6",
            display: "flex", gap: 8, flexShrink: 0,
          }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
              placeholder="Digite sua pergunta..."
              disabled={carregando}
              style={{
                flex: 1, padding: "9px 14px", borderRadius: 12,
                border: "1px solid #e5e7eb", fontSize: 13,
                outline: "none", background: "#f9fafb",
                color: "#111827",
              }}
            />
            <button
              onClick={() => enviar()}
              disabled={!input.trim() || carregando}
              style={{
                width: 38, height: 38, borderRadius: 10,
                background: input.trim() && !carregando ? "#16a34a" : "#e5e7eb",
                color: input.trim() && !carregando ? "#fff" : "#9ca3af",
                border: "none", cursor: input.trim() && !carregando ? "pointer" : "default",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 16, flexShrink: 0, transition: "all 0.15s",
              }}
            >
              {carregando
                ? <span style={{ width: 16, height: 16, border: "2px solid #9ca3af", borderTopColor: "#374151", borderRadius: "50%", display: "block", animation: "spin 0.7s linear infinite" }} />
                : "➤"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
