// Fórmula de score — seção 5.1 da spec.
// Score = C × (0,35·I_abs + 0,25·I_rel + 0,25·D + 0,15·P) × 100
import type { ClasseAchado } from "./tipos";

export interface ParametrosScore {
  deltaAbsoluto: number; // sempre positivo (módulo)
  pisoReais: number;
  receitaDoMes: number; // denominador de I_rel — sempre movimentacoes entrada (seção 2)
  desvioNormalizado: number; // D, já em [0,1] (ver estatistica.ts)
  mesesConsecutivos: number; // pra persistência; 0 se não aplicável/não calculável
  confianca: number; // C, multiplicador 0,4 / 0,7 / 1,0
}

/** Score abaixo disso não vira achado — nem no relatório, nem em "ver todos". */
export const SCORE_MINIMO_RELEVANTE = 15;

export const PESO_I_ABS = 0.35;
export const PESO_I_REL = 0.25;
export const PESO_D = 0.25;
export const PESO_P = 0.15;

export function calcularImpactoAbsoluto(deltaAbsoluto: number, pisoReais: number): number {
  if (pisoReais <= 0) return deltaAbsoluto > 0 ? 1 : 0;
  return Math.min(Math.abs(deltaAbsoluto) / pisoReais, 1);
}

export function calcularImpactoRelativo(deltaAbsoluto: number, receitaDoMes: number): number {
  if (receitaDoMes <= 0) return 0;
  return Math.min((Math.abs(deltaAbsoluto) / receitaDoMes) * 10, 1);
}

export function calcularPersistencia(mesesConsecutivos: number): number {
  return Math.min(mesesConsecutivos / 3, 1);
}

export function calcularScore(p: ParametrosScore): number {
  const iAbs = calcularImpactoAbsoluto(p.deltaAbsoluto, p.pisoReais);
  const iRel = calcularImpactoRelativo(p.deltaAbsoluto, p.receitaDoMes);
  const persistencia = calcularPersistencia(p.mesesConsecutivos);
  const base = PESO_I_ABS * iAbs + PESO_I_REL * iRel + PESO_D * p.desvioNormalizado + PESO_P * persistencia;
  return Math.round(p.confianca * base * 100 * 10) / 10; // 1 casa decimal
}

/** Classifica um achado por score + sinal da variação (favorável/desfavorável). */
export function classificarAchado(score: number, favoravel: boolean): ClasseAchado {
  if (favoravel) return score >= 50 ? "oportunidade" : "observacao";
  if (score >= 70) return "critico";
  if (score >= 50) return "atencao";
  return "observacao";
}
