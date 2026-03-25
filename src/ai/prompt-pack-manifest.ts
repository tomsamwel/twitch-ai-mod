import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import type { ConfigSnapshot } from "../types.js";

const promptPackManifestSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hypothesis: z.string().min(1),
  baselinePack: z.string().min(1).optional(),
});

export type PromptPackManifest = z.infer<typeof promptPackManifestSchema>;

export async function loadPromptPackManifest(
  config: Pick<ConfigSnapshot, "paths">,
  packName: string,
): Promise<PromptPackManifest> {
  const manifestPath = path.resolve(config.paths.promptPacksDir, packName, "pack.yaml");

  try {
    const raw = await readFile(manifestPath, "utf8");
    return promptPackManifestSchema.parse(YAML.parse(raw));
  } catch {
    return {
      id: packName,
      label: packName,
      hypothesis: `Comparison manifest not yet defined for ${packName}.`,
    };
  }
}
