"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";

interface CartaoArquivo {
  id: string;
  adquirente: string | null;
  nome_arquivo: string;
  conteudo_bruto: string | null;
  status: string;
  importado_em: string;
}

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

const ADQUIRENTES = ["Rede", "Cielo", "Stone", "GetNet", "PagSeguro", "Outra"];
const MAX_TAMANHO = 10 * 1024 * 1024; // 10 MB

/** Melhor esforço: tenta UTF-8 estrito, cai pra ISO-8859-1 (nunca falha) — só pra guardar/exibir o texto bruto, sem interpretar. */
function decodificarMelhorEsforco(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("iso-8859-1").decode(bytes);
  }
}

function formatarDataHora(iso: string) {
  return new Date(iso).toLocaleString("pt-BR");
}

export default function CartoesTestePage() {
  const supabase = createClient();

  const [role, setRole] = useState<string | null>(null);
  const podeEscrever = role === "master" || role === "funcionario";

  const [mensagem, setMensagem] = useState<Mensagem>(null);
  const [adquirente, setAdquirente] = useState(ADQUIRENTES[0]);
  const [enviando, setEnviando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [arquivos, setArquivos] = useState<CartaoArquivo[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [expandidoId, setExpandidoId] = useState<string | null>(null);

  async function carregarArquivos() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("cartao_arquivo")
      .select("*")
      .order("importado_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(200);
    if (!error && data) setArquivos(data as CartaoArquivo[]);
    setCarregando(false);
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarArquivos();
  }, []);

  async function handleEnviar() {
    setMensagem(null);
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setMensagem({ tipo: "erro", texto: "Selecione um arquivo." });
      return;
    }
    if (file.size > MAX_TAMANHO) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${file.name}" rejeitado: maior que 10 MB.` });
      return;
    }

    setEnviando(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const conteudo = decodificarMelhorEsforco(bytes);
      const { data: { user } } = await supabase.auth.getUser();

      const { error } = await supabase.from("cartao_arquivo").insert({
        adquirente,
        nome_arquivo: file.name,
        conteudo_bruto: conteudo,
        status: "aguardando_parser",
        importado_por: user?.id ?? null,
      });
      if (error) throw new Error(error.message);

      setMensagem({ tipo: "sucesso", texto: `Arquivo "${file.name}" guardado. Nenhuma interpretação foi feita — só o conteúdo bruto.` });
      if (inputRef.current) inputRef.current.value = "";
      await carregarArquivos();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro inesperado ao enviar o arquivo." });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Arquivos de Cartão (EDI de conciliação)</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          Fase 3 do projeto de conciliação — ainda sem o layout real da adquirente confirmado. Esta tela só guarda o
          arquivo bruto e mostra as primeiras linhas em texto puro; nenhum parser foi escrito ainda.
        </p>
      </div>

      {mensagem && (
        <div
          className={`mb-4 px-4 py-3 rounded-xl text-sm font-medium border ${
            mensagem.tipo === "sucesso" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {mensagem.tipo === "sucesso" ? "✅ " : "⚠️ "}
          {mensagem.texto}
        </div>
      )}

      {!podeEscrever && (
        <div className="mb-4 px-4 py-2.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
          👁️ Seu perfil tem acesso somente leitura nesta área.
        </div>
      )}

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-xl mb-6">
        <h2 className="font-semibold text-sm mb-4">Enviar arquivo</h2>

        <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Adquirente</label>
        <select
          value={adquirente}
          onChange={(e) => setAdquirente(e.target.value)}
          disabled={!podeEscrever}
          className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-4"
        >
          {ADQUIRENTES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Arquivo (máx 10 MB)</label>
        <input
          ref={inputRef}
          type="file"
          disabled={!podeEscrever}
          className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:text-xs file:font-semibold"
        />

        <button
          type="button"
          onClick={handleEnviar}
          disabled={!podeEscrever || enviando}
          className="w-full px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {enviando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
          {enviando ? "Enviando..." : "Enviar arquivo"}
        </button>
      </div>

      {carregando ? (
        <div className="skeleton h-32 rounded-xl" />
      ) : arquivos.length === 0 ? (
        <EmptyState variant="search" title="Nenhum arquivo enviado" description="Envie um arquivo da adquirente acima para começar." compact />
      ) : (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                <th className="px-3 py-2.5 font-semibold">Enviado em</th>
                <th className="px-3 py-2.5 font-semibold">Adquirente</th>
                <th className="px-3 py-2.5 font-semibold">Arquivo</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Prévia</th>
              </tr>
            </thead>
            <tbody>
              {arquivos.map((a) => {
                const linhas = (a.conteudo_bruto ?? "").split(/\r\n|\n/).slice(0, 20);
                return (
                  <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="px-3 py-2.5 whitespace-nowrap">{formatarDataHora(a.importado_em)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{a.adquirente ?? "—"}</td>
                    <td className="px-3 py-2.5">{a.nome_arquivo}</td>
                    <td className="px-3 py-2.5">
                      <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200 text-[10px] font-semibold whitespace-nowrap">
                        {a.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandidoId(expandidoId === a.id ? null : a.id)}
                        className="px-2 py-1 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)]"
                      >
                        {expandidoId === a.id ? "Ocultar" : "Ver primeiras linhas"}
                      </button>
                      {expandidoId === a.id && (
                        <pre className="mt-2 p-3 rounded-lg bg-[var(--hover-bg)] text-[10px] overflow-x-auto max-w-2xl whitespace-pre">
                          {linhas.join("\n") || "(arquivo vazio)"}
                        </pre>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
