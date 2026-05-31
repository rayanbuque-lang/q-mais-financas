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
  { label: "Máquinas e Contas", href: "/maquinas", icon: "🏦" },
  { label: "Vendas Maquininha", href: "/vendas", icon: "💳" },
  { label: "Categorias", href: "/categorias", icon: "🏷️" },
  { label: "Fluxo de Caixa", href: "/fluxo-de-caixa", icon: "📈" },
  { label: "DRE", href: "/dre", icon: "📑" },
  { label: "Fechamento Mensal", href: "/fechamento", icon: "🔒" },
  { label: "Conciliação Bancária", href: "/conciliacao", icon: "🏦" },
  { label: "Relatórios", href: "/relatorios", icon: "📄" },
  { label: "Análise Inteligente", href: "/analise", icon: "🧠" },
  { label: "Usuários", href: "/usuarios", icon: "👥" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
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
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p>Carregando...</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside style={{
        width: "260px", minWidth: "260px", background: "#ffffff",
        borderRight: "1px solid #e2e8e2", display: "flex",
        flexDirection: "column", height: "100vh", position: "sticky", top: "0",
      }}>
        <div style={{ padding: "20px", borderBottom: "1px solid #e2e8e2" }}>
          <Logo />
        </div>

        <nav style={{ flex: 1, padding: "12px", overflowY: "auto" }}>
          {menuItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "12px 16px", borderRadius: "12px", fontSize: "14px",
                fontWeight: 500, textDecoration: "none", marginBottom: "2px",
                background: isActive ? "#dcfce7" : "transparent",
                color: isActive ? "#166534" : "#6b7280", transition: "all 0.2s",
              }}>
                <span>{item.icon}</span>
                {item.label}
                {isActive && <span style={{ marginLeft: "auto", width: "6px", height: "6px", borderRadius: "50%", background: "#16a34a" }} />}
              </Link>
            );
          })}
        </nav>

        <div style={{ padding: "16px", borderTop: "1px solid #e2e8e2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px", padding: "0 8px" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "#dcfce7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "bold", color: "#16a34a" }}>
              {(profile?.nome || "U").charAt(0).toUpperCase()}
            </div>
            <div>
              <p style={{ fontSize: "12px", fontWeight: 600, margin: 0 }}>{profile?.nome || profile?.email}</p>
              <p style={{ fontSize: "10px", color: "#6b7280", margin: 0 }}>{profile?.role === "master" ? "Administrador" : "Funcionário"}</p>
            </div>
          </div>
          <button onClick={handleLogout} style={{ width: "100%", textAlign: "left", padding: "12px 16px", borderRadius: "12px", fontSize: "14px", color: "#6b7280", background: "transparent", border: "none", cursor: "pointer", fontWeight: 500 }}>
            🚪 Sair
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, padding: "32px" }}>
        <div style={{ maxWidth: "1100px" }}>{children}</div>
      </main>
    </div>
  );
}
