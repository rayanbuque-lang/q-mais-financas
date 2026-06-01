"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";
import NotificacoesBell from "@/components/notificacoes-bell";

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
  { label: "Captura por Foto", href: "/captura", icon: "📸" },
  { label: "Recorrentes", href: "/recorrentes", icon: "🔁" },
  { label: "Contas a Pagar", href: "/contas-pagar", icon: "📋" },
  { label: "Máquinas e Contas", href: "/maquinas", icon: "🏦" },
  { label: "Vendas Maquininha", href: "/vendas", icon: "💳" },
  { label: "Categorias", href: "/categorias", icon: "🏷️" },
  { label: "Fechamento de Caixa", href: "/fechamento-caixa", icon: "🧮" },
  { label: "Fluxo de Caixa", href: "/fluxo-de-caixa", icon: "📈" },
  { label: "DRE", href: "/dre", icon: "📑" },
  { label: "Fechamento Mensal", href: "/fechamento", icon: "🔒" },
  { label: "Conciliação Bancária", href: "/conciliacao", icon: "🏦" },
  { label: "Relatórios", href: "/relatorios", icon: "📄" },
  { label: "Análise Inteligente", href: "/analise", icon: "🧠" },
  { label: "Histórico", href: "/audit", icon: "📜" },
  { label: "Usuários", href: "/usuarios", icon: "👥" },
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      if (data) setProfile(data);
      setLoading(false);
    }
    loadProfile();
  }, []);

  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f8f8" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: "4px solid #d1fae5", borderTopColor: "#059669", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
          <p style={{ color: "#6b7280", fontSize: 14 }}>Carregando...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }

        .sidebar-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.4);
          backdrop-filter: blur(4px);
          z-index: 40; display: none;
        }
        .sidebar-overlay.active { display: block; }

        .sidebar {
          position: fixed; top: 0; left: 0; bottom: 0;
          width: 260px; min-width: 260px;
          background: #ffffff;
          border-right: 1px solid #e2e8e2;
          display: flex; flex-direction: column;
          z-index: 50;
          transform: translateX(-100%);
          transition: transform 0.3s ease;
        }
        .sidebar.open { transform: translateX(0); }

        .topbar {
          display: none;
          position: sticky; top: 0; z-index: 30;
          padding: 12px 16px;
          background: #ffffff;
          border-bottom: 1px solid #e2e8e2;
          align-items: center;
          justify-content: space-between;
        }

        .main-content { flex: 1; min-width: 0; padding: 24px 16px; }

        @media (min-width: 768px) {
          .sidebar { position: sticky; top: 0; transform: translateX(0); }
          .sidebar-overlay.active { display: none; }
          .topbar { display: none !important; }
          .main-content { padding: 32px; }
        }

        @media (max-width: 767px) {
          .topbar { display: flex; }
          .desktop-notif { display: none !important; }
        }

        .nav-link {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 14px; border-radius: 10px;
          font-size: 13px; font-weight: 500;
          text-decoration: none; margin-bottom: 2px;
          transition: all 0.2s; color: #6b7280;
        }
        .nav-link:hover { background: #f3f4f6; color: #374151; }
        .nav-link.active { background: #dcfce7; color: #166534; }

        .user-btn {
          width: 100%; text-align: left;
          padding: 10px 14px; border-radius: 10px;
          font-size: 13px; color: #6b7280;
          background: transparent; border: none;
          cursor: pointer; font-weight: 500; transition: all 0.2s;
        }
        .user-btn:hover { background: #fef2f2; color: #dc2626; }

        .hamburger {
          background: none; border: none;
          cursor: pointer; padding: 8px;
          border-radius: 8px; transition: background 0.2s;
        }
        .hamburger:hover { background: #f3f4f6; }
      `}</style>

      <div style={{ display: "flex", minHeight: "100vh" }}>
        <div className={`sidebar-overlay ${sidebarOpen ? "active" : ""}`} onClick={() => setSidebarOpen(false)} />

        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8e2", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Logo />
          </div>

          <nav style={{ flex: 1, padding: "10px 10px", overflowY: "auto" }}>
            {menuItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} className={`nav-link ${isActive ? "active" : ""}`}>
                  <span style={{ fontSize: 15 }}>{item.icon}</span>
                  {item.label}
                  {isActive && <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%", background: "#16a34a" }} />}
                </Link>
              );
            })}
          </nav>

          <div style={{ padding: "12px 14px", borderTop: "1px solid #e2e8e2" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "0 6px" }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: "#dcfce7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold", color: "#16a34a" }}>
                {(profile?.nome || "U").charAt(0).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 12, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile?.nome || profile?.email}</p>
                <p style={{ fontSize: 10, color: "#6b7280", margin: 0 }}>{profile?.role === "master" ? "Administrador" : "Funcionário"}</p>
              </div>
            </div>
            <button onClick={handleLogout} className="user-btn">🚪 Sair</button>
          </div>
        </aside>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Topbar mobile */}
          <div className="topbar">
            <Logo />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <NotificacoesBell />
              <button onClick={() => setSidebarOpen(true)} className="hamburger">
                <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M3 6h18M3 11h18M3 16h18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {/* Sino desktop */}
          <div className="desktop-notif" style={{ padding: "12px 32px 0", display: "flex", justifyContent: "flex-end" }}>
            <NotificacoesBell />
          </div>

          <main className="main-content">
            <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>{children}</div>
          </main>
        </div>
      </div>
    </>
  );
}
