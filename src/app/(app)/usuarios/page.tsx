"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

interface Profile {
  id: string;
  email: string;
  nome: string;
  role: string;
  permissoes: string[];
  ativo: boolean;
}

const modulos = [
  { href: "/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/movimentacoes", label: "Movimentações", icon: "💰" },
  { href: "/contas-pagar", label: "Contas a Pagar", icon: "📋" },
  { href: "/categorias", label: "Categorias", icon: "🏷️" },
  { href: "/fluxo-de-caixa", label: "Fluxo de Caixa", icon: "📈" },
  { href: "/dre", label: "DRE", icon: "📑" },
  { href: "/relatorios", label: "Relatórios", icon: "📄" },
  { href: "/analise", label: "Análise Inteligente", icon: "🧠" },
];

export default function UsuariosPage() {
  const [usuarios, setUsuarios] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editPermissoes, setEditPermissoes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [novoNome, setNovoNome] = useState("");
  const [novoEmail, setNovoEmail] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const supabase = createClient();

  async function carregarUsuarios() {
    const { data } = await supabase.from("profiles").select("*").order("created_at");
    if (data) setUsuarios(data);
  }

  useEffect(() => {
    carregarUsuarios();
  }, []);

  async function handleCriarUsuario(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMensagem("");

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const response = await fetch("/api/usuarios", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({
        email: novoEmail,
        password: novaSenha,
        nome: novoNome,
      }),
    });

    const result = await response.json();

    if (response.ok) {
      setMensagem("Usuário criado com sucesso!");
      setNovoNome("");
      setNovoEmail("");
      setNovaSenha("");
      setShowForm(false);
      setTimeout(carregarUsuarios, 1500);
    } else {
      setMensagem(`Erro: ${result.error}`);
    }
    setLoading(false);
    setTimeout(() => setMensagem(""), 4000);
  }

  function iniciarEdicao(profile: Profile) {
    setEditandoId(profile.id);
    setEditPermissoes(profile.permissoes || []);
  }

  function togglePermissao(href: string) {
    setEditPermissoes((prev) =>
      prev.includes(href) ? prev.filter((p) => p !== href) : [...prev, href]
    );
  }

  function selecionarTodas() {
    setEditPermissoes(modulos.map((m) => m.href));
  }

  function limparTodas() {
    setEditPermissoes([]);
  }

  async function salvarPermissoes(userId: string) {
    setLoading(true);
    const { error } = await supabase
      .from("profiles")
      .update({ permissoes: editPermissoes })
      .eq("id", userId);

    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem("Permissões atualizadas!");
      setEditandoId(null);
      carregarUsuarios();
    }
    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function toggleAtivo(profile: Profile) {
    await supabase
      .from("profiles")
      .update({ ativo: !profile.ativo })
      .eq("id", profile.id);
    setMensagem(profile.ativo ? "Usuário desativado!" : "Usuário ativado!");
    carregarUsuarios();
    setTimeout(() => setMensagem(""), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Usuários</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">
            Gerencie acessos e permissões da equipe
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200"
        >
          + Novo Usuário
        </button>
      </div>

      {mensagem && (
        <div
          className={`p-3 rounded-xl text-sm font-medium text-center ${
            mensagem.includes("Erro")
              ? "bg-red-50 text-red-600"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {mensagem}
        </div>
      )}

      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">Novo Usuário</h2>
            <button
              onClick={() => setShowForm(false)}
              className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]"
            >
              ✕
            </button>
          </div>
          <form onSubmit={handleCriarUsuario} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">
                  Nome
                </label>
                <input
                  type="text"
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  placeholder="Nome completo"
                  required
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">
                  Email
                </label>
                <input
                  type="email"
                  value={novoEmail}
                  onChange={(e) => setNovoEmail(e.target.value)}
                  placeholder="email@empresa.com"
                  required
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">
                  Senha
                </label>
                <input
                  type="password"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  required
                  minLength={6}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                />
              </div>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              O novo usuário será criado como funcionário. Depois configure as
              permissões dele clicando em "Permissões".
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200"
              >
                {loading ? "Criando..." : "Criar Usuário"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de usuários */}
      <div className="space-y-4">
        {usuarios.length === 0 && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
            Carregando usuários...
          </div>
        )}
        {usuarios.map((user) => (
          <div
            key={user.id}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden"
          >
            <div className="p-4 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center text-base shrink-0 ${
                    user.role === "master"
                      ? "bg-purple-50"
                      : "bg-blue-50"
                  }`}
                >
                  {user.role === "master" ? "👑" : "👤"}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold">
                      {user.nome || user.email}
                    </p>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        user.role === "master"
                          ? "bg-purple-100 text-purple-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {user.role === "master" ? "MASTER" : "FUNCIONÁRIO"}
                    </span>
                    {!user.ativo && (
                      <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">
                        INATIVO
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {user.email}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {user.role !== "master" && (
                  <>
                    <button
                      onClick={() => iniciarEdicao(user)}
                      className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition"
                    >
                      🔐 Permissões
                    </button>
                    <button
                      onClick={() => toggleAtivo(user)}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition ${
                        user.ativo
                          ? "bg-red-50 text-red-500 hover:bg-red-100"
                          : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
                      }`}
                    >
                      {user.ativo ? "⏸ Desativar" : "▶ Ativar"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {editandoId === user.id && (
              <div className="border-t border-[var(--color-border)] p-4 bg-[var(--color-bg)]">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold">
                    Módulos que {user.nome || user.email} pode acessar:
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={selecionarTodas}
                      className="text-xs text-emerald-600 font-medium hover:underline"
                    >
                      Todas
                    </button>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      |
                    </span>
                    <button
                      onClick={limparTodas}
                      className="text-xs text-red-500 font-medium hover:underline"
                    >
                      Nenhuma
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  {modulos.map((mod) => (
                    <button
                      key={mod.href}
                      onClick={() => togglePermissao(mod.href)}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        editPermissoes.includes(mod.href)
                          ? "bg-emerald-600 text-white shadow-sm"
                          : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                      }`}
                    >
                      <span>{mod.icon}</span>
                      <span className="truncate">{mod.label}</span>
                    </button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setEditandoId(null)}
                    className="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={() => salvarPermissoes(user.id)}
                    disabled={loading}
                    className="px-6 py-2 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 transition text-sm disabled:opacity-50"
                  >
                    {loading ? "Salvando..." : "Salvar Permissões"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
