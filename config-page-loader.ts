import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { logger } from "mioki";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "switch" | "select" | "multi-select" | "secret" | "json" | "array";
  description?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  source?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: any;
  itemFields?: ConfigField[];
}

export interface ConfigPageManifest {
  plugin: string;
  title: string;
  description?: string;
  markdown: string;
  fields: ConfigField[];
  hasCustomPage: boolean;
}

export function loadPluginConfigPage(pluginName: string): ConfigPageManifest | null {
  const possiblePaths = [
    path.join(process.cwd(), "plugins", pluginName),
    path.join(process.cwd(), "node_modules", `mioku-plugin-${pluginName}`),
  ];

  return loadConfigPage(pluginName, possiblePaths);
}

export function loadServiceConfigPage(serviceName: string): ConfigPageManifest | null {
  const possiblePaths = [
    path.join(process.cwd(), "services", serviceName),
    path.join(process.cwd(), "node_modules", `mioku-service-${serviceName}`),
  ];

  return loadConfigPage(serviceName, possiblePaths);
}

function loadConfigPage(
  packageName: string,
  possiblePaths: string[],
): ConfigPageManifest | null {
  let configMdPath: string | null = null;
  let packageDir: string | null = null;

  for (const dir of possiblePaths) {
    const candidate = path.join(dir, "config.md");
    if (fs.existsSync(candidate)) {
      configMdPath = candidate;
      packageDir = dir;
      break;
    }
  }

  if (!configMdPath || !packageDir) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(configMdPath, "utf-8");
    const parsed = matter(fileContent);

    const frontmatter = parsed.data as any;
    const fields = (frontmatter.fields || []) as ConfigField[];

    for (const field of fields) {
      if (!field.key || !field.label || !field.type) {
        logger.warn(`Invalid field in ${packageName}/config.md: missing key, label, or type`);
        continue;
      }

      if (!field.key.includes(".")) {
        logger.warn(`Invalid field key in ${packageName}/config.md: ${field.key} (must be <configName>.<path>)`);
      }
    }

    return {
      plugin: packageName,
      title: frontmatter.title || `${packageName} Configuration`,
      description: frontmatter.description,
      markdown: parsed.content,
      fields,
      hasCustomPage: true,
    };
  } catch (error: any) {
    logger.error(`Failed to load config page for ${packageName}: ${error.message}`);
    return null;
  }
}

export function parseConfigKey(key: string): { configName: string; path: string } | null {
  const parts = key.split(".");
  if (parts.length < 2) {
    return null;
  }

  return {
    configName: parts[0],
    path: parts.slice(1).join("."),
  };
}

export function getValueByPath(obj: any, path: string): any {
  const keys = path.split(".");
  let current = obj;

  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

export function setValueByPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
}
