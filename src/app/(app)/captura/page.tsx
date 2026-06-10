"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";
import Tesseract from "tesseract.js";

interface Categoria {
  id: string;
  nome: string;
}

interface ValorDetectado {
  texto: string;
  valor: number;
  selecionado: boolean;
}

export default function CapturaPage() {
  const [imagem, setImagem] = useState<string | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [progresso, setProgresso] = useState(0);
  const [textoExtraido, setTextoExtraido] = useState("");
  const [valoresDetectados, setValoresDetectados] = useState<ValorDetectado[]>([]);
  const [tipo, setTipo] = useState<"entrada" | "saida">("saida");
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [categoriaId, setCategoriaId] = useState("");
  const [data, setData] = useState(new Date().toISOString().split("T")[0]);
  const [observacao, setObservacao] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [etapa, setEtapa] = useState<"upload" | "processando" | "resultados">("upload");
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  async function carregarCategorias() {
    const tabela = tipo === "entrada" ? "categorias_entrada" : "categorias_saida";
    const { data } = await supabase.from(tabela).select("*").eq("ativo", true).order("nome");
    if (data) {
      setCategorias(data);
      if (data.length > 0) setCategoriaId(data[0].id);
    }
  }

  useEffect(() => { carregarCategorias(); }, [tipo]);

  function handleArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setArquivo(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImagem(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
    setEtapa("upload");
    setTextoExtraido("");
    setValoresDetectados([]);
  }

  async function processarImagem() {
    if (!arquivo && !imagem) return;

    setEtapa("processando");
    setProcessando(true);
    setProgresso(0);
    setTextoExtraido("");
    setValoresDetectados([]);

    try {
      const fonte = imagem || arquivo;

      const result = await Tesseract.recognize(
        fonte as string,
        "por",
        {
          logger: (m) => {
            if (m.status === "recognizing text") {
              setProgresso(Math.round(m.progress * 100));
            }
          },
        }
      );

      const texto = result.data.text;
      setTextoExtraido(texto);

      // Extrair valores monetários
      const valores = extrairValores(texto);
      setValoresDetectados(valores);

      // Tentar extrair data
      const dataEncontrada = extrairData(texto);
      if (dataEncontrada) setData(dataEncontrada);

      // Tentar extrair observação (primeira linha não vazia)
      const linhas = texto.split("\n").filter((l: string) => l.trim().length > 3);
      if (linhas.length > 0 && !observacao) {
        setObservacao(linhas[0].trim().substring(0, 100));
      }

      setEtapa("resultados");

      if (valores.length === 0) {
        setMensagem("Nenhum valor detectado. Tente uma foto mais clara ou ajuste manualmente.");
      } else {
        setMensagem(`${valores.length} ${valores.length === 1 ? "valor detectado" : "valores detectados"}!`);
      }
    } catch {
      setMensagem("Erro ao processar imagem. Tente novamente com uma foto mais clara.");
      setEtapa("upload");
    }

    setProcessando(false);
    setTimeout(() => setMensagem(""), 5000);
  }

  function extrairValores(texto: string): ValorDetectado[] {
    const valores: ValorDetectado[] = [];
    const seen = new Set<string>();

    // Padrão: R$ 1.234,56 ou 1.234,56 ou 1234,56
    const regex1 = /R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g;
    let match;
    while ((match = regex1.exec(texto)) !== null) {
      const numStr = match[1].replace(/\./g, "").replace(",", ".");
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0 && !seen.has(num.toFixed(2))) {
        seen.add(num.toFixed(2));
        valores.push({
          texto: match[0].trim(),
          valor: num,
          selecionado: true,
        });
      }
    }

    // Padrão: 1234.56 (ponto como decimal)
    const regex2 = /(\d{1,3}(?:,\d{3})*\.\d{2})/g;
    while ((match = regex2.exec(texto)) !== null) {
      const numStr = match[1].replace(/,/g, "");
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0 && !seen.has(num.toFixed(2))) {
        seen.add(num.toFixed(2));
        valores.push({
          texto: match[0].trim(),
          valor: num,
          selecionado: true,
        });
      }
    }

    // Padrão: números com vírgula simples (ex: 50,00)
    const regex3 = /(\d+,\d{2})\b/g;
    while ((match = regex3.exec(texto)) !== null) {
      const numStr = match[1].replace(",", ".");
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0 && !seen.has(num.toFixed(2))) {
        seen.add(num.toFixed(2));
        valores.push({
          texto: match[0].trim(),
          valor: num,
          selecionado: true,
        });
      }
    }

    return valores.sort((a, b) => b.valor - a.valor);
  }

  function extrairData(texto: string): string | null {
    // Padrão: DD/MM/YYYY
    const regex1 = /(\d{2})\/(\d{2})\/(\d{4})/;
    const match1 = texto.match(regex1);
    if (match1) {
      return `${match1[3]}-${match1[2]}-${match1[1]}`;
    }

    // Padrão: DD-MM-YYYY
    const regex2 = /(\d{2})-(\d{2})-(\d{4})/;
    const match2 = texto.match(regex2);
    if (match2) {
      return `${match2[3]}-${match2[2]}-${match2[1]}`;
    }

    // Padrão: YYYY-MM-DD
    const regex3 = /(\d{4})-(\d{2})-(\d{2})/;
    const match3 = texto.match(regex3);
    if (match3) {
      return `${match3[1]}-${match3[2]}-${match3[3]}`;
    }

    return null;
  }

  function toggleValor(index: number) {
    setValoresDetectados((prev) =>
      prev.map((v, i) => (i === index ? { ...v, selecionado: !v.selecionado } : v))
    );
  }

  function confirmarTodos() {
    setValoresDetectados((prev) => prev.map((v) => ({ ...v, selecionado: true })));
  }

  const totalSelecionado = valoresDetectados
    .filter((v) => v.selecionado)
    .reduce((a, v) => a + v.valor, 0);

  async function handleSalvar() {
    const selecionados = valoresDetectados.filter((v) => v.selecionado);
    if (selecionados.length === 0) {
      setMensagem("Selecione pelo menos um valor.");
      setTimeout(() => setMensagem(""), 3000);
      return;
    }

    setSalvando(true);
    setMensagem("");

    // Salvar como movimentação com sub-itens
    const dados = {
      tipo,
      data,
      valor: totalSelecionado,
      categoria_id: categoriaId,
      observacao: observacao || `Captura por foto`,
      revisar: false,
    };

    const { data: movResult, error } = await supabase
      .from("movimentacoes")
      .insert(dados)
      .select("id")
      .single();

    if (error) {
      setMensagem("Erro ao salvar.");
      setSalvando(false);
      return;
    }

    // Salvar sub-itens se tiver mais de 1 valor
    if (selecionados.length > 1 && movResult) {
      await supabase.from("movimentacao_itens").insert(
        selecionados.map((v, i) => ({
          movimentacao_id: movResult.id,
          descricao: `Valor ${i + 1} (OCR)`,
          valor: v.valor,
        }))
      );
    }

    await registrarLog({
      acao: "criou",
      tabela: "movimentacoes",
      registroId: movResult?.id,
      dadosNovos: dados,
      detalhes: `Captura por foto: ${tipo === "entrada" ? "Entrada" : "Saída"} de R$ ${totalSelecionado.toFixed(2)}`,
    });

    setMensagem(`Salvo! ${selecionados.length} ${selecionados.length === 1 ? "valor" : "valores"} — Total: R$ ${totalSelecionado.toFixed(2)}`);
    setSalvando(false);

    // Reset
    setTimeout(() => {
      setImagem(null);
      setArquivo(null);
      setTextoExtraido("");
      setValoresDetectados([]);
      setObservacao("");
      setEtapa("upload");
      setMensagem("");
    }, 3000);
  }

  function limpar() {
    setImagem(null);
    setArquivo(null);
    setTextoExtraido("");
    setValoresDetectados([]);
    setObservacao("");
    setEtapa("upload");
    setProgresso(0);
    setMensagem("");
  }

  function fmt(v: number) {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Captura por Foto</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          Tire uma foto de um documento, cupom ou boleto e o sistema extrai os valores automaticamente
        </p>
      </div>

      {mensagem && (
        <div className={`p-3 rounded-xl text-sm font-medium text-center ${
          mensagem.includes("Erro") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"
        }`}>
          {mensagem}
        </div>
      )}

      {/* Upload */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-sm">1. Envie a foto ou imagem</h2>
          {imagem && (
            <button onClick={limpar} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-500 text-xs font-semibold hover:bg-red-100 transition">
              ✕ Limpar
            </button>
          )}
        </div>

        {!imagem ? (
          <div className="border-2 border-dashed border-[var(--color-border)] rounded-xl p-10 text-center">
            <p className="text-3xl mb-3">📸</p>
            <p className="text-sm font-semibold text-[var(--color-text-muted)] mb-1">
              Envie uma foto do documento
            </p>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Cupom fiscal, boleto, comprovante, extrato...
            </p>
            <div className="flex gap-3 justify-center flex-wrap">
              {/* Câmera (mobile) */}
              <label className="inline-flex items-center gap-2 px-5 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold cursor-pointer hover:bg-emerald-700 transition">
                📱 Tirar Foto
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleArquivo}
                  className="hidden"
                />
              </label>
              {/* Galeria / Arquivo */}
              <label className="inline-flex items-center gap-2 px-5 py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold cursor-pointer hover:bg-blue-700 transition">
                🖼️ Escolher Arquivo
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={handleArquivo}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imagem} alt="Documento" className="w-full max-h-80 object-contain" />
            </div>

            {etapa === "upload" && (
              <button
                onClick={processarImagem}
                className="w-full py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200"
              >
                🔍 Extrair Valores Automaticamente
              </button>
            )}
          </div>
        )}
      </div>

      {/* Processando */}
      {etapa === "processando" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm font-semibold mb-2">Lendo o documento...</p>
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden max-w-md mx-auto">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${progresso}%` }}
              />
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-2">{progresso}%</p>
          </div>
        </div>
      )}

      {/* Resultados */}
      {etapa === "resultados" && (
        <>
          {/* Texto extraído */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
            <h2 className="font-bold text-sm mb-3">2. Texto extraído</h2>
            <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4 max-h-40 overflow-y-auto">
              <pre className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap font-mono">
                {textoExtraido || "Nenhum texto detectado."}
              </pre>
            </div>
          </div>

          {/* Valores detectados */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-sm">3. Valores detectados — clique para selecionar</h2>
              {valoresDetectados.length > 0 && (
                <button onClick={confirmarTodos} className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-semibold hover:bg-emerald-100 transition">
                  ✓ Confirmar todos
                </button>
              )}
            </div>
            {valoresDetectados.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] text-center py-4">
                Nenhum valor encontrado. Tente uma foto mais clara.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {valoresDetectados.map((v, i) => (
                  <button
                    key={i}
                    onClick={() => toggleValor(i)}
                    className={`p-4 rounded-xl border-2 text-center transition-all ${
                      v.selecionado
                        ? "border-emerald-500 bg-emerald-50"
                        : "border-[var(--color-border)] bg-[var(--color-bg)]"
                    }`}
                  >
                    <p className="text-lg font-bold">{fmt(v.valor)}</p>
                    <p className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate">
                      &quot;{v.texto}&quot;
                    </p>
                    {v.selecionado && (
                      <p className="text-[10px] text-emerald-600 font-bold mt-1">✓ Selecionado</p>
                    )}
                  </button>
                ))}
              </div>
            )}

            {valoresDetectados.filter((v) => v.selecionado).length > 0 && (
              <div className="mt-4 bg-emerald-50 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm font-semibold text-emerald-800">
                  {valoresDetectados.filter((v) => v.selecionado).length} valores selecionados
                </span>
                <span className="text-lg font-bold text-emerald-700">{fmt(totalSelecionado)}</span>
              </div>
            )}
          </div>

          {/* Formulário de salvamento */}
          {valoresDetectados.filter((v) => v.selecionado).length > 0 && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
              <h2 className="font-bold text-sm mb-4">4. Confirme e salve</h2>
              <div className="space-y-4">
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setTipo("entrada")}
                    className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${
                      tipo === "entrada"
                        ? "bg-emerald-600 text-white shadow-md shadow-emerald-200"
                        : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                    }`}
                  >
                    ▲ Entrada
                  </button>
                  <button
                    type="button"
                    onClick={() => setTipo("saida")}
                    className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${
                      tipo === "saida"
                        ? "bg-red-500 text-white shadow-md shadow-red-200"
                        : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                    }`}
                  >
                    ▼ Saída
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data</label>
                    <input
                      type="date"
                      value={data}
                      onChange={(e) => setData(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Categoria</label>
                    <select
                      value={categoriaId}
                      onChange={(e) => setCategoriaId(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                    >
                      {categorias.map((cat) => (
                        <option key={cat.id} value={cat.id}>{cat.nome}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label>
                  <input
                    type="text"
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    placeholder="Descrição do documento"
                    className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"
                  />
                </div>

                {/* Preview */}
                <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--color-text-muted)]">Total a salvar:</span>
                    <span className={`text-xl font-bold ${tipo === "entrada" ? "text-emerald-600" : "text-red-500"}`}>
                      {fmt(totalSelecionado)}
                    </span>
                  </div>
                  {valoresDetectados.filter((v) => v.selecionado).length > 1 && (
                    <p className="text-xs text-[var(--color-text-muted)] mt-1">
                      Soma de {valoresDetectados.filter((v) => v.selecionado).length} valores individuais
                    </p>
                  )}
                </div>

                <div className="flex gap-3">
                  <button onClick={limpar} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">
                    Cancelar
                  </button>
                  <button
                    onClick={handleSalvar}
                    disabled={salvando}
                    className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200"
                  >
                    {salvando ? "Salvando..." : "💾 Salvar Movimentação"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
