export type BfclExample = {
  id: string;
  prompt: string;
  completion: string;
  // optional metadata from BFCL
  metadata?: Record<string, unknown>;
};

export type BfclDataset = BfclExample[];
