"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";
import { useRole } from "@/lib/role-context";

interface Maquina {
  id: string;
  nome: string;
  banco: string;
  agencia: string;
  conta: string;
  taxa_debito: number;
  taxa_credito: number;
  taxa_pix: number;
  ativo: boolean;
}

export default function MaquinasPage() {
  const { isReadOnly } = useRole();
  const [maquinas, setMaquinas] = useState<Maquina[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState("");

  const [nome, setNome] = useState("");
  const [banco, setBanco] = useState("");
  const [agencia, setAgencia] = useState("");
  const [conta, setConta] = useState("");
  const [taxaDebito, setTaxaDebito] = useState("");
  const [taxaCredito, setTaxaCredito] = useState("");
  const [taxaPix, setTaxaPix] = useState("");

  const supabase = createClient();

  async function carregar() {
    const { data } = await supabase.from("maquinas").select("*").order("nome");
    if (data) setMaquinas(data);
  }

  useEffect(() => { carregar(); }, []);

  function resetarForm() {
    setNome(""); setBanco(""); setAgencia(""); setConta("");
    setTaxaDebito(""); setTaxaCredito(""); setTaxaPix("");
    setEditandoId(null);
  }

  function abrirNovo() { resetarForm(); setShowForm(true); }

  function abrirEditar(m: Maquina) {
    setNome(m.nome); setBanco(m.banco); setAgencia(m.agencia || "");
    setConta(m.conta || ""); setTaxaDebito(m.taxa_debito.toString().replace(".", ","));
    setTaxaCredito(m.taxa_credito.toString().replace(".", ","));
    setTaxaPix(m.taxa_pix.toString().replace(".", ","));
    setEditandoId(m.id); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMensagem("");

    const dados = {
      nome, banco, agencia, conta,
      taxa_debito: parseFloat(taxaDebito.replace(",", ".")) || 0,
      taxa_credito: parseFloat(taxaCredito.replace(",", ".")) || 0,
      taxa_pix: parseFloat(taxaPix.replace(",", ".")) || 0,
    };

    let error;
    if (editandoId) {
      const r = await supabase.from("maquinas").update(dados).eq("id", editandoId);
      error = r.error;
    } else {
      const r = await supabase.from("maquinas").insert(dados);
      error = r.error;
    }

    if (error) setMensagem("Erro ao salvar.");
    else {
      setMensagem(editandoId ? "Atualizado!" : "Cadastrado!");
      resetarForm(); setShowForm(false); carregar();
    }
    setLoading(false); setTimeout(() => setMensagem(""), 3000);
  }

  async function toggleAtivo(m: Maquina) {
    await supabase.from("maquinas").update({ ativo: !m.ativo }).eq("id", m.id);
    setMensagem(m.ativo ? "Desativado!" : "Ativado!");
    carregar(); setTimeout(() => setMensagem(""), 3000);
  }

  async function handleExcluir(id: string) {
    if (!confirm("Excluir?")) return;
    await supabase.from("maquinas").delete().eq("id", id);
    setMensagem("Excluído!"); carregar(); setTimeout(() => setMensagem(""), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Máquinas e Contas</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Cadastre maquininhas, bancos e taxas</p>
        </div>
        {!isReadOnly && (
          <button onClick={abrirNovo} className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all text-sm shadow-md shadow-blue-200">
            + Nova Máquina
          </button>
        )}
      </div>

      {mensagem && <div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {showForm && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId ? "Editar" : "Nova"} Máquina</h2>
            <button onClick={() => { setShowForm(false); resetarForm(); }} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleSalvar} className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">Dados Bancários</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Nome da Máquina</label>
                  <input type="text" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: Maquininha 1" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Banco</label>
                  <input type="text" value={banco} onChange={(e) => setBanco(e.target.value)} placeholder="Ex: Inter, Santander" required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Agência</label>
                  <input type="text" value={agencia} onChange={(e) => setAgencia(e.target.value)} placeholder="0001" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Conta</label>
                  <input type="text" value={conta} onChange={(e) => setConta(e.target.value)} placeholder="12345-6" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none" />
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text-muted)] mb-1 uppercase tracking-wider">Taxas (%)</h3>
              <p className="text-xs text-[var(--color-text-muted)] mb-3">Percentual descontado por venda em cada modalidade</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <label className="block text-sm font-semibold mb-2 text-amber-800">💳 Débito (%)</label>
                  <input type="text" value={taxaDebito} onChange={(e) => setTaxaDebito(e.target.value)} placeholder="Ex: 1,99" className="w-full px-4 py-3 rounded-xl border border-amber-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
                  <p className="text-[10px] text-amber-600 mt-1">Recebe: próximo dia útil</p>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <label className="block text-sm font-semibold mb-2 text-blue-800">💳 Crédito (%)</label>
                  <input type="text" value={taxaCredito} onChange={(e) => setTaxaCredito(e.target.value)} placeholder="Ex: 3,49" className="w-full px-4 py-3 rounded-xl border border-blue-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                  <p className="text-[10px] text-blue-600 mt-1">Recebe: 30 dias úteis</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <label className="block text-sm font-semibold mb-2 text-emerald-800">📱 Pix (%)</label>
                  <input type="text" value={taxaPix} onChange={(e) => setTaxaPix(e.target.value)} placeholder="Ex: 0,00" className="w-full px-4 py-3 rounded-xl border border-emerald-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
                  <p className="text-[10px] text-emerald-600 mt-1">Recebe: na hora</p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowForm(false); resetarForm(); }} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold rounded-xl hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-blue-200">
                {loading ? "Salvando..." : editandoId ? "Atualizar" : "Salvar"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      {maquinas.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <EmptyState variant="machines" title="Nenhuma máquina cadastrada"
            description='Clique em "+ Nova Máquina" para adicionar sua maquininha ou conta bancária.' />
        </div>
      ) : (
        <div className="space-y-3">
          {maquinas.map((m) => (
            <div key={m.id} className={`bg-[var(--color-surface)] border rounded-2xl p-4 ${m.ativo ? "border-[var(--color-border)]" : "border-gray-200 opacity-60"}`}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-sm shrink-0">🏦</div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold">{m.nome}</p>
                      {!m.ativo && <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">INATIVO</span>}
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {m.banco}{m.agencia ? ` · Ag: ${m.agencia}` : ""}{m.conta ? ` · Conta: ${m.conta}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex gap-2 text-xs">
                    <span className="px-2 py-1 bg-amber-50 text-amber-700 rounded-lg font-medium">Déb: {m.taxa_debito}%</span>
                    <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded-lg font-medium">Créd: {m.taxa_credito}%</span>
                    <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg font-medium">Pix: {m.taxa_pix}%</span>
                  </div>
                  {!isReadOnly && (
                    <div className="flex gap-1">
                      <button onClick={() => abrirEditar(m)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                      <button onClick={() => toggleAtivo(m)} className={`p-1.5 rounded-lg transition text-sm ${m.ativo ? "hover:bg-amber-50 text-[var(--color-text-muted)] hover:text-amber-600" : "hover:bg-emerald-50 text-[var(--color-text-muted)] hover:text-emerald-600"}`}>
                        {m.ativo ? "⏸" : "▶"}
                      </button>
                      <button onClick={() => handleExcluir(m.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
