export type TimingObserver = (phase: string, elapsedMs: number) => void;

/** Coarse wall timing: Workers clocks advance around I/O, not synchronous CPU. */
export async function measured<T>(observe: TimingObserver | undefined, phase: string, run: () => Promise<T>): Promise<T> {
  if (!observe) return run();
  const started = Date.now();
  try { return await run(); }
  finally { observe(phase, Date.now() - started); }
}

export function timingRecorder() {
  const phases: Record<string, number> = {};
  const observe: TimingObserver = (phase, elapsedMs) => { phases[phase] = (phases[phase] || 0) + Math.max(0, elapsedMs); };
  return { phases, observe };
}
