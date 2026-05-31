"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError("Email ou senha incorretos.");
    } else {
      window.location.href = "/dashboard";
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-emerald-50 via-white to-emerald-50">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-10">
          <Logo />
        </div>

        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-3xl p-8 shadow-lg shadow-emerald-100/50">
          <h2 className="text-xl font-bold text-center mb-1">Bem-vindo de volta</h2>
          <p className="text-sm text-[var(--color-text-muted)] text-center mb-8">
            Acesse sua conta para continuar
          </p>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                required
                className="w-full px-4 py-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none transition"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Senha</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Sua senha"
                required
                className="w-full px-4 py-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none transition"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <p className="text-sm text-[var(--color-danger)] text-center font-medium">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all duration-200 disabled:opacity-50 shadow-md shadow-emerald-200"
            >
              {loading ? "Entrando..." : "Entrar"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-[var(--color-text-muted)] mt-6">
          +Q Finanças · Controle financeiro inteligente
        </p>
      </div>
    </div>
  );
}
