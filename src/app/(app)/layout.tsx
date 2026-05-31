"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";

interface Profile {
  id: string;
  nome: string;
  email: string;
  role: string;
  permissoes: string[];
}

const menuItems = [
  { label: "Dashboard", href: "/dashboard", icon: "📊" },
  { label: "Movimentações", href: "/movimentacoes", icon: "💰" },
  { label: "Contas a Pagar", href: "/contas-pagar", icon: "📋" },
  { label: "Categorias", href: "/categorias", icon: "🏷️" },
  { label: "Fluxo de Caixa", href: "/fluxo-de-caixa", icon: "📈" },
  { label: "DRE", href: "/dre", icon: "📑" },
  { label: "Relatórios", href: "/relatorios", icon: "📄" },
  { label: "Análise Inteligente", href: "/analise", icon: "🧠" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function loadProfile() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();
      if (data) setProfile(data);
      setLoading(false);
    }
    loadProfile();
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-[var(--color-text-muted)] text-sm">Carregando...</p>
        </div>
      </div>
    );
  }

  const isMaster = profile?.role === "master";
  const permissoes = profile?.permissoes || [];

  const filteredMenu = menuItems.filter((item) => {
    if (isMaster) return true;
    return permissoes.includes(item.href);
  });

  const allMenu = isMaster
    ? [...filteredMenu, { label: "Usuários", href: "/usuarios", icon: "👥" }]
    : filteredMenu;

  return (
    <div className="min-h-screen flex">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-[260px] bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="p-5 border-b border-[var(--color-border)]">
          <Logo />
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {allMenu.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-emerald-50 text-emerald-800 shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
                {isActive && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Usuário e sair */}
        <div className="p-4 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2 mb-3 px-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-xs font-bold text-emerald-600">
              {(profile?.nome || "U").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">
                {profile?.nome || profile?.email}
              </p>
              <p className="text-[10px] text-[var(--color-text-muted)]">
                {isMaster ? "Administrador" : "Funcionário"}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full text-left px-4 py-3 rounded-xl text-sm text-[var(--color-text-muted)] hover:bg-red-50 hover:text-[var(--color-danger)] transition-all duration-200 font-medium"
          >
            🚪 Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="lg:hidden flex items-center justify-between p-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] sticky top-0 z-20">
          <Logo />
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-xl hover:bg-[var(--color-bg)] transition"
          >
            <svg
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="M3 7h18M3 12h18M3 17h18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="p-4 lg:p-8 max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
