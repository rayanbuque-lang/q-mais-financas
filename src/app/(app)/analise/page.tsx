"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
}

interface Insight {
  icone: string;
  titulo: string;
  descricao: string;
  tipo: "positivo" | "negativo" | "neutro" | "alerta";
}

const meses = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

export default function AnalisePage() {
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  async function gerarInsights() {
    setLoading(true);

    const mesAtualInicio = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const mesAtualFim = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(new Date(ano, mes + 1, 0).getDate()).padStart(2, "0")}`;

    // Mês anterior
    let mesAnt = mes - 1;
    let anoAnt = ano;
    if (mesAnt < 0) { mesAnt = 11; anoAnt = ano - 1; }
    const mesAntInicio = `${anoAnt}-${String(mesAnt + 1).padStart(2, "0")}-01`;
    const mesAntFim = `${anoAnt}-${String(mesAnt + 1).padStart(2, "0")}-${String(new Date(anoAnt, mesAnt + 1, 0).getDate()).padStart(2, "0")}`;

    // Ano anterior (mesmo mês)
    const anoAnteriorInicio = `${ano - 1}-${String(mes + 1).padStart(2, "0")}-01`;
    const anoAnteriorFim = `${ano - 1}-${String(mes + 1).padStart(2, "0")}-${String(new Date(ano - 1, mes + 1, 0).getDate()).padStart(2, "0")}`;

    // Buscar dados
    const movAtual = await fetchAllRows<Movimentacao>((from, to) =>
      supabase.from("movimentacoes").select("*").gte("data", mesAtualInicio).lte("data", mesAtualFim).range(from, to)
    );

    const movAnterior = await fetchAllRows<Movimentacao>((from, to) =>
      supabase.from("movimentacoes").select("*").gte("data", mesAntInicio).lte("data", mesAntFim).range(from, to)
    );

    const movAnoAnterior = await fetchAllRows<Movimentacao>((from, to) =>
      supabase.from("movimentacoes").select("*").gte("data", anoAnteriorInicio).lte("data", anoAnteriorFim).range(from, to)
    );

    const { data: catsEntrada } = await supabase
      .from("categorias_entrada").select("*").eq("ativo", true);

    const { data: catsSaida } = await supabase
      .from("categorias_saida").select("*").eq("ativo", true);

    if (!movAtual) { setLoading(false); return; }

    const novosInsights: Insight[] = [];

    // Totais mês atual
    const entradasAtual = movAtual.filter((m) => m.tipo === "entrada").reduce((acc, m) => acc + m.valor, 0);
    const saidasAtual = movAtual.filter((m) => m.tipo === "saida").reduce((acc, m) => acc + m.valor, 0);
    const resultadoAtual = entradasAtual - saidasAtual;
    const margemAtual = entradasAtual > 0 ? (resultadoAtual / entradasAtual) * 100 : 0;

    // Totais mês anterior
    const entradasAnterior = (movAnterior || []).filter((m) => m.tipo === "entrada").reduce((acc, m) => acc + m.valor, 0);
    const saidasAnterior = (movAnterior || []).filter((m) => m.tipo === "saida").reduce((acc, m) => acc + m.valor, 0);
    const resultadoAnterior = entradasAnterior - saidasAnterior;
    const margemAnterior = entradasAnterior > 0 ? (resultadoAnterior / entradasAnterior) * 100 : 0;

    // Totais ano anterior
    const entradasAnoAnt = (movAnoAnterior || []).filter((m) => m.tipo === "entrada").reduce((acc, m) => acc + m.valor, 0);
    const saidasAnoAnt = (movAnoAnterior || []).filter((m) => m.tipo === "saida").reduce((acc, m) => acc + m.valor, 0);

    // Insight: Resumo geral
    if (movAtual.length > 0) {
      novosInsights.push({
        icone: "📊",
        titulo: "Resumo do Mês",
        descricao: `Você registrou ${movAtual.length} movimentações em ${meses[mes]}. Receita de ${formatarMoeda(entradasAtual)} contra ${formatarMoeda(saidasAtual)} em despesas.`,
        tipo: "neutro",
      });
    }

    // Insight: Faturamento vs mês anterior
    if (entradasAnterior > 0) {
      const variacao = ((entradasAtual - entradasAnterior) / entradasAnterior) * 100;
      if (variacao > 0) {
        novosInsights.push({
          icone: "📈",
          titulo: "Faturamento em alta",
          descricao: `O faturamento cresceu ${variacao.toFixed(1)}% em relação a ${meses[mesAnt]}.`,
          tipo: "positivo",
        });
      } else if (variacao < 0) {
        novosInsights.push({
          icone: "📉",
          titulo: "Faturamento em queda",
          descricao: `O faturamento caiu ${Math.abs(variacao).toFixed(1)}% em relação a ${meses[mesAnt]}.`,
          tipo: "negativo",
        });
      }
    }

    // Insight: Faturamento vs ano anterior
    if (entradasAnoAnt > 0) {
      const variacaoAno = ((entradasAtual - entradasAnoAnt) / entradasAnoAnt) * 100;
      if (variacaoAno > 0) {
        novosInsights.push({
          icone: "📅",
          titulo: "Comparativo anual positivo",
          descricao: `O faturamento cresceu ${variacaoAno.toFixed(1)}% em relação ao mesmo mês de ${ano - 1}.`,
          tipo: "positivo",
        });
      } else if (variacaoAno < 0) {
        novosInsights.push({
          icone: "📅",
          titulo: "Comparativo anual negativo",
          descricao: `O faturamento está ${Math.abs(variacaoAno).toFixed(1)}% abaixo do mesmo mês de ${ano - 1}.`,
          tipo: "negativo",
        });
      }
    }

    // Insight: Margem
    if (margemAnterior !== 0 && entradasAtual > 0) {
      const variacaoMargem = margemAtual - margemAnterior;
      if (variacaoMargem > 0) {
        novosInsights.push({
          icone: "✅",
          titulo: "Margem melhorou",
          descricao: `A margem de lucro subiu de ${margemAnterior.toFixed(1)}% para ${margemAtual.toFixed(1)}% (variação de ${variacaoMargem.toFixed(1)} pontos).`,
          tipo: "positivo",
        });
      } else if (variacaoMargem < 0) {
        novosInsights.push({
          icone: "⚠️",
          titulo: "Margem caiu",
          descricao: `A margem caiu de ${margemAnterior.toFixed(1)}% para ${margemAtual.toFixed(1)}% (queda de ${Math.abs(variacaoMargem).toFixed(1)} pontos).`,
          tipo: "alerta",
        });
      }
    }

    // Insight: Despesas vs mês anterior
    if (saidasAnterior > 0) {
      const variacaoDesp = ((saidasAtual - saidasAnterior) / saidasAnterior) * 100;
      if (variacaoDesp > 10) {
        novosInsights.push({
          icone: "🔴",
          titulo: "Despesas aumentaram",
          descricao: `As despesas cresceram ${variacaoDesp.toFixed(1)}% em relação a ${meses[mesAnt]}. Atenção!`,
          tipo: "negativo",
        });
      } else if (variacaoDesp < -5) {
        novosInsights.push({
          icone: "💚",
          titulo: "Despesas reduzidas",
          descricao: `As despesas diminuíram ${Math.abs(variacaoDesp).toFixed(1)}% em relação a ${meses[mesAnt]}. Bom trabalho!`,
          tipo: "positivo",
        });
      }
    }

    // Insight: Maior categoria de receita
    if (catsEntrada && entradasAtual > 0) {
      const categoriasEntrada = catsEntrada.map((cat) => {
        const total = movAtual
          .filter((m) => m.tipo === "entrada" && m.categoria_id === cat.id)
          .reduce((acc, m) => acc + m.valor, 0);
        return { nome: cat.nome, total };
      }).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);

      if (categoriasEntrada.length > 0) {
        const maior = categoriasEntrada[0];
        const percentual = (maior.total / entradasAtual) * 100;
        novosInsights.push({
          icone: "💰",
          titulo: "Principal fonte de receita",
          descricao: `${maior.nome} representa ${percentual.toFixed(1)}% da receita (${formatarMoeda(maior.total)}).`,
          tipo: percentual > 50 ? "alerta" : "neutro",
        });
      }
    }

    // Insight: Maior categoria de despesa
    if (catsSaida && saidasAtual > 0) {
      const categoriasSaida = catsSaida.map((cat) => {
        const total = movAtual
          .filter((m) => m.tipo === "saida" && m.categoria_id === cat.id)
          .reduce((acc, m) => acc + m.valor, 0);
        return { nome: cat.nome, total };
      }).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);

      if (categoriasSaida.length > 0) {
        const maior = categoriasSaida[0];
        const percentual = (maior.total / saidasAtual) * 100;
        novosInsights.push({
          icone: "🏷️",
          titulo: "Maior despesa do mês",
          descricao: `${maior.nome} representa ${percentual.toFixed(1)}% das despesas (${formatarMoeda(maior.total)}).`,
          tipo: percentual > 40 ? "alerta" : "neutro",
        });
      }
    }

    // Insight: Categorias com aumento significativo
    if (catsSaida && movAnterior && movAnterior.length > 0) {
      catsSaida.forEach((cat) => {
        const totalAtual = movAtual
          .filter((m) => m.tipo === "saida" && m.categoria_id === cat.id)
          .reduce((acc, m) => acc + m.valor, 0);

        const totalAnt = (movAnterior || [])
          .filter((m) => m.tipo === "saida" && m.categoria_id === cat.id)
          .reduce((acc, m) => acc + m.valor, 0);

        if (totalAnt > 0 && totalAtual > 0) {
          const variacao = ((totalAtual - totalAnt) / totalAnt) * 100;
          if (variacao > 20) {
            novosInsights.push({
              icone: "🔺",
              titulo: `${cat.nome} em alta`,
              descricao: `Os gastos com ${cat.nome} aumentaram ${variacao.toFixed(1)}% em relação ao mês anterior.`,
              tipo: "alerta",
            });
          }
        }
      });
    }

    // Insight: Lucro ou prejuízo
    if (entradasAtual > 0) {
      if (resultadoAtual > 0) {
        novosInsights.push({
          icone: "🎯",
          titulo: "Mês com lucro",
          descricao: `Lucro líquido de ${formatarMoeda(resultadoAtual)} com margem de ${margemAtual.toFixed(1)}%.`,
          tipo: "positivo",
        });
      } else if (resultadoAtual < 0) {
        novosInsights.push({
          icone: "🚨",
          titulo: "Mês com prejuízo",
          descricao: `Prejuízo de ${formatarMoeda(Math.abs(resultadoAtual))}. Despesas superaram a receita.`,
          tipo: "negativo",
        });
      }
    }

    // Insight: Dica baseada nos dados
    if (saidasAtual > 0 && entradasAtual > 0) {
      const razao = saidasAtual / entradasAtual;
      if (razao > 0.9 && razao <= 1) {
        novosInsights.push({
          icone: "💡",
          titulo: "Atenção ao equilíbrio",
          descricao: "Suas despesas estão muito próximas da receita. Considere reduzir gastos ou aumentar a receita.",
          tipo: "alerta",
        });
      } else if (razao > 1) {
        novosInsights.push({
          icone: "🚨",
          titulo: "Gastando mais do que entra",
          descricao: "Suas despesas superam a receita. Isso não é sustentável a longo prazo.",
          tipo: "negativo",
        });
      }
    }

    // Insight: Sem dados
    if (movAtual.length === 0) {
      novosInsights.push({
        icone: "📭",
        titulo: "Sem movimentações",
        descricao: `Nenhuma movimentação registrada em ${meses[mes]} de ${ano}. Cadastre suas entradas e saídas para gerar análises.`,
        tipo: "neutro",
      });
    }

    setInsights(novosInsights);
    setLoading(false);
  }

  useEffect(() => {
    gerarInsights();
  }, [mes, ano]);

  function formatarMoeda(valor: number) {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function mesAnterior() {
    if (mes === 0) { setMes(11); setAno(ano - 1); }
    else setMes(mes - 1);
  }

  function mesProximo() {
    if (mes === 11) { setMes(0); setAno(ano + 1); }
    else setMes(mes + 1);
  }

  function corTipo(tipo: string) {
    switch (tipo) {
      case "positivo":
        return "bg-[var(--color-primary-light)] border-[var(--color-primary)]";
      case "negativo":
        return "bg-red-50 border-[var(--color-danger)]";
      case "alerta":
        return "bg-amber-50 border-amber-400";
      default:
        return "bg-[var(--color-surface)] border-[var(--color-border)]";
    }
  }

  function corTitulo(tipo: string) {
    switch (tipo) {
      case "positivo":
        return "text-[var(--color-primary-dark)]";
      case "negativo":
        return "text-[var(--color-danger)]";
      case "alerta":
        return "text-amber-700";
      default:
        return "text-[var(--color-text)]";
    }
  }

  const positivos = insights.filter((i) => i.tipo === "positivo");
  const negativos = insights.filter((i) => i.tipo === "negativo");
  const alertas = insights.filter((i) => i.tipo === "alerta");
  const neutros = insights.filter((i) => i.tipo === "neutro");

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-bold">Análise Inteligente</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          O sistema interpreta seus dados e gera observações automáticas
        </p>
      </div>

      {/* Seletor de mês */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">
          ← Anterior
        </button>
        <div className="text-center">
          <p className="font-semibold capitalize">{meses[mes]}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{ano}</p>
        </div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">
          Próximo →
        </button>
      </div>

      {/* Resumo visual */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[var(--color-primary-light)] rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-primary)]">{positivos.length}</p>
          <p className="text-xs text-[var(--color-primary-dark)]">Positivos</p>
        </div>
        <div className="bg-red-50 rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-danger)]">{negativos.length}</p>
          <p className="text-xs text-[var(--color-danger)]">Negativos</p>
        </div>
        <div className="bg-amber-50 rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-amber-600">{alertas.length}</p>
          <p className="text-xs text-amber-700">Alertas</p>
        </div>
        <div className="bg-[var(--color-bg)] rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-text-muted)]">{neutros.length}</p>
          <p className="text-xs text-[var(--color-text-muted)]">Informativos</p>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-[var(--color-text-muted)]">
          Analisando dados...
        </div>
      )}

      {/* Insights */}
      {!loading && insights.length > 0 && (
        <div className="space-y-3">
          {insights.map((insight, index) => (
            <div
              key={index}
              className={`rounded-2xl border p-5 ${corTipo(insight.tipo)}`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl mt-0.5">{insight.icone}</span>
                <div>
                  <h3 className={`font-semibold ${corTitulo(insight.tipo)}`}>
                    {insight.titulo}
                  </h3>
                  <p className="text-sm text-[var(--color-text)] mt-1">
                    {insight.descricao}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Rodapé */}
      {!loading && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            As análises são geradas automaticamente com base nos seus lançamentos.
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            Quanto mais dados, mais precisa será a análise.
          </p>
        </div>
      )}
    </div>
  );
}
