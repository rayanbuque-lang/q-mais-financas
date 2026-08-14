"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseNFe, decodificarXml, NFeParseError, type NFeParseResult } from "@/lib/xml-nfe";
import { extrairArquivosZip, ZipParseError } from "@/lib/zip";
import EmptyState from "@/components/empty-state";

interface Duplicata {
  id: string;
  numero: string | null;
  vencimento: string | null;
  valor: number;
  status: string;
}

interface Nota {
  id: string;
  chave_acesso: string;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  numero_nota: string | null;
  valor_total: number | null;
  emitida_em: string | null;
  criado_em: string;
  xml_duplicata: Duplicata[];
}

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

function formatarMoeda(v: number | null) {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarData(iso: string | null) {
  if (!iso) return "—";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

// criado_em é timestamptz (ex.: "2026-08-13 01:02:29.76+00"), diferente de
// emitida_em/vencimento que são datas puras -- não dá pra usar formatarData.
function formatarDataCadastro(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR");
}

function formatarChave(chave: string) {
  return chave.replace(/(\d{4})(?=\d)/g, "$1 ");
}

const MAX_ARQUIVOS_TAMANHO = 10 * 1024 * 1024; // 10 MB por arquivo

export default function XmlNotasPage() {
  const supabase = createClient();

  const [role, setRole] = useState<string | null>(null);
  const podeEscrever = role === "master" || role === "funcionario";

  const [aba, setAba] = useState<"importar" | "notas">("importar");
  const [mensagem, setMensagem] = useState<Mensagem>(null);

  const [importando, setImportando] = useState(false);
  const [resumoImportacao, setResumoImportacao] = useState<{
    arquivosLidos: number;
    notasEncontradas: number;
    novas: number;
    duplicadas: number;
    erros: string[];
  } | null>(null);
  const inputArquivosRef = useRef<HTMLInputElement>(null);

  const [notas, setNotas] = useState<Nota[]>([]);
  const [carregandoNotas, setCarregandoNotas] = useState(false);
  const [notaExpandidaId, setNotaExpandidaId] = useState<string | null>(null);

  async function carregarNotas() {
    setCarregandoNotas(true);
    const { data, error } = await supabase
      .from("xml_nota")
      .select("*, xml_duplicata(*)")
      .order("emitida_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(500);
    if (!error && data) setNotas(data as unknown as Nota[]);
    setCarregandoNotas(false);
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarNotas();
  }, []);

  // Por arquivo, não pro lote inteiro: um .zip corrompido não pode derrubar os
  // XMLs que já vieram bons de outros arquivos do mesmo upload -- mesmo padrão
  // de resiliência que já existe no parse de cada NF-e logo abaixo.
  async function coletarXmlsDosArquivos(
    files: File[]
  ): Promise<{ arquivos: { nomeOrigem: string; bytes: Uint8Array }[]; erros: string[] }> {
    const arquivos: { nomeOrigem: string; bytes: Uint8Array }[] = [];
    const erros: string[] = [];
    for (const file of files) {
      const nomeMin = file.name.toLowerCase();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (nomeMin.endsWith(".xml")) {
          arquivos.push({ nomeOrigem: file.name, bytes });
        } else if (nomeMin.endsWith(".zip")) {
          const entradas = await extrairArquivosZip(bytes, file.name);
          const xmls = entradas.filter((e) => e.nome.toLowerCase().endsWith(".xml"));
          for (const e of xmls) {
            arquivos.push({ nomeOrigem: `${file.name} → ${e.nome}`, bytes: e.bytes });
          }
        }
      } catch (e) {
        erros.push(e instanceof ZipParseError ? e.message : `Erro inesperado ao processar "${file.name}".`);
      }
    }
    return { arquivos, erros };
  }

  async function handleImportar() {
    setMensagem(null);
    setResumoImportacao(null);

    const files = Array.from(inputArquivosRef.current?.files ?? []);
    if (files.length === 0) {
      setMensagem({ tipo: "erro", texto: "Selecione um ou mais arquivos .xml ou .zip." });
      return;
    }
    for (const f of files) {
      const nomeMin = f.name.toLowerCase();
      if (!nomeMin.endsWith(".xml") && !nomeMin.endsWith(".zip")) {
        setMensagem({ tipo: "erro", texto: `Arquivo "${f.name}" rejeitado: apenas .xml e .zip são aceitos.` });
        return;
      }
      if (f.size > MAX_ARQUIVOS_TAMANHO) {
        setMensagem({ tipo: "erro", texto: `Arquivo "${f.name}" rejeitado: maior que 10 MB.` });
        return;
      }
    }

    setImportando(true);
    const erros: string[] = [];
    try {
      const { arquivos: xmls, erros: errosColeta } = await coletarXmlsDosArquivos(files);
      erros.push(...errosColeta);

      const notasParseadas: { resultado: NFeParseResult; xmlBruto: string }[] = [];
      for (const { nomeOrigem, bytes } of xmls) {
        try {
          const texto = decodificarXml(bytes, nomeOrigem);
          const resultado = parseNFe(texto, nomeOrigem);
          notasParseadas.push({ resultado, xmlBruto: texto });
        } catch (e) {
          erros.push(e instanceof NFeParseError ? e.message : `Erro inesperado ao processar "${nomeOrigem}".`);
        }
      }

      if (notasParseadas.length === 0) {
        setResumoImportacao({ arquivosLidos: xmls.length, notasEncontradas: 0, novas: 0, duplicadas: 0, erros });
        setMensagem({ tipo: erros.length > 0 ? "erro" : "sucesso", texto: erros.length > 0 ? "Nenhuma nota válida encontrada." : "Nenhum XML encontrado nos arquivos selecionados." });
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();

      const { data: importacao, error: erroImportacao } = await supabase
        .from("xml_importacao")
        .insert({ origem: "upload_manual", qtd_notas: notasParseadas.length, importado_por: user?.id ?? null })
        .select()
        .single();
      if (erroImportacao) throw new Error(erroImportacao.message);

      const linhasNota = notasParseadas.map(({ resultado, xmlBruto }) => ({
        importacao_id: importacao.id,
        chave_acesso: resultado.chaveAcesso,
        fornecedor_nome: resultado.fornecedorNome,
        fornecedor_cnpj: resultado.fornecedorCnpj,
        numero_nota: resultado.numeroNota,
        valor_total: resultado.valorTotal,
        emitida_em: resultado.emitidaEm,
        xml_bruto: xmlBruto,
      }));

      const { data: notasInseridas, error: erroNota } = await supabase
        .from("xml_nota")
        .upsert(linhasNota, { onConflict: "chave_acesso", ignoreDuplicates: true })
        .select("id, chave_acesso");
      if (erroNota) throw new Error(erroNota.message);

      const novas = notasInseridas?.length ?? 0;
      const duplicadas = linhasNota.length - novas;

      if (notasInseridas && notasInseridas.length > 0) {
        const duplicatasParaInserir = notasInseridas.flatMap((notaInserida) => {
          const original = notasParseadas.find((n) => n.resultado.chaveAcesso === notaInserida.chave_acesso);
          if (!original) return [];
          return original.resultado.duplicatas.map((d) => ({
            nota_id: notaInserida.id,
            numero: d.numero,
            vencimento: d.vencimento,
            valor: d.valor,
            status: "candidata",
          }));
        });
        if (duplicatasParaInserir.length > 0) {
          const { error: erroDup } = await supabase.from("xml_duplicata").insert(duplicatasParaInserir);
          if (erroDup) throw new Error(erroDup.message);
        }
      }

      setResumoImportacao({ arquivosLidos: xmls.length, notasEncontradas: notasParseadas.length, novas, duplicadas, erros });
      setMensagem({
        tipo: "sucesso",
        texto: `${notasParseadas.length} nota(s) lida(s) · ${novas} nova(s) · ${duplicadas} já existente(s)` + (erros.length > 0 ? ` · ${erros.length} arquivo(s) com erro` : ""),
      });
      if (inputArquivosRef.current) inputArquivosRef.current.value = "";
      await carregarNotas();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro inesperado ao importar." });
    } finally {
      setImportando(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-[var(--color-text)]">XML de Notas Fiscais</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          Fase 2 do projeto de conciliação — camada de staging, só leitura. Nada aqui é gravado em Contas a Pagar; é só para
          observar o dado real antes de decidirmos o destino final.
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

      <div className="flex gap-1 mb-6 border-b border-[var(--color-border)]">
        {[
          { id: "importar", label: "📥 Importar" },
          { id: "notas", label: "📄 Notas" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setAba(t.id as typeof aba)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition ${
              aba === t.id ? "border-emerald-500 text-emerald-600" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!podeEscrever && (
        <div className="mb-4 px-4 py-2.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
          👁️ Seu perfil tem acesso somente leitura nesta área.
        </div>
      )}

      {aba === "importar" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-xl">
          <h2 className="font-semibold text-sm mb-1">Importar XML de nota fiscal</h2>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            Sem conector de e-mail nesta fase — envie os arquivos .xml (ou .zip com vários XMLs) manualmente, baixados do
            e-mail ou da SEFAZ, exatamente como hoje.
          </p>

          <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Arquivos .xml ou .zip (máx 10 MB cada)</label>
          <input
            ref={inputArquivosRef}
            type="file"
            accept=".xml,.zip"
            multiple
            disabled={!podeEscrever}
            className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:text-xs file:font-semibold"
          />

          <button
            type="button"
            onClick={handleImportar}
            disabled={!podeEscrever || importando}
            className="w-full px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {importando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {importando ? "Importando..." : "Importar notas"}
          </button>

          {resumoImportacao && (
            <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              <p className="font-semibold">
                {resumoImportacao.arquivosLidos} XML(s) lido(s) · {resumoImportacao.notasEncontradas} nota(s) reconhecida(s) · {resumoImportacao.novas} nova(s) · {resumoImportacao.duplicadas} já existente(s)
              </p>
              {resumoImportacao.erros.length > 0 && (
                <ul className="mt-2 list-disc list-inside text-amber-700">
                  {resumoImportacao.erros.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {aba === "notas" && (
        <div>
          {carregandoNotas ? (
            <div className="skeleton h-40 rounded-xl" />
          ) : notas.length === 0 ? (
            <EmptyState variant="search" title="Nenhuma nota importada" description="Importe XMLs na aba Importar para começar." compact />
          ) : (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Emissão</th>
                    <th className="px-3 py-2.5 font-semibold">Cadastrado em</th>
                    <th className="px-3 py-2.5 font-semibold">Fornecedor</th>
                    <th className="px-3 py-2.5 font-semibold">Nº nota</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Valor total</th>
                    <th className="px-3 py-2.5 font-semibold">Chave de acesso</th>
                    <th className="px-3 py-2.5 font-semibold">Vencimento(s)</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n) => (
                    <Fragment key={n.id}>
                      <tr className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatarData(n.emitida_em)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatarDataCadastro(n.criado_em)}</td>
                        <td className="px-3 py-2.5 max-w-[220px] truncate" title={n.fornecedor_nome ?? ""}>
                          {n.fornecedor_nome ?? "—"}
                          {n.fornecedor_cnpj && <span className="block text-[10px] text-[var(--color-text-muted)]">{n.fornecedor_cnpj}</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{n.numero_nota ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap font-semibold">{formatarMoeda(n.valor_total)}</td>
                        <td className="px-3 py-2.5 font-mono text-[10px]" title={n.chave_acesso}>
                          {formatarChave(n.chave_acesso).slice(0, 24)}…
                        </td>
                        <td className="px-3 py-2.5">
                          {n.xml_duplicata.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setNotaExpandidaId(notaExpandidaId === n.id ? null : n.id)}
                              className="flex flex-wrap gap-1 items-center"
                              title="Ver valor e status de cada parcela"
                            >
                              {[...n.xml_duplicata]
                                .sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? "") || a.id.localeCompare(b.id))
                                .map((d) => (
                                  <span
                                    key={d.id}
                                    className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold whitespace-nowrap"
                                  >
                                    {formatarData(d.vencimento)}
                                  </span>
                                ))}
                              <span className="text-[10px] text-[var(--color-text-muted)]">{notaExpandidaId === n.id ? "▲" : "▼"}</span>
                            </button>
                          ) : (
                            <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                          )}
                        </td>
                      </tr>
                      {notaExpandidaId === n.id && n.xml_duplicata.length > 0 && (
                        <tr className="bg-[var(--hover-bg)]">
                          <td colSpan={7} className="px-3 py-2.5">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-[var(--color-text-muted)]">
                                  <th className="text-left font-semibold pb-1">Parcela</th>
                                  <th className="text-left font-semibold pb-1">Vencimento</th>
                                  <th className="text-right font-semibold pb-1">Valor</th>
                                  <th className="text-left font-semibold pb-1 pl-3">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...n.xml_duplicata]
                                  .sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? "") || a.id.localeCompare(b.id))
                                  .map((d) => (
                                    <tr key={d.id}>
                                      <td className="py-0.5">{d.numero ?? "—"}</td>
                                      <td className="py-0.5">{formatarData(d.vencimento)}</td>
                                      <td className="py-0.5 text-right">{formatarMoeda(d.valor)}</td>
                                      <td className="py-0.5 pl-3">
                                        <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px]">{d.status}</span>
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
