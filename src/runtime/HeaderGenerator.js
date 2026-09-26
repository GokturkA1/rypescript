// src/runtime/HeaderGenerator.js
import fs from "node:fs";

/**
 * C Başlık dosyası üretimi (generateCHeader) ve
 * harici C başlık dosyalarının ayrıştırılması (loadCHeader).
 */
export class HeaderGenerator {
  static mlirTypeToCType(mlirType, isString = false) {
    if (isString) return "const char*";
    if (mlirType === "f64") return "double";
    if (mlirType === "f32") return "float";
    if (mlirType === "i64") return "int64_t";
    if (mlirType === "i32") return "int32_t";
    if (mlirType === "i1") return "bool";
    if (mlirType === "!llvm.ptr") return "void*";
    if (mlirType === "none" || !mlirType) return "void";
    return "void*";
  }

  static cTypeToMlir(cType) {
    const clean = cType.replace(/\s+/g, " ").trim();
    if (clean.includes("*")) return "!llvm.ptr";
    switch (clean) {
      case "double":
        return "f64";
      case "float":
        return "f32";
      case "int":
      case "int32_t":
      case "uint32_t":
      case "short":
        return "i32";
      case "int64_t":
      case "uint64_t":
      case "long":
      case "long long":
      case "size_t":
        return "i64";
      case "bool":
      case "_Bool":
        return "i1";
      case "void":
        return "none";
      default:
        return "f64";
    }
  }

  static generateCHeader({
    structRegistry,
    enumRegistry,
    functionRegistry,
    exportedFunctionNames,
    usedFeatures,
    headerGuard = "RYPESCRIPT_H",
  }) {
    const lines = [
      `#ifndef ${headerGuard}`,
      `#define ${headerGuard}`,
      "",
      "#include <stdint.h>",
      "#include <stdbool.h>",
      "",
      "#ifdef __cplusplus",
      'extern "C" {',
      "#endif",
      "",
    ];

    // 1. Tagged Union Kullanıldıysa C Tanımı
    if (usedFeatures && usedFeatures.union) {
      lines.push(
        "typedef struct {",
        "    int32_t tag;",
        "    union {",
        "        int64_t i64_val;",
        "        double f64_val;",
        "        const char* str_val;",
        "        bool bool_val;",
        "    } payload;",
        "} RtsTaggedUnion;",
        ""
      );
    }

    // 2. C-Style Struct & Untagged Union Tanımları
    for (const [name, meta] of structRegistry.entries()) {
      const keyword = meta.isUnion ? "union" : "struct";
      const packPrefix = meta.isPacked ? "__attribute__((packed)) " : "";
      lines.push(`typedef ${packPrefix}${keyword} {`);
      for (const f of meta.fields) {
        if (f.name === "__type_id") continue;
        if (f.isFunction && f.fnSig) {
          const fnRet = this.mlirTypeToCType(f.fnSig.retType);
          const fnArgs = f.fnSig.paramTypes.map((t) => this.mlirTypeToCType(t)).join(", ") || "void";
          lines.push(`    ${fnRet} (*${f.name})(${fnArgs});`);
        } else {
          const cType = f.enumName || this.mlirTypeToCType(f.type, f.isString);
          lines.push(`    ${cType} ${f.name};`);
        }
      }
      lines.push(`} ${name};`, "");
    }

    // 3. C-Style Enum & Bitflags Tanımları
    for (const [name, meta] of enumRegistry.entries()) {
      if (meta.kind === "numeric") {
        lines.push(`typedef enum {`);
        const entries = [];
        for (const [mName, mVal] of meta.members.entries()) {
          if (!mVal.isString) {
            entries.push(`    ${name}_${mName} = ${mVal.value}`);
          }
        }
        lines.push(entries.join(",\n"));
        lines.push(`} ${name};`, "");
      }
    }

    // 4. Dışa Aktarılan Fonksiyonlar
    for (const fnName of exportedFunctionNames) {
      let meta = functionRegistry.get(fnName);
      if (!meta) {
        for (const [origName, m] of functionRegistry.entries()) {
          if (m.exportAlias === fnName) {
            meta = m;
            break;
          }
        }
      }
      if (!meta) continue;

      const cRet = meta.enumRetName || meta.structRetName || this.mlirTypeToCType(meta.retType, meta.isRetString);
      const cParams = (meta.params || []).map((p) => {
        if (p.isFunction && p.fnSig) {
          const fnRet = this.mlirTypeToCType(p.fnSig.retType);
          const fnArgs = p.fnSig.paramTypes.map((t) => this.mlirTypeToCType(t)).join(", ") || "void";
          return `${fnRet} (*${p.name})(${fnArgs})`;
        }
        const cType = p.enumName || p.structName || this.mlirTypeToCType(p.type, p.isString);
        return `${cType} ${p.name}`;
      });

      const paramStr = cParams.length > 0 ? cParams.join(", ") : "void";
      lines.push(`${cRet} ${fnName}(${paramStr});`);
    }

    lines.push("", "#ifdef __cplusplus", "}", "#endif", "", `#endif // ${headerGuard}`, "");

    return lines.join("\n");
  }

  static loadCHeader(headerFilePath, functionRegistry, builder) {
    if (!fs.existsSync(headerFilePath)) {
      throw new Error(`[CHeaderParser] Başlık dosyası bulunamadı: ${headerFilePath}`);
    }

    let content = fs.readFileSync(headerFilePath, "utf8");

    // Yorum satırlarını temizle (// ve /* ... */)
    content = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    // Preprocessor (#include, #ifndef vb.) ve extern "C" satırlarını temizle
    content = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .replace(/extern\s+"C"\s*\{?/g, "")
      .replace(/\}/g, "");

    // C Fonksiyon Prototiplerini Yakala: return_type func_name(param1, param2, ...);
    const protoRegex = /([a-zA-Z0-9_*]+(?:\s+[a-zA-Z0-9_*]+)*)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*;/g;
    let match;

    while ((match = protoRegex.exec(content)) !== null) {
      const rawRet = match[1].trim();
      const funcName = match[2].trim();
      const rawParamsStr = match[3].trim();

      if (["typedef", "return", "if", "while"].includes(rawRet)) continue;

      const retType = this.cTypeToMlir(rawRet);
      const isRetString = rawRet.includes("char*");

      const params = [];
      const paramTypes = [];

      if (rawParamsStr && rawParamsStr !== "void") {
        const rawParamList = rawParamsStr.split(",");
        rawParamList.forEach((p, idx) => {
          const trimmed = p.trim();
          if (!trimmed) return;
          const parts = trimmed.split(/\s+/);
          const pName = parts[parts.length - 1].replace(/^\*+/, "") || `arg_${idx}`;
          const pTypeStr = trimmed.slice(0, trimmed.lastIndexOf(pName)).trim() || parts[0];
          const mlirType = this.cTypeToMlir(pTypeStr);
          const isString = pTypeStr.includes("char*");

          params.push({ name: pName, type: mlirType, isString });
          paramTypes.push(mlirType);
        });
      }

      const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
      const declSig = retType === "none" ? `(${paramTypes.join(", ")})` : `(${paramTypes.join(", ")}) -> ${retType}`;

      functionRegistry.set(funcName, {
        isAsync: false,
        isDeclare: true,
        innerRetType: retType,
        retType,
        structRetName: null,
        isRetString,
        params,
        paramTypes,
        mlirType,
        declSig,
      });

      builder.declareExternalFunction(funcName, declSig);
    }
  }
}
