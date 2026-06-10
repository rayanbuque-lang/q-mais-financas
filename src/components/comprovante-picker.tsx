"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  tabela: "movimentacoes" | "contas-pagar";
  urlAtual?: string | null;
  onChange: (url: string | null) => void;
}

export default function ComprovantePicker({ tabela, urlAtual, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(urlAtual ?? null);
  const [erro, setErro] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  async function handleFile(file: File) {
    if (!file) return;
    setErro("");
    setUploading(true);

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
    const path = `${tabela}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabase.storage.from("comprovantes").upload(path, file, {
      cacheControl: "3600",
      upsert: false,
    });

    if (error) {
      setErro("Erro no upload: " + error.message);
      setUploading(false);
      return;
    }

    const { data } = supabase.storage.from("comprovantes").getPublicUrl(path);
    setPreview(data.publicUrl);
    onChange(data.publicUrl);
    setUploading(false);
  }

  async function remover() {
    if (!preview) return;
    // Remove do storage se for deste projeto
    try {
      const url = new URL(preview);
      const path = url.pathname.split("/comprovantes/").pop();
      if (path) await supabase.storage.from("comprovantes").remove([path]);
    } catch { /* ignora erros de URL inválida */ }
    setPreview(null);
    onChange(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  const isPdf = preview?.toLowerCase().includes(".pdf");

  return (
    <div>
      <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">
        Comprovante (foto/PDF)
      </label>

      {preview ? (
        <div className="border border-[var(--color-border)] rounded-xl overflow-hidden bg-[var(--color-bg)]">
          {isPdf ? (
            <div className="flex items-center justify-between p-3 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-2xl shrink-0">📄</span>
                <a href={preview} target="_blank" rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline truncate">
                  Ver PDF
                </a>
              </div>
              <button type="button" onClick={remover}
                className="shrink-0 text-xs px-2 py-1 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 transition">
                ✕ Remover
              </button>
            </div>
          ) : (
            <div className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Comprovante" className="w-full max-h-52 object-contain p-2" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                <a href={preview} target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-white rounded-lg text-xs font-semibold shadow hover:shadow-md transition">
                  🔍 Ampliar
                </a>
                <button type="button" onClick={remover}
                  className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-semibold shadow hover:bg-red-600 transition">
                  ✕ Remover
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed border-[var(--color-border)] rounded-xl p-4 text-center cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/50 transition-all"
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
              <span className="w-4 h-4 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin" />
              Enviando...
            </div>
          ) : (
            <>
              <p className="text-2xl mb-1">📎</p>
              <p className="text-xs font-semibold text-[var(--color-text-muted)]">
                Clique ou arraste aqui
              </p>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                JPG, PNG, WEBP ou PDF · máx 10 MB
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            className="hidden"
          />
        </div>
      )}

      {erro && <p className="text-xs text-red-500 mt-1">{erro}</p>}
    </div>
  );
}
