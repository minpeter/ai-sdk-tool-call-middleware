import { createHash } from "node:crypto";

export interface IdentifiedArm {
  id: string;
}

export interface PairedResumeKeys {
  glm5Key: string;
  identity: string;
  nativeKey: string;
}

export function assertPairedResumeSymmetry(options: {
  completed: ReadonlySet<string>;
  pairs: readonly PairedResumeKeys[];
}): void {
  const asymmetric = options.pairs.filter(
    ({ glm5Key, nativeKey }) =>
      options.completed.has(nativeKey) !== options.completed.has(glm5Key)
  );
  if (asymmetric.length > 0) {
    throw new Error(
      "Cannot resume paired benchmark with asymmetric native/glm5 completion; " +
        `restart in a fresh output directory. Affected pairs: ${asymmetric
          .slice(0, 5)
          .map((pair) => pair.identity)
          .join(", ")}${asymmetric.length > 5 ? " …" : ""}`
    );
  }
}

export function hasNativeGlm5Pair(arms: readonly IdentifiedArm[]): boolean {
  const ids = new Set(arms.map((arm) => arm.id));
  return ids.has("native") && ids.has("glm5");
}

export function pairedArmOrder<T extends IdentifiedArm>(
  arms: readonly T[],
  seed: number,
  jobIdentity: string
): T[] {
  const native = arms.find((arm) => arm.id === "native");
  const glm5 = arms.find((arm) => arm.id === "glm5");
  if (!(native && glm5)) {
    return [...arms];
  }
  const [firstByte = 0] = createHash("sha256")
    .update(`${seed}\u0000${jobIdentity}`)
    .digest();
  const pair =
    firstByte % 2 === 0 ? ([native, glm5] as const) : ([glm5, native] as const);
  return [...pair, ...arms.filter((arm) => arm !== native && arm !== glm5)];
}

/**
 * Build worker-sized batches.  The paired arms deliberately share one batch so
 * a worker awaits the first arm before starting the second.  Other arms remain
 * independently schedulable one-job batches.
 */
export function pairedArmBatches<T extends IdentifiedArm>(
  arms: readonly T[],
  seed: number,
  jobIdentity: string
): T[][] {
  const ordered = pairedArmOrder(arms, seed, jobIdentity);
  if (!hasNativeGlm5Pair(arms)) {
    return ordered.map((arm) => [arm]);
  }
  return [ordered.slice(0, 2), ...ordered.slice(2).map((arm) => [arm])];
}
