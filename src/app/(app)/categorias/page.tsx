"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";

interface Categoria {
  id: string;
  nome: string;
  ativo: boolean;
  created_at: string;
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

export default function CategoriasPage() {
  const [aba, setAba] = useState<"entrada" | "saida">("entrada");
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [novoNome, setNovoNome] = useState("");
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editandoNome, setEditandoNome] = useState("");
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [showInativas, setShowInativas] = useState(false);
  const [movimentacoesPorCategoria, setMovimentacoesPorCategoria] = useState<Record<string, number>>({});
  const supabase = createClient();

  const tabela = aba === "entrada" ? "categorias_entrada" : "categorias_saida";

  async function carregarCategorias() {
    const query = supabase.from(tabela).select("*").order("nome");

    if (!showInativas) {
      query.eq("ativo", true);
    }

    const { data } = await query;
    if (data) setCategorias(data);

    // Carregar contagem de movimentações por categoria
    const { data: movs } = await supabase
      .from("movimentacoes")
      .select("categoria_id")
      .eq("tipo", aba === "entrada" ? "entrada" : "saida");

    if (movs) {
      const contagem: Record<string, number> = {};
      movs.forEach((m) => {
        contagem[m.categoria_id] = (contagem[m.categoria_id] || 0) + 1;
      });
      setMovimentacoesPorCategoria(contagem);
    }
  }

  useEffect(() => {
    carregarCategorias();
  }, [aba, showInativas]);

