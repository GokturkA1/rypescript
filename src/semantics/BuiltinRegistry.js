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
  }
}
