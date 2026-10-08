use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

use oxc::{
    allocator::Allocator,
    parser::{ParseOptions, Parser, ParserReturn},
    semantic::SemanticBuilder,
    span::SourceType,
};

mod comment;
mod convert;
mod error;
mod source_utils;
mod types;

pub use comment::*;
pub use error::*;
pub use source_utils::*;
pub use types::*;

#[cfg(all(
    feature = "allocator",
    not(any(
        target_arch = "arm",
        target_os = "android",
        target_os = "freebsd",
        target_os = "windows",
        target_family = "wasm"
    ))
))]
#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum AstType {
    JavaScript,
    TypeScript,
}

fn get_ast_type(source_type: SourceType, options: &ParserOptions) -> AstType {
    match options.ast_type.as_deref() {
        Some("js") => AstType::JavaScript,
        Some("ts") => AstType::TypeScript,
        _ => {
            if source_type.is_javascript() {
                AstType::JavaScript
            } else {
                AstType::TypeScript
            }
        }
    }
}

fn parse_impl<'a>(
    allocator: &'a Allocator,
    source_type: SourceType,
    source_text: &'a str,
    options: &ParserOptions,
) -> ParserReturn<'a> {
    Parser::new(allocator, source_text, source_type)
        .with_options(ParseOptions {
            preserve_parens: options.preserve_parens.unwrap_or(true),
            enable_ident_hashes: options.show_semantic_errors == Some(true),
            ..ParseOptions::default()
        })
        .parse()
}

pub fn parse_with_return(filename: &str, source_text: &str, options: &ParserOptions) -> String {
    let allocator = Allocator::default();
    let source_type =
        get_source_type(filename, options.lang.as_deref(), options.source_type.as_deref());
    let ast_type = get_ast_type(source_type, options);
    let ranges = options.range.unwrap_or(false);
    let ret = parse_impl(&allocator, source_type, source_text, options);

    let mut program = ret.program;
    let mut module_record = ret.module_record;
    let mut diagnostics = ret.diagnostics;

    if options.show_semantic_errors == Some(true) {
        let semantic_ret = SemanticBuilder::new_compiler().build(&program);
        diagnostics.extend(semantic_ret.diagnostics);
    }

    let mut errors = OxcError::from_diagnostics(filename, source_text, diagnostics);

    let mut comments =
        convert_utf8_to_utf16(source_text, &mut program, &mut module_record, &mut errors);

    if ast_type == AstType::JavaScript {
        if let Some(hashbang) = &program.hashbang {
            comments.insert(
                0,
                Comment {
                    r#type: "Line".to_string(),
                    value: hashbang.value.to_string(),
                    start: hashbang.span.start,
                    end: hashbang.span.end,
                },
            );
        }
    }

    let include_ts_fields = ast_type == AstType::TypeScript;
    let program_json = program.to_estree_json(include_ts_fields, ranges);

    let module = EcmaScriptModule::from(&module_record);
    let module_json = serde_json::to_string(&module).unwrap_or_else(|_| "{}".to_string());
    let comments_json = serde_json::to_string(&comments).unwrap_or_else(|_| "[]".to_string());
    let errors_json = serde_json::to_string(&errors).unwrap_or_else(|_| "[]".to_string());

    format!(
        r#"{{"program":{},"module":{},"comments":{},"errors":{}}}"#,
        program_json, module_json, comments_json, errors_json
    )
}

// =========================================================================
// C-ABI FFI EXPORTS (extern "C")
// =========================================================================

/// Parses JavaScript/TypeScript source code and returns ESTree JSON string.
/// The returned pointer must be freed using `oxc_free_string`.
///
/// # Safety
/// Caller must pass valid null-terminated C strings or null pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oxc_parse(
    filename: *const c_char,
    source_text: *const c_char,
) -> *mut c_char {
    unsafe { oxc_parse_with_options(filename, source_text, ptr::null()) }
}

/// Parses JavaScript/TypeScript source code with optional JSON options.
/// The returned pointer must be freed using `oxc_free_string`.
///
/// # Safety
/// Caller must pass valid null-terminated C strings or null pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oxc_parse_with_options(
    filename: *const c_char,
    source_text: *const c_char,
    options_json: *const c_char,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if source_text.is_null() {
            return ptr::null_mut();
        }

        let filename_str = if filename.is_null() {
            "anonymous.ts"
        } else {
            match unsafe { CStr::from_ptr(filename) }.to_str() {
                Ok(s) => s,
                Err(_) => "anonymous.ts",
            }
        };

        let source_str = match unsafe { CStr::from_ptr(source_text) }.to_str() {
            Ok(s) => s,
            Err(_) => return ptr::null_mut(),
        };

        let options: ParserOptions = if !options_json.is_null() {
            if let Ok(opts_str) = unsafe { CStr::from_ptr(options_json) }.to_str() {
                serde_json::from_str(opts_str).unwrap_or_default()
            } else {
                ParserOptions::default()
            }
        } else {
            ParserOptions::default()
        };

        let json = parse_with_return(filename_str, source_str, &options);
        match CString::new(json) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => ptr::null_mut(),
        }
    });

    match result {
        Ok(ptr) => ptr,
        Err(_) => ptr::null_mut(),
    }
}

/// Frees the string returned by `oxc_parse` or `oxc_parse_with_options`.
///
/// # Safety
/// Caller must pass the pointer originally returned by oxc_parse, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oxc_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = std::panic::catch_unwind(|| {
            drop(unsafe { CString::from_raw(ptr) });
        });
    }
}
