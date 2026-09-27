// src/semantics/BuiltinRegistry.js

/**
 * Yerleşik fonksiyonlar, struct/interface ve enum meta-verilerinin merkezi deposu.
 */
export class BuiltinRegistry {
  constructor() {
    this.functionSignatures = new Map();
    this.structSignatures = new Map();
    this.enumSignatures = new Map();
    this.typeAliasRegistry = new Map();
    this.unionRegistry = new Map();
    this.functionTypeAliases = new Set();

    this.registerBuiltins();
  }

  registerBuiltins() {
    // 1. Derleyici İpuçları ve Dekoratörler
    this.functionSignatures.set("inline", { params: [], returnType: "any" });
    this.functionSignatures.set("noinline", { params: [], returnType: "any" });
    this.functionSignatures.set("packed", { params: [], returnType: "any" });
    this.functionSignatures.set("export_name", { params: ["string"], returnType: "any" });
    this.functionSignatures.set("napi", { params: [], returnType: "any" });
    this.functionSignatures.set("unique", { params: [], returnType: "any" });
    this.functionSignatures.set("move", { params: [], returnType: "any" });

    // 2. Sistem ve Bellek Yönetimi Fonksiyonları
    this.functionSignatures.set("malloc", { params: ["number"], returnType: "pointer" });
    this.functionSignatures.set("free", { params: ["pointer"], returnType: "void" });
    this.functionSignatures.set("alloca", { params: ["number"], returnType: "pointer" });
    this.functionSignatures.set("sleep", { params: ["number"], returnType: "void" });
    this.functionSignatures.set("panic", { params: ["string"], returnType: "never" });
    this.functionSignatures.set("assert", { params: ["boolean", "string"], returnType: "void" });
    this.functionSignatures.set("join", { params: ["pointer"], returnType: "void" });
    this.functionSignatures.set("spawn", { params: ["function", "any"], minArgs: 1, returnType: "pointer" });

    // 3. Result<T, E> ve Hata Yönetimi Fonksiyonları
    this.functionSignatures.set("Ok", { params: ["any"], returnType: "Result" });
    this.functionSignatures.set("Err", { params: ["any"], returnType: "Result" });
    this.functionSignatures.set("unwrap", { params: ["any"], returnType: "any" });

    // 4. Standart Result Yapısı
    this.structSignatures.set("Result", {
      fields: new Map([
        ["ok", { type: "boolean" }],
        ["value", { type: "any" }],
        ["error", { type: "any" }],
      ]),
      methods: new Map(),
    });

    // 5. Özel Bellek Yöneticileri (Arena, Pool, FixedBuffer)
    this.structSignatures.set("Arena", {
      fields: new Map(),
      methods: new Map([
        ["alloc", { params: ["number"], returnType: "pointer" }],
        ["reset", { params: [], returnType: "void" }],
        ["dispose", { params: [], returnType: "void" }],
      ]),
    });

    this.structSignatures.set("Pool", {
      fields: new Map(),
      methods: new Map([
        ["alloc", { params: [], returnType: "pointer" }],
        ["free", { params: ["pointer"], returnType: "void" }],
        ["dispose", { params: [], returnType: "void" }],
      ]),
    });

    this.structSignatures.set("FixedBuffer", {
      fields: new Map(),
      methods: new Map([
        ["alloc", { params: ["number"], returnType: "pointer" }],
        ["reset", { params: [], returnType: "void" }],
        ["dispose", { params: [], returnType: "void" }],
      ]),
    });

    // 6. Eşzamanlılık (Channel)
    this.structSignatures.set("Channel", {
      fields: new Map(),
      methods: new Map([
        ["send", { params: ["any"], returnType: "void" }],
        ["recv", { params: [], returnType: "any" }],
      ]),
    });

    // 7. Native Hash Table (Map & Set)
    this.structSignatures.set("Map", {
      fields: new Map([["size", { type: "number" }]]),
      methods: new Map([
        ["set", { params: ["any", "any"], returnType: "pointer" }],
        ["get", { params: ["any"], returnType: "any" }],
        ["has", { params: ["any"], returnType: "boolean" }],
      ]),
    });

    this.structSignatures.set("Set", {
      fields: new Map([["size", { type: "number" }]]),
      methods: new Map([
        ["add", { params: ["any"], returnType: "pointer" }],
        ["has", { params: ["any"], returnType: "boolean" }],
      ]),
    });

    // 8. Math Yardımcıları
    this.structSignatures.set("Math", {
      fields: new Map([
        ["PI", { type: "number" }],
        ["E", { type: "number" }],
      ]),
      methods: new Map([
        ["sqrt", { params: ["number"], returnType: "number" }],
        ["sin", { params: ["number"], returnType: "number" }],
        ["cos", { params: ["number"], returnType: "number" }],
        ["floor", { params: ["number"], returnType: "number" }],
        ["ceil", { params: ["number"], returnType: "number" }],
        ["round", { params: ["number"], returnType: "number" }],
        ["abs", { params: ["number"], returnType: "number" }],
        ["min", { params: ["number", "number"], returnType: "number" }],
        ["max", { params: ["number", "number"], returnType: "number" }],
        ["pow", { params: ["number", "number"], returnType: "number" }],
      ]),
    });

    // 9. String Metotları (C-Style sıfır maliyetli dilimleme)
    const stringMethods = new Map([
      ["slice", { params: ["number", "number"], minArgs: 1, returnType: "string" }],
      ["substring", { params: ["number", "number"], minArgs: 1, returnType: "string" }],
    ]);
    this.structSignatures.set("string", {
      fields: new Map([["length", { type: "number" }]]),
      methods: stringMethods,
    });
    this.structSignatures.set("String", {
      fields: new Map([["length", { type: "number" }]]),
      methods: stringMethods,
    });

    // 10. SIMD Vektör Tipleri ve Fonksiyonları
    const vectorTypes = ["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8"];
    for (const vt of vectorTypes) {
      this.typeAliasRegistry.set(vt, { type: "TSTypeReference", typeName: { name: vt } });
    }

    // Doğrudan vektör yapılandırıcı fonksiyonlar
    this.functionSignatures.set("f32x4", { params: ["number", "number", "number", "number"], minArgs: 0, returnType: "f32x4" });
    this.functionSignatures.set("f64x2", { params: ["number", "number"], minArgs: 0, returnType: "f64x2" });
    this.functionSignatures.set("i32x4", { params: ["number", "number", "number", "number"], minArgs: 0, returnType: "i32x4" });
    this.functionSignatures.set("i64x2", { params: ["number", "number"], minArgs: 0, returnType: "i64x2" });
    this.functionSignatures.set("f64x4", { params: ["number", "number", "number", "number"], minArgs: 0, returnType: "f64x4" });
    this.functionSignatures.set("f32x8", { params: ["number", "number", "number", "number", "number", "number", "number", "number"], minArgs: 0, returnType: "f32x8" });
    this.functionSignatures.set("i32x8", { params: ["number", "number", "number", "number", "number", "number", "number", "number"], minArgs: 0, returnType: "i32x8" });

    // f32x4 statik ve operasyon metotları
    this.structSignatures.set("f32x4", {
      fields: new Map(),
      methods: new Map([
        ["splat", { params: ["number"], returnType: "f32x4" }],
        ["load", { params: ["pointer"], returnType: "f32x4" }],
        ["store", { params: ["pointer", "f32x4"], returnType: "void" }],
        ["add", { params: ["f32x4", "f32x4"], returnType: "f32x4" }],
        ["sub", { params: ["f32x4", "f32x4"], returnType: "f32x4" }],
        ["mul", { params: ["f32x4", "f32x4"], returnType: "f32x4" }],
        ["div", { params: ["f32x4", "f32x4"], returnType: "f32x4" }],
        ["fma", { params: ["f32x4", "f32x4", "f32x4"], returnType: "f32x4" }],
        ["reduce_add", { params: ["f32x4"], returnType: "number" }],
        ["reduce_mul", { params: ["f32x4"], returnType: "number" }],
        ["reduce_min", { params: ["f32x4"], returnType: "number" }],
        ["reduce_max", { params: ["f32x4"], returnType: "number" }],
        ["extract", { params: ["f32x4", "number"], returnType: "number" }],
        ["insert", { params: ["f32x4", "number", "number"], returnType: "f32x4" }],
        ["sqrt", { params: ["f32x4"], returnType: "f32x4" }],
        ["abs", { params: ["f32x4"], returnType: "f32x4" }],
      ]),
    });

    // f64x2 statik ve operasyon metotları
    this.structSignatures.set("f64x2", {
      fields: new Map(),
      methods: new Map([
        ["splat", { params: ["number"], returnType: "f64x2" }],
        ["load", { params: ["pointer"], returnType: "f64x2" }],
        ["store", { params: ["pointer", "f64x2"], returnType: "void" }],
        ["add", { params: ["f64x2", "f64x2"], returnType: "f64x2" }],
        ["sub", { params: ["f64x2", "f64x2"], returnType: "f64x2" }],
        ["mul", { params: ["f64x2", "f64x2"], returnType: "f64x2" }],
        ["div", { params: ["f64x2", "f64x2"], returnType: "f64x2" }],
        ["fma", { params: ["f64x2", "f64x2", "f64x2"], returnType: "f64x2" }],
        ["reduce_add", { params: ["f64x2"], returnType: "number" }],
        ["reduce_mul", { params: ["f64x2"], returnType: "number" }],
        ["reduce_min", { params: ["f64x2"], returnType: "number" }],
        ["reduce_max", { params: ["f64x2"], returnType: "number" }],
        ["extract", { params: ["f64x2", "number"], returnType: "number" }],
        ["insert", { params: ["f64x2", "number", "number"], returnType: "f64x2" }],
        ["sqrt", { params: ["f64x2"], returnType: "f64x2" }],
        ["abs", { params: ["f64x2"], returnType: "f64x2" }],
      ]),
    });

    // i32x4 statik ve operasyon metotları
    this.structSignatures.set("i32x4", {
      fields: new Map(),
      methods: new Map([
        ["splat", { params: ["number"], returnType: "i32x4" }],
        ["load", { params: ["pointer"], returnType: "i32x4" }],
        ["store", { params: ["pointer", "i32x4"], returnType: "void" }],
        ["add", { params: ["i32x4", "i32x4"], returnType: "i32x4" }],
        ["sub", { params: ["i32x4", "i32x4"], returnType: "i32x4" }],
        ["mul", { params: ["i32x4", "i32x4"], returnType: "i32x4" }],
        ["reduce_add", { params: ["i32x4"], returnType: "number" }],
        ["reduce_min", { params: ["i32x4"], returnType: "number" }],
        ["reduce_max", { params: ["i32x4"], returnType: "number" }],
        ["extract", { params: ["i32x4", "number"], returnType: "number" }],
        ["insert", { params: ["i32x4", "number", "number"], returnType: "i32x4" }],
      ]),
    });

    // i64x2 statik ve operasyon metotları
    this.structSignatures.set("i64x2", {
      fields: new Map(),
      methods: new Map([
        ["splat", { params: ["number"], returnType: "i64x2" }],
        ["load", { params: ["pointer"], returnType: "i64x2" }],
        ["store", { params: ["pointer", "i64x2"], returnType: "void" }],
        ["add", { params: ["i64x2", "i64x2"], returnType: "i64x2" }],
        ["sub", { params: ["i64x2", "i64x2"], returnType: "i64x2" }],
        ["mul", { params: ["i64x2", "i64x2"], returnType: "i64x2" }],
        ["reduce_add", { params: ["i64x2"], returnType: "number" }],
        ["extract", { params: ["i64x2", "number"], returnType: "number" }],
        ["insert", { params: ["i64x2", "number", "number"], returnType: "i64x2" }],
      ]),
    });

    // Evrensel simd Namespace
    this.structSignatures.set("simd", {
      fields: new Map(),
      methods: new Map([
        ["f32x4", { params: ["number", "number", "number", "number"], returnType: "f32x4" }],
        ["f64x2", { params: ["number", "number"], returnType: "f64x2" }],
        ["i32x4", { params: ["number", "number", "number", "number"], returnType: "i32x4" }],
        ["i64x2", { params: ["number", "number"], returnType: "i64x2" }],
        ["splat_f32x4", { params: ["number"], returnType: "f32x4" }],
        ["splat_f64x2", { params: ["number"], returnType: "f64x2" }],
        ["splat_i32x4", { params: ["number"], returnType: "i32x4" }],
        ["splat_i64x2", { params: ["number"], returnType: "i64x2" }],
        ["load_f32x4", { params: ["pointer"], returnType: "f32x4" }],
        ["load_f64x2", { params: ["pointer"], returnType: "f64x2" }],
        ["load_i32x4", { params: ["pointer"], returnType: "i32x4" }],
        ["store", { params: ["pointer", "any"], returnType: "void" }],
        ["add", { params: ["any", "any"], returnType: "any" }],
        ["sub", { params: ["any", "any"], returnType: "any" }],
        ["mul", { params: ["any", "any"], returnType: "any" }],
        ["div", { params: ["any", "any"], returnType: "any" }],
        ["fma", { params: ["any", "any", "any"], returnType: "any" }],
        ["reduce_add", { params: ["any"], returnType: "number" }],
        ["sum", { params: ["any"], returnType: "number" }],
        ["reduce_mul", { params: ["any"], returnType: "number" }],
        ["reduce_min", { params: ["any"], returnType: "number" }],
        ["reduce_max", { params: ["any"], returnType: "number" }],
        ["extract", { params: ["any", "number"], returnType: "number" }],
        ["insert", { params: ["any", "number", "number"], returnType: "any" }],
        ["sqrt", { params: ["any"], returnType: "any" }],
        ["abs", { params: ["any"], returnType: "any" }],
      ]),
    });
  }
}
