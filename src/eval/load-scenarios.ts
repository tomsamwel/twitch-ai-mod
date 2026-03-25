import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { normalizeScenarioFile, scenarioInputSchema, type ScenarioFile } from "./scenario-schema.js";

async function walkYamlFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.resolve(rootDir, entry.name);

      if (entry.isDirectory()) {
        return walkYamlFiles(entryPath);
      }

      if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

export interface LoadedScenario {
  path: string;
  suite: string;
  scenario: ScenarioFile;
}

export async function loadScenarios(
  scenariosRootDir: string,
  filters: {
    suite?: string;
    scenarioId?: string;
  } = {},
): Promise<LoadedScenario[]> {
  const files = await walkYamlFiles(scenariosRootDir);
  const loadedScenarios = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(scenariosRootDir, filePath);
      const raw = await readFile(filePath, "utf8");
      const parsed = YAML.parse(raw) as unknown;
      const scenario = normalizeScenarioFile(scenarioInputSchema.parse(parsed));
      const suite = relativePath.split(path.sep)[0] ?? "default";

      return {
        path: filePath,
        suite,
        scenario,
      };
    }),
  );

  return loadedScenarios.filter(({ suite, scenario }) => {
    if (filters.suite && filters.suite !== suite) {
      return false;
    }

    if (filters.scenarioId && filters.scenarioId !== scenario.id) {
      return false;
    }

    return true;
  });
}
