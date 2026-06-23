"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";
import { useRole } from "@/lib/role-context";

interface Meta {
  id: string;
  tipo: "receita" | "despesa_categoria";
  categoria_id: string | null;
  valor_meta: number;
  mes: number;
  ano: number;
}

interface Categoria { id: string; nome: string; }

const mesesNomes = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
function fmt(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

export default function MetasPage() {
  const { isReadOnly } = useRole();
  const hoje = new Date();
  const [mes, setMes] = useState(hoje.getMonth() + 1);
  const [ano, setAno] = useState(hoje.getFullYear());
  const [metas, setMetas] = useState<Meta[]>([]);
  const [cats, setCats] = useState<Categoria[]>([]);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");

  const [editandoReceita, setEditandoReceita] = useState(false);
  const [inputReceita, setInputReceita] = useState("");

  const [showFormCat, setShowFormCat] = useState(false);
  const [editandoCatMetaId, setEditandoCatMetaId] = useState<string | null>(null);
  const [selectedCat, setSelectedCat] = useState("");
  const [inputValorCat, setInputValorCat] = useState("");

  const supabase = createClient();

  const metaReceita = metas.find(m => m.tipo === "receita");
  const metasCat = metas.filter(m => m.tipo === "despesa_categoria");
  const catsDisponiveis = cats.filter(c => !metasCat.find(m => m.categoria_id === c.id));

  async function carregar() {
    const [r1, r2] = await Promise.all([
      supabase.from("metas").select("*").eq("mes", mes).eq("ano", ano),
      supabase.from("categorias_saida").select("id,nome").eq("ativo", true).order("nome"),
    ]);
    if (r1.data) setMetas(r1.data as Meta[]);
    if (r2.data) setCats(r2.data);
  }

  useEffect(() => { carregar(); }, [mes, ano]);

  useEffect(() => {
    if (!editandoCatMetaId && catsDisponiveis.length > 0 && !selectedCat) {
      setSelectedCat(catsDisponiveis[0].id);
    }
  }, [cats, metas]);

  function aviso(msg: string) {
    setMensagem(msg);
    setTimeout(() => setMensagem(""), 3000);
  }

  async function salvarReceita() {
    const v = parseFloat(inputReceita.replace(",", "."));
    if (isNaN(v) || v <= 0) return;
    setLoading(true);
    if (metaReceita) {
      await supabase.from("metas").update({ valor_meta: v }).eq("id", metaReceita.id);
    } else {
      await supabase.from("metas").insert({ tipo: "receita", categoria_id: null, mes, ano, valor_meta: v });
    }
    setEditandoReceita(false);
    carregar();
    aviso("Meta de receita salva!");
    setLoading(false);
  }

  async function excluirReceita() {
    if (!metaReceita) return;
    await supabase.from("metas").delete().eq("id", metaReceita.id);
    carregar();
    aviso("Meta removida.");
  }

  async function salvarMetaCat() {
    const v = parseFloat(inputValorCat.replace(",", "."));
    if (isNaN(v) || v <= 0 || !selectedCat) return;
    setLoading(true);
    if (editandoCatMetaId) {
      await supabase.from("metas").update({ valor_meta: v }).eq("id", editandoCatMetaId);
    } else {
      await supabase.from("metas").insert({ tipo: "despesa_categoria", categoria_id: selectedCat, mes, ano, valor_meta: v });
    }
    setShowFormCat(false);
    setEditandoCatMetaId(null);
    setInputValorCat("");
    setSelectedCat(catsDisponiveis[0]?.id || "");
    carregar();
    aviso("Orçamento salvo!");
    setLoading(false);
  }

  async function excluirMetaCat(id: string) {
    await supabase.from("metas").delete().eq("id", id);
    carregar();
    aviso("Orçamento removido.");
  }

  function editarMetaCat(m: Meta) {
    setEditandoCatMetaId(m.id);
    setSelectedCat(m.categoria_id || "");
    setInputValorCat(m.valor_meta.toFixed(2).replace(".", ","));
    setShowFormCat(true);
  }

  function abrirFormCat() {
    setEditandoCatMetaId(null);
    setInputValorCat("");
    setSelectedCat(catsDisponiveis[0]?.id || "");
    setShowFormCat(true);
  }

  function navMes(dir: number) {
    let nm = mes + dir, na = ano;
    if (nm < 1) { nm = 12; na--; }
    if (nm > 12) { nm = 1; na++; }
    setMes(nm); setAno(na);
  }

  const isRemocao = mensagem.includes("remov");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Metas e Orçamento</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Defina metas de receita e limites por categoria de despesa</p>
        </div>
      </div>

      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${isRemocao ? "bg-[var(--color-danger-light)] text-[var(--color-danger)]" : "bg-[var(--color-primary-light)] text-[var(--color-primary-dark)]"}`}>
          {mensagem}
        </div>
      )}

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={() => navMes(-1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center">
          <p className="font-semibold text-lg">{mesesNomes[mes - 1]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button onClick={() => navMes(1)} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      {/* Meta de Receita */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="font-bold text-base">🎯 Meta de Receita</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">Total de entradas esperado no mês</p>
          </div>
          {!isReadOnly && (
            <div className="flex gap-2 shrink-0">
              {metaReceita && (
                <button onClick={excluirReceita}
                  className="px-3 py-1.5 text-xs rounded-lg hover:bg-[var(--color-danger-light)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] border border-[var(--color-border)] transition">
                  Remover
                </button>
              )}
              <button
                onClick={() => { setEditandoReceita(true); setInputReceita(metaReceita ? metaReceita.valor_meta.toFixed(2).replace(".", ",") : ""); }}
                className="px-4 py-1.5 text-xs rounded-lg bg-[var(--color-primary)] text-white font-semibold hover:bg-[var(--color-primary-dark)] transition">
                {metaReceita ? "Editar" : "Definir meta"}
              </button>
            </div>
          )}
        </div>

        {metaReceita ? (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4" style={{ background: "var(--green-subtle)", borderColor: "var(--green-border)" }}>
            <p className="text-2xl font-bold" style={{ color: "var(--green)" }}>{fmt(metaReceita.valor_meta)}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Meta de receita para {mesesNomes[mes - 1]} de {ano}</p>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)] text-center py-4">Nenhuma meta definida para este mês.</p>
        )}

        {editandoReceita && (
          <div className="mt-4 flex gap-3 items-center flex-wrap">
            <input
              type="text" value={inputReceita} onChange={e => setInputReceita(e.target.value)}
              placeholder="Ex: 50000,00" autoFocus
              className="flex-1 min-w-48 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
              onKeyDown={e => { if (e.key === "Enter") salvarReceita(); if (e.key === "Escape") setEditandoReceita(false); }}
            />
            <button onClick={salvarReceita} disabled={loading}
              className="px-5 py-3 bg-[var(--color-primary)] text-white text-sm font-semibold rounded-xl hover:bg-[var(--color-primary-dark)] transition disabled:opacity-50">
              Salvar
            </button>
            <button onClick={() => setEditandoReceita(false)}
              className="px-4 py-3 border border-[var(--color-border)] text-sm rounded-xl hover:bg-[var(--color-bg)] transition text-[var(--color-text-muted)]">
              Cancelar
            </button>
          </div>
        )}
      </div>

      {/* Orçamento por Categoria */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-base">📋 Orçamento por Categoria</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">Limite mensal de gasto por categoria de despesa</p>
          </div>
          {catsDisponiveis.length > 0 && !showFormCat && !isReadOnly && (
            <button onClick={abrirFormCat}
              className="px-4 py-2 bg-[var(--color-primary)] text-white text-sm font-semibold rounded-xl hover:bg-[var(--color-primary-dark)] transition">
              + Adicionar
            </button>
          )}
        </div>

        {showFormCat && (
          <div className="p-5 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
              {editandoCatMetaId ? "Editar orçamento" : "Novo orçamento"}
            </p>
            <div className="flex gap-3 items-end flex-wrap">
              <div className="flex-1 min-w-40">
                <label className="block text-xs font-semibold mb-1.5 text-[var(--color-text-muted)]">Categoria de Despesa</label>
                <select
                  value={selectedCat}
                  onChange={e => setSelectedCat(e.target.value)}
                  disabled={!!editandoCatMetaId}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none"
                >
                  {editandoCatMetaId
                    ? cats.filter(c => c.id === selectedCat).map(c => <option key={c.id} value={c.id}>{c.nome}</option>)
                    : catsDisponiveis.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)
                  }
                </select>
              </div>
              <div className="flex-1 min-w-36">
                <label className="block text-xs font-semibold mb-1.5 text-[var(--color-text-muted)]">Limite mensal (R$)</label>
                <input
                  type="text" value={inputValorCat}
                  onChange={e => setInputValorCat(e.target.value)}
                  placeholder="Ex: 2000,00" autoFocus
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none"
                  onKeyDown={e => { if (e.key === "Enter") salvarMetaCat(); if (e.key === "Escape") { setShowFormCat(false); setEditandoCatMetaId(null); } }}
                />
              </div>
              <div className="flex gap-2">
                <button onClick={salvarMetaCat} disabled={loading}
                  className="px-5 py-3 bg-[var(--color-primary)] text-white text-sm font-semibold rounded-xl hover:bg-[var(--color-primary-dark)] transition disabled:opacity-50">
                  Salvar
                </button>
                <button onClick={() => { setShowFormCat(false); setEditandoCatMetaId(null); }}
                  className="px-4 py-3 border border-[var(--color-border)] text-sm rounded-xl hover:bg-[var(--color-surface)] transition text-[var(--color-text-muted)]">
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {metasCat.length === 0 && !showFormCat ? (
          <EmptyState variant="categories" title="Nenhum orçamento definido"
            description="Defina limites de gasto por categoria para controlar melhor as despesas."
            action={isReadOnly ? undefined : { label: "Adicionar orçamento", onClick: abrirFormCat }} />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {metasCat.map(m => {
              const cat = cats.find(c => c.id === m.categoria_id);
              return (
                <div key={m.id} className="flex items-center justify-between p-4 hover:bg-[var(--color-bg)] transition">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-sm shrink-0" style={{ background: "var(--red-subtle)" }}>
                      📋
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{cat?.nome || "—"}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">Orçamento mensal</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-bold" style={{ color: "var(--red)" }}>{fmt(m.valor_meta)}</span>
                    {!isReadOnly && (
                      <div className="flex gap-1">
                        <button onClick={() => editarMetaCat(m)}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                        <button onClick={() => excluirMetaCat(m.id)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
