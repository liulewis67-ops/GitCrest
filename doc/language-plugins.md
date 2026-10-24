# GitCrest 语言插件

语言插件为代码感知 Diff 增加一种语言：GitCrest 会按插件描述的函数、类型、规则等结构归组修改，并支持按结构选择与暂存。设计背景见 [代码感知 Diff](PRD-code-aware-diff.md)。

## 1. 内置语言

| 语言 | 文件 | 识别的结构 |
|---|---|---|
| JavaScript / JSX / TypeScript / TSX | `.js` `.mjs` `.cjs` `.jsx` `.ts` `.mts` `.cts` `.tsx` | 函数、类、方法、属性、接口、类型、枚举、常量、namespace、导入与导出 |
| Rust | `.rs` | fn、impl 及方法、trait、struct、enum、type、const/static、mod、宏、use |
| Python | `.py` `.pyi` `.pyw` | 类、方法（含装饰器）、函数、模块与类级赋值、import |
| Go | `.go` | 函数、方法（按接收者类型命名，如 `User.Load`）、struct、interface 及其方法、const/var、package 与 import |
| Java | `.java` | 类、record、接口、注解类型、枚举及其方法、方法、构造器、字段、package 与 import |
| C# | `.cs` `.csx` | namespace、类、record、struct、接口、枚举、委托、方法、构造器、析构器、运算符、属性、事件、字段、using |
| CSS | `.css` | 规则（按选择器命名）、`@media`/`@supports` 及其中的规则、`@keyframes`、其它 at-rule、`@import` |
| JSON | `.json` `.jsonc` `.json5` `.webmanifest` 等 | 嵌套的键，修改报告为“值” |
| Markdown | `.md` `.markdown` `.mdown` `.mkd` | 按标题划分的章节（ATX 与 Setext），跳过代码块与 front matter；修改报告为“内容” |

除 Markdown 外，内置语言均使用 tree-sitter 官方语法的 WebAssembly 版本。同一文件类型以内置语言为准。

## 2. 安装插件

1. 打开 **设置 → 语言 → 打开插件目录**。默认位置是应用数据目录下的 `language-plugins`；设置了环境变量 `GITCREST_LANGUAGE_PLUGINS_PATH` 时使用该目录。
2. 每个插件占一个子文件夹，内含：
   - `gitcrest-language.json`：清单，见第 3 节；
   - 清单中 `grammar` 指定的 tree-sitter 语法 `.wasm` 文件。
3. 点击 **重新加载插件**。列表会显示每个插件是“可用”，还是“未加载”及原因；不需要重启应用。

示例：[`examples/language-plugin-starlark`](examples/language-plugin-starlark/gitcrest-language.json)，用于 Bazel 的 BUILD 与 `.bzl` 文件，需要再放入一个 Starlark 或 Python 的 tree-sitter 语法。

## 3. 清单

```jsonc
{
  "schemaVersion": 1,              // 固定为 1
  "id": "starlark",                // 2–40 个小写字母、数字或连字符，以字母开头；不能与内置语言同名
  "name": "Starlark",              // 显示名称，最多 60 字符
  "version": "0.1.0",              // 显示用版本，最多 30 字符
  "extensions": ["bzl", "star"],   // 不带点，不区分大小写，最多 20 个
  "fileNames": ["BUILD.bazel"],    // 整个文件名，不区分大小写，最多 20 个；与 extensions 至少一项非空
  "grammar": "tree-sitter-starlark.wasm", // 插件文件夹内的文件，最大 32 MB
  "monacoLanguage": "python",      // 可选：高亮使用的 Monaco 语言；默认纯文本
  "structure": { … }               // 结构规则，见第 4 节
}
```

### 语法文件

`grammar` 是 tree-sitter 语法编译出的 WebAssembly，ABI 版本需在 13–16 之间。许多语法的 npm 包已附带 `.wasm`；没有的话，在语法仓库中运行：

```bash
npx tree-sitter-cli build --wasm
```

ABI 不兼容时，清单仍能读出，但设置中会显示“语法无法使用”及具体版本范围。

## 4. 结构规则

