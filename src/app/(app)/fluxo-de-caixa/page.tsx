"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
  observacao: string;
}

interface DiaResumo {
  data: string;
  dataFormatada: string;
  diaSemana: string;
  entradas: number;
  saidas: number;
  saldo: number;
}

interface SemanaResumo {
  label: string;
  entradas: number;
  saidas: number;
  saldo: number;
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export default function FluxoDeCaixaPage() {
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [visualizacao, setVisualizacao] = useState<"diario" | "semanal" | "mensal">("mensal");
  const [movimentacoes, setMovimentacoes] = useState<Movimentacao[]>([]);
  const supabase = createClient();

  async function carregarDados() {
    const inicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const fim = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;

    const { data } = await supabase
      .from("movimentacoes")
      .select("*")
      .gte("data", inicio)
      .lte("data", fim)
      .order("data", { ascending: true });

    if (data) setMovimentacoes(data);
  }

  useEffect(() => {
    carregarDados();
  }, [mes, ano]);

  function formatarMoeda(valor: number) {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function mesAnterior() {
    if (mes === 0) {
      setMes(11);
      setAno(ano - 1);
    } else {
      setMes(mes - 1);
    }
  }

  function mesProximo() {
    if (mes === 11) {
      setMes(0);
      setAno(ano + 1);
    } else {
      setMes(mes + 1);
    }
  }

  // Totais do mês
  const totalEntradas = movimentacoes
    .filter((m) => m.tipo === "entrada")
    .reduce((acc, m) => acc + m.valor, 0);

  const totalSaidas = movimentacoes
    .filter((m) => m.tipo === "saida")
    .reduce((acc, m) => acc + m.valor, 0);

  const saldoAtual = totalEntradas - totalSaidas;

  // Dados diários
  const dadosDiarios: DiaResumo[] = [];
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();

  for (let dia = 1; dia <= ultimoDia; dia++) {
    const dataStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const movsDoDia = movimentacoes.filter((m) => m.data === dataStr);
    const entradas = movsDoDia.filter((m) => m.tipo === "entrada").reduce((acc, m) => acc + m.valor, 0);
    const saidas = movsDoDia.filter((m) => m.tipo === "saida").reduce((acc, m) => acc + m.valor, 0);

    const dataObj = new Date(ano, mes, dia);
    dadosDiarios.push({
      data: dataStr,
      dataFormatada: `${String(dia).padStart(2, "0")}/${String(mes + 1).padStart(2, "0")}`,
      diaSemana: diasSemana[dataObj.getDay()],
      entradas,
      saidas,
      saldo: entradas - saidas,
    });
  }

  // Dados semanais
  const dadosSemanais: SemanaResumo[] = [];
  let semanaAtual: DiaResumo[] = [];
  let numSemana = 1;

  dadosDiarios.forEach((dia, index) => {
    semanaAtual.push(dia);
    const isUltimo = index === dadosDiarios.length - 1;
    const isSabado = new Date(ano, mes, index + 1).getDay() === 6;

    if (isSabado || isUltimo) {
      const entradas = semanaAtual.reduce((acc, d) => acc + d.entradas, 0);
      const saidas = semanaAtual.reduce((acc, d) => acc + d.saidas, 0);
      dadosSemanais.push({
        label: `Semana ${numSemana} (${semanaAtual[0].dataFormatada} a ${semanaAtual[semanaAtual.length - 1].dataFormatada})`,
        entradas,
        saidas,
        saldo: entradas - saidas,
      });
      numSemana++;
      semanaAtual = [];
    }
  });

  // Calcular saldo acumulado diário
  let saldoAcumulado = 0;
  const dadosDiariosAcumulados = dadosDiarios.map((dia) => {
    saldoAcumulado += dia.saldo;
    return { ...dia, saldoAcumulado };
  });

  // Saldo projetado (último saldo acumulado + média diária de receita * dias restantes)
  const diasComMovimento = dadosDiarios.filter((d) => d.entradas > 0 || d.saidas > 0).length;
  const mediaDiariaEntrada = diasComMovimento > 0 ? totalEntradas / diasComMovimento : 0;
  const mediaDiariaSaida = diasComMovimento > 0 ? totalSaidas / diasComMovimento : 0;
  const diasRestantes = ultimoDia - new Date().getDate();
  const saldoProjetado = saldoAtual + (mediaDiariaEntrada - mediaDiariaSaida) * Math.max(diasRestantes, 0);

  // Maior barra para escala visual
  const maxValor = Math.max(
    ...dadosDiarios.map((d) => Math.max(d.entradas, d.saidas)),
    1
  );

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-bold">Fluxo de Caixa</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          Entradas, saídas e saldos do período
        </p>
      </div>

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button
          onClick={mesAnterior}
          className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition"
        >
          ← Anterior
        </button>
        <div className="text-center">
          <p className="font-semibold capitalize">{meses[mes]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button
          onClick={mesProximo}
          className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition"
        >
          Próximo →
        </button>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-xs text-[var(--color-text-muted)]">Entradas</p>
          <p className="text-xl font-bold text-[var(--color-primary)] mt-1">{formatarMoeda(totalEntradas)}</p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-xs text-[var(--color-text-muted)]">Saídas</p>
          <p className="text-xl font-bold text-[var(--color-danger)] mt-1">{formatarMoeda(totalSaidas)}</p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-xs text-[var(--color-text-muted)]">Saldo Atual</p>
          <p className={`text-xl font-bold mt-1 ${saldoAtual >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
            {formatarMoeda(saldoAtual)}
          </p>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5">
          <p className="text-xs text-[var(--color-text-muted)]">Saldo Projetado</p>
          <p className={`text-xl font-bold mt-1 ${saldoProjetado >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
            {formatarMoeda(saldoProjetado)}
          </p>
          <p className="text-[10px] text-[var(--color-text-muted)] mt-1">Fim do mês</p>
        </div>
      </div>

      {/* Toggle visualização */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
        {(["diario", "semanal", "mensal"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVisualizacao(v)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium capitalize transition ${
              visualizacao === v
                ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]"
                : "text-[var(--color-text-muted)]"
            }`}
          >
            {v === "diario" ? "Diário" : v === "semanal" ? "Semanal" : "Mensal"}
          </button>
        ))}
      </div>

      {/* Visualização Mensal - resumo único */}
      {visualizacao === "mensal" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <h2 className="font-semibold mb-5">Resumo Mensal</h2>

          <div className="space-y-6">
            {/* Barra de entradas */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-[var(--color-text-muted)]">Total Entradas</span>
                <span className="font-semibold text-[var(--color-primary)]">{formatarMoeda(totalEntradas)}</span>
              </div>
              <div className="w-full h-6 bg-[var(--color-bg)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--color-primary)] rounded-full transition-all duration-700"
                  style={{ width: `${totalEntradas > 0 ? 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Barra de saídas */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-[var(--color-text-muted)]">Total Saídas</span>
                <span className="font-semibold text-[var(--color-danger)]">{formatarMoeda(totalSaidas)}</span>
              </div>
              <div className="w-full h-6 bg-[var(--color-bg)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--color-danger)] rounded-full transition-all duration-700"
                  style={{ width: `${totalEntradas > 0 ? (totalSaidas / totalEntradas) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Linha divisória */}
            <div className="border-t border-[var(--color-border)] pt-4">
              <div className="flex justify-between items-center">
                <span className="font-semibold">Saldo do Mês</span>
                <span className={`text-2xl font-bold ${saldoAtual >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
                  {formatarMoeda(saldoAtual)}
                </span>
              </div>
              <div className="flex justify-between items-center mt-3">
                <span className="text-sm text-[var(--color-text-muted)]">Projeção fim do mês</span>
                <span className={`text-lg font-bold ${saldoProjetado >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
                  {formatarMoeda(saldoProjetado)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Visualização Diária */}
      {visualizacao === "diario" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)]">
            <h2 className="font-semibold">Fluxo Diário</h2>
          </div>

          {movimentacoes.length === 0 ? (
            <EmptyState variant="movements" title="Nenhuma movimentação neste mês"
              description="Registre entradas e saídas para ver o fluxo diário." compact
              action={{ label: "Registrar", href: "/movimentacoes" }} />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {dadosDiariosAcumulados
                .filter((d) => d.entradas > 0 || d.saidas > 0)
                .map((dia) => (
                <div key={dia.data} className="p-4 hover:bg-[var(--color-bg)] transition">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-sm font-medium">{dia.dataFormatada}</span>
                      <span className="text-xs text-[var(--color-text-muted)] ml-2">{dia.diaSemana}</span>
                    </div>
                    <span className={`text-xs font-medium ${dia.saldoAcumulado >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
                      Acumulado: {formatarMoeda(dia.saldoAcumulado)}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Barra entrada */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[var(--color-text-muted)]">Entrada</span>
                        <span className="font-medium text-[var(--color-primary)]">{formatarMoeda(dia.entradas)}</span>
                      </div>
                      <div className="w-full h-3 bg-[var(--color-bg)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--color-primary)] rounded-full transition-all duration-500"
                          style={{ width: `${maxValor > 0 ? (dia.entradas / maxValor) * 100 : 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Barra saída */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[var(--color-text-muted)]">Saída</span>
                        <span className="font-medium text-[var(--color-danger)]">{formatarMoeda(dia.saidas)}</span>
                      </div>
                      <div className="w-full h-3 bg-[var(--color-bg)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--color-danger)] rounded-full transition-all duration-500"
                          style={{ width: `${maxValor > 0 ? (dia.saidas / maxValor) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Visualização Semanal */}
      {visualizacao === "semanal" && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[var(--color-border)]">
            <h2 className="font-semibold">Fluxo Semanal</h2>
          </div>

          {dadosSemanais.length === 0 ? (
            <EmptyState variant="movements" title="Nenhuma movimentação neste mês"
              description="Registre entradas e saídas para ver o fluxo semanal." compact
              action={{ label: "Registrar", href: "/movimentacoes" }} />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {dadosSemanais.map((semana, index) => (
                <div key={index} className="p-4 hover:bg-[var(--color-bg)] transition">
                  <p className="text-sm font-medium mb-3">{semana.label}</p>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)]">Entradas</p>
                      <p className="text-sm font-bold text-[var(--color-primary)]">{formatarMoeda(semana.entradas)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)]">Saídas</p>
                      <p className="text-sm font-bold text-[var(--color-danger)]">{formatarMoeda(semana.saidas)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)]">Saldo</p>
                      <p className={`text-sm font-bold ${semana.saldo >= 0 ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
                        {formatarMoeda(semana.saldo)}
                      </p>
                    </div>
                  </div>

                  {/* Barra comparativa */}
                  <div className="mt-3 flex gap-1 h-4">
                    <div
                      className="bg-[var(--color-primary)] rounded-l-full transition-all duration-500"
                      style={{
                        width: `${semana.entradas + semana.saidas > 0 ? (semana.entradas / (semana.entradas + semana.saidas)) * 100 : 50}%`,
                      }}
                    />
                    <div
                      className="bg-[var(--color-danger)] rounded-r-full transition-all duration-500"
                      style={{
                        width: `${semana.entradas + semana.saidas > 0 ? (semana.saidas / (semana.entradas + semana.saidas)) * 100 : 50}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
