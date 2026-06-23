"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRole } from "@/lib/role-context";

interface TesteResult {
  sent?: boolean;
  reason?: string;
  summary?: { hoje: number; amanha: number; vencidas: number };
  result?: { id?: string; message?: string };
  error?: string;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
        ok
          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
          : "bg-red-50 text-red-600 border border-red-200"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      {label}
    </span>
  );
}

function SetupStep({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
          done ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"
        }`}
      >
        {done ? "✓" : n}
      </div>
      <div className="flex-1 pb-6 border-b border-[var(--color-border)] last:border-0">
        <p className={`font-semibold text-sm mb-1 ${done ? "text-emerald-700" : "text-[var(--color-text)]"}`}>
          {title}
        </p>
        <div className="text-sm text-[var(--color-text-muted)]">{children}</div>
      </div>
    </div>
  );
}

export default function ConfiguracoesPage() {
  const { role } = useRole();
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState<TesteResult | null>(null);
  const [contasPendentes, setContasPendentes] = useState<{ hoje: number; amanha: number; vencidas: number } | null>(null);
  const [loadingContas, setLoadingContas] = useState(true);

  const supabase = createClient();

  useEffect(() => {
    async function carregarContas() {
      const hoje = new Date().toISOString().split("T")[0];
      const amanha = new Date(Date.now() + 86400000).toISOString().split("T")[0];

      const [r1, r2, r3] = await Promise.all([
        supabase.from("contas_pagar").select("id", { count: "exact", head: true }).eq("status", "pendente").eq("data_vencimento", hoje),
        supabase.from("contas_pagar").select("id", { count: "exact", head: true }).eq("status", "pendente").eq("data_vencimento", amanha),
        supabase.from("contas_pagar").select("id", { count: "exact", head: true }).eq("status", "pendente").lt("data_vencimento", hoje),
      ]);

      setContasPendentes({
        hoje: r1.count ?? 0,
        amanha: r2.count ?? 0,
        vencidas: r3.count ?? 0,
      });
      setLoadingContas(false);
    }
    carregarContas();
  }, []);

  async function testarAgora() {
    setLoading(true);
    setResultado(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setLoading(false); return; }

    const res = await fetch("/api/notificacoes-teste", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    const data: TesteResult = await res.json();
    setResultado(data);
    setLoading(false);
  }

  const totalAlerta = (contasPendentes?.hoje ?? 0) + (contasPendentes?.amanha ?? 0) + (contasPendentes?.vencidas ?? 0);

  if (role !== null && role !== "master") {
    return (
      <div className="text-center py-12">
        <p className="text-4xl mb-3">🔒</p>
        <p className="font-bold text-lg">Acesso restrito</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">Configurações é exclusivo para administradores.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--color-text)] mb-1">Configurações</h1>
        <p className="text-sm text-[var(--color-text-muted)]">Gerencie notificações e integrações do sistema</p>
      </div>

      {/* Seção: Email de Notificações */}
      <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6 mb-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-bold text-[var(--color-text)] flex items-center gap-2">
              <span className="text-xl">📧</span> Notificações por Email
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Email diário às 8h com contas vencendo e em atraso
            </p>
          </div>
          <StatusBadge ok={false} label="Aguardando configuração" />
        </div>

        {/* Preview do que será enviado */}
        <div className="bg-[var(--color-bg)] rounded-xl p-4 mb-5 border border-[var(--color-border)]">
          <p className="text-xs font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wide">
            Situação atual das contas a pagar
          </p>
          {loadingContas ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <span className="w-3 h-3 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin" />
              Verificando...
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className={`rounded-lg p-3 text-center ${(contasPendentes?.hoje ?? 0) > 0 ? "bg-red-50 border border-red-100" : "bg-gray-50"}`}>
                <p className={`text-2xl font-bold ${(contasPendentes?.hoje ?? 0) > 0 ? "text-red-600" : "text-gray-400"}`}>
                  {contasPendentes?.hoje ?? 0}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Vencem hoje</p>
              </div>
              <div className={`rounded-lg p-3 text-center ${(contasPendentes?.amanha ?? 0) > 0 ? "bg-amber-50 border border-amber-100" : "bg-gray-50"}`}>
                <p className={`text-2xl font-bold ${(contasPendentes?.amanha ?? 0) > 0 ? "text-amber-600" : "text-gray-400"}`}>
                  {contasPendentes?.amanha ?? 0}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Vencem amanhã</p>
              </div>
              <div className={`rounded-lg p-3 text-center ${(contasPendentes?.vencidas ?? 0) > 0 ? "bg-red-50 border border-red-100" : "bg-gray-50"}`}>
                <p className={`text-2xl font-bold ${(contasPendentes?.vencidas ?? 0) > 0 ? "text-red-700" : "text-gray-400"}`}>
                  {contasPendentes?.vencidas ?? 0}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Em atraso</p>
              </div>
            </div>
          )}
          {!loadingContas && totalAlerta === 0 && (
            <p className="text-xs text-emerald-600 text-center mt-2 font-medium">
              ✓ Nenhuma conta vencendo hoje — o email não seria enviado agora
            </p>
          )}
          {!loadingContas && totalAlerta > 0 && (
            <p className="text-xs text-amber-700 text-center mt-2 font-medium">
              ⚠️ {totalAlerta} alerta{totalAlerta > 1 ? "s" : ""} — o email seria enviado agora
            </p>
          )}
        </div>

        {/* Botão testar */}
        <button
          onClick={testarAgora}
          disabled={loading}
          className="w-full py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Enviando teste...
            </>
          ) : (
            "📤 Enviar email de teste agora"
          )}
        </button>

        {resultado && (
          <div
            className={`mt-3 rounded-xl p-4 text-sm ${
              resultado.sent
                ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                : resultado.reason === "nothing_to_notify"
                ? "bg-blue-50 border border-blue-200 text-blue-800"
                : "bg-red-50 border border-red-200 text-red-800"
            }`}
          >
            {resultado.sent && (
              <>
                <p className="font-semibold mb-1">✅ Email enviado com sucesso!</p>
                {resultado.summary && (
                  <p className="text-xs">
                    {resultado.summary.hoje} hoje · {resultado.summary.amanha} amanhã · {resultado.summary.vencidas} em atraso
                  </p>
                )}
              </>
            )}
            {resultado.reason === "nothing_to_notify" && (
              <p className="font-semibold">ℹ️ Nenhuma conta vencendo — email não enviado</p>
            )}
            {resultado.reason === "RESEND_API_KEY not set" && (
              <>
                <p className="font-semibold mb-1">⚠️ RESEND_API_KEY não configurada</p>
                <p className="text-xs">Siga as instruções abaixo para configurar o envio de emails</p>
              </>
            )}
            {resultado.error && (
              <p className="font-semibold">❌ {resultado.error}</p>
            )}
          </div>
        )}
      </div>

      {/* Passo a passo de configuração */}
      <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6 mb-6">
        <h2 className="text-base font-bold text-[var(--color-text)] mb-5 flex items-center gap-2">
          <span className="text-xl">🔧</span> Como configurar
        </h2>

        <div className="space-y-0">
          <SetupStep n={1} done={false} title="Criar conta gratuita no Resend">
            <p>Acesse <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">resend.com</span> e crie uma conta gratuita.</p>
            <p className="mt-1">O plano gratuito inclui <strong>3.000 emails/mês</strong> — mais que suficiente.</p>
          </SetupStep>

          <SetupStep n={2} done={false} title="Gerar a chave de API">
            <p>No dashboard do Resend: <strong>API Keys → Create API Key</strong></p>
            <p className="mt-1">Copie a chave gerada (começa com <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">re_</span>).</p>
          </SetupStep>

          <SetupStep n={3} done={false} title="Adicionar a chave no Supabase">
            <p>No dashboard do Supabase:</p>
            <div className="mt-2 space-y-1.5">
              <p>1. Vá em <strong>Edge Functions → notificacoes-email → Secrets</strong></p>
              <p>2. Adicione as variáveis:</p>
              <div className="mt-2 bg-gray-900 text-gray-100 rounded-lg p-3 font-mono text-xs space-y-1">
                <p><span className="text-green-400">RESEND_API_KEY</span>=re_xxxxxxxxxx</p>
                <p><span className="text-green-400">NOTIFICATION_EMAIL</span>=maisquemercadotupa@gmail.com</p>
                <p><span className="text-green-400">CRON_SECRET</span>=qmaisfinancas-cron-2026</p>
              </div>
            </div>
          </SetupStep>

          <SetupStep n={4} done={false} title="Adicionar variáveis no Vercel">
            <p>No dashboard do Vercel:</p>
            <div className="mt-2 space-y-1.5">
              <p>1. Vá em <strong>Settings → Environment Variables</strong></p>
              <p>2. Adicione:</p>
              <div className="mt-2 bg-gray-900 text-gray-100 rounded-lg p-3 font-mono text-xs">
                <p><span className="text-green-400">CRON_SECRET</span>=qmaisfinancas-cron-2026</p>
              </div>
              <p className="mt-1 text-xs">Este secret protege o endpoint do cron para não ser chamado externamente.</p>
            </div>
          </SetupStep>

          <SetupStep n={5} done={false} title="Testar o envio">
            <p>Após configurar as chaves, clique em <strong>"Enviar email de teste agora"</strong> acima para verificar se está funcionando.</p>
            <p className="mt-1">O email chegará em <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">maisquemercadotupa@gmail.com</span></p>
          </SetupStep>
        </div>
      </div>

      {/* Info do cron */}
      <div className="bg-[var(--color-card)] rounded-2xl border border-[var(--color-border)] p-6">
        <h2 className="text-base font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
          <span className="text-xl">🕐</span> Agendamento automático
        </h2>
        <div className="flex items-center gap-3 p-3 bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)]">
          <div className="text-2xl">⏰</div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text)]">Todos os dias às 8h00 (horário de Brasília)</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Vercel Cron Job · <span className="font-mono">0 11 * * *</span> UTC · Rota: /api/cron/notificacoes
            </p>
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mt-3">
          O email só é enviado se houver contas vencendo hoje, amanhã ou em atraso. Dias sem alertas não geram emails.
        </p>
      </div>
    </div>
  );
}
