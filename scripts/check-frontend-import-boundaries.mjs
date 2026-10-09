import { readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import ts from "typescript";

const repositoryRoot = process.cwd();
const sourceRoot = resolve(repositoryRoot, "src");
const configFile = ts.readConfigFile(resolve(repositoryRoot, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}
const compilerOptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot).options;

function sourceLayer(filePath) {
  const parts = relative(sourceRoot, filePath).split(sep);
  if (parts[0] === "features" && parts.length > 1) return { name: "feature", feature: parts[1] };
  if (["app", "pages", "api", "shared"].includes(parts[0])) return { name: parts[0] };
  return { name: "other" };
}

function isPublicFeatureEntry(filePath) {
  const parts = relative(sourceRoot, filePath).split(sep);
  return parts[0] === "features" && parts.length === 3 && /^index\.tsx?$/.test(parts[2]);
}

function isTypeOnlyDeclaration(node) {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return Boolean(
    clause.namedBindings
    && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function boundaryViolation(importer, imported) {
  const from = sourceLayer(importer);
  const to = sourceLayer(imported);
  if (from.name === "feature") {
    if (to.name === "app" || to.name === "pages") return "features cannot depend on app or page modules";
    if (to.name === "feature" && to.feature !== from.feature && !isPublicFeatureEntry(imported)) {
      return "features must import another feature through its index.ts public API";
    }
    return undefined;
  }
  if (from.name === "pages") {
    if (to.name === "app" || to.name === "pages") return "pages cannot depend on app or other page modules";
    if (to.name === "feature" && !isPublicFeatureEntry(imported)) return "pages must import a feature through its index.ts public API";
    return undefined;
  }
  if (from.name === "api" && ["app", "pages", "feature"].includes(to.name)) {
    return "api modules cannot depend on app, pages, or features";
  }
  if (from.name === "shared" && ["app", "pages", "api", "feature"].includes(to.name)) {
    return "shared modules cannot depend on app, pages, api, or features";
  }
  if (from.name === "app" && to.name === "feature" && !isPublicFeatureEntry(imported)) {
    return "app modules must import a feature through its index.ts public API";
  }
  return undefined;
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) return [entryPath];
    return [];
  }));
  return nested.flat();
}

function moduleSpecifiers(sourceFile) {
  const result = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push({ specifier: node.moduleSpecifier.text, node: node.moduleSpecifier, typeOnly: isTypeOnlyDeclaration(node) });
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      result.push({ specifier: node.arguments[0].text, node: node.arguments[0], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

const violations = [];
for (const filePath of await listSourceFiles(sourceRoot)) {
  const text = await ts.sys.readFile(filePath);
  if (text === undefined) continue;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  for (const { specifier, node, typeOnly } of moduleSpecifiers(sourceFile)) {
    const resolved = ts.resolveModuleName(specifier, filePath, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    if (!resolved) continue;
    const importedPath = resolve(resolved);
    if (!importedPath.startsWith(`${sourceRoot}${sep}`)) continue;
    const reason = sourceLayer(filePath).name === "pages" && sourceLayer(importedPath).name === "api" && !typeOnly
      ? "pages may use API contract types but cannot call API runtime modules"
      : boundaryViolation(filePath, importedPath);
    if (!reason) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${relative(repositoryRoot, filePath)}:${line + 1}: ${reason} (${specifier})`);
  }
}

if (violations.length > 0) {
  console.error("Frontend import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Frontend import boundaries passed.");
}
