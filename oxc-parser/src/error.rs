use std::sync::Arc;

use oxc_diagnostics::{LabeledSpan, NamedSource, OxcDiagnostic};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OxcError {
    pub severity: Severity,
    pub message: String,
    pub labels: Vec<ErrorLabel>,
    pub help_message: Option<String>,
    pub codeframe: Option<String>,
}

impl OxcError {
    pub fn new(message: String) -> Self {
        Self {
            severity: Severity::Error,
            message,
            labels: vec![],
            help_message: None,
            codeframe: None,
        }
    }

    pub fn from_diagnostics(
        filename: &str,
        source_text: &str,
        diagnostics: impl IntoIterator<Item = OxcDiagnostic>,
    ) -> Vec<Self> {
        let diagnostics = diagnostics.into_iter().collect::<Vec<_>>();
        if diagnostics.is_empty() {
            return vec![];
        }
        let source = Arc::new(NamedSource::new(filename, source_text.to_string()));
        diagnostics.into_iter().map(|e| Self::from_diagnostic(&source, e)).collect()
    }

    pub fn from_diagnostic(
        named_source: &Arc<NamedSource<String>>,
        diagnostic: OxcDiagnostic,
    ) -> Self {
        let mut error = Self::from(&diagnostic);
        error.codeframe = Some(diagnostic.render_with_source_code(Arc::clone(named_source)));
        error
    }
}

impl From<&OxcDiagnostic> for OxcError {
    fn from(diagnostic: &OxcDiagnostic) -> Self {
        let labels = diagnostic.labels.iter().map(ErrorLabel::from).collect::<Vec<_>>();
        Self {
            severity: Severity::from(diagnostic.severity),
            message: diagnostic.message.to_string(),
            labels,
            help_message: diagnostic.help.as_ref().map(ToString::to_string),
            codeframe: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorLabel {
    pub message: Option<String>,
    pub start: u32,
    pub end: u32,
}

impl From<&LabeledSpan> for ErrorLabel {
    fn from(label: &LabeledSpan) -> Self {
        Self {
            message: label.label().map(ToString::to_string),
            start: label.offset(),
            end: label.offset() + label.len(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Advice,
}

impl From<oxc_diagnostics::Severity> for Severity {
    fn from(value: oxc_diagnostics::Severity) -> Self {
        match value {
            oxc_diagnostics::Severity::Error => Self::Error,
            oxc_diagnostics::Severity::Warning => Self::Warning,
            oxc_diagnostics::Severity::Advice => Self::Advice,
        }
    }
}
