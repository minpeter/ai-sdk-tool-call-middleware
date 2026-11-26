export type ToolResponseMediaType = "image" | "audio" | "video" | "file";

export interface ToolResponseMediaCapabilities {
  audio?: boolean;
  file?: boolean;
  image?: boolean;
  video?: boolean;
}

/**
 * How tool-result media (`content` parts) is projected into the next model
 * prompt.
 *
 * - `model` (default): forward canonical `text` / `file` parts to the model
 * - `placeholder`: degrade media to text placeholders (text-only fallback)
 * - `auto`: keep original content parts when `capabilities` enable the media
 *   kind; otherwise placeholder
 */
export type ToolResponseMediaMode = "placeholder" | "auto" | "model";

export interface ToolResponseMediaStrategy {
  capabilities?: ToolResponseMediaCapabilities;
  mode?: ToolResponseMediaMode;
}

export function getMediaMode(
  strategy?: ToolResponseMediaStrategy
): ToolResponseMediaMode {
  return strategy?.mode ?? "model";
}

export function getMediaKindFromMediaType(
  mediaType: string
): ToolResponseMediaType {
  if (mediaType.startsWith("image/") || mediaType === "image") {
    return "image";
  }
  if (mediaType.startsWith("audio/") || mediaType === "audio") {
    return "audio";
  }
  if (mediaType.startsWith("video/") || mediaType === "video") {
    return "video";
  }
  return "file";
}

export function shouldPassRawByStrategy(
  mediaKind: ToolResponseMediaType,
  strategy?: ToolResponseMediaStrategy
): boolean {
  const mode = getMediaMode(strategy);
  if (mode !== "auto") {
    return false;
  }

  return strategy?.capabilities?.[mediaKind] === true;
}
