use serde::{Deserialize, Serialize};

use crate::comment::Comment;
use crate::error::OxcError;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ParserOptions {
    /// Treat the source text as `js`, `jsx`, `ts`, `tsx` or `dts`.
    pub lang: Option<String>,

    /// Treat the source text as `script` or `module` code.
    pub source_type: Option<String>,

    /// Return an AST which includes TypeScript-related properties, or excludes them.
    /// `'js'` is default for JS / JSX files.
    /// `'ts'` is default for TS / TSX files.
    pub ast_type: Option<String>,

    /// Controls whether the `range` property is included on AST nodes.
    pub range: Option<bool>,

    /// Emit `ParenthesizedExpression` and `TSParenthesizedType` in AST.
    pub preserve_parens: Option<bool>,

    /// Produce semantic errors with an additional AST pass.
    pub show_semantic_errors: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    pub program_and_fixes: String,
    pub module: EcmaScriptModule,
    pub comments: Vec<Comment>,
    pub errors: Vec<OxcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EcmaScriptModule {
    /// Has ESM syntax (`import`, `export`, `import.meta`).
    pub has_module_syntax: bool,
    /// Import statements.
    pub static_imports: Vec<StaticImport>,
    /// Export statements.
    pub static_exports: Vec<StaticExport>,
    /// Dynamic import expressions.
    pub dynamic_imports: Vec<DynamicImport>,
    /// Span positions of `import.meta`
    pub import_metas: Vec<Span>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ValueSpan {
    pub value: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StaticImport {
    /// Start of import statement.
    pub start: u32,
    /// End of import statement.
    pub end: u32,
    /// Import source.
    pub module_request: ValueSpan,
    /// Import specifiers.
    pub entries: Vec<StaticImportEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StaticImportEntry {
    pub import_name: ImportName,
    pub local_name: ValueSpan,
    pub is_type: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ImportNameKind {
    #[default]
    Name,
    NamespaceObject,
    Default,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImportName {
    pub kind: ImportNameKind,
    pub name: Option<String>,
    pub start: Option<u32>,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StaticExportEntry {
    pub start: u32,
    pub end: u32,
    pub module_request: Option<ValueSpan>,
    pub import_name: ExportImportName,
    pub export_name: ExportExportName,
    pub local_name: ExportLocalName,
    pub is_type: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StaticExport {
    pub start: u32,
    pub end: u32,
    pub entries: Vec<StaticExportEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ExportImportNameKind {
    #[default]
    Name,
    All,
    AllButDefault,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExportImportName {
    pub kind: ExportImportNameKind,
    pub name: Option<String>,
    pub start: Option<u32>,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ExportExportNameKind {
    #[default]
    Name,
    Default,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExportExportName {
    pub kind: ExportExportNameKind,
    pub name: Option<String>,
    pub start: Option<u32>,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExportLocalName {
    pub kind: ExportLocalNameKind,
    pub name: Option<String>,
    pub start: Option<u32>,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ExportLocalNameKind {
    #[default]
    Name,
    Default,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DynamicImport {
    pub start: u32,
    pub end: u32,
    pub module_request: Span,
}
