"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";

// Layout isolado da Fase 2 (staging de XML de nota fiscal). Propositalmente FORA
// do route group (app): não herda a sidebar/menu do sistema principal, não é
// linkado de nenhuma tela existente e só é alcançável digitando a URL.
export default function XmlNotasLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pronto, setPronto] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    let ativo = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!ativo) return;
      if (!session) {
        router.push("/login");
        return;
      }
      setPronto(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.push("/login");
    });
    return () => {
      ativo = false;
      subscription.unsubscribe();
    };
  }, []);

  if (!pronto) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
        <div className="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-8 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 whitespace-nowrap">
            🧪 Área experimental — dados de staging
          </span>
        </div>
        <a
          href="/dashboard"
          className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition"
        >
          ← Voltar ao sistema
        </a>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-8 py-8">{children}</main>
    </div>
  );
}
