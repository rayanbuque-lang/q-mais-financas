"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Profile {
  id: string;
  nome: string;
  email: string;
  role: string;
  permissoes_modulos: string[] | null;
  created_at: string;
}

const todosModulos = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "movimentacoes", label: "Movimentações", icon: "💰" },
  { id: "captura", label: "Captura por Foto", icon: "📸" },
  { id: "recorrentes", label: "Recorrentes", icon: "🔁" },
  { id: "contas-pagar", label: "Contas a Pagar", icon: "📋" },
  { id: "maquinas", label: "Máquinas e Contas", icon: "🏦" },
  { id: "vendas", label: "Vendas Maquininha", icon: "💳" },
  { id: "categorias", label: "Categorias", icon: "🏷️" },
  { id: "fechamento-caixa", label: "Fechamento de Caixa", icon: "🧮" },
  { id: "fluxo-de-caixa", label: "Fluxo de Caixa", icon: "📈" },
  { id: "dre", label: "DRE", icon: "📑" },
  { id: "fechamento", label: "Fechamento Mensal", icon: "🔒" },
  { id: "conciliacao", label: "Conciliação Bancária", icon: "🏦" },
  { id: "relatorios", label: "Relatórios", icon: "📄" },
  { id: "analise", label: "Análise Inteligente", icon: "🧠" },
  { id: "audit", label: "Histórico", icon: "📜" },
];