  async function handleAdicionar(e: React.FormEvent) {
    e.preventDefault();
    if (!novoNome.trim()) return;
    setLoading(true);

    const { error } = await supabase.from(tabela).insert({ nome: novoNome.trim() });

    if (error) {
      setMensagem("Erro ao criar categoria.");
    } else {
      setMensagem("Categoria criada com sucesso!");
      setNovoNome("");
      carregarCategorias();
    }

    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function handleEditar(id: string) {
    if (!editandoNome.trim()) return;
    setLoading(true);

    const { error } = await supabase
      .from(tabela)
      .update({ nome: editandoNome.trim() })
      .eq("id", id);

    if (error) {
      setMensagem("Erro ao editar.");
    } else {
      setMensagem("Categoria atualizada!");
      setEditandoId(null);
      setEditandoNome("");
      carregarCategorias();
    }

    setLoading(false);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function handleDesativar(id: string, nome: string) {
    const temMovimentacoes = movimentacoesPorCategoria[id] || 0;
    const texto = temMovimentacoes > 0
      ? `A categoria "${nome}" possui ${temMovimentacoes} movimentações. Ela será desativada mas o histórico será mantido. Continuar?`
      : `Desativar a categoria "${nome}"?`;

    const confirmar = confirm(texto);
    if (!confirmar) return;

    const { error } = await supabase
      .from(tabela)
      .update({ ativo: false })
      .eq("id", id);

    if (error) {
      setMensagem("Erro ao desativar.");
    } else {
      setMensagem("Categoria desativada!");
      carregarCategorias();
    }

    setTimeout(() => setMensagem(""), 3000);
  }

  async function handleReativar(id: string) {
    const { error } = await supabase
      .from(tabela)
      .update({ ativo: true })
      .eq("id", id);

    if (error) {
      setMensagem("Erro ao reativar.");
    } else {
      setMensagem("Categoria reativada!");
      carregarCategorias();
    }

    setTimeout(() => setMensagem(""), 3000);
  }

  const ativas = categorias.filter((c) => c.ativo);
  const inativas = categorias.filter((c) => !c.ativo);

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-bold">Categorias</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          Gerencie as categorias de entradas e saídas
        </p>
      </div>

      {/* Abas Entrada / Saída */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
        <button
          onClick={() => setAba("entrada")}
          className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
            aba === "entrada"
              ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-primary)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          Categorias de Entrada
        </button>
        <button
          onClick={() => setAba("saida")}
          className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
            aba === "saida"
              ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-danger)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          Categorias de Saída
        </button>
      </div>

      {/* Mensagem */}
      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${
          mensagem.includes("Erro")
            ? "bg-red-50 text-[var(--color-danger)]"
            : "bg-[var(--color-primary-light)] text-[var(--color-primary-dark)]"
        }`}>
          {mensagem}
        </div>
      )}

      {/* Formulário de adicionar */}
      <form onSubmit={handleAdicionar} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
        <h2 className="font-semibold mb-3">Nova Categoria</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={novoNome}
            onChange={(e) => setNovoNome(e.target.value)}
            placeholder={aba === "entrada" ? "Ex: Pix Nubank" : "Ex: Internet"}
            className="flex-1 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] transition"
          />
          <button
            type="submit"
            disabled={loading || !novoNome.trim()}
            className="px-6 py-3 bg-[var(--color-primary)] text-white font-semibold rounded-xl hover:bg-[var(--color-primary-dark)] transition disabled:opacity-50 text-sm"
          >
            Adicionar
          </button>
        </div>
      </form>

      {/* Lista de categorias ativas */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-[var(--color-border)]">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">
              Categorias Ativas ({ativas.length})
            </h2>
          </div>
        </div>

        {ativas.length === 0 ? (
          <EmptyState variant="categories" title="Nenhuma categoria ainda"
            description="Crie categorias para organizar suas entradas e saídas." />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {ativas.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between p-4 hover:bg-[var(--color-bg)] transition">
                {editandoId === cat.id ? (
                  <div className="flex items-center gap-3 flex-1">
                    <input
                      type="text"
                      value={editandoNome}
                      onChange={(e) => setEditandoNome(e.target.value)}
                      autoFocus
                      className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-primary)] bg-[var(--color-bg)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleEditar(cat.id);
                        if (e.key === "Escape") { setEditandoId(null); setEditandoNome(""); }
                      }}
                    />
                    <button
                      onClick={() => handleEditar(cat.id)}
                      className="px-3 py-2 bg-[var(--color-primary)] text-white rounded-lg text-xs font-medium hover:bg-[var(--color-primary-dark)] transition"
                    >
                      Salvar
                    </button>
                    <button
                      onClick={() => { setEditandoId(null); setEditandoNome(""); }}
                      className="px-3 py-2 bg-[var(--color-bg)] text-[var(--color-text-muted)] rounded-lg text-xs font-medium border border-[var(--color-border)] hover:bg-gray-100 transition"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${aba === "entrada" ? "bg-[var(--color-primary)]" : "bg-[var(--color-danger)]"}`} />
                      <div>
                        <p className="text-sm font-medium">{cat.nome}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {movimentacoesPorCategoria[cat.id] || 0} movimentações
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setEditandoId(cat.id); setEditandoNome(cat.nome); }}
                        title="Editar"
                        className="p-2 rounded-lg hover:bg-[var(--color-primary-light)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition text-sm"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => handleDesativar(cat.id, cat.nome)}
                        title="Desativar"
                        className="p-2 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition text-sm"
                      >
                        ⏸️
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toggle para mostrar inativas */}
      {inativas.length > 0 && (
        <div>
          <button
            onClick={() => setShowInativas(!showInativas)}
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-medium transition"
          >
            {showInativas ? "▼" : "▶"} Categorias inativas ({inativas.length})
          </button>

          {showInativas && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden mt-3">
              <div className="divide-y divide-[var(--color-border)] opacity-60">
                {inativas.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-gray-300" />
                      <div>
                        <p className="text-sm font-medium line-through">{cat.nome}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          Desativada · {movimentacoesPorCategoria[cat.id] || 0} movimentações preservadas
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleReativar(cat.id)}
                      title="Reativar"
                      className="p-2 rounded-lg hover:bg-[var(--color-primary-light)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition text-sm"
                    >
                      ▶️
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

