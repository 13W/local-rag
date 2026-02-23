export function timeDecay(createdAt: string, halfLifeDays = 7.0): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / 86_400_000;
  return Math.pow(2, -(ageDays / halfLifeDays));
}

export function finalScore(
  cosineSim: number,
  createdAt: string,
  importance: number,
  applyDecay: boolean
): number {
  const decay = applyDecay ? timeDecay(createdAt) : 1.0;
  return cosineSim * (0.5 + 0.5 * decay) * (0.7 + 0.3 * importance);
}