export default function UsuariosPage() {
  const [usuarios, setUsuarios] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [mensagem, setMensagem] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [role, setRole] = useState("funcionario");
  const [modulosSelecionados, setModulosSelecionados] = useState<string[]>([]);

  const supabase = createClient();

  async function carregarUsuarios() {
    setLoading(true);
    const { data } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
    if (data) setUsuarios(data as Profile[]);
    setLoading(false);
  }

  useEffect(() => { carregarUsuarios(); }, []);

  function resetForm() {
    setNome(""); setEmail(""); setSenha(""); setRole("funcionario");
    setModulosSelecionados([]); setEditandoId(null);
  }

  function novoUsuario() {
    resetForm();
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function editarUsuario(u: Profile) {
    setNome(u.nome);
    setEmail(u.email);
    setSenha("");
    setRole(u.role);
    setModulosSelecionados(u.permissoes_modulos || []);
    setEditandoId(u.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleModulo(modId: string) {
    setModulosSelecionados(prev =>
      prev.includes(modId) ? prev.filter(m => m !== modId) : [...prev, modId]
    );
  }

  function selecionarTodos() {
    setModulosSelecionados(todosModulos.map(m => m.id));
  }

  function limparTodos() {
    setModulosSelecionados([]);
  }

  const precisaPermissoes = role === "funcionario" || role === "leitura";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMensagem("");

    if (editandoId) {
      const updateData: Record<string, unknown> = {
        nome,
        role,
        permissoes_modulos: precisaPermissoes ? modulosSelecionados : [],
      };
      const { error } = await supabase.from("profiles").update(updateData).eq("id", editandoId);
      if (error) setMensagem("Erro ao atualizar: " + error.message);
      else setMensagem("Usuário atualizado!");
    } else {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password: senha,
        options: { data: { nome } },
      });

      if (authError) {
        setMensagem("Erro ao criar conta: " + authError.message);
        setLoading(false);
        setTimeout(() => setMensagem(""), 5000);
        return;
      }

      if (authData.user) {
        const { error: profileError } = await supabase.from("profiles").upsert({
          id: authData.user.id,
          nome,
          email,
          role,
          permissoes_modulos: precisaPermissoes ? modulosSelecionados : [],
        });
        if (profileError) setMensagem("Conta criada, mas erro no perfil: " + profileError.message);
        else setMensagem("Usuário criado com sucesso!");
      }
    }

    setShowForm(false);
    resetForm();
    await carregarUsuarios();
    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function excluirUsuario(id: string) {
    if (!confirm("Tem certeza que deseja excluir este usuário?")) return;
    await supabase.from("profiles").delete().eq("id", id);
    setMensagem("Usuário removido!");
    carregarUsuarios();
    setTimeout(() => setMensagem(""), 3000);
  }

  function getRoleInfo(role: string) {
    if (role === "master") return { label: "Administrador", bg: "#dcfce7", color: "#166534", icon: "👑" };
    if (role === "leitura") return { label: "Somente Leitura", bg: "#fef3c7", color: "#92400e", icon: "👁️" };
    return { label: "Funcionário", bg: "#dbeafe", color: "#1e40af", icon: "👤" };
  }

  function getModulosLabel(u: Profile) {
    if (u.role === "master") return "Acesso total";
    const mods = u.permissoes_modulos || [];
    if (mods.length === 0) return "Todos os módulos";
    return `${mods.length} módulo(s)`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Usuários</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Gerencie quem acessa o sistema</p>
        </div>
        <button onClick={novoUsuario} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
          + Novo Usuário
        </button>
      </div>

      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>
          {mensagem}
        </div>
      )}

      {/* Legenda */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <p className="text-xs font-bold text-[var(--color-text-muted)] mb-2">Tipos de acesso:</p>
        <div className="flex flex-wrap gap-3">
          {[
            { icon: "👑", label: "Administrador", desc: "Acesso total. Vê tudo incluindo Painel do CEO e Usuários", bg: "#dcfce7" },
            { icon: "👤", label: "Funcionário", desc: "Acessa apenas módulos definidos pelo administrador", bg: "#dbeafe" },
            { icon: "👁️", label: "Somente Leitura", desc: "Apenas visualiza módulos definidos, sem editar nada", bg: "#fef3c7" },
          ].map(r => (
            <div key={r.label} className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: r.bg }}>
              <span>{r.icon}</span>
              <div>
                <p className="text-xs font-semibold">{r.label}</p>
                <p className="text-[10px] text-[var(--color-text-muted)]">{r.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Formulário */}
      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Novo"} Usuário</h2>
            <button onClick={() => { setShowForm(false); resetForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Nome</label>
                <input type="text" value={nome} onChange={e => setNome(e.target.value)} required placeholder="Nome completo"
                  className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="email@exemplo.com"
                  disabled={!!editandoId}
                  className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm disabled:opacity-50" />
              </div>
            </div>

            {!editandoId && (
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Senha</label>
                <input type="password" value={senha} onChange={e => setSenha(e.target.value)} required placeholder="Mínimo 6 caracteres"
                  minLength={6}
                  className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm" />
              </div>
            )}

            {/* Tipo de acesso */}
            <div>
              <label className="block text-xs font-semibold mb-2 text-[var(--color-text-muted)]">Tipo de Acesso</label>
              <div className="flex gap-3">
                {[
                  { id: "master", label: "👑 Administrador", bg: "#dcfce7", border: "#86efac" },
                  { id: "funcionario", label: "👤 Funcionário", bg: "#dbeafe", border: "#93c5fd" },
                  { id: "leitura", label: "👁️ Somente Leitura", bg: "#fef3c7", border: "#fde68a" },
                ].map(r => (
                  <button key={r.id} type="button" onClick={() => setRole(r.id)}
                    className={`flex-1 py-3 rounded-xl font-semibold text-xs transition-all ${role === r.id ? "shadow-md" : "opacity-60"}`}
                    style={{ background: r.bg, border: role === r.id ? `2px solid ${r.border}` : "2px solid transparent" }}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Permissões para Funcionário e Leitura */}
            {precisaPermissoes && (
              <div className="rounded-xl p-4" style={{ background: role === "leitura" ? "#fefce8" : "#eff6ff", border: `1px solid ${role === "leitura" ? "#fde68a" : "#bfdbfe"}` }}>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-bold" style={{ color: role === "leitura" ? "#92400e" : "#1e40af" }}>
                    Módulos que este usuário pode acessar:
                  </label>
                  <div className="flex gap-2">
                    <button type="button" onClick={selecionarTodos} className="text-[10px] px-2 py-1 rounded-lg font-semibold" style={{ background: role === "leitura" ? "#fde68a" : "#bfdbfe", color: role === "leitura" ? "#92400e" : "#1e40af" }}>Todos</button>
                    <button type="button" onClick={limparTodos} className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded-lg font-semibold hover:bg-gray-200">Limpar</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {todosModulos.map(mod => {
                    const selecionado = modulosSelecionados.includes(mod.id);
                    return (
                      <button key={mod.id} type="button" onClick={() => toggleModulo(mod.id)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left ${selecionado
                            ? role === "leitura"
                              ? "bg-amber-100 text-amber-800 border border-amber-300 shadow-sm"
                              : "bg-blue-100 text-blue-800 border border-blue-300 shadow-sm"
                            : "bg-white text-gray-500 border border-gray-200"
                          }`}>
                        <span>{mod.icon}</span>
                        <span className="truncate">{mod.label}</span>
                        {selecionado && <span className="ml-auto">✓</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] mt-2" style={{ color: role === "leitura" ? "#92400e" : "#1e40af" }}>
                  {modulosSelecionados.length === 0
                    ? "Nenhum módulo selecionado — usuário não verá nada no menu"
                    : `${modulosSelecionados.length} de ${todosModulos.length} módulo(s) selecionado(s)`}
                </p>
              </div>
            )}

            {role === "master" && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                <p className="text-xs text-emerald-700 font-medium">👑 Administrador tem acesso total ao sistema, incluindo Painel do CEO e gerenciamento de usuários.</p>
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
              {loading ? "Salvando..." : editandoId ? "Atualizar" : "Criar Usuário"}
            </button>
          </form>
        </div>
      )}

      {/* Lista de usuários */}
      {loading && !showForm ? (
        <div className="text-center"><div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>
      ) : usuarios.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">
          Nenhum usuário cadastrado.
        </div>
      ) : (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          {usuarios.map(u => {
            const roleInfo = getRoleInfo(u.role);
            return (
              <div key={u.id} className="p-4 flex items-center justify-between hover:bg-[var(--color-bg)] transition-colors border-b border-[var(--color-border)] last:border-b-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0" style={{ background: roleInfo.bg, color: roleInfo.color }}>
                    {(u.nome || "U").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{u.nome || "Sem nome"}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">{u.email}</p>
                    <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                      {getModulosLabel(u)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium px-2.5 py-1 rounded-lg" style={{ background: roleInfo.bg, color: roleInfo.color }}>
                    {roleInfo.icon} {roleInfo.label}
                  </span>
                  <button onClick={() => editarUsuario(u)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                  <button onClick={() => excluirUsuario(u.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
