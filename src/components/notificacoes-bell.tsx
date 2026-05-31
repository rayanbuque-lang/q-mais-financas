"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { gerarNotificacoes } from "@/lib/notificacoes";

interface Notificacao {
  id: string;
  tipo: string;
  titulo: string;
  mensagem: string;
  modulo: string | null;
  link: string | null;
  lida: boolean;
  prioridade: string;
  created_at: string;
}

const prioridadeConfig: Record<string, { color: string; bg: string }> = {
  baixa: { color: "text-gray-500", bg: "bg-gray-50" },
  normal: { color: "text-blue-600", bg: "bg-blue-50" },
  alta: { color: "text-amber-600", bg: "bg-amber-50" },
  urgente: { color: "text-red-600", bg: "bg-red-50" },
};

const tipoIcon: Record<string, string> = {
  conta_vencendo: "⏰",
  conta_vencida: "🚨",
  divergencia: "⚠️",
  fluxo_negativo: "📉",
  venda_pendente: "💳",
  meta_estourou: "🎯",
  fechamento_pendente: "📅",
  info: "ℹ️",
};

export default function NotificacoesBell() {
  const [notificacoes, setNotificacoes] = useState<Notificacao[]>([]);
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const supabase = createClient();

  const naoLidas = notificacoes.filter((n) => !n.lida).length;

  async function carregarNotificacoes() {
    setCarregando(true);

    // Gerar notificações baseadas nos dados atuais
    await gerarNotificacoes();

    // Carregar notificações
    const { data } = await supabase
      .from("notificacoes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (data) setNotificacoes(data);
    setCarregando(false);
  }

  useEffect(() => {
    carregarNotificacoes();
    // Atualizar a cada 5 minutos
    const interval = setInterval(carregarNotificacoes, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  async function marcarComoLida(id: string) {
    await supabase.from("notificacoes").update({ lida: true }).eq("id", id);
    setNotificacoes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, lida: true } : n))
    );
  }

  async function marcarTodasLidas() {
    const ids = notificacoes.filter((n) => !n.lida).map((n) => n.id);
    if (ids.length === 0) return;
    await supabase.from("notificacoes").update({ lida: true }).in("id", ids);
    setNotificacoes((prev) => prev.map((n) => ({ ...n, lida: true })));
  }

  async function limparTodas() {
    if (!confirm("Limpar todas as notificações?")) return;
    await supabase.from("notificacoes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    setNotificacoes([]);
    setAberto(false);
  }

  function fmtTempo(iso: string) {
    const agora = new Date();
    const d = new Date(iso);
    const diff = Math.floor((agora.getTime() - d.getTime()) / 1000);

    if (diff < 60) return "Agora";
    if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d atrás`;
    return d.toLocaleDateString("pt-BR");
  }

  return (
    <div style={{ position: "relative" }}>
      {/* Botão sino */}
      <button
        onClick={() => {
          setAberto(!aberto);
          if (!aberto) carregarNotificacoes();
        }}
        style={{
          position: "relative",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "8px",
          borderRadius: "10px",
          fontSize: "20px",
          transition: "background 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
      >
        🔔
        {naoLidas > 0 && (
          <span
            style={{
              position: "absolute",
              top: "2px",
              right: "2px",
              background: "#dc2626",
              color: "white",
              fontSize: "9px",
              fontWeight: 700,
              width: "18px",
              height: "18px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {naoLidas > 9 ? "9+" : naoLidas}
          </span>
        )}
      </button>

      {/* Painel de notificações */}
      {aberto && (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 90,
            }}
            onClick={() => setAberto(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 8,
              width: 380,
              maxHeight: 500,
              background: "white",
              borderRadius: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
              border: "1px solid #e2e8e2",
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid #e2e8e2",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 14 }}>
                Notificações {naoLidas > 0 && `(${naoLidas})`}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {naoLidas > 0 && (
                  <button
                    onClick={marcarTodasLidas}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#059669",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ✓ Ler todas
                  </button>
                )}
                <button
                  onClick={limparTodas}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9ca3af",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Limpar
                </button>
              </div>
            </div>

            {/* Lista */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {carregando && notificacoes.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                  Carregando...
                </div>
              ) : notificacoes.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                  <p style={{ fontSize: 28, marginBottom: 8 }}>🔔</p>
                  Nenhuma notificação
                </div>
              ) : (
                notificacoes.map((n) => {
                  const pConfig = prioridadeConfig[n.prioridade] || prioridadeConfig.normal;
                  const icon = tipoIcon[n.tipo] || "ℹ️";
                  const Conteudo = (
                    <div
                      style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid #f3f4f6",
                        background: n.lida ? "white" : "#f9fafb",
                        cursor: n.link ? "pointer" : "default",
                        transition: "background 0.2s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = n.lida ? "white" : "#f9fafb")}
                      onClick={() => {
                        marcarComoLida(n.id);
                        setAberto(false);
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 18, marginTop: 2 }}>{icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: n.lida ? 500 : 700,
                                color: "#1f2937",
                              }}
                            >
                              {n.titulo}
                            </span>
                            {!n.lida && (
                              <span
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: "50%",
                                  background: n.prioridade === "urgente" ? "#dc2626" : n.prioridade === "alta" ? "#d97706" : "#2563eb",
                                  flexShrink: 0,
                                }}
                              />
                            )}
                          </div>
                          <p style={{ fontSize: 11, color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
                            {n.mensagem}
                          </p>
                          <p style={{ fontSize: 10, color: "#9ca3af", margin: "4px 0 0" }}>
                            {fmtTempo(n.created_at)}
                            {n.modulo && ` · ${n.modulo}`}
                          </p>
                        </div>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 6,
                            background: pConfig.bg,
                            color: pConfig.color,
                            textTransform: "uppercase",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {n.prioridade}
                        </span>
                      </div>
                    </div>
                  );

                  return n.link ? (
                    <Link key={n.id} href={n.link} style={{ textDecoration: "none", color: "inherit" }}>
                      {Conteudo}
                    </Link>
                  ) : (
                    <div key={n.id}>{Conteudo}</div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
