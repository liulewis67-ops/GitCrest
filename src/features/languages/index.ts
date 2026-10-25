export {
  getLanguageRegistry,
  languageById,
  languageForPath,
  reloadLanguagePlugins,
  useLanguageRegistry,
  type LanguagePluginStatus,
  type LanguageRegistrySnapshot,
} from "./model/language-registry";
export type { LanguageDefinition, LanguageSyntax } from "./model/builtin-languages";
export type { LineRange, SourceDeclaration, StructureKind } from "./model/structure-common";
/** The tree-sitter runtime stays out of the startup bundle until a parse is needed. */
export const loadGrammarModule = () => import("./model/grammar-loader");
export { LanguagesSection } from "./ui/LanguagesSection";