规则是纯数据：哪些语法节点是声明，以及如何读出名称、参数、返回类型和主体。可在 [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/7-playground.html) 中查看语法的节点类型与字段名。内置语言的规则见 [`builtin-languages.ts`](../src/features/languages/model/builtin-languages.ts)，可直接复制作为起点。

| 字段 | 含义 |
|---|---|
| `declarations` | 必填，1–300 条声明规则，每种节点类型最多一条 |
| `imports` | 导入、导出、包声明等节点类型；只在顶层生效，合并为一项“导入与导出” |
| `leading` | 紧贴声明上方、属于该声明的节点类型，如注释、属性 |
| `transparent` | 把子节点当作自身层级读取的节点类型，如 JSON 文档的 `object` |
| `wrappers` | 包裹声明的节点类型，如 Python 的 `decorated_definition`、Go 的 `type ( … )`。只包裹一个声明时，该声明使用包裹节点的范围，装饰器因此归属被装饰的函数 |

### 声明规则

| 字段 | 含义 |
|---|---|
| `node` | 必填，语法节点类型 |
| `kind` | 必填：`function` `method` `property` `variable` `constant` `class` `interface` `struct` `enum` `trait` `impl` `module` `type` `macro` `rule` `section` `key` |
| `name` | 读取名称，默认 `{ "path": [{ "field": "name" }] }`；读不到名称的节点会被忽略 |
| `kindFrom` | 按子节点类型选择种类，如 `{ "path": [{ "field": "type" }], "map": { "struct_type": "struct" } }` |
| `kindInside` | 位于某种结构内时改用的种类，如 `{ "class": "method" }` |
| `qualifier` | 写在名称前并用点连接，如 Go 方法的接收者类型 |
| `parameters` / `returnType` | 参数列表与返回类型节点的路径；用于“参数”“返回类型”变化标签 |
| `body` | 主体节点的路径；有 `parameters` 时，主体内的修改标为“函数体” |
| `members` | 为 `true` 时在 `body` 中继续查找嵌套声明，使该结构成为容器 |

**路径**是从声明节点出发的步骤列表（最多 6 步），每步为 `{ "field": "字段名" }` 或 `{ "child": "节点类型" }`（第一个该类型的命名子节点）；空列表表示声明节点本身。

**文本读取**（`name`、`qualifier`）可选字段：

- `pattern`：正则表达式，应用于空白折叠后的前 300 个字符；有捕获组时取第一个，否则取整个匹配；不匹配即视为无名。
- `unquote`：去掉一对外层引号。
- `prefix`：加在名称前，如 `"@keyframes "`。

名称最长 120 字符，超出时截断。同一容器内同名同种类的声明按出现次序编号，这类结构只报告变更行，不判断新增、删除或签名变化。

## 5. 安全与限制

- 插件不能执行 JavaScript：清单是数据，语法在 WebAssembly 沙箱中运行，只接收文件文本，不访问磁盘或网络。
- 主进程只读取插件目录；语法文件必须位于插件文件夹内（解析符号链接后检查），清单最大 256 KB，语法最大 32 MB，最多 50 个插件。
- 渲染进程在使用前校验全部规则；未知字段、非法种类、无效正则或超出限制都会使插件显示为“未加载”及具体位置。
- 结构信息只用于组织与描述修改；暂存仍以 Git 的真实变更行为准，插件规则不会改变写入 index 的内容。

## 6. 排查

| 现象 | 处理 |
|---|---|
| 设置中没有出现插件 | 确认清单文件名为 `gitcrest-language.json`，位于插件目录的子文件夹中，然后重新加载 |
| “未加载”：某字段无效 | 按提示修改清单或规则；提示会给出字段路径，如 `structure.declarations[1].kind` |
| “语法无法使用” | 语法的 ABI 版本不在 13–16 范围，或文件不是 tree-sitter 语法；用兼容版本的 tree-sitter CLI 重新构建 |
| 结构列表为空或缺项 | 节点类型或字段名与语法不符；在 playground 中核对，必要时为包裹节点加 `wrappers` 或 `transparent` |
| 文件仍使用内置语言 | 同一扩展名以内置语言为准，设置中会列出被内置语言接管的类型 |
