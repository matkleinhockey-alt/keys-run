/**
 * Golden comparison for a value that goes through `Math.sin`/`Math.cos`.
 *
 * These were `toBe` — bit equality — and that is not a contract any platform can keep. The
 * transcendentals are not required to be correctly rounded, and V8 does not compute them the
 * same way on arm64 as on x64, so a golden generated on one machine is a last-ulp mismatch on
 * the other. CI has been red on every push to main for months over exactly three assertions
 * (`depthAt` and the two `waveHBase` goldens), all of them differing in the final digit:
 * 3.7592300469412008 against 3.7592300469412003.
 *
 * A relative 1e-12 is four orders of magnitude above that noise and still far below anything a
 * real change could hide in — a reordered term or a changed coefficient moves these by parts in
 * a thousand, not parts in a trillion. The fidelity the test exists to protect is intact; what
 * is gone is a claim about floating-point determinism across architectures that was never true.
 */
export function expectGolden(actual: number, expected: number, what: string): void {
  const tol = Math.max(Math.abs(expected), 1) * 1e-12;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: expected ${expected}, got ${actual} (differs by ${Math.abs(actual - expected)}, tolerance ${tol})`);
  }
}
