import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { BOT_CWD, logger } from "mioku";
import { projectRoot } from "./utils";

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
  const root = projectRoot();
  return loadConfigPage(pluginName, `mioku-plugin-${pluginName}`, [
    path.join(root, "plugins", pluginName),
    path.join(root, "node_modules", `mioku-plugin-${pluginName}`),
  ]);
}

export function loadServiceConfigPage(serviceName: string): ConfigPageManifest | null {
  const root = projectRoot();
  return loadConfigPage(serviceName, `mioku-service-${serviceName}`, [
    path.join(root, "services", serviceName),
    path.join(root, "node_modules", `mioku-service-${serviceName}`),
  ]);
}

export function loadAdapterConfigPage(adapterName: string): ConfigPageManifest | null {
  return loadConfigPage(adapterName, `mioku-adapter-${adapterName}`, [
    path.join(projectRoot(), "node_modules", `mioku-adapter-${adapterName}`),
  ]);
}

/** 从机器人根目录按 node_modules 依赖解析包真实目录（pnpm / 提升安装等布局） */
function resolvePackageDir(root: string, packageName: string): string | null {
  const require = createRequire(path.join(root, "package.json"));
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    // exports 未暴露 package.json 时，从入口文件向上找
  }
  try {
    let dir = path.dirname(require.resolve(packageName));
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // 未安装该依赖
  }
  return null;
}

function loadConfigPage(
  packageName: string,
  npmName: string,
  possiblePaths: string[],
): ConfigPageManifest | null {
  const resolved = resolvePackageDir(projectRoot(), npmName);
  const candidates =
    resolved && !possiblePaths.includes(resolved)
      ? [...possiblePaths, resolved]
      : possiblePaths;
  let configMdPath: string | null = null;
  let packageDir: string | null = null;

  for (const dir of candidates) {
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
