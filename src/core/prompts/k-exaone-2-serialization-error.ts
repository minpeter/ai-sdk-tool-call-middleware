export const K_EXAONE_2_MAX_NESTING_DEPTH = 256;
export const K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS = 100_000;

export type KExaone2SerializationFailure = "cycle" | "depth" | "size";

export class KExaone2SerializationError extends Error {
  readonly reason: KExaone2SerializationFailure;

  constructor(reason: KExaone2SerializationFailure) {
    const detail = {
      cycle: "contains a cycle",
      depth: `exceeds ${K_EXAONE_2_MAX_NESTING_DEPTH} nested containers`,
      size: `exceeds ${K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS} work items`,
    }[reason];
    super(`K-EXAONE native JSON ${detail}`);
    this.name = "KExaone2SerializationError";
    this.reason = reason;
  }
}
