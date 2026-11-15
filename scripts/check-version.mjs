import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 校验发布标签与插件版本一致：
 *   node scripts/check-version.mjs v1.2.1
 * 标签必须形如 vX.Y.Z，并与 src/plugin.js 的 @version、package.json 的 version 相同。
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = (process.argv[2] ?? "").trim();

try {
  if (!tag) throw new Error("用法：node scripts/check-version.mjs vX.Y.Z");

  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) throw new Error(`标签格式无效：${tag}（期望 vX.Y.Z）`);
  const tagVersion = match[1];

  const [pluginSource, packageJson] = await Promise.all([
    readFile(resolve(projectRoot, "src", "plugin.js"), "utf8"),
    readFile(resolve(projectRoot, "package.json"), "utf8"),
  ]);

  const pluginVersion = /@version\s+(\S+)/.exec(pluginSource)?.[1];
  const packageVersion = JSON.parse(packageJson).version;

  if (!pluginVersion) throw new Error("src/plugin.js 缺少 @version 声明");
  if (pluginVersion !== tagVersion) {
    throw new Error(`标签 ${tag} 与插件 @version ${pluginVersion} 不一致`);
  }
  if (packageVersion !== tagVersion) {
    throw new Error(`标签 ${tag} 与 package.json version ${packageVersion} 不一致`);
  }

  process.stdout.write(`Verified release version: ${tag}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
