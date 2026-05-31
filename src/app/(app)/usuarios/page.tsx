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

const todosModulos = modulos.map((m) => m.href);

export default function UsuariosPage() {
  const [usuarios, setUsuarios] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editPermissoes, setEditPermissoes] = useState<string[]>([]);
  const [editRole, setEditRole] = useState<"master" | "funcionario">("funcionario");
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");

  const [novoNome, setNovoNome] = useState("");
  const [novoEmail, setNovoEmail] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [novaRole, setNovaRole] = useState<"master" | "funcionario">("funcionario");
  const [novasPermissoes, setNovasPermissoes] = useState<string[]>([]);

  const supabase = createClient();

  async function carregarUsuarios() {
    const { data } = await supabase.from("profiles").select("*").order("created_at");
    if (data) setUsuarios(data);
  }

  useEffect(() => { carregarUsuarios(); }, []);

  function resetarForm() {
    setNovoNome(""); setNovoEmail(""); setNovaSenha("");
    setNovaRole("funcionario"); setNovasPermissoes([]);
  }

  function abrirForm() { resetarForm(); setShowForm(true); }

  // Quando muda o role, atualiza permissões automáticas
  function mudarNovaRole(role: "master" | "funcionario") {
    setNovaRole(role);
    if (role === "master") {
      setNovasPermissoes(todosModulos);
    } else {
      setNovasPermissoes([]);
    }
  }

  function toggleNovaPermissao(href: string) {
    setNovasPermissoes((prev) =>
      prev.includes(href) ? prev.filter((p) => p !== href) : [...prev, href]
    );
  }

  function selecionarTodasNovas() { setNovasPermissoes(todosModulos); }
  function limparTodasNovas() { setNovasPermissoes([]); }

  async function handleCriarUsuario(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMensagem("");

    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch("/api/usuarios", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ email: novoEmail, password: novaSenha, nome: novoNome }),
    });

    const result = await response.json();

    if (response.ok && result.user) {
      const permissoesFinais = novaRole === "master" ? todosModulos : novasPermissoes;

      await supabase.from("profiles").update({
        role: novaRole,
        permissoes: permissoesFinais,
      }).eq("id", result.user.id);

      setMensagem(`Usuário criado como ${novaRole === "master" ? "Administrador" : "Funcionário"}!`);
      resetarForm();
      setShowForm(false);
      setTimeout(carregarUsuarios, 1500);
    } else {
      setMensagem(`Erro: ${result.error}`);
    }

    setLoading(false);
    setTimeout(() => setMensagem(""), 4000);
  }

  // Editar
  function iniciarEdicao(profile: Profile) {
    setEditandoId(profile.id);
    setEditPermissoes(profile.permissoes || []);
    setEditRole(profile.role as "master" | "funcionario");
  }

  function mudarEditRole(role: "master" | "funcionario") {
    setEditRole(role);
    if (role === "master") {
      setEditPermissoes(todosModulos);
    }
  }

  function togglePermissao(href: string) {
    setEditPermissoes((prev) =>
      prev.includes(href) ? prev.filter((p) => p !== href) : [...prev, href]
    );
  }

  function selecionarTodasEdit() { setEditPermissoes(todosModulos); }
  function limparTodasEdit() { setEditPermissoes([]); }

  async function salvarEdicao(userId: string) {
    setLoading(true);
    const permissoesFinais = editRole === "master" ? todosModulos : editPermissoes;

    const { error } = await supabase.from("profiles").update({
      role: editRole,
      permissoes: permissoesFinais,
    }).eq("id", userId);

    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem("Usuário atualizado!");
      setEditandoId(null);
      carregarUsuarios();
    }
    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function toggleAtivo(profile: Profile) {
    await supabase.from("profiles").update({ ativo: !profile.ativo }).eq("id", profile.id);
    setMensagem(profile.ativo ? "Desativado!" : "Ativado!");
    carregarUsuarios();
    setTimeout(() => setMensagem(""), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Usuários</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Gerencie acessos e permissões da equipe</p>
        </div>
        <button onClick={abrirForm} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
          + Novo Usuário
        </button>
      </div>

      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>
          {mensagem}
        </div>
      )}

      {/* Formulário de criação */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">Novo Usuário</h2>
            <button onClick={() => { setShowForm(false); resetarForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleCriarUsuario} className="space-y-5">
            {/* Dados */}
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">Dados de Acesso</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Nome</label>
                  <input type="text" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} placeholder="Nome completo" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Email</label>
                  <input type="email" value={novoEmail} onChange={(e) => setNovoEmail(e.target.value)} placeholder="email@empresa.com" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Senha</label>
                  <input type="password" value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} placeholder="Mínimo 6 caracteres" required minLength={6} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
              </div>
            </div>

            {/* Nível de acesso */}
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">Nível de Acesso</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button type="button" onClick={() => mudarNovaRole("master")} className={`p-5 rounded-xl border-2 text-left transition-all ${novaRole === "master" ? "border-purple-500 bg-purple-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">👑</span>
                    <span className="font-bold text-sm">Administrador (Master)</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">Acesso total ao sistema. Pode criar e gerenciar outros usuários.</p>
                </button>
                <button type="button" onClick={() => mudarNovaRole("funcionario")} className={`p-5 rounded-xl border-2 text-left transition-all ${novaRole === "funcionario" ? "border-blue-500 bg-blue-50" : "border-[var(--color-border)] bg-[var(--color-bg)]"}`}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">👤</span>
                    <span className="font-bold text-sm">Funcionário</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">Acesso restrito. Você escolhe quais módulos ele pode ver.</p>
                </button>
              </div>
            </div>

            {/* Permissões (só para funcionário) */}
            {novaRole === "funcionario" && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    Módulos que pode acessar
                  </h3>
                  <div className="flex gap-2">
                    <button type="button" onClick={selecionarTodasNovas} className="text-xs text-emerald-600 font-medium hover:underline">Todas</button>
                    <span className="text-xs text-[var(--color-text-muted)]">|</span>
                    <button type="button" onClick={limparTodasNovas} className="text-xs text-red-500 font-medium hover:underline">Nenhuma</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {modulos.map((mod) => (
                    <button key={mod.href} type="button" onClick={() => toggleNovaPermissao(mod.href)} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      novasPermissoes.includes(mod.href) ? "bg-emerald-600 text-white shadow-sm" : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                    }`}>
                      <span>{mod.icon}</span>
                      <span className="truncate">{mod.label}</span>
                    </button>
                  ))}
                </div>
                {novasPermissoes.length > 0 && (
                  <p className="text-xs text-emerald-600 mt-2">✓ {novasPermissoes.length} {novasPermissoes.length === 1 ? "módulo selecionado" : "módulos selecionados"}</p>
                )}
              </div>
            )}

            {novaRole === "master" && (
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                <p className="text-sm text-purple-800">👑 O Administrador terá <strong>accesso total</strong> a todos os módulos e poderá gerenciar outros usuários.</p>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarForm(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
                {loading ? "Criando..." : "Criar Usuário"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      <div className="space-y-4">
        {usuarios.length === 0 && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
            Carregando usuários...
          </div>
        )}
        {usuarios.map((user) => (
          <div key={user.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="p-4 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-base shrink-0 ${user.role === "master" ? "bg-purple-50" : "bg-blue-50"}`}>
                  {user.role === "master" ? "👑" : "👤"}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold">{user.nome || user.email}</p>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${user.role === "master" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                      {user.role === "master" ? "MASTER" : "FUNCIONÁRIO"}
                    </span>
                    {!user.ativo && <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">INATIVO</span>}
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">{user.email}</p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {user.role === "master" ? "Acesso total" : `${user.permissoes?.length || 0} módulos`}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => iniciarEdicao(user)} className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition">
                  ✏️ Editar
                </button>
                <button onClick={() => toggleAtivo(user)} className={`px-3 py-2 rounded-lg text-xs font-semibold transition ${user.ativo ? "bg-red-50 text-red-500 hover:bg-red-100" : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"}`}>
                  {user.ativo ? "⏸ Desativar" : "▶ Ativar"}
                </button>
              </div>
            </div>

            {/* Edição inline */}
            {editandoId === user.id && (
              <div className="border-t border-[var(--color-border)] p-5 bg-[var(--color-bg)] space-y-4">
                {/* Alterar nível */}
                <div>
                  <p className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">Nível de Acesso</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button type="button" onClick={() => mudarEditRole("master")} className={`p-4 rounded-xl border-2 text-left transition-all ${editRole === "master" ? "border-purple-500 bg-purple-50" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span>👑</span>
                        <span className="font-bold text-sm">Administrador</span>
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">Acesso total</p>
                    </button>
                    <button type="button" onClick={() => mudarEditRole("funcionario")} className={`p-4 rounded-xl border-2 text-left transition-all ${editRole === "funcionario" ? "border-blue-500 bg-blue-50" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span>👤</span>
                        <span className="font-bold text-sm">Funcionário</span>
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">Acesso restrito</p>
                    </button>
                  </div>
                </div>

                {/* Permissões (só para funcionário) */}
                {editRole === "funcionario" && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Módulos</p>
                      <div className="flex gap-2">
                        <button onClick={selecionarTodasEdit} className="text-xs text-emerald-600 font-medium hover:underline">Todas</button>
                        <span className="text-xs text-[var(--color-text-muted)]">|</span>
                        <button onClick={limparTodasEdit} className="text-xs text-red-500 font-medium hover:underline">Nenhuma</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {modulos.map((mod) => (
                        <button key={mod.href} type="button" onClick={() => togglePermissao(mod.href)} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                          editPermissoes.includes(mod.href) ? "bg-emerald-600 text-white shadow-sm" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                        }`}>
                          <span>{mod.icon}</span>
                          <span className="truncate">{mod.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {editRole === "master" && (
                  <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                    <p className="text-sm text-purple-800">👑 Será promovido a <strong>Administrador</strong> com acesso total.</p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button onClick={() => setEditandoId(null)} className="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
                  <button onClick={() => salvarEdicao(user.id)} disabled={loading} className="px-6 py-2 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 transition text-sm disabled:opacity-50">
                    {loading ? "Salvando..." : "Salvar"}
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
