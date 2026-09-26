// src/ir/ASTLowerer.js
import fs from "node:fs";
import { LambdaLifter } from "../frontend/LambdaLifter.js";
import { Monomorphizer } from "../frontend/Monomorphizer.js";
import { HeaderGenerator } from "../runtime/HeaderGenerator.js";
import { ClassLowerer } from "./lowerers/ClassLowerer.js";
import { NapiLowerer } from "./lowerers/NapiLowerer.js";

export class ASTLowerer {
  constructor(builder) {
    this.builder = builder;
    this.symbolTable = new Map();
    this.structRegistry = new Map();
    this.functionRegistry = new Map();
    this.classList = [];
    this.vcallRouters = new Set();

    this.typeAliasRegistry = new Map();
    this.enumRegistry = new Map();
    this.exportedFunctionNames = new Set();

    // Generics Şablon Havuzları
    this.genericClassTemplates = new Map();
    this.genericFunctionTemplates = new Map();
    this.genericTypeTemplates = new Map();
    this.genericInterfaceTemplates = new Map();
    this.specializedClasses = new Set();
    this.specializedFunctions = new Set();
    this.specializedTypes = new Set();
    this.spawnRunners = new Map();
    this.globals = new Map();
    this.napiFunctions = [];

    // Standart Kütüphane: Yerleşik Result<T, E = string> Şablonu
    this.genericInterfaceTemplates.set("Result", {
      type: "TSInterfaceDeclaration",
      id: { type: "Identifier", name: "Result" },
      typeParameters: {
        params: [
          { name: { name: "T" } },
          { name: { name: "E" }, default: { type: "TSStringKeyword" } },
        ],
      },
      body: {
        type: "TSInterfaceBody",
        body: [
          {
            type: "TSPropertySignature",
            key: { name: "ok" },
            typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: { type: "TSBooleanKeyword" } },
          },
          {
            type: "TSPropertySignature",
            key: { name: "value" },
            typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: { type: "TSTypeReference", typeName: { name: "T" } } },
          },
          {
            type: "TSPropertySignature",
            key: { name: "error" },
            typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: { type: "TSTypeReference", typeName: { name: "E" } } },
          },
        ],
      },
    });

    this.scopeStack = [];
    this.builder.onAllocate = (ptr) => this.trackHeap(ptr);
  }

  getPragmas(node) {
    const pragmas = {
      inline: false,
      noinline: false,
      packed: false,
      napi: false,
      exportName: null,
    };
    if (!node) return pragmas;

    // 1. AST Decorators (Sınıflar ve Metotlar üzerindeki yerleşik Decorator'lar)
    const rawDecorators = node.decorators || node.declaration?.decorators || [];
    for (const dec of rawDecorators) {
      const expr = dec.expression;
      if (!expr) continue;
      if (expr.type === "Identifier") {
        if (expr.name === "inline") pragmas.inline = true;
        if (expr.name === "noinline") pragmas.noinline = true;
        if (expr.name === "packed") pragmas.packed = true;
        if (expr.name === "napi") pragmas.napi = true;
      } else if (expr.type === "CallExpression") {
        const fnName = expr.callee?.name;
        if (fnName === "export_name") {
          const arg = expr.arguments?.[0];
          if (arg) pragmas.exportName = arg.value ?? null;
        }
      }
    }

    // 2. Sentetik Decorators (Fonksiyon ve Interface öncesi yakalananlar)
    const nodeName = node.id?.name || node.declaration?.id?.name || node.key?.name;
    if (this.currentSyntheticDecorators && nodeName && this.currentSyntheticDecorators.has(nodeName)) {
      const decList = this.currentSyntheticDecorators.get(nodeName);
      for (const dec of decList) {
        if (dec.name === "inline") pragmas.inline = true;
        if (dec.name === "noinline") pragmas.noinline = true;
        if (dec.name === "packed") pragmas.packed = true;
        if (dec.name === "napi") pragmas.napi = true;
        if (dec.name === "export_name") pragmas.exportName = dec.arg;
      }
    }

    // 3. Fallback: Yorum Satırı (Yalnızca geriye dönük uyumluluk için)
    if (!pragmas.inline && !pragmas.noinline && !pragmas.packed && !pragmas.napi && !pragmas.exportName && this.currentComments) {
      const nodeStart = node.start ?? node.span?.start ?? 0;
      for (const c of this.currentComments) {
        if (c.end <= nodeStart && nodeStart - c.end < 60) {
          const text = c.value || "";
          if (/@inline\b/.test(text)) pragmas.inline = true;
          if (/@noinline\b/.test(text)) pragmas.noinline = true;
          if (/@packed\b/.test(text)) pragmas.packed = true;
          if (/@napi\b/.test(text)) pragmas.napi = true;
          const matchExport = text.match(/@export_name\s*\(\s*["']([^"']+)["']\s*\)/);
          if (matchExport) pragmas.exportName = matchExport[1];
        }
      }
    }

    return pragmas;
  }

  enterScope(isFunction = false, retType = null, structRetName = null) {
    this.scopeStack.push({
      isFunction,
      retType,
      structRetName,
      heapAllocations: new Set(),
      transferred: new Set(),
      disposables: [],
      deferrals: [],
    });
  }

  getCurrentFunctionRetType() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].isFunction) {
        return this.scopeStack[i].retType;
      }
    }
    return null;
  }

  getCurrentFunctionStructRetName() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].isFunction) {
        return this.scopeStack[i].structRetName;
      }
    }
    return null;
  }

  // --- ESCAPE ANALYSIS (Kaçış Analizi) ---
  checkEscape(varName, fnNode) {
    if (!fnNode || !fnNode.body) return true; // Global alandaysa kaçabilir varsay
    let escapes = false;

    this.walkAST(fnNode.body, (n) => {
      if (escapes) return;

      // 1. Return ifadesinde varName doğrudan dönüyor mu? (u.i gibi skaler alan okumaları kaçış sayılmaz)
      if (n.type === "ReturnStatement" && n.argument) {
        if (n.argument.type === "Identifier" && n.argument.name === varName) {
          escapes = true;
        } else if (n.argument.type !== "MemberExpression") {
          this.walkAST(n.argument, (sub) => {
            if (sub.type === "Identifier" && sub.name === varName) escapes = true;
          });
        }
      }

      // 2. Bir nesne alanına atanıyor mu? (obj.field = varName)
      if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
        this.walkAST(n.right, (sub) => {
          if (sub.type === "Identifier" && sub.name === varName) escapes = true;
        });
      }

      // 3. Fonksiyon çağrısına argüman olarak kaçıyor mu?
      if (n.type === "CallExpression") {
        const isSelfMethodCall =
          n.callee.type === "MemberExpression" &&
          n.callee.object.type === "Identifier" &&
          n.callee.object.name === varName;

        for (const arg of n.arguments || []) {
          this.walkAST(arg, (sub) => {
            if (sub.type === "Identifier" && sub.name === varName) escapes = true;
          });
        }
      }

      // 4. Lambda veya iç fonksiyon tarafından yakalanıyor mu (closure)?
      if ((n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") && n !== fnNode) {
        this.walkAST(n.body, (sub) => {
          if (sub.type === "Identifier" && sub.name === varName) escapes = true;
        });
      }
    });

    return escapes;
  }

  exitScope() {
    if (this.scopeStack.length === 0) return;
    const scope = this.scopeStack.pop();

    // Erken return ile blok zaten sonlandıysa tekrar kod üretme
    if (!this.builder.hasTerminated) {
      // 0. finally (defer) bloklarını ters sırada (LIFO) çalıştır
      for (let i = (scope.deferrals || []).length - 1; i >= 0; i--) {
        this.lowerStatement(scope.deferrals[i]);
      }

      // 1. using ile tanımlanan kaynakları ters sırada (LIFO) dispose et
      for (let i = scope.disposables.length - 1; i >= 0; i--) {
        const d = scope.disposables[i];
        this.emitDispose(d);
      }
      // 2. Kalan genel heap tahsislerini serbest bırak
      for (const ptr of scope.heapAllocations) {
        if (!scope.transferred.has(ptr)) {
          this.builder.emitFree(ptr);
        }
      }
    }
  }

  trackDisposable(ptr, structName, isStack = false, allocMeta = null) {
    if (this.scopeStack.length > 0) {
      const current = this.scopeStack[this.scopeStack.length - 1];
      current.disposables.push({ ptr, structName, isStack, allocMeta });
      current.heapAllocations.delete(ptr); // Çift free çağrısını önle
    }
  }

  emitDispose(d) {
    if (d.allocMeta?.isArena) {
      this.builder.emit(`func.call @rts_arena_destroy(${d.ptr}) : (!llvm.ptr) -> ()`);
      return;
    }
    if (d.allocMeta?.isPool) {
      this.builder.emit(`func.call @rts_pool_destroy(${d.ptr}) : (!llvm.ptr) -> ()`);
      return;
    }
    if (d.allocMeta?.isFixedBuffer) {
      this.builder.emit(`func.call @rts_fixed_buffer_destroy(${d.ptr}) : (!llvm.ptr) -> ()`);
      return;
    }
    if (d.structName) {
      const meta = this.structRegistry.get(d.structName);
      if (meta?.methods?.has("dispose")) {
        this.builder.emit(`func.call @${d.structName}_dispose(${d.ptr}) : (!llvm.ptr) -> ()`);
      }
    }
    // Stack'e tahsis edildiyse free çağrısı yapılmaz!
    if (!d.isStack) {
      this.builder.emitFree(d.ptr);
    }
  }

  trackHeap(ptr) {
    if (this.scopeStack.length > 0) {
      const current = this.scopeStack[this.scopeStack.length - 1];
      current.heapAllocations.add(ptr);
    }
  }

  markTransferred(ptr) {
    if (!ptr) return;
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].heapAllocations.has(ptr)) {
        this.scopeStack[i].transferred.add(ptr);
        break;
      }
    }
  }

  cleanupFunctionScopes() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];

      // Erken return sırasında bekleyen tüm finally bloklarını çalıştır ve temizle
      for (let j = (scope.deferrals || []).length - 1; j >= 0; j--) {
        this.lowerStatement(scope.deferrals[j]);
      }
      scope.deferrals = [];

      for (let j = scope.disposables.length - 1; j >= 0; j--) {
        const d = scope.disposables[j];
        if (!scope.transferred.has(d.ptr)) {
          this.emitDispose(d);
        }
      }
      for (const ptr of scope.heapAllocations) {
        if (!scope.transferred.has(ptr)) {
          this.builder.emitFree(ptr);
        }
      }
      if (scope.isFunction) break;
    }
  }

  unwrapExport(node) {
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") && node.declaration) {
      return node.declaration;
    }
    return node;
  }

  unwrapType(typeNode) {
    if (!typeNode) return null;
    let curr = typeNode;
    while (curr && (curr.type === "TSTypeAnnotation" || curr.type === "TSType") && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    return curr;
  }

  extractFunctionType(typeNode) {
    const unwrapped = this.unwrapType(typeNode);
    if (!unwrapped) return null;

    if (unwrapped.type === "TSTypeReference") {
      const typeName = unwrapped.typeName?.name || unwrapped.typeName?.value;
      if (this.typeAliasRegistry.has(typeName)) {
        return this.extractFunctionType(this.typeAliasRegistry.get(typeName));
      }
    }

    if (unwrapped.type === "TSFunctionType") {
      const rawParams =
        unwrapped.parameters ||
        unwrapped.params?.items ||
        unwrapped.params ||
        [];
      const paramTypes = rawParams.map((p) => {
        const pAnnot = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
        return this.resolveType(pAnnot);
      });

      const retAnnot = unwrapped.returnType || unwrapped.typeAnnotation;
      let retType = this.resolveType(retAnnot);
      if (!retType) retType = "none";

      const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
      return {
        paramTypes,
        retType,
        mlirType,
      };
    }

    return null;
  }

  isFunctionType(typeNode) {
    return this.extractFunctionType(typeNode) !== null;
  }

  isUnionType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return false;
    if (type.type === "TSUnionType") return true;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value;
      if (this.typeAliasRegistry.has(typeName)) {
        return this.isUnionType(this.typeAliasRegistry.get(typeName));
      }
    }
    return false;
  }

  isStringType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return false;
    if (type.type === "TSStringKeyword") return true;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value;
      if (this.enumRegistry.has(typeName)) {
        return this.enumRegistry.get(typeName).kind === "string";
      }
      if (this.typeAliasRegistry.has(typeName)) {
        return this.isStringType(this.typeAliasRegistry.get(typeName));
      }
    }
    return false;
  }

  getTypeKey(typeNode) {
    const t = this.unwrapType(typeNode);
    if (!t) return "f64";
    switch (t.type) {
      case "TSNumberKeyword":
        return "f64";
      case "TSStringKeyword":
        return "str";
      case "TSBooleanKeyword":
        return "bool";
      case "TSVoidKeyword":
        return "void";
      case "TSTypeReference": {
        const name = t.typeName?.name || t.typeName?.value;
        if (["i64", "int64", "u64", "uint64"].includes(name)) return "i64";
        if (["i32", "int32", "u32", "uint32", "int"].includes(name)) return "i32";
        if (["f64", "double"].includes(name)) return "f64";
        if (["f32", "float"].includes(name)) return "f32";
        if (this.enumRegistry.has(name)) {
          return this.enumRegistry.get(name).kind === "string" ? "str" : "i64";
        }
        if (this.typeAliasRegistry.has(name)) {
          return this.getTypeKey(this.typeAliasRegistry.get(name));
        }
        return name || "ptr";
      }
      default:
        return "f64";
    }
  }

  resolveType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return "f64";

    const fnType = this.extractFunctionType(type);
    if (fnType) {
      return fnType.mlirType;
    }

    if (type.type === "TSUnionType") {
      return "!llvm.ptr";
    }

    switch (type.type) {
      case "TSNumberKeyword":
        return "f64";
      case "TSBooleanKeyword":
        return "i1";
      case "TSStringKeyword":
        return "!llvm.ptr";
      case "TSVoidKeyword":
        return "none";
      case "TSArrayType":
        return "!llvm.ptr";
      case "TSTypeReference": {
        const typeName = type.typeName?.name || type.typeName?.value;
        if (typeName === "Channel" || typeName === "Arena" || typeName === "Pool" || typeName === "FixedBuffer") return "!llvm.ptr";
        if (["i64", "int64", "u64", "uint64"].includes(typeName)) return "i64";
        if (["i32", "int32", "u32", "uint32", "int"].includes(typeName)) return "i32";
        if (["f64", "double"].includes(typeName)) return "f64";
        if (["f32", "float"].includes(typeName)) return "f32";
        if (["bool", "boolean"].includes(typeName)) return "i1";
        if (typeName === "Promise") {
          return "!llvm.ptr";
        }
        if (this.enumRegistry.has(typeName)) {
          const en = this.enumRegistry.get(typeName);
          return en.kind === "string" ? "!llvm.ptr" : "i64";
        }
        if (this.structRegistry.has(typeName)) {
          return "!llvm.ptr";
        }
        if (this.classList.some((c) => c.name === typeName)) {
          return "!llvm.ptr";
        }
        if (this.typeAliasRegistry.has(typeName)) {
          return this.resolveType(this.typeAliasRegistry.get(typeName));
        }
        return "!llvm.ptr";
      }
      default:
        return "f64";
    }
  }

  getStructName(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return null;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value || null;
      if (!typeName) return null;
      if (this.enumRegistry.has(typeName)) {
        return null;
      }
      if (this.structRegistry.has(typeName)) {
        return typeName;
      }
      if (this.classList.some((c) => c.name === typeName)) {
        return typeName;
      }
      if (this.typeAliasRegistry.has(typeName)) {
        return this.getStructName(this.typeAliasRegistry.get(typeName));
      }
      return null;
    }
    return null;
  }

  getEnumName(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return null;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value || null;
      if (typeName && this.enumRegistry.has(typeName)) {
        return typeName;
      }
      if (typeName && this.typeAliasRegistry.has(typeName)) {
        return this.getEnumName(this.typeAliasRegistry.get(typeName));
      }
    }
    return null;
  }

  coerceType(val, targetType) {
    if (!val || val.type === targetType) return val;

    if (targetType === "i1") {
      if (val.type === "!llvm.ptr") {
        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        return this.builder.createComparison("!=", val, { ssa: nullPtr, type: "!llvm.ptr" });
      }
      if (val.type === "f64" || val.type === "f32") {
        const zero = this.builder.createConstant(0.0, val.type);
        return this.builder.createComparison("!=", val, zero);
      }
      if (val.type === "i64" || val.type === "i32") {
        const zero = this.builder.createConstant(0, val.type);
        return this.builder.createComparison("!=", val, zero);
      }
    }

    if (targetType === "f64" && (val.type === "i64" || val.type === "i32")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.sitofp ${val.ssa} : ${val.type} to f64`);
      return { ssa, type: "f64" };
    }
    if (targetType === "i64" && val.type === "f64") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.fptosi ${val.ssa} : f64 to i64`);
      return { ssa, type: "i64" };
    }
    if (targetType === "i64" && val.type === "i32") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.extsi ${val.ssa} : i32 to i64`);
      return { ssa, type: "i64" };
    }
    if (targetType === "i32" && val.type === "i64") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.trunci ${val.ssa} : i64 to i32`);
      return { ssa, type: "i32" };
    }
    return val;
  }

  boxIntoUnion(slotPtr, val) {
    this.builder.markFeature("union");
    if (val.isUnion) {
      const srcTagPtr = this.builder.nextSSA();
      this.builder.emit(`${srcTagPtr} = llvm.getelementptr ${val.ptr || val.ssa}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      const tag = this.builder.load(srcTagPtr, "i32");
      const dstTagPtr = this.builder.nextSSA();
      this.builder.emit(`${dstTagPtr} = llvm.getelementptr ${slotPtr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      this.builder.store(dstTagPtr, tag);

      const srcPayloadPtr = this.builder.nextSSA();
      this.builder.emit(`${srcPayloadPtr} = llvm.getelementptr ${val.ptr || val.ssa}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      const payload = this.builder.load(srcPayloadPtr, "i64");
      const dstPayloadPtr = this.builder.nextSSA();
      this.builder.emit(`${dstPayloadPtr} = llvm.getelementptr ${slotPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      this.builder.store(dstPayloadPtr, payload);
      return;
    }

    let tag = 5;
    if (val.isString || val.type === "!llvm.ptr") {
      tag = 3;
    } else if (val.type === "i64" || val.type === "i32") {
      tag = 1;
    } else if (val.type === "f64" || val.type === "f32") {
      tag = 2;
    } else if (val.type === "i1") {
      tag = 4;
    }

    const tagConst = this.builder.nextSSA();
    this.builder.emit(`${tagConst} = arith.constant ${tag} : i32`);
    const tagPtr = this.builder.nextSSA();
    this.builder.emit(`${tagPtr} = llvm.getelementptr ${slotPtr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
    this.builder.emit(`llvm.store ${tagConst}, ${tagPtr} : i32, !llvm.ptr`);

    const payloadPtr = this.builder.nextSSA();
    this.builder.emit(`${payloadPtr} = llvm.getelementptr ${slotPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
    if (tag === 1 && val.type === "i32") {
      val = this.coerceType(val, "i64");
    }
    this.builder.store(payloadPtr, val);
  }

  unboxUnion(uPtr, targetType) {
    this.builder.markFeature("union");
    if (targetType === "string") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_string(${uPtr}) : (!llvm.ptr) -> !llvm.ptr`);
      const slot = this.builder.allocateStack("!llvm.ptr");
      this.builder.store(slot.ptr, { ssa, type: "!llvm.ptr" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "!llvm.ptr", isString: true, isRef: true };
    } else if (targetType === "number") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_number(${uPtr}) : (!llvm.ptr) -> f64`);
      const slot = this.builder.allocateStack("f64");
      this.builder.store(slot.ptr, { ssa, type: "f64" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "f64", isRef: true };
    } else if (targetType === "boolean") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_bool(${uPtr}) : (!llvm.ptr) -> i1`);
      const slot = this.builder.allocateStack("i1");
      this.builder.store(slot.ptr, { ssa, type: "i1" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "i1", isRef: true };
    }
    return null;
  }

  extractTypeofCheck(expr) {
    if (!expr || expr.type !== "BinaryExpression") return null;
    if (expr.operator !== "===" && expr.operator !== "==") return null;

    let varName = null;
    let targetType = null;

    if (
      expr.left.type === "UnaryExpression" &&
      expr.left.operator === "typeof" &&
      expr.left.argument.type === "Identifier" &&
      (expr.right.type === "StringLiteral" || (expr.right.type === "Literal" && typeof expr.right.value === "string"))
    ) {
      varName = expr.left.argument.name;
      targetType = expr.right.value;
    } else if (
      expr.right.type === "UnaryExpression" &&
      expr.right.operator === "typeof" &&
      expr.right.argument.type === "Identifier" &&
      (expr.left.type === "StringLiteral" || (expr.left.type === "Literal" && typeof expr.left.value === "string"))
    ) {
      varName = expr.right.argument.name;
      targetType = expr.left.value;
    }

    if (varName && targetType) {
      return { varName, targetType };
    }
    return null;
  }

  walkAST(node, visitor) {
    LambdaLifter.walkAST(node, visitor);
  }

  liftLambdas(rootNodes) {
    return LambdaLifter.liftLambdas(rootNodes);
  }

  deepCloneWithSubst(node, substMap, specializedName) {
    if (!node || typeof node !== "object") return node;

    if (Array.isArray(node)) {
      return node.map((item) => this.deepCloneWithSubst(item, substMap, specializedName));
    }

    if (node.type === "TSTypeReference") {
      const typeName = node.typeName?.name || node.typeName?.value;
      if (typeName && substMap.has(typeName)) {
        return JSON.parse(JSON.stringify(substMap.get(typeName)));
      }
    }

    const cloned = {};
    for (const key of Object.keys(node)) {
      cloned[key] = this.deepCloneWithSubst(node[key], substMap, specializedName);
    }

    if (
      (cloned.type === "ClassDeclaration" ||
        cloned.type === "FunctionDeclaration" ||
        cloned.type === "TSInterfaceDeclaration" ||
        cloned.type === "TSTypeAliasDeclaration") &&
      specializedName
    ) {
      cloned.id = { type: "Identifier", name: specializedName };
      delete cloned.typeParameters;
      delete cloned.exportAlias;
    }

    return cloned;
  }

  instantiateGenericClass(baseName, typeArgs) {
    const templateNode = this.genericClassTemplates.get(baseName);
    if (!templateNode) return baseName;

    const typeKeys = typeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedClasses.has(specializedName)) {
      return specializedName;
    }
    this.specializedClasses.add(specializedName);

    const substMap = new Map();
    const rawParams = templateNode.typeParameters?.params || [];
    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const concreteType = typeArgs[i] || { type: "TSNumberKeyword" };
      substMap.set(pName, concreteType);
    });

    const specializedClassNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedClassNode };
  }

  instantiateGenericFunction(baseName, typeArgs) {
    const templateNode = this.genericFunctionTemplates.get(baseName);
    if (!templateNode) return baseName;

    const typeKeys = typeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedFunctions.has(specializedName)) {
      return specializedName;
    }
    this.specializedFunctions.add(specializedName);

    const substMap = new Map();
    const rawParams = templateNode.typeParameters?.params || [];
    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const concreteType = typeArgs[i] || { type: "TSNumberKeyword" };
      substMap.set(pName, concreteType);
    });

    const specializedFnNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedFnNode };
  }

  instantiateGenericStruct(baseName, typeArgs) {
    const isInterface = this.genericInterfaceTemplates.has(baseName);
    const templateNode = isInterface
      ? this.genericInterfaceTemplates.get(baseName)
      : this.genericTypeTemplates.get(baseName);

    if (!templateNode) return baseName;

    const rawParams = templateNode.typeParameters?.params || [];
    const substMap = new Map();
    const resolvedTypeArgs = [];

    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const defaultType = param.default || { type: "TSNumberKeyword" };
      const concreteType = typeArgs[i] || defaultType;
      substMap.set(pName, concreteType);
      resolvedTypeArgs.push(concreteType);
    });

    const typeKeys = resolvedTypeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedTypes.has(specializedName)) {
      return specializedName;
    }
    this.specializedTypes.add(specializedName);

    const specializedNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedNode, isInterface };
  }

  lower(program) {
    this.lowerModules([{ filePath: "main.ts", fileName: "main.ts", program, isEntry: true }]);
  }

  lowerModules(modules) {
    this.globals = new Map();

    // 0. Tüm modüllerdeki en üst düzey (global) değişken tanımlarını tespit et
    for (const mod of modules) {
      this.currentComments = mod.comments || [];
      this.currentSyntheticDecorators = mod.syntheticDecorators || new Map();
      for (const rawNode of mod.program.body) {
        const node = this.unwrapExport(rawNode);
        if (node.type === "VariableDeclaration") {
          for (const decl of node.declarations) {
            const varName = decl.id.name;
            let type = "f64";
            let isString = false;
            let initVal = 0;
            let structName = this.getStructName(decl.id.typeAnnotation);
            if (decl.id.typeAnnotation) {
              type = this.resolveType(decl.id.typeAnnotation);
              isString = this.isStringType(decl.id.typeAnnotation);
            } else if (decl.init) {
              if (decl.init.type === "BooleanLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "boolean")) {
                type = "i1";
                initVal = Boolean(decl.init.value);
              } else if (decl.init.type === "NumericLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "number")) {
                const raw = decl.init.raw || String(decl.init.value);
                const isInt = !raw.includes(".") && Number.isInteger(decl.init.value);
                type = isInt ? "i64" : "f64";
                initVal = decl.init.value;
              } else if (decl.init.type === "StringLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "string")) {
                type = "!llvm.ptr";
                isString = true;
                initVal = decl.init.value;
              } else if (decl.init.type === "TemplateLiteral") {
                type = "!llvm.ptr";
                isString = true;
              } else if (decl.init.type === "ArrayExpression") {
                type = "!llvm.ptr";
              } else if (decl.init.type === "ObjectExpression" || decl.init.type === "NewExpression") {
                type = "!llvm.ptr";
                structName = this.inferStructName(decl.init);
              } else if (decl.init.type === "BinaryExpression" && decl.init.operator === "+") {
                const isStr = (n) => n && (n.type === "StringLiteral" || (n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");
                if (isStr(decl.init.left) || isStr(decl.init.right)) {
                  type = "!llvm.ptr";
                  isString = true;
                }
              }
            }
            const globalSym = `@g_${varName}`;
            this.globals.set(varName, { name: varName, globalSym, type, isString, initVal, structName });
            this.builder.registerGlobal(globalSym, type, initVal);
          }
        }
      }
    }

    const allParsedNodes = [];
    const entryTopLevelStatements = [];
    const nonEntryTopLevelStatements = [];

    for (const mod of modules) {
      for (const rawNode of mod.program.body) {
        if (rawNode.type === "ImportDeclaration") continue;

        const isExported =
          rawNode.type === "ExportNamedDeclaration" ||
          rawNode.type === "ExportDefaultDeclaration";

        const node = this.unwrapExport(rawNode);

        const hasTypeParams =
          Boolean(node.typeParameters?.params?.length > 0) ||
          Boolean(node.typeParameters && Array.isArray(node.typeParameters.params));

        // Generic şablon fonksiyonlar doğrudan C sembolü olarak dışa aktarılmaz (monomorfize edilince aktarılır)
        if (isExported && (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") && !hasTypeParams) {
          if (node.id?.name) {
            const pragmas = this.getPragmas(rawNode);
            const finalName = pragmas.exportName || node.id.name;
            node.exportAlias = finalName;
            this.exportedFunctionNames.add(finalName);
            if (pragmas.napi) {
              node.isNapi = true;
              this.napiFunctions.push({
                origName: node.id.name,
                exportName: finalName,
                node,
              });
            }
          }
        }

        if (node.type === "ClassDeclaration" && hasTypeParams) {
          this.genericClassTemplates.set(node.id.name, node);
        } else if (node.type === "FunctionDeclaration" && hasTypeParams) {
          this.genericFunctionTemplates.set(node.id.name, node);
        } else if (node.type === "TSInterfaceDeclaration" && hasTypeParams) {
          this.genericInterfaceTemplates.set(node.id.name, node);
        } else if (node.type === "TSTypeAliasDeclaration" && hasTypeParams) {
          this.genericTypeTemplates.set(node.id.name, node);
        } else {
          allParsedNodes.push(node);
          if (
            node.type !== "TSInterfaceDeclaration" &&
            node.type !== "TSTypeAliasDeclaration" &&
            node.type !== "TSEnumDeclaration" &&
            node.type !== "ClassDeclaration" &&
            node.type !== "FunctionDeclaration" &&
            node.type !== "TSDeclareFunction"
          ) {
            if (mod.isEntry) {
              entryTopLevelStatements.push(node);
            } else {
              nonEntryTopLevelStatements.push(node);
            }
          }
        }
      }
    }

    const liftedLambdas = this.liftLambdas(allParsedNodes);
    for (const l of liftedLambdas) {
      allParsedNodes.push(l);
    }

    const synthesizedClasses = [];
    const synthesizedFunctions = [];

    const scanAndSpecialize = (rootNode) => {
      this.walkAST(rootNode, (n) => {
        if (n.type === "TSTypeReference") {
          const typeName = n.typeName?.name || n.typeName?.value;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (typeName && typeParams) {
            if (this.genericClassTemplates.has(typeName)) {
              const spec = this.instantiateGenericClass(typeName, typeParams);
              if (spec && spec.node) {
                synthesizedClasses.push(spec.node);
              }
              n.typeName.name = spec.specializedName || spec;
              delete n.typeParameters;
              delete n.typeArguments;
            } else if (this.genericInterfaceTemplates.has(typeName) || this.genericTypeTemplates.has(typeName)) {
              const spec = this.instantiateGenericStruct(typeName, typeParams);
              if (spec && spec.node) {
                if (spec.isInterface) {
                  this.lowerInterface(spec.node);
                } else {
                  this.registerTypeAlias(spec.node);
                }
              }
              n.typeName.name = spec.specializedName || spec;
              delete n.typeParameters;
              delete n.typeArguments;
            }
          }
        } else if (n.type === "NewExpression") {
          const calleeName = n.callee?.name;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (calleeName && this.genericClassTemplates.has(calleeName) && typeParams) {
            const spec = this.instantiateGenericClass(calleeName, typeParams);
            if (spec && spec.node) {
              synthesizedClasses.push(spec.node);
            }
            n.callee.name = spec.specializedName || spec;
            delete n.typeParameters;
            delete n.typeArguments;
          }
        } else if (n.type === "CallExpression") {
          const calleeName = n.callee?.name;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (calleeName && this.genericFunctionTemplates.has(calleeName) && typeParams) {
            const spec = this.instantiateGenericFunction(calleeName, typeParams);
            if (spec && spec.node) {
              synthesizedFunctions.push(spec.node);
            }
            n.callee.name = spec.specializedName || spec;
            delete n.typeParameters;
            delete n.typeArguments;
          }
        }
      });
    };

    for (const n of allParsedNodes) {
      scanAndSpecialize(n);
    }

    for (const clsNode of synthesizedClasses) {
      scanAndSpecialize(clsNode);
      allParsedNodes.push(clsNode);
    }
    for (const fnNode of synthesizedFunctions) {
      scanAndSpecialize(fnNode);
      allParsedNodes.push(fnNode);
    }

    // 1. Enum'ları kaydet
    for (const node of allParsedNodes) {
      if (node.type === "TSEnumDeclaration") {
        this.registerEnum(node);
      }
    }

    // 2. Type Alias ve Interfaceleri 2 geçişle kaydet (Kalıtım ve Kesişimleri tam bağlamak için)
    const typeAndInterfaceNodes = allParsedNodes.filter(
      (n) => n.type === "TSTypeAliasDeclaration" || n.type === "TSInterfaceDeclaration"
    );
    for (let pass = 0; pass < 2; pass++) {
      for (const node of typeAndInterfaceNodes) {
        if (node.type === "TSTypeAliasDeclaration") {
          this.registerTypeAlias(node);
        } else if (node.type === "TSInterfaceDeclaration") {
          this.lowerInterface(node);
        }
      }
    }

    const rawClasses = allParsedNodes.filter((n) => n.type === "ClassDeclaration");
    this.resolveClassHierarchy(rawClasses);

    for (const node of allParsedNodes) {
      if (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") {
        const funcName = node.id.name;
        const isAsync = Boolean(node.async);
        const isDeclare = Boolean(node.declare || node.type === "TSDeclareFunction" || !node.body);

        let innerRetType = "f64";
        const unwrappedRet = this.unwrapType(node.returnType);
        if (unwrappedRet && unwrappedRet.type === "TSTypeReference" && (unwrappedRet.typeName?.name === "Promise" || unwrappedRet.typeName?.value === "Promise")) {
          const innerParam = unwrappedRet.typeParameters?.params?.[0] || unwrappedRet.typeArguments?.params?.[0];
          innerRetType = innerParam ? this.resolveType(innerParam) : "none";
        } else if (node.returnType) {
          innerRetType = this.resolveType(node.returnType);
        } else {
          let hasReturnVal = false;
          if (node.body?.body) {
            this.walkAST(node.body, (n) => {
              if (n.type === "ReturnStatement" && n.argument) hasReturnVal = true;
            });
          }
          innerRetType = hasReturnVal ? "f64" : "none";
        }

        const retType = isAsync ? "!llvm.ptr" : innerRetType;
        const structRetName = this.getStructName(node.returnType);
        const enumRetName = this.getEnumName(node.returnType);
        const isRetString = this.isStringType(node.returnType);

        const rawParams = Array.isArray(node.params)
          ? node.params
          : Array.isArray(node.params?.items)
          ? node.params.items
          : [];
        const params = [];
        const paramTypes = [];

        rawParams.forEach((param, i) => {
          const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
          const isFn = this.isFunctionType(typeAnnot);
          const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
          const isUnion = this.isUnionType(typeAnnot);
          if (isUnion) {
            this.builder.markFeature("union");
          }
          const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
          const isStr = this.isStringType(typeAnnot);
          const pType = isFn ? fnSig.mlirType : (isUnion || isArr || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
          const enumName = this.getEnumName(typeAnnot);
          const isChan = this.unwrapType(typeAnnot)?.typeName?.name === "Channel";
          params.push({ name: param.name || `arg_${i}`, type: pType, isUnion, isArray: isArr, isFunction: isFn, fnSig, enumName, isChannel: isChan, isString: isStr });
          paramTypes.push(pType);
        });

        const declSig = retType === "none" ? `(${paramTypes.join(", ")})` : `(${paramTypes.join(", ")}) -> ${retType}`;
        const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
        this.functionRegistry.set(funcName, { isAsync, isDeclare, innerRetType, retType, structRetName, enumRetName, isRetString, params, paramTypes, mlirType, declSig });

        if (isDeclare) {
          this.builder.declareExternalFunction(funcName, declSig);
        }
      }
    }

    for (const cls of this.classList) {
      this.lowerClassMethods(cls.node);
    }

    this.emitVCallRouters();

    for (const node of allParsedNodes) {
      if (node.type === "FunctionDeclaration") {
        if (!node.declare && node.body) {
          this.lowerFunction(node);
        }
      }
    }

    this.emitSpawnRunners();
    this.emitNapiWrappers();

    this.builder.block("func.func @main() -> i32", () => {
      this.builder.hasTerminated = false;
      this.enterScope(true, "i32");

      for (const stmt of nonEntryTopLevelStatements) {
        this.lowerStatement(stmt);
      }
      for (const stmt of entryTopLevelStatements) {
        this.lowerStatement(stmt);
      }

      this.exitScope();
      const zero = this.builder.createConstant(0, "i32");
      this.builder.createReturn(zero);
    });
  }

  emitSpawnRunners() {
    for (const [targetFnName, { runnerName, targetMeta }] of this.spawnRunners.entries()) {
      this.builder.block(`func.func @${runnerName}(%arg_raw: !llvm.ptr) -> !llvm.ptr`, () => {
        if (targetMeta && targetMeta.params && targetMeta.params.length > 0) {
          const pType = targetMeta.params[0].type;
          this.builder.emit(`func.call @${targetFnName}(%arg_raw) : (${pType}) -> ()`);
        } else {
          this.builder.emit(`func.call @${targetFnName}() : () -> ()`);
        }
        const nullRet = this.builder.nextSSA();
        this.builder.emit(`${nullRet} = llvm.mlir.zero : !llvm.ptr`);
        this.builder.emit(`func.return ${nullRet} : !llvm.ptr`);
      });
    }
  }

  emitNapiWrappers() {
    NapiLowerer.emitNapiWrappers(this);
  }

  evalConstExpr(expr, scope = new Map()) {
    if (!expr) return 0;
    if (
      expr.type === "ParenthesizedExpression" ||
      expr.type === "TSAsExpression" ||
      expr.type === "NonNullExpression"
    ) {
      return this.evalConstExpr(expr.expression, scope);
    }
    if (expr.type === "MemberExpression") {
      const propName = expr.property?.name ?? expr.property?.value;
      if (scope.has(propName)) return scope.get(propName);
    }
    if (expr.type === "NumericLiteral" || (expr.type === "Literal" && typeof expr.value === "number")) {
      return expr.value;
    }
    if (expr.type === "Identifier" && scope.has(expr.name)) {
      return scope.get(expr.name);
    }
    if (expr.type === "BinaryExpression") {
      const left = this.evalConstExpr(expr.left, scope);
      const right = this.evalConstExpr(expr.right, scope);
      switch (expr.operator) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return Math.floor(left / right);
        case "%": return left % right;
        case "<<": return left << right;
        case ">>": return left >> right;
        case ">>>": return left >>> right;
        case "|": return left | right;
        case "&": return left & right;
        case "^": return left ^ right;
      }
    }
    if (expr.type === "UnaryExpression") {
      const arg = this.evalConstExpr(expr.argument, scope);
      if (expr.operator === "~") return ~arg;
      if (expr.operator === "-") return -arg;
      if (expr.operator === "+") return +arg;
    }
    return 0;
  }

  registerEnum(node) {
    const enumName = node.id.name;
    const members = new Map();
    const constScope = new Map();
    let currentVal = 0;
    let enumKind = "numeric";

    const rawMembers =
      node.members ||
      node.body?.members ||
      node.body?.body ||
      node.elements ||
      node.body?.elements ||
      (Array.isArray(node.body) ? node.body : []);

    for (const member of rawMembers) {
      const memberName =
        member.id?.name ??
        member.id?.value ??
        member.key?.name ??
        member.key?.value ??
        member.name;

      const init = member.initializer || member.init;

      if (init) {
        if (
          init.type === "StringLiteral" ||
          (init.type === "Literal" && typeof init.value === "string")
        ) {
          members.set(memberName, { type: "!llvm.ptr", value: init.value, isString: true });
          enumKind = "string";
        } else {
          // Sayısal veya Bitwise İfade (1 << 0, A | B vb.)
          currentVal = this.evalConstExpr(init, constScope);
          constScope.set(memberName, currentVal);
          members.set(memberName, { type: "i64", value: currentVal, isString: false });
          members.set(String(currentVal), { type: "!llvm.ptr", value: memberName, isString: true });
          currentVal++;
        }
      } else {
        constScope.set(memberName, currentVal);
        members.set(memberName, { type: "i64", value: currentVal, isString: false });
        members.set(String(currentVal), { type: "!llvm.ptr", value: memberName, isString: true });
        currentVal++;
      }
    }

    this.enumRegistry.set(enumName, { name: enumName, members, kind: enumKind });
  }

  registerTypeAlias(node) {
    const aliasName = node.id.name;
    let innerType = this.unwrapType(node.typeAnnotation);
    let isUntaggedUnion = false;

    // Untagged<{ ... }> kontrolü
    if (
      innerType.type === "TSTypeReference" &&
      (innerType.typeName?.name === "Untagged" || innerType.typeName?.value === "Untagged")
    ) {
      const typeArg = innerType.typeParameters?.params?.[0] || innerType.typeArguments?.params?.[0];
      if (typeArg) {
        innerType = this.unwrapType(typeArg);
        isUntaggedUnion = true;
      }
    }

    if (innerType.type === "TSTypeLiteral") {
      const rawMembers =
        innerType.members ||
        innerType.body?.body ||
        innerType.body?.members ||
        (Array.isArray(innerType.body) ? innerType.body : []);

      const fields = [];
      const types = [];

      rawMembers.forEach((member, index) => {
        const fieldName = member.key?.name || member.key?.value || member.name || member.id?.name;
        const typeAnnot = member.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const fieldType = isFn ? "!llvm.ptr" : this.resolveType(typeAnnot);
        const structName = this.getStructName(typeAnnot);
        const enumName = this.getEnumName(typeAnnot);
        const isString = this.isStringType(typeAnnot);
        const fieldIdx = isUntaggedUnion ? 0 : index;
        fields.push({
          name: fieldName,
          type: fieldType,
          structName,
          enumName,
          isString,
          isFunction: isFn,
          fnSig,
          index: fieldIdx,
        });
        types.push(fieldType);
      });

      const pragmas = this.getPragmas(node);
      const isPacked = pragmas.packed;

      // Untagged union bellek boyutu en büyük alan kadardır (LLVM seviyesinde !llvm.array<8 x i8>)
      const mlirType = isUntaggedUnion
        ? `!llvm.array<8 x i8>`
        : (isPacked ? `!llvm.struct<packed (${types.join(", ")})>` : `!llvm.struct<(${types.join(", ")})>`);

      this.structRegistry.set(aliasName, {
        name: aliasName,
        fields,
        types,
        mlirType,
        methods: new Map(),
        isUnion: isUntaggedUnion,
        isPacked,
      });
    } else if (innerType.type === "TSIntersectionType") {
      const mergedFields = [];
      const mergedTypes = [];
      let idx = 0;

      const typesList = innerType.types || [];
      for (const t of typesList) {
        const unwrappedT = this.unwrapType(t);
        const sName = this.getStructName(unwrappedT);
        if (sName && this.structRegistry.has(sName)) {
          const meta = this.structRegistry.get(sName);
          for (const f of meta.fields) {
            if (f.name !== "__type_id" && !mergedFields.some((mf) => mf.name === f.name)) {
              mergedFields.push({ ...f, index: idx++ });
              mergedTypes.push(f.type);
            }
          }
        } else if (unwrappedT.type === "TSTypeLiteral") {
          const rawMembers =
            unwrappedT.members ||
            unwrappedT.body?.body ||
            unwrappedT.body?.members ||
            (Array.isArray(unwrappedT.body) ? unwrappedT.body : []);

          rawMembers.forEach((member) => {
            const fieldName = member.key?.name || member.key?.value || member.name || member.id?.name;
            const typeAnnot = member.typeAnnotation;
            const isFn = this.isFunctionType(typeAnnot);
            const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
            const fieldType = isFn ? "!llvm.ptr" : this.resolveType(typeAnnot);
            const sNameSub = this.getStructName(typeAnnot);
            const enumName = this.getEnumName(typeAnnot);
            const isString = this.isStringType(typeAnnot);
            if (!mergedFields.some((mf) => mf.name === fieldName)) {
              mergedFields.push({
                name: fieldName,
                type: fieldType,
                structName: sNameSub,
                enumName,
                isString,
                isFunction: isFn,
                fnSig,
                index: idx++,
              });
              mergedTypes.push(fieldType);
            }
          });
        }
      }
      const mlirType = `!llvm.struct<(${mergedTypes.join(", ")})>`;
      this.structRegistry.set(aliasName, { name: aliasName, fields: mergedFields, mlirType, methods: new Map() });
    }

    this.typeAliasRegistry.set(aliasName, innerType);
  }

  lowerInterface(node) {
    const structName = node.id.name;
    const fields = [];
    const types = [];

    // 1. Interface Kalıtımı (interface EntityHeader extends Base, Identifiable)
    const extendsList = node.extends || node.heritage || [];
    const heritageClauses = Array.isArray(extendsList) ? extendsList : [extendsList];
    for (const h of heritageClauses) {
      const parentName = h.expression?.name || h.expression?.value || h.id?.name || h.name;
      if (parentName && this.structRegistry.has(parentName)) {
        const parentMeta = this.structRegistry.get(parentName);
        for (const f of parentMeta.fields) {
          if (f.name !== "__type_id" && !fields.some((existing) => existing.name === f.name)) {
            fields.push({ ...f, index: fields.length });
            types.push(f.type);
          }
        }
      }
    }

    // 2. Kendi Alanları (Own members)
    const members =
      node.members ||
      node.body?.body ||
      node.body?.members ||
      (Array.isArray(node.body) ? node.body : []);

    members.forEach((member) => {
      if (member.type === "TSPropertySignature" || member.key) {
        const fieldName = member.key?.name || member.key?.value || member.name;
        const existingIdx = fields.findIndex((f) => f.name === fieldName);
        const typeAnnot = member.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const fieldType = isFn ? "!llvm.ptr" : this.resolveType(typeAnnot);
        const sName = this.getStructName(typeAnnot);
        const enumName = this.getEnumName(typeAnnot);
        const isString = this.isStringType(typeAnnot);

        if (existingIdx !== -1) {
          fields[existingIdx] = {
            name: fieldName,
            type: fieldType,
            structName: sName,
            enumName,
            isString,
            isFunction: isFn,
            fnSig,
            index: existingIdx,
          };
          types[existingIdx] = fieldType;
        } else {
          fields.push({
            name: fieldName,
            type: fieldType,
            structName: sName,
            enumName,
            isString,
            isFunction: isFn,
            fnSig,
            index: fields.length,
          });
          types.push(fieldType);
        }
      }
    });

    const pragmas = this.getPragmas(node);
    const isPacked = pragmas.packed;
    const mlirType = isPacked ? `!llvm.struct<packed (${types.join(", ")})>` : `!llvm.struct<(${types.join(", ")})>`;
    this.structRegistry.set(structName, { name: structName, fields, mlirType, methods: new Map(), isPacked });
  }

  resolveClassHierarchy(rawClasses) {
    const classMap = new Map();
    for (const node of rawClasses) {
      const name = node.id.name;
      const superClass = node.superClass?.name || null;
      classMap.set(name, { node, name, superClass });
    }

    const visited = new Set();
    const ordered = [];

    const visit = (name) => {
      if (visited.has(name)) return;
      const item = classMap.get(name);
      if (!item) return;
      if (item.superClass) visit(item.superClass);
      visited.add(name);
      ordered.push(item);
    };

    for (const name of classMap.keys()) {
      visit(name);
    }

    this.classList = ordered;
    let nextTypeId = 1;

    for (const { node, name, superClass } of ordered) {
      const parentMeta = superClass ? this.structRegistry.get(superClass) : null;
      const fields = [];
      const types = [];
      const typeId = nextTypeId++;

      fields.push({ name: "__type_id", type: "i32", index: 0 });
      types.push("i32");

      if (parentMeta) {
        for (let i = 1; i < parentMeta.fields.length; i++) {
          const f = parentMeta.fields[i];
          fields.push({
            name: f.name,
            type: f.type,
            structName: f.structName,
            isString: f.isString,
            index: fields.length,
          });
          types.push(f.type);
        }
      }

      const bodyElements = node.body?.body || [];
      const ownMethods = new Map();

      for (const elem of bodyElements) {
        if (elem.type === "PropertyDefinition") {
          const fieldName = elem.key.name || elem.key.value;
          const fieldType = this.resolveType(elem.typeAnnotation);
          const structName = this.getStructName(elem.typeAnnotation);
          const isString = this.isStringType(elem.typeAnnotation);
          fields.push({ name: fieldName, type: fieldType, structName, isString, index: fields.length });
          types.push(fieldType);
        } else if (elem.type === "MethodDefinition") {
          const mName = elem.key.name || elem.key.value;
          const isConstructor = elem.kind === "constructor";
          const retType = isConstructor ? "none" : this.resolveType(elem.value?.returnType);
          const structRetName = isConstructor ? name : this.getStructName(elem.value?.returnType);
          const isRetString = !isConstructor && this.isStringType(elem.value?.returnType);

          const rawParams = Array.isArray(elem.value?.params)
            ? elem.value.params
            : Array.isArray(elem.value?.params?.items)
            ? elem.value.params.items
            : [];
          const params = [];
          rawParams.forEach((param, i) => {
            const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
            const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
            const isFn = this.isFunctionType(typeAnnot);
            const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
            const isUnion = this.isUnionType(typeAnnot);
            const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
            const pType = isFn ? fnSig.mlirType : (isUnion || isArr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
            params.push({ name: pName, type: pType, isUnion, isArray: isArr, isFunction: isFn, fnSig });
          });

          ownMethods.set(mName, {
            name: mName,
            className: name,
            isConstructor,
            retType,
            structRetName,
            isRetString,
            params,
            node: elem,
          });
        }
      }

      const mlirType = `!llvm.struct<(${types.join(", ")})>`;
      this.structRegistry.set(name, {
        name,
        superClass,
        typeId,
        fields,
        types,
        mlirType,
        methods: ownMethods,
        isClass: true,
      });
    }
  }

  emitVCallRouters() {
    ClassLowerer.emitVCallRouters(this);
  }

  lowerClassMethods(node) {
    const className = node.id.name;
    const bodyElements = node.body?.body || [];

    for (const elem of bodyElements) {
      if (elem.type !== "MethodDefinition") continue;

      const isConstructor = elem.kind === "constructor";
      const methodName = elem.key.name || elem.key.value;
      const fnName = isConstructor ? `${className}_constructor` : `${className}_${methodName}`;

      const fnExpr = elem.value;
      const rawParams = Array.isArray(fnExpr.params)
        ? fnExpr.params
        : Array.isArray(fnExpr.params?.items)
        ? fnExpr.params.items
        : [];

      const paramStrings = [`%arg_this: !llvm.ptr`];
      const params = [{ name: "this", ssa: "%arg_this", type: "!llvm.ptr", structName: className }];

      rawParams.forEach((param, i) => {
        const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
        const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const isUnion = this.isUnionType(typeAnnot);
        const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
        const isStr = this.isStringType(typeAnnot);
        const pType = isFn ? fnSig.mlirType : (isUnion || isArr || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
        const structName = this.getStructName(typeAnnot);
        const ssaArg = `%arg_${pName}`;

        paramStrings.push(`${ssaArg}: ${pType}`);
        params.push({ name: pName, ssa: ssaArg, type: pType, structName, isUnion, isArray: isArr, isFunction: isFn, fnSig, typeAnnot, isString: isStr });
      });

      const retType = isConstructor ? "none" : this.resolveType(fnExpr.returnType);
      const sig = retType === "none" ? "" : ` -> ${retType}`;

      this.builder.block(`func.func @${fnName}(${paramStrings.join(", ")})${sig}`, () => {
        this.currentFunctionNode = elem.value;
        this.enterScope(true, retType);

        const prevSyms = new Map(this.symbolTable);
        this.symbolTable.clear();

        this.symbolTable.set("this", {
          ptr: "%arg_this",
          ssa: "%arg_this",
          type: "!llvm.ptr",
          structName: className,
          isRef: true,
        });

        for (const p of params) {
          if (p.name === "this") continue;
          if (p.isFunction) {
            this.symbolTable.set(p.name, {
              ssa: p.ssa,
              ptr: p.ssa,
              type: p.type,
              isFunction: true,
              fnSig: p.fnSig,
            });
          } else if (p.isUnion) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              isUnion: true,
              unionNode: p.typeAnnot,
            });
          } else if (p.isArray) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              isArray: true,
              isRef: true,
            });
          } else if (p.structName) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              structName: p.structName,
              isRef: true,
            });
          } else {
            const slot = this.builder.allocateStack(p.type);
            this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
            this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true, isString: p.isString });
          }
        }

        if (fnExpr.body?.body) {
          for (const s of fnExpr.body.body) {
            this.lowerStatement(s);
          }
        }

        if (retType === "none") {
          this.exitScope();
          this.builder.createReturn();
        } else if (this.scopeStack.length > 0 && this.scopeStack[this.scopeStack.length - 1].isFunction) {
          this.scopeStack.pop();
        }

        this.symbolTable = prevSyms;
      });
    }
  }

  // --- ASYNC & STANDART FONKSİYON LOWERING ---
  lowerFunction(node) {
    const funcName = node.id.name;
    const isAsync = Boolean(node.async);
    const fnMeta = this.functionRegistry.get(funcName);

    const params = [];
    const paramStrings = [];
    const paramTypes = [];

    const rawParams = Array.isArray(node.params)
      ? node.params
      : Array.isArray(node.params?.items)
      ? node.params.items
      : [];

    rawParams.forEach((param, i) => {
      const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
      const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
      const isFn = this.isFunctionType(typeAnnot);
      const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
      const isUnion = this.isUnionType(typeAnnot);
      if (isUnion) {
        this.builder.markFeature("union");
      }
      const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
      const isChan = this.unwrapType(typeAnnot)?.typeName?.name === "Channel";
      const isStr = this.isStringType(typeAnnot);
      const pType = isFn ? fnSig.mlirType : (isUnion || isArr || isChan || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
      const structName = this.getStructName(typeAnnot);

      const ssaArg = `%arg_${pName}`;
      paramStrings.push(`${ssaArg}: ${pType}`);
      paramTypes.push(pType);
      params.push({ name: pName, ssa: ssaArg, type: pType, structName, isUnion, isArray: isArr, isFunction: isFn, fnSig, typeAnnot, isChannel: isChan, isString: isStr });
    });

    const innerRetType = fnMeta?.innerRetType || "f64";
    const retType = isAsync ? "!llvm.ptr" : innerRetType;
    const structRetName = fnMeta?.structRetName || this.getStructName(node.returnType);

    // A. ASYNC FUNCTION: Arka plan thread'ine lifting
    if (isAsync) {
      this.builder.markFeature("threads");
      const innerName = `__async_inner_${funcName}`;
      const runnerName = `__async_runner_${funcName}`;
      const innerSig = innerRetType === "none" ? "" : ` -> ${innerRetType}`;

      // 1. İç mantık fonksiyonu (@__async_inner_*)
      this.builder.block(`func.func @${innerName}(${paramStrings.join(", ")})${innerSig}`, () => {
        this.enterScope(true, innerRetType);
        const prevSyms = new Map(this.symbolTable);

        for (const p of params) {
          const slot = this.builder.allocateStack(p.type);
          this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
          this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true, isString: p.isString });
        }

        if (node.body?.body) {
          for (const s of node.body.body) {
            this.lowerStatement(s);
          }
        }

        if (innerRetType === "none") {
          this.exitScope();
          this.builder.createReturn();
        }
        this.symbolTable = prevSyms;
      });

      // 2. pthread runner fonksiyonu (@__async_runner_*)
      this.builder.block(`func.func @${runnerName}(%arg_ctx: !llvm.ptr) -> !llvm.ptr`, () => {
        const callArgs = [];
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p.type === "f64") {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr %arg_ctx[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            const loaded = this.builder.load(gep, "f64");
            callArgs.push(loaded.ssa);
          } else {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr %arg_ctx[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            const loaded = this.builder.load(gep, "!llvm.ptr");
            callArgs.push(loaded.ssa);
          }
        }

        const callStr = callArgs.join(", ");
        const typeStr = paramTypes.join(", ");

        if (innerRetType === "none") {
          this.builder.emit(`func.call @${innerName}(${callStr}) : (${typeStr}) -> ()`);
        } else {
          const resSSA = this.builder.nextSSA();
          this.builder.emit(`${resSSA} = func.call @${innerName}(${callStr}) : (${typeStr}) -> ${innerRetType}`);
          if (innerRetType === "f64") {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr %arg_ctx[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${resSSA}, ${resGEP} : f64, !llvm.ptr`);
          } else {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr %arg_ctx[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${resSSA}, ${resGEP} : !llvm.ptr, !llvm.ptr`);
          }
        }

        const nullRet = this.builder.nextSSA();
        this.builder.emit(`${nullRet} = llvm.mlir.zero : !llvm.ptr`);
        this.builder.emit(`func.return ${nullRet} : !llvm.ptr`);
      });

      // 3. Çağrıcı fonksiyon (@compute: TaskContext ayırır, pthread_create başlatır ve döner)
      this.builder.block(`func.func @${funcName}(${paramStrings.join(", ")}) -> !llvm.ptr`, () => {
        const ctxSz = this.builder.nextSSA();
        this.builder.emit(`${ctxSz} = llvm.mlir.constant(48 : i64) : i64`);
        const taskPtr = this.builder.nextSSA();
        this.builder.emit(`${taskPtr} = llvm.call @malloc(${ctxSz}) : (i64) -> !llvm.ptr`);

        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p.type === "f64") {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr ${taskPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${p.ssa}, ${gep} : f64, !llvm.ptr`);
          } else {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr ${taskPtr}[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${p.ssa}, ${gep} : !llvm.ptr, !llvm.ptr`);
          }
        }

        const nullAttr = this.builder.nextSSA();
        this.builder.emit(`${nullAttr} = llvm.mlir.zero : !llvm.ptr`);

        // DÜZELTME: Runner fonksiyonunu func.constant ile alıp func.call ile pthread_create'e geçiyoruz
        const runnerAddr = this.builder.nextSSA();
        this.builder.emit(`${runnerAddr} = func.constant @${runnerName} : (!llvm.ptr) -> !llvm.ptr`);

        const createRes = this.builder.nextSSA();
        this.builder.emit(
          `${createRes} = func.call @pthread_create(${taskPtr}, ${nullAttr}, ${runnerAddr}, ${taskPtr}) : (!llvm.ptr, !llvm.ptr, (!llvm.ptr) -> !llvm.ptr, !llvm.ptr) -> i32`
        );

        this.builder.emit(`func.return ${taskPtr} : !llvm.ptr`);
      });

      return;
    }

    // B. STANDART SENKRON FONKSİYON
    const pragmas = this.getPragmas(node);
    // Generic somutlamaları (örn. mirror_f64) her zaman kendi funcName adıyla basılmalıdır
    const effectiveFnName = (funcName.includes("_") && !node.exportAlias)
      ? funcName
      : (node.exportAlias || pragmas.exportName || funcName);

    let attrStr = "";
    if (pragmas.inline) {
      attrStr = ` attributes {passthrough = ["alwaysinline"]}`;
    } else if (pragmas.noinline) {
      attrStr = ` attributes {passthrough = ["noinline"]}`;
    }

    const sig = retType === "none" ? "" : ` -> ${retType}`;
    this.builder.block(`func.func @${effectiveFnName}(${paramStrings.join(", ")})${sig}${attrStr}`, () => {
      this.currentFunctionNode = node;
      this.builder.hasTerminated = false;
      this.enterScope(true, retType, structRetName);
      const prevSyms = new Map(this.symbolTable);

      for (const p of params) {
        if (p.isFunction) {
          this.symbolTable.set(p.name, {
            ssa: p.ssa,
            ptr: p.ssa,
            type: p.type,
            isFunction: true,
            fnSig: p.fnSig,
          });
        } else if (p.isUnion) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isUnion: true,
            unionNode: p.typeAnnot,
          });
        } else if (p.isArray) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isArray: true,
            isRef: true,
          });
        } else if (p.isChannel) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isChannel: true,
            isRef: true,
          });
        } else if (p.isChannel) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isChannel: true,
            isRef: true,
          });
        } else if (p.structName) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            structName: p.structName,
            isRef: true,
          });
        } else {
          const slot = this.builder.allocateStack(p.type);
          this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
          this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true, isString: p.isString });
        }
      }

      if (node.body?.body) {
        for (const stmt of node.body.body) {
          this.lowerStatement(stmt);
        }
      }

      if (!this.builder.hasTerminated) {
        if (retType === "none") {
          this.exitScope();
          this.builder.createReturn();
        } else if (retType === "!llvm.ptr") {
          const nullPtr = this.builder.nextSSA();
          this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
          this.exitScope();
          this.builder.createReturn({ ssa: nullPtr, type: "!llvm.ptr" });
        } else {
          const defVal = this.builder.createConstant(0, retType);
          this.exitScope();
          this.builder.createReturn(defVal);
        }
      } else if (this.scopeStack.length > 0 && this.scopeStack[this.scopeStack.length - 1].isFunction) {
        this.scopeStack.pop();
      }

      this.symbolTable = prevSyms;
    });
  }

  lowerStatement(stmt) {
    switch (stmt.type) {
      case "TryStatement": {
        // Eğer sadece try {} finally {} ise setjmp/longjmp ek yüküne girmeden doğrudan defer çalıştır!
        if (!stmt.handler && stmt.finalizer) {
          this.enterScope(false);
          const currentScope = this.scopeStack[this.scopeStack.length - 1];
          currentScope.deferrals.push(stmt.finalizer);
          this.lowerStatement(stmt.block);
          this.exitScope();
          break;
        }

        this.builder.markFeature("exceptions");
        const localJmpBuf = this.builder.allocateStack("!llvm.array<200 x i8>");
        const gJmpBufAddr = this.builder.nextSSA();
        this.builder.emit(`${gJmpBufAddr} = llvm.mlir.addressof @rts_current_jmpbuf : !llvm.ptr`);
        const prevJmpBuf = this.builder.load(gJmpBufAddr, "!llvm.ptr");
        this.builder.store(gJmpBufAddr, { ssa: localJmpBuf.ptr, type: "!llvm.ptr" });

        const setjmpRes = this.builder.nextSSA();
        this.builder.emit(`${setjmpRes} = llvm.call @setjmp(${localJmpBuf.ptr}) : (!llvm.ptr) -> i32`);

        const zero = this.builder.createConstant(0, "i32");
        const cmp = this.builder.createComparison("==", { ssa: setjmpRes, type: "i32" }, zero);

        this.enterScope(false);
        if (stmt.finalizer) {
          const currentScope = this.scopeStack[this.scopeStack.length - 1];
          currentScope.deferrals.push(stmt.finalizer);
        }

        this.builder.createIf(
          cmp,
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.block);
            this.builder.store(gJmpBufAddr, prevJmpBuf);
            this.exitScope();
          },
          stmt.handler
            ? () => {
                this.enterScope(false);
                this.builder.store(gJmpBufAddr, prevJmpBuf);
                const gExcAddr = this.builder.nextSSA();
                this.builder.emit(`${gExcAddr} = llvm.mlir.addressof @rts_current_exception : !llvm.ptr`);
                const thrownVal = this.builder.load(gExcAddr, "!llvm.ptr");

                const paramName = stmt.handler.param?.name || "e";
                const prevSym = this.symbolTable.get(paramName);

                const excSlot = this.builder.allocateStack("!llvm.ptr");
                this.builder.store(excSlot.ptr, thrownVal);
                this.symbolTable.set(paramName, {
                  ptr: excSlot.ptr,
                  type: "!llvm.ptr",
                  isString: true,
                  isRef: true,
                });

                this.lowerStatement(stmt.handler.body);

                if (prevSym) this.symbolTable.set(paramName, prevSym);
                else this.symbolTable.delete(paramName);
                this.exitScope();
              }
            : null
        );

        this.exitScope();
        break;
      }

      case "ThrowStatement": {
        const excVal = this.lowerExpression(stmt.argument);
        const gExcAddr = this.builder.nextSSA();
        this.builder.emit(`${gExcAddr} = llvm.mlir.addressof @rts_current_exception : !llvm.ptr`);
        this.builder.store(gExcAddr, { ssa: excVal.ssa || excVal.ptr, type: "!llvm.ptr" });

        const gJmpBufAddr = this.builder.nextSSA();
        this.builder.emit(`${gJmpBufAddr} = llvm.mlir.addressof @rts_current_jmpbuf : !llvm.ptr`);
        const currJmpBuf = this.builder.load(gJmpBufAddr, "!llvm.ptr");

        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        const isNull = this.builder.createComparison("==", currJmpBuf, { ssa: nullPtr, type: "!llvm.ptr" });

        this.builder.createIf(
          isNull,
          () => {
            const fmtErr = this.builder.nextSSA();
            this.builder.emit(`${fmtErr} = llvm.mlir.addressof @fmt_uncaught_err : !llvm.ptr`);
            this.builder.emit(`llvm.call @printf(${fmtErr}, ${excVal.ssa || excVal.ptr}) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr) -> i32`);
            this.builder.emit(`llvm.call @abort() : () -> ()`);
          },
          () => {
            const one = this.builder.createConstant(1, "i32");
            this.builder.emit(`llvm.call @longjmp(${currJmpBuf.ssa}, ${one.ssa}) : (!llvm.ptr, i32) -> ()`);
          }
        );
        break;
      }

      case "VariableDeclaration": {
        const isUsing = stmt.kind === "using";
        for (const decl of stmt.declarations) {
          const varName = decl.id.name;
          const isUnion = this.isUnionType(decl.id.typeAnnotation);
          const explicitStruct = this.getStructName(decl.id.typeAnnotation);

          // ESCAPE KONTROLÜ: Nesne fonksiyon dışına sızmıyorsa stack'e yükselt
          let canStackAllocate = false;
          if (decl.init) {
            if (decl.init.type === "NewExpression") {
              const cls = decl.init.callee.name;
              if (cls !== "Map" && cls !== "Set") {
                const escapes = this.checkEscape(varName, this.currentFunctionNode);
                if (!escapes) {
                  canStackAllocate = true;
                }
              }
            } else if (decl.init.type === "ObjectExpression") {
              const escapes = this.checkEscape(varName, this.currentFunctionNode);
              if (!escapes) {
                canStackAllocate = true;
              }
            }
          }

          // Modül seviyesinde küresel bir değişkense:
          if (this.globals && this.globals.has(varName) && this.scopeStack.length === 1) {
            const g = this.globals.get(varName);
            if (decl.init) {
              let val;
              if (decl.init.type === "NewExpression") {
                val = this.lowerNewExpression(decl.init, false);
              } else if (decl.init.type === "ObjectExpression") {
                const sName = this.inferStructName(decl.init, explicitStruct);
                const ptr = this.instantiateStruct(decl.init, sName, false);
                val = {
                  ssa: ptr,
                  ptr: ptr,
                  type: "!llvm.ptr",
                  structName: sName,
                  isRef: true,
                  isHeap: true,
                  isStack: false,
                };
              } else {
                val = this.lowerExpression(decl.init);
              }

              const addr = this.builder.nextSSA();
              this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
              const coerced = this.coerceType(val, g.type);
              this.builder.store(addr, coerced);

              const finalStruct = explicitStruct || val.structName || g.structName;
              if (finalStruct) g.structName = finalStruct;
              if (val.isArray || (decl.init && decl.init.type === "ArrayExpression")) g.isArray = true;
              if (val.isMap) g.isMap = true;
              if (val.isSet) g.isSet = true;
              if (val.isString) {
                g.isString = true;
                g.type = "!llvm.ptr";
              }
            }
            continue;
          }

          if (isUnion) {
            const slot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
            if (decl.init) {
              const val = this.lowerExpression(decl.init);
              this.boxIntoUnion(slot.ptr, val);
            }
            this.symbolTable.set(varName, {
              ptr: slot.ptr,
              ssa: slot.ptr,
              type: "!llvm.ptr",
              isUnion: true,
              unionNode: decl.id.typeAnnotation,
            });
          } else if (decl.init) {
            let val;
            if (decl.init.type === "NewExpression" && canStackAllocate) {
              val = this.lowerNewExpression(decl.init, true);
            } else if (decl.init.type === "ObjectExpression") {
              const sName = this.inferStructName(decl.init, explicitStruct);
              const ptr = this.instantiateStruct(decl.init, sName, canStackAllocate);
              val = {
                ssa: ptr,
                ptr: ptr,
                type: "!llvm.ptr",
                structName: sName,
                isRef: true,
                isHeap: !canStackAllocate,
                isStack: canStackAllocate,
              };
            } else {
              val = this.lowerExpression(decl.init);
            }

            if (val.isArena || val.isPool || val.isFixedBuffer) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isArena: val.isArena,
                isPool: val.isPool,
                isFixedBuffer: val.isFixedBuffer,
                isRef: true,
              });
            } else if (val.isChannel) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isChannel: true,
                isRef: true,
              });
              if (decl.init.type === "Identifier" && !val.isBorrowed) {
                const srcSym = this.symbolTable.get(decl.init.name);
                if (srcSym) {
                  srcSym.isMoved = true;
                  this.markTransferred(srcSym.ptr || srcSym.ssa);
                }
              }
            } else if (val.isMap || val.isSet) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isMap: val.isMap,
                isSet: val.isSet,
                valType: val.valType,
                isRef: true,
              });
            } else if (val.isPromise) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isPromise: true,
                innerRetType: val.innerRetType,
                isRef: true,
              });
            } else if (val.isFunction) {
              this.symbolTable.set(varName, {
                ssa: val.ssa,
                ptr: val.ssa,
                type: val.type,
                isFunction: true,
                fnSig: val.fnSig,
              });
            } else if (val.isArray || (decl.init && decl.init.type === "ArrayExpression")) {
              this.symbolTable.set(varName, {
                ptr: val.ptr || val.ssa,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isArray: true,
                arrayLen: val.arrayLen || val.length,
                elemType: val.elemType || "f64",
                isRef: true,
              });
            } else if (decl.init.type === "NewExpression") {
              if (stmt.kind === "let") {
                const slot = this.builder.allocateStack("!llvm.ptr");
                this.builder.store(slot.ptr, val);
                this.symbolTable.set(varName, {
                  ptr: slot.ptr,
                  type: "!llvm.ptr",
                  structName: val.structName,
                  isRef: true,
                  isSlot: true,
                  isHeap: val.isHeap,
                  isStack: val.isStack,
                });
              } else {
                this.symbolTable.set(varName, {
                  ptr: val.ssa,
                  type: "!llvm.ptr",
                  structName: val.structName,
                  isRef: true,
                });
              }
            } else {
              const finalStruct = explicitStruct || val.structName;

              if (finalStruct) {
                if (stmt.kind === "let") {
                  const slot = this.builder.allocateStack("!llvm.ptr");
                  this.builder.store(slot.ptr, val);
                  this.symbolTable.set(varName, {
                    ptr: slot.ptr,
                    type: "!llvm.ptr",
                    structName: finalStruct,
                    isRef: true,
                    isSlot: true,
                    isHeap: val.isHeap,
                    isStack: val.isStack,
                  });
                } else {
                  this.symbolTable.set(varName, {
                    ptr: val.ssa || val.ptr,
                    type: "!llvm.ptr",
                    structName: finalStruct,
                    isRef: true,
                    isHeap: val.isHeap,
                    isStack: val.isStack,
                  });
                }

                // Move Semantiği: Sağdaki ifade doğrudan bir Identifier ise sahipliği taşı
                if (decl.init.type === "Identifier" && !val.isBorrowed) {
                  const srcSym = this.symbolTable.get(decl.init.name);
                  if (srcSym && (srcSym.isHeap || srcSym.structName || srcSym.isChannel)) {
                    srcSym.isMoved = true;
                    // Taşıma yapıldığı için önceki sahibinin çift free yapmasını önle
                    this.markTransferred(srcSym.ptr || srcSym.ssa);
                  }
                }
              } else {
                const slot = this.builder.allocateStack(val.type);
                this.builder.store(slot.ptr, val);
                this.symbolTable.set(varName, {
                  ptr: slot.ptr,
                  type: val.type,
                  isRef: true,
                  isString: val.isString || this.isStringType(decl.id.typeAnnotation),
                });
              }
            }

            if (isUsing) {
              const sym = this.symbolTable.get(varName);
              const targetPtr = val.ptr || val.ssa || sym?.ptr;
              const isAlloc = Boolean(sym?.isArena || val.isArena || sym?.isPool || val.isPool || sym?.isFixedBuffer || val.isFixedBuffer);
              if (targetPtr && (val.isHeap || val.isStack || sym?.structName || sym?.isMap || sym?.isSet || val.isArray || isAlloc)) {
                this.trackDisposable(targetPtr, sym?.structName || val.structName, Boolean(val.isStack), {
                  isArena: Boolean(sym?.isArena || val.isArena),
                  isPool: Boolean(sym?.isPool || val.isPool),
                  isFixedBuffer: Boolean(sym?.isFixedBuffer || val.isFixedBuffer),
                });
              }
            }
          } else {
            // decl.init bulunmayan değişken tanımları (örn: let outer: Counter; veya let x: number;)
            const resolvedType = decl.id.typeAnnotation ? this.resolveType(decl.id.typeAnnotation) : "f64";
            const isString = this.isStringType(decl.id.typeAnnotation);
            const finalStruct = explicitStruct || (this.structRegistry.has(resolvedType) ? resolvedType : null);

            if (finalStruct || resolvedType === "!llvm.ptr") {
              const slot = this.builder.allocateStack("!llvm.ptr");
              const zeroPtr = this.builder.nextSSA();
              this.builder.emit(`${zeroPtr} = llvm.mlir.zero : !llvm.ptr`);
              this.builder.store(slot.ptr, { ssa: zeroPtr, type: "!llvm.ptr" });
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                type: "!llvm.ptr",
                structName: finalStruct,
                isRef: true,
                isSlot: true,
                isHeap: false,
                isString: isString,
              });
            } else {
              const slot = this.builder.allocateStack(resolvedType);
              const zeroConst = this.builder.createConstant(0, resolvedType);
              this.builder.store(slot.ptr, zeroConst);
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                type: resolvedType,
                isRef: true,
                isString: isString,
              });
            }
          }
        }
        break;
      }

      case "ExpressionStatement": {
        if (stmt.expression.type === "CallExpression" && stmt.expression.callee.type === "Super") {
          const thisSym = this.symbolTable.get("this");
          const classMeta = this.structRegistry.get(thisSym.structName);
          if (!classMeta.superClass) {
            throw new Error(`[Lowering] '${classMeta.name}' bir üst sınıfa sahip değil!`);
          }

          const superConstructor = `${classMeta.superClass}_constructor`;
          const parentMeta = this.structRegistry.get(classMeta.superClass);
          const ctorMeta = parentMeta?.methods?.get("constructor");

          const args = stmt.expression.arguments ? stmt.expression.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const paramMeta = ctorMeta?.params?.[i];
            if (paramMeta?.isUnion && !val.isUnion) {
              const uSlot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
              this.boxIntoUnion(uSlot.ptr, val);
              return { ssa: uSlot.ptr, ptr: uSlot.ptr, type: "!llvm.ptr", isUnion: true };
            }
            if (val.isUnion) {
              return { ssa: val.ssa || val.ptr, ptr: val.ssa || val.ptr, type: "!llvm.ptr", isUnion: true };
            }
            if (paramMeta && !val.isFunction) {
              val = this.coerceType(val, paramMeta.type);
            }
            return val;
          }) : [];
          const allArgsSSA = [thisSym.ptr, ...args.map((a) => a.ssa || a.ptr)];
          const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

          this.builder.emit(
            `func.call @${superConstructor}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`
          );
          return;
        }

        this.lowerExpression(stmt.expression);
        break;
      }

      case "ForStatement": {
        this.enterScope(false);
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            this.lowerStatement(stmt.init);
          } else {
            this.lowerExpression(stmt.init);
          }
        }
        this.builder.createWhile(
          () => (stmt.test ? this.lowerExpression(stmt.test) : this.builder.createConstant(1, "i1")),
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.body);
            if (stmt.update) {
              this.lowerExpression(stmt.update);
            }
            this.exitScope();
          }
        );
        this.exitScope();
        break;
      }

      case "WhileStatement": {
        this.builder.createWhile(
          () => this.lowerExpression(stmt.test),
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.body);
            this.exitScope();
          }
        );
        break;
      }

      case "IfStatement": {
        const typeofCheck = this.extractTypeofCheck(stmt.test);
        let originalSym = null;
        let narrowedVarName = null;

        if (typeofCheck) {
          const sym = this.symbolTable.get(typeofCheck.varName);
          if (sym && sym.isUnion) {
            narrowedVarName = typeofCheck.varName;
            originalSym = sym;
          }
        }

        const cond = this.lowerExpression(stmt.test);
        const thenBlock = this.builder.nextBlock("then");
        const elseBlock = stmt.alternate ? this.builder.nextBlock("else") : null;
        const mergeBlock = this.builder.nextBlock("merge");

        const falseTarget = elseBlock || mergeBlock;
        this.builder.emitBranchConditional(cond.ssa, thenBlock, falseTarget);

        // --- THEN BLOĞU ---
        this.builder.emitBlockLabel(thenBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);
        if (narrowedVarName) {
          const unboxed = this.unboxUnion(originalSym.ptr || originalSym.ssa, typeofCheck.targetType);
          if (unboxed) {
            this.symbolTable.set(narrowedVarName, unboxed);
          }
        }
        this.lowerStatement(stmt.consequent);
        if (narrowedVarName) {
          this.symbolTable.set(narrowedVarName, originalSym);
        }
        this.exitScope();

        const thenTerminated = this.builder.hasTerminated;
        if (!thenTerminated) {
          this.builder.emitBranch(mergeBlock);
        }

        // --- ELSE BLOĞU ---
        let elseTerminated = false;
        if (elseBlock) {
          this.builder.emitBlockLabel(elseBlock);
          this.builder.hasTerminated = false;
          this.enterScope(false);
          if (narrowedVarName) {
            let otherType = null;
            if (typeofCheck.targetType === "string") otherType = "number";
            else if (typeofCheck.targetType === "number") otherType = "string";

            if (otherType) {
              const unboxed = this.unboxUnion(originalSym.ptr || originalSym.ssa, otherType);
              if (unboxed) {
                this.symbolTable.set(narrowedVarName, unboxed);
              }
            }
          }
          this.lowerStatement(stmt.alternate);
          if (narrowedVarName) {
            this.symbolTable.set(narrowedVarName, originalSym);
          }
          this.exitScope();

          elseTerminated = this.builder.hasTerminated;
          if (!elseTerminated) {
            this.builder.emitBranch(mergeBlock);
          }
        }

        // --- MERGE BLOĞU ---
        if (!thenTerminated || (elseBlock && !elseTerminated) || !elseBlock) {
          this.builder.emitBlockLabel(mergeBlock);
          this.builder.hasTerminated = false;
        } else {
          this.builder.hasTerminated = true;
        }
        break;
      }

      case "BlockStatement": {
        this.enterScope(false);
        for (const s of stmt.body) {
          if (this.builder.hasTerminated) break;
          this.lowerStatement(s);
        }
        this.exitScope();
        break;
      }

      case "ReturnStatement": {
        const expectedRet = this.getCurrentFunctionRetType();
        if (stmt.argument) {
          let val = this.lowerExpression(stmt.argument);
          if (expectedRet && expectedRet !== "none") {
            val = this.coerceType(val, expectedRet);
          }
          if (val.type === "!llvm.ptr" || val.isHeap) {
            this.markTransferred(val.ssa || val.ptr);
          }
          this.cleanupFunctionScopes();
          this.builder.createReturn(val);
        } else {
          this.cleanupFunctionScopes();
          this.builder.createReturn();
        }
        break;
      }
    }
  }

  lowerNewExpression(expr, canStackAllocate = false) {
    const className = expr.callee.name;

    if (className === "Channel") {
      this.builder.markFeature("channels");
      this.builder.markFeature("threads");
      let capVal = { ssa: "", type: "i64" };
      if (expr.arguments && expr.arguments.length > 0) {
        capVal = this.coerceType(this.lowerExpression(expr.arguments[0]), "i64");
      } else {
        capVal = this.builder.createConstant(1, "i64");
      }
      const ptr = this.builder.nextSSA();
      this.builder.emit(`${ptr} = func.call @rts_chan_new(${capVal.ssa}) : (i64) -> !llvm.ptr`);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        isChannel: true,
        isRef: true,
        isHeap: true,
      };
    }

    if (className === "Arena") {
      this.builder.markFeature("allocators");
      this.builder.markFeature("heap");
      this.builder.markFeature("exceptions");
      let capVal = { ssa: "", type: "i64" };
      if (expr.arguments && expr.arguments.length > 0) {
        capVal = this.coerceType(this.lowerExpression(expr.arguments[0]), "i64");
      } else {
        capVal = this.builder.createConstant(64 * 1024, "i64");
      }
      const ptr = this.builder.nextSSA();
      this.builder.emit(`${ptr} = func.call @rts_arena_new(${capVal.ssa}) : (i64) -> !llvm.ptr`);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        isArena: true,
        isRef: true,
        isHeap: true,
      };
    }

    if (className === "Pool") {
      this.builder.markFeature("allocators");
      this.builder.markFeature("heap");
      this.builder.markFeature("exceptions");
      let chunkSz = { ssa: "", type: "i64" };
      let chunkCnt = { ssa: "", type: "i64" };
      if (expr.arguments && expr.arguments.length >= 2) {
        chunkSz = this.coerceType(this.lowerExpression(expr.arguments[0]), "i64");
        chunkCnt = this.coerceType(this.lowerExpression(expr.arguments[1]), "i64");
      } else {
        chunkSz = this.builder.createConstant(64, "i64");
        chunkCnt = this.builder.createConstant(16, "i64");
      }
      const ptr = this.builder.nextSSA();
      this.builder.emit(`${ptr} = func.call @rts_pool_new(${chunkSz.ssa}, ${chunkCnt.ssa}) : (i64, i64) -> !llvm.ptr`);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        isPool: true,
        isRef: true,
        isHeap: true,
      };
    }

    if (className === "FixedBuffer") {
      this.builder.markFeature("allocators");
      this.builder.markFeature("heap");
      this.builder.markFeature("exceptions");
      let capVal = { ssa: "", type: "i64" };
      if (expr.arguments && expr.arguments.length > 0) {
        capVal = this.coerceType(this.lowerExpression(expr.arguments[0]), "i64");
      } else {
        capVal = this.builder.createConstant(1024, "i64");
      }
      const ptr = this.builder.nextSSA();
      this.builder.emit(`${ptr} = func.call @rts_fixed_buffer_new(${capVal.ssa}) : (i64) -> !llvm.ptr`);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        isFixedBuffer: true,
        isRef: true,
        isHeap: true,
      };
    }

    if (className === "Map" || className === "Set") {
      this.builder.markFeature("map");
      const isMap = className === "Map";
      const typeParams = expr.typeParameters?.params || expr.typeArguments?.params;
      let valType = "f64";
      if (isMap && typeParams && typeParams[1]) {
        const t = this.unwrapType(typeParams[1]);
        if (t?.type === "TSStringKeyword") valType = "string";
      }

      const ptr = this.builder.nextSSA();
      this.builder.emit(`${ptr} = func.call @rts_map_new() : () -> !llvm.ptr`);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        isMap,
        isSet: !isMap,
        valType,
        isRef: true,
        isHeap: true,
      };
    }

    const classMeta = this.structRegistry.get(className);
    if (!classMeta) {
      throw new Error(`[Lowering] Tanımsız sınıf: ${className}`);
    }

    // Escape etmiyorsa heap yerine doğrudan stack (alloca) kullan!
    let slot;
    if (canStackAllocate) {
      slot = this.builder.allocateStack(classMeta.mlirType);
    } else {
      const byteSize = Math.max(classMeta.fields.length * 8, 8);
      slot = this.builder.allocateHeap(byteSize);
    }

    const typeIdConst = this.builder.nextSSA();
    this.builder.emit(`${typeIdConst} = arith.constant ${classMeta.typeId} : i32`);
    this.builder.emit(`llvm.store ${typeIdConst}, ${slot.ptr} : i32, !llvm.ptr`);

    if (classMeta.methods.has("constructor")) {
      const ctorMeta = classMeta.methods.get("constructor");
      const args = expr.arguments ? expr.arguments.map((a, i) => {
        let val = this.lowerExpression(a);
        const paramMeta = ctorMeta?.params?.[i];
        if (paramMeta?.isUnion && !val.isUnion) {
          const uSlot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
          this.boxIntoUnion(uSlot.ptr, val);
          return { ssa: uSlot.ptr, ptr: uSlot.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (val.isUnion) {
          return { ssa: val.ssa || val.ptr, ptr: val.ssa || val.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (paramMeta && !val.isFunction) {
          val = this.coerceType(val, paramMeta.type);
        }
        return val;
      }) : [];
      const allArgsSSA = [slot.ptr, ...args.map((a) => a.ssa || a.ptr)];
      const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

      this.builder.emit(
        `func.call @${className}_constructor(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`
      );
    }

    return {
      ssa: slot.ptr,
      ptr: slot.ptr,
      type: "!llvm.ptr",
      structName: className,
      isRef: true,
      isHeap: !canStackAllocate,
      isStack: canStackAllocate,
    };
  }

  inferStructName(objExpr, hintStructName = null) {
    if (hintStructName && this.structRegistry.has(hintStructName)) {
      return hintStructName;
    }
    const propNames = objExpr.properties.map((p) => p.key?.name || p.key?.value);
    for (const [sName, sMeta] of this.structRegistry.entries()) {
      const metaFields = sMeta.fields.filter((f) => f.name !== "__type_id").map((f) => f.name);
      if (sMeta.isUnion) {
        if (propNames.length > 0 && propNames.every((p) => metaFields.includes(p))) {
          return sName;
        }
      } else {
        if (propNames.length === metaFields.length && propNames.every((p) => metaFields.includes(p))) {
          return sName;
        }
      }
    }
    throw new Error(`[Lowering] Nesne alanlarıyla (${propNames.join(", ")}) eşleşen bir interface/class bulunamadı!`);
  }

  instantiateStruct(objExpr, structName, canStackAllocate = false) {
    const structMeta = this.structRegistry.get(structName);
    let slot;
    if (canStackAllocate) {
      slot = this.builder.allocateStack(structMeta.mlirType);
    } else {
      const byteSize = structMeta.isUnion ? 8 : Math.max(structMeta.fields.length * 8, 8);
      slot = this.builder.allocateHeap(byteSize);
    }

    if (structMeta.isClass && structMeta.typeId) {
      const typeIdConst = this.builder.nextSSA();
      this.builder.emit(`${typeIdConst} = arith.constant ${structMeta.typeId} : i32`);
      this.builder.emit(`llvm.store ${typeIdConst}, ${slot.ptr} : i32, !llvm.ptr`);
    }

    if (structMeta.isUnion) {
      if (objExpr.properties.length > 0) {
        // C union standardı: İlk alan başlangıç değerini (active variant) belirler
        const prop = objExpr.properties[0];
        const fieldName = prop.key.name || prop.key.value;
        const fieldMeta = structMeta.fields.find((f) => f.name === fieldName);
        if (fieldMeta) {
          let val = this.lowerExpression(prop.value);
          val = this.coerceType(val, fieldMeta.type);
          this.builder.store(slot.ptr, val);
        }
      }
      return slot.ptr;
    }

    for (const prop of objExpr.properties) {
      const fieldName = prop.key.name || prop.key.value;
      const fieldMeta = structMeta.fields.find((f) => f.name === fieldName);
      if (!fieldMeta) {
        throw new Error(`[Lowering] '${structName}' üzerinde '${fieldName}' alanı bulunamadı!`);
      }
      let val = this.lowerExpression(prop.value);

      if (fieldMeta.isFunction && (val.isFunction || val.type !== "!llvm.ptr")) {
        const castSSA = this.builder.nextSSA();
        this.builder.emit(
          `${castSSA} = builtin.unrealized_conversion_cast ${val.ssa || val.ptr} : ${val.type} to !llvm.ptr`
        );
        val = { ssa: castSSA, ptr: castSSA, type: "!llvm.ptr" };
      } else {
        val = this.coerceType(val, fieldMeta.type);
      }

      const fieldPtr = this.builder.nextSSA();
      this.builder.emit(
        `${fieldPtr} = llvm.getelementptr ${slot.ptr}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
      );
      this.builder.store(fieldPtr, val);
    }

    return slot.ptr;
  }

  instantiateArray(arrExpr) {
    const len = arrExpr.elements.length;
    const byteSize = Math.max((len + 1) * 8, 16);
    const heapSlot = this.builder.allocateHeap(byteSize);

    const lenConst = this.builder.nextSSA();
    this.builder.emit(`${lenConst} = llvm.mlir.constant(${len} : i64) : i64`);
    this.builder.emit(`llvm.store ${lenConst}, ${heapSlot.ptr} : i64, !llvm.ptr`);

    arrExpr.elements.forEach((elem, index) => {
      let val = this.lowerExpression(elem);
      val = this.coerceType(val, "f64");
      const idxConst = this.builder.nextSSA();
      const elemPtr = this.builder.nextSSA();

      this.builder.emit(`${idxConst} = llvm.mlir.constant(${index + 1} : i64) : i64`);
      this.builder.emit(
        `${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
      );
      this.builder.store(elemPtr, val);
    });

    return { ptr: heapSlot.ptr, length: len, arrayLen: len, elemType: "f64", isHeap: true, isArray: true };
  }

  lowerExpression(expr) {
    if (!expr) return { ssa: "", type: "none" };

    if (
      expr.type === "ParenthesizedExpression" ||
      expr.type === "TSAsExpression" ||
      expr.type === "NonNullExpression" ||
      expr.type === "TSSatisfiesExpression"
    ) {
      return this.lowerExpression(expr.expression);
    }

    // --- ADIM 7: AWAIT İFADESİ (pthread_join) ---
    if (expr.type === "AwaitExpression") {
      const task = this.lowerExpression(expr.argument);
      const threadIdPtr = this.builder.nextSSA();
      this.builder.emit(`${threadIdPtr} = llvm.getelementptr ${task.ssa || task.ptr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
      const threadId = this.builder.load(threadIdPtr, "i64");

      const nullPtr = this.builder.nextSSA();
      this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);

      const joinRes = this.builder.nextSSA();
      this.builder.emit(`${joinRes} = llvm.call @pthread_join(${threadId.ssa}, ${nullPtr}) : (i64, !llvm.ptr) -> i32`);

      const isStringRes = task.innerRetType === "!llvm.ptr" || task.isString || task.isPromise && task.innerRetType === "string";
      if (isStringRes) {
        const resPtrGEP = this.builder.nextSSA();
        this.builder.emit(`${resPtrGEP} = llvm.getelementptr ${task.ssa || task.ptr}[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
        const loaded = this.builder.load(resPtrGEP, "!llvm.ptr");
        loaded.isString = true;
        return loaded;
      } else {
        const resF64GEP = this.builder.nextSSA();
        this.builder.emit(`${resF64GEP} = llvm.getelementptr ${task.ssa || task.ptr}[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
        return this.builder.load(resF64GEP, "f64");
      }
    }

    if (expr.type === "ArrayExpression") {
      const arrMeta = this.instantiateArray(expr);
      return {
        ssa: arrMeta.ptr,
        ptr: arrMeta.ptr,
        type: "!llvm.ptr",
        isArray: true,
        arrayLen: arrMeta.length,
        length: arrMeta.length,
        elemType: arrMeta.elemType,
        isHeap: true,
        isRef: true,
      };
    }

    if (expr.type === "ObjectExpression") {
      const structName = this.inferStructName(expr);
      const ptr = this.instantiateStruct(expr, structName);
      return {
        ssa: ptr,
        ptr: ptr,
        type: "!llvm.ptr",
        structName: structName,
        isRef: true,
        isHeap: true,
      };
    }

    if (expr.type === "StringLiteral" || (expr.type === "Literal" && typeof expr.value === "string")) {
      const sym = this.builder.getOrRegisterString(expr.value);
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = llvm.mlir.addressof ${sym} : !llvm.ptr`);
      return { ssa, type: "!llvm.ptr", isString: true, isHeap: false };
    }

    if (expr.type === "TemplateLiteral") {
      let result = null;

      for (let i = 0; i < expr.quasis.length; i++) {
        const text = expr.quasis[i].value?.raw ?? expr.quasis[i].value?.cooked ?? "";
        if (text.length > 0) {
          const sym = this.builder.getOrRegisterString(text);
          const ssa = this.builder.nextSSA();
          this.builder.emit(`${ssa} = llvm.mlir.addressof ${sym} : !llvm.ptr`);
          const textVal = { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
          result = result ? this.builder.createStringConcat(result, textVal) : textVal;
        }

        if (i < expr.expressions.length) {
          let exprVal = this.lowerExpression(expr.expressions[i]);
          exprVal = this.builder.convertToString(exprVal);
          result = result ? this.builder.createStringConcat(result, exprVal) : exprVal;
        }
      }

      if (!result) {
        const sym = this.builder.getOrRegisterString("");
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.mlir.addressof ${sym} : !llvm.ptr`);
        return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
      }

      return result;
    }

    if (expr.type === "NumericLiteral" || (expr.type === "Literal" && typeof expr.value === "number")) {
      const raw = expr.raw || String(expr.value);
      const isInteger = !raw.includes(".") && Number.isInteger(expr.value);

      if (isInteger) {
        return this.builder.createConstant(expr.value, "i64");
      } else {
        return this.builder.createConstant(expr.value, "f64");
      }
    }

    if (expr.type === "BooleanLiteral" || (expr.type === "Literal" && typeof expr.value === "boolean")) {
      return this.builder.createConstant(expr.value, "i1");
    }

    if (expr.type === "NullLiteral" || (expr.type === "Literal" && expr.value === null)) {
      const nullPtr = this.builder.nextSSA();
      this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
      return { ssa: nullPtr, ptr: nullPtr, type: "!llvm.ptr", isNull: true, isHeap: false };
    }

    if (expr.type === "ThisExpression") {
      const thisSym = this.symbolTable.get("this");
      if (!thisSym) throw new Error("[Lowering] 'this' sadece metotlarda kullanılabilir!");
      return {
        ssa: thisSym.ptr,
        ptr: thisSym.ptr,
        type: "!llvm.ptr",
        structName: thisSym.structName,
        isRef: true,
      };
    }

    if (expr.type === "NewExpression") {
      return this.lowerNewExpression(expr);
    }

    if (expr.type === "UnaryExpression" && expr.operator === "-") {
      let val = this.lowerExpression(expr.argument);
      if (val.type === "f64" || val.type === "f32") {
        const zero = this.builder.createConstant(0.0, val.type);
        return this.builder.createArithmetic("-", zero, val);
      } else {
        const zero = this.builder.createConstant(0, val.type === "i32" ? "i32" : "i64");
        return this.builder.createArithmetic("-", zero, val);
      }
    }

    if (expr.type === "UnaryExpression" && expr.operator === "+") {
      let val = this.lowerExpression(expr.argument);
      if (val.type !== "f64" && val.type !== "f32" && val.type !== "i64" && val.type !== "i32") {
        val = this.coerceType(val, "f64");
      }
      return val;
    }

    if (expr.type === "UnaryExpression" && expr.operator === "!") {
      let val = this.lowerExpression(expr.argument);
      if (val.type === "!llvm.ptr") {
        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        return this.builder.createComparison("==", val, { ssa: nullPtr, type: "!llvm.ptr" });
      }
      val = this.coerceType(val, "i1");
      const trueConst = this.builder.createConstant(1, "i1");
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.xori ${val.ssa}, ${trueConst.ssa} : i1`);
      return { ssa, type: "i1" };
    }

    if (expr.type === "UnaryExpression" && expr.operator === "~") {
      let val = this.lowerExpression(expr.argument);
      val = this.coerceType(val, "i64");
      return this.builder.createBitwiseNot(val);
    }

    if (expr.type === "UnaryExpression" && expr.operator === "typeof") {
      const arg = expr.argument;
      if (arg.type === "Identifier") {
        const sym = this.symbolTable.get(arg.name);
        if (sym && sym.isUnion) {
          this.builder.markFeature("union");
          const ssa = this.builder.nextSSA();
          this.builder.emit(`${ssa} = func.call @rts_union_typeof(${sym.ptr || sym.ssa}) : (!llvm.ptr) -> !llvm.ptr`);
          return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
        }
      }

      const val = this.lowerExpression(arg);
      let typeName = "object";
      if (val.isString) typeName = "string";
      else if (val.type === "i64" || val.type === "f64" || val.type === "i32") typeName = "number";
      else if (val.type === "i1") typeName = "boolean";

      const sym = this.builder.getOrRegisterString(typeName);
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = llvm.mlir.addressof ${sym} : !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
    }

    if (expr.type === "UpdateExpression") {
      const isInc = expr.operator === "++";
      const op = isInc ? "+" : "-";

      if (expr.argument.type === "Identifier") {
        let ptr = null;
        let type = null;
        if (this.symbolTable.has(expr.argument.name)) {
          const sym = this.symbolTable.get(expr.argument.name);
          ptr = sym.ptr;
          type = sym.type;
        } else if (this.globals && this.globals.has(expr.argument.name)) {
          const g = this.globals.get(expr.argument.name);
          const addr = this.builder.nextSSA();
          this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
          ptr = addr;
          type = g.type;
        }
        if (ptr && type) {
          const oldVal = this.builder.load(ptr, type);
          const step = type === "i64" || type === "i32" ? 1 : 1.0;
          const one = this.builder.createConstant(step, type);
          const newVal = this.builder.createArithmetic(op, oldVal, one);
          this.builder.store(ptr, newVal);
          return expr.prefix ? newVal : oldVal;
        }
      } else if (expr.argument.type === "MemberExpression") {
        const base = this.lowerExpression(expr.argument.object);
        if (expr.argument.computed) {
          let idxVal = this.lowerExpression(expr.argument.property);
          idxVal = this.coerceType(idxVal, "i64");
          const oneIdx = this.builder.createConstant(1, "i64");
          const realIdx = this.builder.createArithmetic("+", idxVal, oneIdx);
          const elemPtr = this.builder.nextSSA();
          this.builder.emit(
            `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
          );
          const oldVal = this.builder.load(elemPtr, "f64");
          const one = this.builder.createConstant(1.0, "f64");
          const newVal = this.builder.createArithmetic(op, oldVal, one);
          this.builder.store(elemPtr, newVal);
          return expr.prefix ? newVal : oldVal;
        } else if (base.structName) {
          const structMeta = this.structRegistry.get(base.structName);
          const fieldName = expr.argument.property.name || expr.argument.property.value;
          const fieldMeta = structMeta?.fields.find((f) => f.name === fieldName);
          if (fieldMeta) {
            const fieldPtr = this.builder.nextSSA();
            this.builder.emit(
              `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
            );
            const oldVal = this.builder.load(fieldPtr, fieldMeta.type);
            const step = fieldMeta.type === "i64" || fieldMeta.type === "i32" ? 1 : 1.0;
            const one = this.builder.createConstant(step, fieldMeta.type);
            const newVal = this.builder.createArithmetic(op, oldVal, one);
            this.builder.store(fieldPtr, newVal);
            return expr.prefix ? newVal : oldVal;
          }
        }
      }
    }

    if (expr.type === "Identifier") {
      if (expr.name === "undefined") {
        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        return { ssa: nullPtr, ptr: nullPtr, type: "!llvm.ptr", isNull: true, isUndefined: true, isHeap: false };
      }
      if (this.symbolTable.has(expr.name)) {
        const sym = this.symbolTable.get(expr.name);

        if (sym.isFunction) {
          return {
            ssa: sym.ssa,
            ptr: sym.ptr,
            type: sym.type,
            isFunction: true,
            fnSig: sym.fnSig,
          };
        }
        if (sym.isUnion) {
          return {
            ssa: sym.ptr,
            ptr: sym.ptr,
            type: "!llvm.ptr",
            isUnion: true,
            unionNode: sym.unionNode,
          };
        }
        if (sym.structName || sym.isArray || sym.isMap || sym.isSet || sym.isPromise || sym.isChannel || sym.isArena || sym.isPool || sym.isFixedBuffer) {
          if (sym.isSlot) {
            const loaded = this.builder.load(sym.ptr, "!llvm.ptr");
            return {
              ssa: loaded.ssa,
              ptr: loaded.ssa,
              type: "!llvm.ptr",
              structName: sym.structName,
              isArray: sym.isArray,
              isMap: sym.isMap,
              isSet: sym.isSet,
              isPromise: sym.isPromise,
              isChannel: sym.isChannel,
              isArena: sym.isArena,
              isPool: sym.isPool,
              isFixedBuffer: sym.isFixedBuffer,
              innerRetType: sym.innerRetType,
              valType: sym.valType,
              arrayLen: sym.arrayLen,
              isHeap: true,
            };
          }
          return {
            ssa: sym.ptr,
            ptr: sym.ptr,
            type: "!llvm.ptr",
            structName: sym.structName,
            isArray: sym.isArray,
            isMap: sym.isMap,
            isSet: sym.isSet,
            isPromise: sym.isPromise,
            isChannel: sym.isChannel,
            isArena: sym.isArena,
            isPool: sym.isPool,
            isFixedBuffer: sym.isFixedBuffer,
            innerRetType: sym.innerRetType,
            valType: sym.valType,
            arrayLen: sym.arrayLen,
            isHeap: true,
          };
        }
        const loaded = this.builder.load(sym.ptr, sym.type);
        if (sym.isString) loaded.isString = true;
        return loaded;
      }

      if (this.globals && this.globals.has(expr.name)) {
        const g = this.globals.get(expr.name);
        const addr = this.builder.nextSSA();
        this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
        const loaded = this.builder.load(addr, g.type);
        if (g.isString) loaded.isString = true;
        if (g.structName) {
          loaded.structName = g.structName;
          loaded.ptr = loaded.ssa;
        }
        if (g.isArray) {
          loaded.isArray = true;
          loaded.ptr = loaded.ssa;
        }
        if (g.isMap) loaded.isMap = true;
        if (g.isSet) loaded.isSet = true;
        return loaded;
      }

      if (this.functionRegistry.has(expr.name)) {
        const fnMeta = this.functionRegistry.get(expr.name);
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = func.constant @${expr.name} : ${fnMeta.mlirType}`);
        return {
          ssa,
          ptr: ssa,
          type: fnMeta.mlirType,
          isFunction: true,
          fnSig: {
            paramTypes: fnMeta.paramTypes,
            retType: fnMeta.retType,
            mlirType: fnMeta.mlirType,
          },
        };
      }

      throw new Error(`[Lowering] Tanımsız değişken veya fonksiyon: ${expr.name}`);
    }

    if (expr.type === "MemberExpression") {
      if (expr.object.type === "Identifier" && this.enumRegistry.has(expr.object.name)) {
        const enumMeta = this.enumRegistry.get(expr.object.name);
        let memberName = null;

        if (expr.computed) {
          if (
            expr.property.type === "NumericLiteral" ||
            (expr.property.type === "Literal" && typeof expr.property.value === "number")
          ) {
            memberName = String(expr.property.value);
          } else if (
            expr.property.type === "StringLiteral" ||
            (expr.property.type === "Literal" && typeof expr.property.value === "string")
          ) {
            memberName = expr.property.value;
          }
        } else {
          memberName = expr.property.name || expr.property.value;
        }

        if (!memberName || !enumMeta.members.has(memberName)) {
          throw new Error(`[Lowering] '${enumMeta.name}' enum'ında '${memberName}' üyesi bulunamadı!`);
        }

        const member = enumMeta.members.get(memberName);
        if (member.isString) {
          const sym = this.builder.getOrRegisterString(member.value);
          const ssa = this.builder.nextSSA();
          this.builder.emit(`${ssa} = llvm.mlir.addressof ${sym} : !llvm.ptr`);
          return { ssa, type: "!llvm.ptr", isString: true, isHeap: false };
        } else {
          return this.builder.createConstant(member.value, "i64");
        }
      }

      const base = this.lowerExpression(expr.object);

      if (!expr.computed && (expr.property.name || expr.property.value) === "size" && (base.isMap || base.isSet)) {
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = func.call @rts_map_size(${base.ptr || base.ssa}) : (!llvm.ptr) -> i64`);
        return { ssa, type: "i64" };
      }

      if (!expr.computed && (expr.property.name || expr.property.value) === "length") {
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.load ${base.ptr || base.ssa} : !llvm.ptr -> i64`);
        return { ssa, type: "i64" };
      }

      if (expr.computed) {
        let idxVal = this.lowerExpression(expr.property);
        idxVal = this.coerceType(idxVal, "i64");
        const one = this.builder.createConstant(1, "i64");
        const realIdx = this.builder.createArithmetic("+", idxVal, one);

        const elemPtr = this.builder.nextSSA();
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
        );
        return this.builder.load(elemPtr, "f64");
      }

      if (base.structName) {
        const structMeta = this.structRegistry.get(base.structName);
        const fieldName = expr.property.name || expr.property.value;
        const fieldMeta = structMeta?.fields.find((f) => f.name === fieldName);

        if (!fieldMeta) {
          return { base, methodName: fieldName, isMethodRef: true, structName: base.structName };
        }

        if (structMeta.isUnion) {
          const res = this.builder.load(base.ptr || base.ssa, fieldMeta.type);
          if (fieldMeta.isString) res.isString = true;
          if (fieldMeta.structName) res.structName = fieldMeta.structName;
          return res;
        }

        const fieldPtr = this.builder.nextSSA();
        this.builder.emit(
          `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
        );
        const res = this.builder.load(fieldPtr, fieldMeta.type);
        if (fieldMeta.isString) {
          res.isString = true;
        }
        if (fieldMeta.structName) {
          res.structName = fieldMeta.structName;
        }
        return res;
      }

      // Güvenli Fallback: Eşleşmeyen üye erişimleri için varsayılan nesne döndür
      return { ssa: base.ssa || base.ptr || "", type: "!llvm.ptr", structName: null };
    }

    if (expr.type === "AssignmentExpression") {
      const isCompound = expr.operator !== "=";
      const op = isCompound ? expr.operator.slice(0, -1) : null;
      let rhs = this.lowerExpression(expr.right);

      if (expr.left.type === "MemberExpression") {
        const base = this.lowerExpression(expr.left.object);

        if (expr.left.computed) {
          let idxVal = this.lowerExpression(expr.left.property);
          idxVal = this.coerceType(idxVal, "i64");
          const one = this.builder.createConstant(1, "i64");
          const realIdx = this.builder.createArithmetic("+", idxVal, one);

          const elemPtr = this.builder.nextSSA();
          this.builder.emit(
            `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
          );
          if (isCompound) {
            const curVal = this.builder.load(elemPtr, "f64");
            rhs = this.coerceType(rhs, "f64");
            rhs = this.builder.createArithmetic(op, curVal, rhs);
          } else {
            rhs = this.coerceType(rhs, "f64");
          }
          this.builder.store(elemPtr, rhs);
          return rhs;
        }

        if (base.structName) {
          const structMeta = this.structRegistry.get(base.structName);
          const fieldName = expr.left.property.name || expr.left.property.value;
          const fieldMeta = structMeta?.fields.find((f) => f.name === fieldName);

          const fieldPtr = this.builder.nextSSA();
          this.builder.emit(
            `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
          );

          if (isCompound) {
            let curVal = this.builder.load(fieldPtr, fieldMeta.type);
            if (fieldMeta.isString) curVal.isString = true;
            if (op === "+" && (curVal.isString || rhs.isString)) {
              const leftStr = this.builder.convertToString(curVal);
              const rightStr = this.builder.convertToString(rhs);
              rhs = this.builder.createStringConcat(leftStr, rightStr);
            } else if (["|", "&", "^", "<<", ">>", ">>>"].includes(op)) {
              const lInt = this.coerceType(curVal, "i64");
              const rInt = this.coerceType(rhs, "i64");
              rhs = this.builder.createArithmetic(op, lInt, rInt);
              rhs = this.coerceType(rhs, fieldMeta.type);
            } else {
              rhs = this.builder.createArithmetic(op, curVal, rhs);
              rhs = this.coerceType(rhs, fieldMeta.type);
            }
          } else {
            rhs = this.coerceType(rhs, fieldMeta.type);
          }

          this.builder.store(fieldPtr, rhs);

          if (rhs.type === "!llvm.ptr" || rhs.isHeap) {
            this.markTransferred(rhs.ssa || rhs.ptr);
          }
          return rhs;
        }
      } else if (expr.left.type === "Identifier") {
        if (this.symbolTable.has(expr.left.name)) {
          const sym = this.symbolTable.get(expr.left.name);
          if (isCompound) {
            let curVal = this.builder.load(sym.ptr, sym.type);
            if (sym.isString) curVal.isString = true;
            if (op === "+" && (curVal.isString || rhs.isString)) {
              const leftStr = this.builder.convertToString(curVal);
              const rightStr = this.builder.convertToString(rhs);
              rhs = this.builder.createStringConcat(leftStr, rightStr);
              sym.isString = true;
            } else if (["|", "&", "^", "<<", ">>", ">>>"].includes(op)) {
              const lInt = this.coerceType(curVal, "i64");
              const rInt = this.coerceType(rhs, "i64");
              rhs = this.builder.createArithmetic(op, lInt, rInt);
              rhs = this.coerceType(rhs, sym.type);
            } else {
              rhs = this.builder.createArithmetic(op, curVal, rhs);
              rhs = this.coerceType(rhs, sym.type);
            }
          } else {
            if (sym.isUnion) {
              this.boxIntoUnion(sym.ptr, rhs);
              return { ssa: sym.ptr, ptr: sym.ptr, type: "!llvm.ptr", isUnion: true };
            }
            rhs = this.coerceType(rhs, sym.type);
          }
          this.builder.store(sym.ptr, rhs);
          if (rhs.isString) sym.isString = true;
          if (rhs.type === "!llvm.ptr" || rhs.isHeap) {
            this.markTransferred(rhs.ssa || rhs.ptr);
          }
          return rhs;
        } else if (this.globals && this.globals.has(expr.left.name)) {
          const g = this.globals.get(expr.left.name);
          const addr = this.builder.nextSSA();
          this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
          if (isCompound) {
            let curVal = this.builder.load(addr, g.type);
            if (g.isString) curVal.isString = true;
            if (op === "+" && (curVal.isString || rhs.isString)) {
              const leftStr = this.builder.convertToString(curVal);
              const rightStr = this.builder.convertToString(rhs);
              rhs = this.builder.createStringConcat(leftStr, rightStr);
              g.isString = true;
            } else if (["|", "&", "^", "<<", ">>", ">>>"].includes(op)) {
              const lInt = this.coerceType(curVal, "i64");
              const rInt = this.coerceType(rhs, "i64");
              rhs = this.builder.createArithmetic(op, lInt, rInt);
              rhs = this.coerceType(rhs, g.type);
            } else {
              rhs = this.builder.createArithmetic(op, curVal, rhs);
              rhs = this.coerceType(rhs, g.type);
            }
          } else {
            rhs = this.coerceType(rhs, g.type);
          }
          this.builder.store(addr, rhs);
          if (rhs.isString) g.isString = true;
          if (rhs.type === "!llvm.ptr" || rhs.isHeap) {
            this.markTransferred(rhs.ssa || rhs.ptr);
          }
          return rhs;
        }
        throw new Error(`[Lowering] Atama yapılan tanımsız değişken: '${expr.left.name}'`);
      }
    }

    if (expr.type === "LogicalExpression") {
      const lhs = this.lowerExpression(expr.left);
      const rhs = this.lowerExpression(expr.right);
      return this.builder.createLogical(expr.operator, lhs, rhs);
    }

    if (expr.type === "BinaryExpression") {
      const lhs = this.lowerExpression(expr.left);
      const rhs = this.lowerExpression(expr.right);

      if (expr.operator === "+" && (lhs.isString || rhs.isString)) {
        const leftStr = this.builder.convertToString(lhs);
        const rightStr = this.builder.convertToString(rhs);
        return this.builder.createStringConcat(leftStr, rightStr);
      }

      if (["+", "-", "*", "/", "%", "|", "&", "^", "<<", ">>", ">>>"].includes(expr.operator)) {
        if (["|", "&", "^", "<<", ">>", ">>>"].includes(expr.operator)) {
          const lInt = this.coerceType(lhs, "i64");
          const rInt = this.coerceType(rhs, "i64");
          return this.builder.createArithmetic(expr.operator, lInt, rInt);
        }
        return this.builder.createArithmetic(expr.operator, lhs, rhs);
      }
      if (["<", "<=", ">", ">=", "==", "===", "!=", "!=="].includes(expr.operator)) {
        return this.builder.createComparison(expr.operator, lhs, rhs);
      }
    }

    if (expr.type === "CallExpression") {
      if (expr.callee.type === "Identifier" && expr.callee.name === "malloc") {
        this.builder.markFeature("heap");
        let szVal = this.lowerExpression(expr.arguments[0]);
        szVal = this.coerceType(szVal, "i64");
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.call @malloc(${szVal.ssa}) : (i64) -> !llvm.ptr`);
        return { ssa, ptr: ssa, type: "!llvm.ptr", isRef: true, isHeap: true };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "free") {
        this.builder.markFeature("heap");
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        this.builder.emit(`llvm.call @free(${ptrVal.ssa || ptrVal.ptr}) : (!llvm.ptr) -> ()`);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "alloca") {
        let szVal = this.lowerExpression(expr.arguments[0]);
        szVal = this.coerceType(szVal, "i32");
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.alloca ${szVal.ssa} x i8 : (i32) -> !llvm.ptr`);
        return { ssa, ptr: ssa, type: "!llvm.ptr", isRef: true, isStack: true };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "borrow") {
        const val = this.lowerExpression(expr.arguments[0]);
        val.isBorrowed = true;
        return val;
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "panic") {
        this.builder.markFeature("exceptions");
        const msgArg = expr.arguments?.[0];
        const prefixSym = this.builder.getOrRegisterString("[PANIC] ");
        const prefixSSA = this.builder.nextSSA();
        this.builder.emit(`${prefixSSA} = llvm.mlir.addressof ${prefixSym} : !llvm.ptr`);
        this.builder.printString(prefixSSA);

        if (msgArg) {
          const msgVal = this.lowerExpression(msgArg);
          this.builder.printString(msgVal.ssa || msgVal.ptr);
        }
        this.builder.printNewline();
        this.builder.emit(`llvm.call @abort() : () -> ()`);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "spawn") {
        this.builder.markFeature("threads");
        const fnArg = expr.arguments[0];
        const targetFnName = fnArg.name;
        const targetMeta = this.functionRegistry.get(targetFnName);
        const runnerName = `__spawn_runner_${targetFnName}`;

        this.spawnRunners.set(targetFnName, {
          targetFnName,
          runnerName,
          targetMeta,
        });

        const c8 = this.builder.nextSSA();
        this.builder.emit(`${c8} = llvm.mlir.constant(8 : i64) : i64`);
        const thSlot = this.builder.nextSSA();
        this.builder.emit(`${thSlot} = llvm.call @malloc(${c8}) : (i64) -> !llvm.ptr`);

        const nullAttr = this.builder.nextSSA();
        this.builder.emit(`${nullAttr} = llvm.mlir.zero : !llvm.ptr`);

        let argSSA = nullAttr;
        if (expr.arguments[1]) {
          const customArg = this.lowerExpression(expr.arguments[1]);
          argSSA = customArg.ssa || customArg.ptr;
        }

        const runnerAddr = this.builder.nextSSA();
        this.builder.emit(`${runnerAddr} = func.constant @${runnerName} : (!llvm.ptr) -> !llvm.ptr`);

        const createRes = this.builder.nextSSA();
        this.builder.emit(
          `${createRes} = func.call @pthread_create(${thSlot}, ${nullAttr}, ${runnerAddr}, ${argSSA}) : (!llvm.ptr, !llvm.ptr, (!llvm.ptr) -> !llvm.ptr, !llvm.ptr) -> i32`
        );

        return { ssa: thSlot, ptr: thSlot, type: "!llvm.ptr", isThread: true, isHeap: true };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "join") {
        this.builder.markFeature("threads");
        const thVal = this.lowerExpression(expr.arguments[0]);
        const thId = this.builder.load(thVal.ptr || thVal.ssa, "i64");
        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        const joinRes = this.builder.nextSSA();
        this.builder.emit(
          `${joinRes} = llvm.call @pthread_join(${thId.ssa}, ${nullPtr}) : (i64, !llvm.ptr) -> i32`
        );
        this.builder.emitFree(thVal.ptr || thVal.ssa);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "assert") {
        this.builder.markFeature("exceptions");
        const condVal = this.coerceType(this.lowerExpression(expr.arguments[0]), "i1");
        const passBlock = this.builder.nextBlock("assert_pass");
        const failBlock = this.builder.nextBlock("assert_fail");

        this.builder.emitBranchConditional(condVal.ssa, passBlock, failBlock);

        this.builder.emitBlockLabel(failBlock);
        const prefixSym = this.builder.getOrRegisterString("[ASSERTION FAILED] ");
        const prefixSSA = this.builder.nextSSA();
        this.builder.emit(`${prefixSSA} = llvm.mlir.addressof ${prefixSym} : !llvm.ptr`);
        this.builder.printString(prefixSSA);

        if (expr.arguments[1]) {
          const msgVal = this.lowerExpression(expr.arguments[1]);
          this.builder.printString(msgVal.ssa || msgVal.ptr);
        }
        this.builder.printNewline();
        this.builder.emit(`llvm.call @abort() : () -> ()`);
        this.builder.emitBranch(passBlock);

        this.builder.emitBlockLabel(passBlock);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "Ok") {
        const val = this.lowerExpression(expr.arguments[0]);
        let sName = this.getCurrentFunctionStructRetName();
        if (!sName || !sName.startsWith("Result_")) {
          const valKey = val.isString ? "str" : val.type;
          sName = `Result_${valKey}_str`;
        }

        const structMeta = this.structRegistry.get(sName);
        if (!structMeta) {
          throw new Error(`[Result] '${sName}' tipi bulunamadı!`);
        }

        const byteSize = Math.max(structMeta.fields.length * 8, 8);
        const slot = this.builder.allocateHeap(byteSize);
        const okConst = this.builder.createConstant(1, "i1");
        const okPtr = this.builder.nextSSA();
        this.builder.emit(`${okPtr} = llvm.getelementptr ${slot.ptr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        this.builder.store(okPtr, okConst);

        const valPtr = this.builder.nextSSA();
        this.builder.emit(`${valPtr} = llvm.getelementptr ${slot.ptr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        const coercedVal = this.coerceType(val, structMeta.fields[1].type);
        this.builder.store(valPtr, coercedVal);

        let emptyErr;
        if (structMeta.fields[2].type === "!llvm.ptr") {
          const emptySym = this.builder.getOrRegisterString("");
          const emptySSA = this.builder.nextSSA();
          this.builder.emit(`${emptySSA} = llvm.mlir.addressof ${emptySym} : !llvm.ptr`);
          emptyErr = { ssa: emptySSA, type: "!llvm.ptr" };
        } else {
          emptyErr = this.builder.createConstant(0, structMeta.fields[2].type);
        }
        const errPtr = this.builder.nextSSA();
        this.builder.emit(`${errPtr} = llvm.getelementptr ${slot.ptr}[0, 2] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        this.builder.store(errPtr, emptyErr);

        return { ssa: slot.ptr, ptr: slot.ptr, type: "!llvm.ptr", structName: sName, isRef: true, isHeap: true };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "Err") {
        const errVal = this.lowerExpression(expr.arguments[0]);
        let sName = this.getCurrentFunctionStructRetName();
        if (!sName || !sName.startsWith("Result_")) {
          sName = `Result_f64_str`;
        }

        const structMeta = this.structRegistry.get(sName);
        if (!structMeta) {
          throw new Error(`[Result] '${sName}' tipi bulunamadı!`);
        }

        const byteSize = Math.max(structMeta.fields.length * 8, 8);
        const slot = this.builder.allocateHeap(byteSize);
        const okConst = this.builder.createConstant(0, "i1");
        const okPtr = this.builder.nextSSA();
        this.builder.emit(`${okPtr} = llvm.getelementptr ${slot.ptr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        this.builder.store(okPtr, okConst);

        let zeroVal;
        if (structMeta.fields[1].type === "!llvm.ptr") {
          const zeroPtr = this.builder.nextSSA();
          this.builder.emit(`${zeroPtr} = llvm.mlir.zero : !llvm.ptr`);
          zeroVal = { ssa: zeroPtr, type: "!llvm.ptr" };
        } else {
          zeroVal = this.builder.createConstant(0, structMeta.fields[1].type);
        }
        const valPtr = this.builder.nextSSA();
        this.builder.emit(`${valPtr} = llvm.getelementptr ${slot.ptr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        this.builder.store(valPtr, zeroVal);

        const errPtr = this.builder.nextSSA();
        this.builder.emit(`${errPtr} = llvm.getelementptr ${slot.ptr}[0, 2] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        const coercedErr = this.coerceType(errVal, structMeta.fields[2].type);
        this.builder.store(errPtr, coercedErr);

        return { ssa: slot.ptr, ptr: slot.ptr, type: "!llvm.ptr", structName: sName, isRef: true, isHeap: true };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "unwrap") {
        this.builder.markFeature("exceptions");
        const resObj = this.lowerExpression(expr.arguments[0]);
        const structMeta = this.structRegistry.get(resObj.structName);
        if (!structMeta || structMeta.fields.length < 3) {
          throw new Error(`[Result] unwrap() sadece Result struct'ları üzerinde çalışabilir!`);
        }

        const valType = structMeta.fields[1].type;
        const valSlot = this.builder.allocateStack(valType);

        const okPtr = this.builder.nextSSA();
        this.builder.emit(`${okPtr} = llvm.getelementptr ${resObj.ptr || resObj.ssa}[0, 0] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        const okVal = this.builder.load(okPtr, "i1");

        const okBlock = this.builder.nextBlock("unwrap_ok");
        const errBlock = this.builder.nextBlock("unwrap_err");
        const contBlock = this.builder.nextBlock("unwrap_cont");

        this.builder.emitBranchConditional(okVal.ssa, okBlock, errBlock);

        this.builder.emitBlockLabel(errBlock);
        const errPrefixSym = this.builder.getOrRegisterString("[PANIC] unwrap failed: ");
        const errPrefixSSA = this.builder.nextSSA();
        this.builder.emit(`${errPrefixSSA} = llvm.mlir.addressof ${errPrefixSym} : !llvm.ptr`);
        this.builder.printString(errPrefixSSA);

        const errPtr = this.builder.nextSSA();
        this.builder.emit(`${errPtr} = llvm.getelementptr ${resObj.ptr || resObj.ssa}[0, 2] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        const errType = structMeta.fields[2].type;
        const errLoaded = this.builder.load(errPtr, errType);
        if (structMeta.fields[2].isString || errType === "!llvm.ptr") {
          this.builder.printString(errLoaded.ssa);
        } else if (errType === "i64") {
          this.builder.printI64(errLoaded.ssa);
        } else if (errType === "i32") {
          this.builder.printI32(errLoaded.ssa);
        } else if (errType === "i1") {
          this.builder.printBool(errLoaded.ssa);
        } else {
          this.builder.printF64(errLoaded.ssa);
        }
        this.builder.printNewline();
        this.builder.emit(`llvm.call @abort() : () -> ()`);
        this.builder.emitBranch(contBlock);

        this.builder.emitBlockLabel(okBlock);
        const valPtr = this.builder.nextSSA();
        this.builder.emit(`${valPtr} = llvm.getelementptr ${resObj.ptr || resObj.ssa}[0, 1] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`);
        const loadedVal = this.builder.load(valPtr, valType);
        this.builder.store(valSlot.ptr, loadedVal);
        this.builder.emitBranch(contBlock);

        this.builder.emitBlockLabel(contBlock);
        const finalVal = this.builder.load(valSlot.ptr, valType);
        if (structMeta.fields[1].isString) finalVal.isString = true;
        return finalVal;
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "sleep") {
        this.builder.markFeature("sleep");
        const msVal = this.lowerExpression(expr.arguments[0]);
        const msI32 = this.coerceType(msVal, "i32");
        const c1000 = this.builder.createConstant(1000, "i32");
        const usec = this.builder.createArithmetic("*", msI32, c1000);
        const sleepRes = this.builder.nextSSA();
        this.builder.emit(`${sleepRes} = llvm.call @usleep(${usec.ssa}) : (i32) -> i32`);
        return { ssa: "", type: "none" };
      }

      const isConsoleLog =
        expr.callee.type === "MemberExpression" &&
        expr.callee.object?.name === "console" &&
        expr.callee.property?.name === "log";

      if (isConsoleLog) {
        expr.arguments.forEach((argNode, idx) => {
          const arg = this.lowerExpression(argNode);
          if (arg.isUnion) {
            this.builder.printUnion(arg.ssa || arg.ptr);
          } else if (arg.isNull) {
            const nullStrSym = this.builder.getOrRegisterString("null");
            const nullSSA = this.builder.nextSSA();
            this.builder.emit(`${nullSSA} = llvm.mlir.addressof ${nullStrSym} : !llvm.ptr`);
            this.builder.printString(nullSSA);
          } else if (arg.isUndefined) {
            const undefStrSym = this.builder.getOrRegisterString("undefined");
            const undefSSA = this.builder.nextSSA();
            this.builder.emit(`${undefSSA} = llvm.mlir.addressof ${undefStrSym} : !llvm.ptr`);
            this.builder.printString(undefSSA);
          } else if (arg.isString) {
            this.builder.printString(arg.ssa || arg.ptr);
          } else if (arg.type === "i1") {
            this.builder.printBool(arg.ssa);
          } else if (arg.type === "i64") {
            this.builder.printI64(arg.ssa);
          } else if (arg.type === "i32") {
            this.builder.printI32(arg.ssa);
          } else if (arg.type === "f64" || arg.type === "f32") {
            this.builder.printF64(arg.ssa);
          } else if (arg.type === "!llvm.ptr") {
            this.builder.printPointer(arg.ssa || arg.ptr);
          } else {
            this.builder.printF64(arg.ssa);
          }
          if (idx < expr.arguments.length - 1) {
            this.builder.printSpace();
          }
        });
        this.builder.printNewline();
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "MemberExpression" && expr.callee.object.type === "Super") {
        const thisSym = this.symbolTable.get("this");
        const classMeta = this.structRegistry.get(thisSym.structName);
        const methodName = expr.callee.property.name || expr.callee.property.value;
        const targetFn = `@${classMeta.superClass}_${methodName}`;

        const parentMeta = this.structRegistry.get(classMeta.superClass);
        const mMeta = parentMeta?.methods.get(methodName);

        const args = expr.arguments ? expr.arguments.map((a, i) => {
          let val = this.lowerExpression(a);
          const paramMeta = mMeta?.params?.[i];
          if (paramMeta && !val.isFunction) {
            val = this.coerceType(val, paramMeta.type);
          }
          return val;
        }) : [];
        const allArgsSSA = [thisSym.ptr, ...args.map((a) => a.ssa || a.ptr)];
        const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

        const retType = mMeta?.retType || "none";

        if (retType === "none") {
          this.builder.emit(`func.call ${targetFn}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`);
          return { ssa: "", ptr: "", type: "none" };
        } else {
          const ssa = this.builder.nextSSA();
          this.builder.emit(
            `${ssa} = func.call ${targetFn}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ${retType}`
          );
          return {
            ssa,
            ptr: ssa,
            type: retType,
            structName: mMeta?.structRetName,
            isString: mMeta?.isRetString || false,
            isHeap: retType === "!llvm.ptr",
          };
        }
      }

      if (expr.callee.type === "MemberExpression") {
        const base = this.lowerExpression(expr.callee.object);
        const methodName = expr.callee.property.name || expr.callee.property.value;

        if (base.isArena) {
          this.builder.markFeature("allocators");
          if (methodName === "alloc") {
            let szVal = this.lowerExpression(expr.arguments[0]);
            szVal = this.coerceType(szVal, "i64");
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call @rts_arena_alloc(${base.ptr || base.ssa}, ${szVal.ssa}) : (!llvm.ptr, i64) -> !llvm.ptr`
            );
            return { ssa, ptr: ssa, type: "!llvm.ptr", isRef: true };
          } else if (methodName === "reset") {
            this.builder.emit(
              `func.call @rts_arena_reset(${base.ptr || base.ssa}) : (!llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          } else if (methodName === "dispose" || methodName === "destroy") {
            this.builder.emit(
              `func.call @rts_arena_destroy(${base.ptr || base.ssa}) : (!llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          }
        }

        if (base.isPool) {
          this.builder.markFeature("allocators");
          if (methodName === "alloc") {
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call @rts_pool_alloc(${base.ptr || base.ssa}) : (!llvm.ptr) -> !llvm.ptr`
            );
            return { ssa, ptr: ssa, type: "!llvm.ptr", isRef: true };
          } else if (methodName === "free") {
            const chunkVal = this.lowerExpression(expr.arguments[0]);
            this.builder.emit(
              `func.call @rts_pool_free(${base.ptr || base.ssa}, ${chunkVal.ssa || chunkVal.ptr}) : (!llvm.ptr, !llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          } else if (methodName === "dispose" || methodName === "destroy") {
            this.builder.emit(
              `func.call @rts_pool_destroy(${base.ptr || base.ssa}) : (!llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          }
        }

        if (base.isFixedBuffer) {
          this.builder.markFeature("allocators");
          if (methodName === "alloc") {
            let szVal = this.lowerExpression(expr.arguments[0]);
            szVal = this.coerceType(szVal, "i64");
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call @rts_fixed_buffer_alloc(${base.ptr || base.ssa}, ${szVal.ssa}) : (!llvm.ptr, i64) -> !llvm.ptr`
            );
            return { ssa, ptr: ssa, type: "!llvm.ptr", isRef: true };
          } else if (methodName === "reset") {
            this.builder.emit(
              `func.call @rts_fixed_buffer_reset(${base.ptr || base.ssa}) : (!llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          } else if (methodName === "dispose" || methodName === "destroy") {
            this.builder.emit(
              `func.call @rts_fixed_buffer_destroy(${base.ptr || base.ssa}) : (!llvm.ptr) -> ()`
            );
            return { ssa: "", type: "none" };
          }
        }

        if (base.isChannel) {
          this.builder.markFeature("channels");
          if (methodName === "send") {
            let val = this.lowerExpression(expr.arguments[0]);
            val = this.coerceType(val, "f64");
            this.builder.emit(
              `func.call @rts_chan_send_f64(${base.ptr || base.ssa}, ${val.ssa}) : (!llvm.ptr, f64) -> ()`
            );
            return { ssa: "", type: "none" };
          } else if (methodName === "recv") {
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call @rts_chan_recv_f64(${base.ptr || base.ssa}) : (!llvm.ptr) -> f64`
            );
            return { ssa, type: "f64" };
          }
        }

        if (base.isMap) {
          if (methodName === "set") {
            const key = this.lowerExpression(expr.arguments[0]);
            const val = this.lowerExpression(expr.arguments[1]);
            if (val.isString || val.type === "!llvm.ptr") {
              this.builder.emit(`func.call @rts_map_set_str_str(${base.ptr || base.ssa}, ${key.ssa || key.ptr}, ${val.ssa || val.ptr}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr) -> ()`);
            } else {
              const valF64 = this.coerceType(val, "f64");
              this.builder.emit(`func.call @rts_map_set_str_f64(${base.ptr || base.ssa}, ${key.ssa || key.ptr}, ${valF64.ssa}) : (!llvm.ptr, !llvm.ptr, f64) -> ()`);
            }
            return { ssa: base.ssa || base.ptr, type: "!llvm.ptr", isMap: true, valType: base.valType };
          } else if (methodName === "get") {
            const key = this.lowerExpression(expr.arguments[0]);
            const ssa = this.builder.nextSSA();
            if (base.valType === "string") {
              this.builder.emit(`${ssa} = func.call @rts_map_get_str_str(${base.ptr || base.ssa}, ${key.ssa || key.ptr}) : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr`);
              return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true };
            } else {
              this.builder.emit(`${ssa} = func.call @rts_map_get_str_f64(${base.ptr || base.ssa}, ${key.ssa || key.ptr}) : (!llvm.ptr, !llvm.ptr) -> f64`);
              return { ssa, ptr: ssa, type: "f64" };
            }
          } else if (methodName === "has") {
            const key = this.lowerExpression(expr.arguments[0]);
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call @rts_map_has_str(${base.ptr || base.ssa}, ${key.ssa || key.ptr}) : (!llvm.ptr, !llvm.ptr) -> i1`);
            return { ssa, type: "i1" };
          }
        }

        if (base.isSet) {
          if (methodName === "add") {
            const key = this.lowerExpression(expr.arguments[0]);
            const oneF64 = this.builder.createConstant(1.0, "f64");
            this.builder.emit(`func.call @rts_map_set_str_f64(${base.ptr || base.ssa}, ${key.ssa || key.ptr}, ${oneF64.ssa}) : (!llvm.ptr, !llvm.ptr, f64) -> ()`);
            return { ssa: base.ssa || base.ptr, type: "!llvm.ptr", isSet: true };
          } else if (methodName === "has") {
            const key = this.lowerExpression(expr.arguments[0]);
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call @rts_map_has_str(${base.ptr || base.ssa}, ${key.ssa || key.ptr}) : (!llvm.ptr, !llvm.ptr) -> i1`);
            return { ssa, type: "i1" };
          }
        }

        if (base.structName) {
          const structMeta = this.structRegistry.get(base.structName);
          const fieldMeta = structMeta?.fields.find((f) => f.name === methodName);

          if (fieldMeta && fieldMeta.isFunction && fieldMeta.fnSig) {
            const fnSig = fieldMeta.fnSig;
            const fieldPtr = this.builder.nextSSA();
            this.builder.emit(
              `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
            );
            const loadedPtr = this.builder.load(fieldPtr, "!llvm.ptr");
            const fnValSSA = this.builder.nextSSA();
            this.builder.emit(
              `${fnValSSA} = builtin.unrealized_conversion_cast ${loadedPtr.ssa} : !llvm.ptr to ${fnSig.mlirType}`
            );

            const args = expr.arguments ? expr.arguments.map((a, i) => {
              let val = this.lowerExpression(a);
              const targetPType = fnSig.paramTypes?.[i];
              if (targetPType) val = this.coerceType(val, targetPType);
              return val;
            }) : [];

            const argSSAs = args.map((a) => a.ssa || a.ptr).join(", ");
            if (fnSig.retType === "none") {
              this.builder.emit(`func.call_indirect ${fnValSSA}(${argSSAs}) : ${fnSig.mlirType}`);
              return { ssa: "", ptr: "", type: "none" };
            } else {
              const ssa = this.builder.nextSSA();
              this.builder.emit(`${ssa} = func.call_indirect ${fnValSSA}(${argSSAs}) : ${fnSig.mlirType}`);
              return { ssa, ptr: ssa, type: fnSig.retType };
            }
          }

          let curr = structMeta;
          let methodMeta = null;
          let declaringClass = base.structName;

          while (curr) {
            if (curr.methods && curr.methods.has(methodName)) {
              methodMeta = curr.methods.get(methodName);
              declaringClass = curr.name;
              break;
            }
            if (curr.superClass) {
              curr = this.structRegistry.get(curr.superClass);
            } else {
              break;
            }
          }

          if (!methodMeta) {
            throw new Error(`[Lowering] '${base.structName}' üzerinde '${methodName}' metodu veya fonksiyon alanı bulunamadı!`);
          }

          const vcallName = `${declaringClass}_vcall_${methodName}`;
          const isVCall = this.vcallRouters.has(vcallName);
          const targetFn = isVCall ? `@${vcallName}` : `@${methodMeta.className || declaringClass}_${methodName}`;

          const args = expr.arguments ? expr.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const paramMeta = methodMeta?.params?.[i];
            if (paramMeta?.isUnion && !val.isUnion) {
              const uSlot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
              this.boxIntoUnion(uSlot.ptr, val);
              return { ssa: uSlot.ptr, ptr: uSlot.ptr, type: "!llvm.ptr", isUnion: true };
            }
            if (val.isUnion) {
              return { ssa: val.ssa || val.ptr, ptr: val.ssa || val.ptr, type: "!llvm.ptr", isUnion: true };
            }
            if (paramMeta && !val.isFunction) {
              val = this.coerceType(val, paramMeta.type);
            }
            return val;
          }) : [];

          const allArgsSSA = [base.ssa || base.ptr, ...args.map((a) => a.ssa || a.ptr)];
          const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

          const retType = methodMeta?.retType || "none";

          if (retType === "none") {
            this.builder.emit(`func.call ${targetFn}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call ${targetFn}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ${retType}`
            );
            return {
              ssa,
              ptr: ssa,
              type: retType,
              structName: methodMeta?.structRetName,
              isString: methodMeta?.isRetString || false,
              isHeap: retType === "!llvm.ptr",
            };
          }
        }
      }

      if (expr.callee.type === "Identifier" && this.symbolTable.has(expr.callee.name)) {
        const localSym = this.symbolTable.get(expr.callee.name);
        if (localSym && localSym.isFunction) {
          const fnSig = localSym.fnSig;
          const args = expr.arguments ? expr.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const targetPType = fnSig.paramTypes?.[i];
            if (targetPType) {
              val = this.coerceType(val, targetPType);
            }
            return val;
          }) : [];

          const argSSAs = args.map((a) => a.ssa || a.ptr).join(", ");
          if (fnSig.retType === "none") {
            this.builder.emit(`func.call_indirect ${localSym.ssa || localSym.ptr}(${argSSAs}) : ${fnSig.mlirType}`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call_indirect ${localSym.ssa || localSym.ptr}(${argSSAs}) : ${fnSig.mlirType}`);
            return { ssa, ptr: ssa, type: fnSig.retType };
          }
        }
      }

      const funcName = expr.callee.name;
      const fnMeta = this.functionRegistry.get(funcName);

      const args = expr.arguments ? expr.arguments.map((a, i) => {
        const isBorrowCall = a.type === "CallExpression" && a.callee?.name === "borrow";
        const actualArgNode = isBorrowCall ? a.arguments[0] : a;

        let val = this.lowerExpression(actualArgNode);
        if (isBorrowCall) {
          val.isBorrowed = true;
        }

        const paramMeta = fnMeta?.params?.[i];
        if (paramMeta?.isUnion && !val.isUnion) {
          const uSlot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
          this.boxIntoUnion(uSlot.ptr, val);
          return { ssa: uSlot.ptr, ptr: uSlot.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (val.isUnion) {
          return { ssa: val.ssa || val.ptr, ptr: val.ssa || val.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (paramMeta && !val.isFunction) {
          val = this.coerceType(val, paramMeta.type);
        }

        return val;
      }) : [];

      const argStr = args.map((a) => a.ssa || a.ptr).join(", ");
      const typeStr = args.map((a) => a.type).join(", ");
      const retType = fnMeta?.retType || "f64";

      const targetMeta = this.functionRegistry.get(funcName);
      const callSymbol = targetMeta?.exportAlias || funcName;

      if (retType === "none") {
        this.builder.emit(`func.call @${callSymbol}(${argStr}) : (${typeStr}) -> ()`);
        return { ssa: "", ptr: "", type: "none" };
      } else {
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = func.call @${callSymbol}(${argStr}) : (${typeStr}) -> ${retType}`);
        return {
          ssa,
          ptr: ssa,
          type: retType,
          isPromise: Boolean(fnMeta?.isAsync),
          innerRetType: fnMeta?.innerRetType || "f64",
          structName: fnMeta?.structRetName || null,
          isString: fnMeta?.isRetString || false,
          isHeap: retType === "!llvm.ptr",
        };
      }
    }

    throw new Error(`[Lowering] Desteklenmeyen ifade: ${expr.type}`);
  }

  mlirTypeToCType(mlirType, isString = false) {
    return HeaderGenerator.mlirTypeToCType(mlirType, isString);
  }

  generateCHeader(headerGuard = "RYPESCRIPT_H") {
    return HeaderGenerator.generateCHeader(this, headerGuard);
  }

  cTypeToMlir(cType) {
    return HeaderGenerator.cTypeToMlir(cType);
  }

  loadCHeader(headerFilePath) {
    return HeaderGenerator.loadCHeader(this, headerFilePath);
  }
}

export { ASTLowerer as ASTLowering };