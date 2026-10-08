// src/ir/ASTLowerer.js
import fs from "node:fs";
import { LambdaLifter } from "../frontend/LambdaLifter.js";
import { Monomorphizer } from "../frontend/Monomorphizer.js";
import { HeaderGenerator } from "../runtime/HeaderGenerator.js";
import { ClassLowerer } from "./lowerers/ClassLowerer.js";
import { NapiLowerer } from "./lowerers/NapiLowerer.js";
import { TypeLowerer } from "./lowerers/TypeLowerer.js";
import { SimdLowerer } from "./lowerers/SimdLowerer.js";
import { MemoryLowerer } from "./lowerers/MemoryLowerer.js";
import { CallLowerer } from "./lowerers/CallLowerer.js";
import { ExpressionLowerer } from "./lowerers/ExpressionLowerer.js";
import { StatementLowerer } from "./lowerers/StatementLowerer.js";

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

    // Generics Şablon Havuzları ve Monomorphizer Entegrasyonu
    this.monomorphizer = new Monomorphizer(this.enumRegistry, this.typeAliasRegistry);
    this.spawnRunners = new Map();
    this.globals = new Map();
    this.napiFunctions = [];
    this.asyncTaskContexts = new Map();

    this.scopeStack = [];
    this.closureRegistry = new Map();
    this.thunkRegistry = new Map();
    this.requiredItables = new Map();
    this.breakTargets = [];
    this.continueTargets = [];
    this.currentLoopLabel = null;
    this.builder.onAllocate = (ptr) => this.trackHeap(ptr);
    this.typeLowerer = new TypeLowerer(this);
    this.simdLowerer = new SimdLowerer(this);
    this.memoryLowerer = new MemoryLowerer(this);
    this.callLowerer = new CallLowerer(this);
    this.expressionLowerer = new ExpressionLowerer(this);
    this.statementLowerer = new StatementLowerer(this);
    this.classLowerer = new ClassLowerer(this);
    this.napiLowerer = new NapiLowerer(this);
  }

  get genericClassTemplates() { return this.monomorphizer.genericClassTemplates; }
  get genericFunctionTemplates() { return this.monomorphizer.genericFunctionTemplates; }
  get genericTypeTemplates() { return this.monomorphizer.genericTypeTemplates; }
  get genericInterfaceTemplates() { return this.monomorphizer.genericInterfaceTemplates; }
  get specializedClasses() { return this.monomorphizer.specializedClasses; }
  get specializedFunctions() { return this.monomorphizer.specializedFunctions; }
  get specializedTypes() { return this.monomorphizer.specializedTypes; }

  getPragmas(node) {
    const pragmas = {
      inline: false,
      noinline: false,
      packed: false,
      napi: false,
      exportName: null,
      noentry: false,
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
        if (expr.name === "noentry" || expr.name === "standalone") pragmas.noentry = true;
      } else if (expr.type === "CallExpression") {
        const fnName = expr.callee?.name;
        if (fnName === "export_name") {
          const arg = expr.arguments?.[0];
          if (arg) pragmas.exportName = arg.value ?? null;
        } else if (fnName === "noentry" || fnName === "standalone") {
          pragmas.noentry = true;
        } else if (fnName === "entry") {
          const arg = expr.arguments?.[0];
          if (arg && (arg.value === false || arg.name === "false")) {
            pragmas.noentry = true;
          }
        }
      }
    }

    // 2. Sentetik Decorators (Fonksiyon ve Interface öncesi yakalananlar)
    const nodeName = node.id?.name || node.declaration?.id?.name || node.key?.name;
    const decList =
      (this.syntheticDecorators && nodeName && this.syntheticDecorators.get(nodeName)) ||
      (this.currentSyntheticDecorators && nodeName && this.currentSyntheticDecorators.get(nodeName));
    if (decList) {
      for (const dec of decList) {
        if (dec.name === "inline") pragmas.inline = true;
        if (dec.name === "noinline") pragmas.noinline = true;
        if (dec.name === "packed") pragmas.packed = true;
        if (dec.name === "napi") pragmas.napi = true;
        if (dec.name === "export_name") pragmas.exportName = dec.arg;
        if (dec.name === "noentry" || dec.name === "standalone") pragmas.noentry = true;
        if (dec.name === "entry" && (dec.arg === "false" || dec.arg === false)) pragmas.noentry = true;
      }
    }

    // 3. Fallback: Yorum Satırı (Yalnızca geriye dönük uyumluluk için)
    if (
      !pragmas.inline &&
      !pragmas.noinline &&
      !pragmas.packed &&
      !pragmas.napi &&
      !pragmas.noentry &&
      !pragmas.exportName &&
      this.currentComments
    ) {
      const nodeStart = node.start ?? node.span?.start ?? 0;
      for (const c of this.currentComments) {
        if (c.end <= nodeStart && nodeStart - c.end < 60) {
          const text = c.value || "";
          if (/@inline\b/.test(text)) pragmas.inline = true;
          if (/@noinline\b/.test(text)) pragmas.noinline = true;
          if (/@packed\b/.test(text)) pragmas.packed = true;
          if (/@napi\b/.test(text)) pragmas.napi = true;
          if (/@noentry\b/.test(text) || /@standalone\b/.test(text)) pragmas.noentry = true;
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
    return this.memoryLowerer.checkEscape(varName, fnNode);
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

  cleanupScopesDownTo(targetDepth) {
    for (let i = this.scopeStack.length - 1; i >= targetDepth; i--) {
      const scope = this.scopeStack[i];
      if (!scope) continue;

      // 0. finally (defer) bloklarını ters sırada (LIFO) çalıştır
      for (let j = (scope.deferrals || []).length - 1; j >= 0; j--) {
        this.lowerStatement(scope.deferrals[j]);
      }

      // 1. using ile tanımlanan kaynakları ters sırada (LIFO) dispose et
      for (let j = (scope.disposables || []).length - 1; j >= 0; j--) {
        const d = scope.disposables[j];
        if (!scope.transferred?.has(d.ptr)) {
          this.emitDispose(d);
        }
      }

      // 2. Kalan genel heap tahsislerini serbest bırak
      for (const ptr of (scope.heapAllocations || [])) {
        if (!scope.transferred?.has(ptr)) {
          this.builder.emitFree(ptr);
        }
      }
    }
  }

  unwrapExport(node) {
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") && node.declaration) {
      return node.declaration;
    }
    return node;
  }

  getNamespaceName(idNode) {
    if (!idNode) return "";
    if (idNode.type === "Identifier") return idNode.name;
    if (idNode.type === "TSQualifiedName") {
      const left = this.getNamespaceName(idNode.left);
      return left ? `${left}_${idNode.right.name}` : idNode.right.name;
    }
    return "";
  }

  extractMemberChain(node) {
    if (!node) return null;
    if (node.type === "Identifier") return [node.name];
    if (node.type === "MemberExpression" && !node.computed) {
      const objChain = this.extractMemberChain(node.object);
      if (!objChain) return null;
      const prop = node.property?.name || node.property?.value;
      if (!prop) return null;
      return [...objChain, prop];
    }
    return null;
  }

  resolveNamespaceGlobal(prefix, name) {
    if (!prefix) return null;
    const parts = prefix.split("_");
    for (let len = parts.length; len >= 1; len--) {
      const candidate = `${parts.slice(0, len).join("_")}_${name}`;
      if (this.globals && this.globals.has(candidate)) return candidate;
    }
    return null;
  }

  resolveNamespaceFunction(prefix, name) {
    if (!prefix) return null;
    const parts = prefix.split("_");
    for (let len = parts.length; len >= 1; len--) {
      const candidate = `${parts.slice(0, len).join("_")}_${name}`;
      if (this.functionRegistry && this.functionRegistry.has(candidate)) return candidate;
    }
    return null;
  }

  resolveNamespaceStruct(prefix, name) {
    if (!prefix) return null;
    const parts = prefix.split("_");
    for (let len = parts.length; len >= 1; len--) {
      const candidate = `${parts.slice(0, len).join("_")}_${name}`;
      if (this.structRegistry && this.structRegistry.has(candidate)) return candidate;
    }
    return null;
  }

  flattenNamespaces(body, parentPrefix = "") {
    const result = [];
    for (const rawStmt of body) {
      const isExported = rawStmt.type === "ExportNamedDeclaration" || rawStmt.type === "ExportDefaultDeclaration";
      const stmt = this.unwrapExport(rawStmt);
      if (stmt.type === "TSModuleDeclaration") {
        const nsName = this.getNamespaceName(stmt.id);
        const fullPrefix = parentPrefix ? `${parentPrefix}_${nsName}` : nsName;
        const innerBody = stmt.body?.body || [];
        const flattened = this.flattenNamespaces(innerBody, fullPrefix);
        result.push(...flattened);
      } else if (parentPrefix) {
        if (stmt.type === "FunctionDeclaration" || stmt.type === "TSDeclareFunction") {
          stmt.id.name = `${parentPrefix}_${stmt.id.name}`;
          stmt._namespacePrefix = parentPrefix;
          result.push(isExported ? rawStmt : stmt);
        } else if (stmt.type === "VariableDeclaration") {
          for (const decl of stmt.declarations) {
            if (decl.id?.name) {
              decl.id.name = `${parentPrefix}_${decl.id.name}`;
            }
          }
          stmt._namespacePrefix = parentPrefix;
          result.push(isExported ? rawStmt : stmt);
        } else if (stmt.type === "ClassDeclaration") {
          stmt.id.name = `${parentPrefix}_${stmt.id.name}`;
          stmt._namespacePrefix = parentPrefix;
          result.push(isExported ? rawStmt : stmt);
        } else if (stmt.type === "TSEnumDeclaration") {
          stmt.id.name = `${parentPrefix}_${stmt.id.name}`;
          result.push(isExported ? rawStmt : stmt);
        } else if (stmt.type === "TSInterfaceDeclaration" || stmt.type === "TSTypeAliasDeclaration") {
          stmt.id.name = `${parentPrefix}_${stmt.id.name}`;
          result.push(isExported ? rawStmt : stmt);
        } else {
          result.push(rawStmt);
        }
      } else {
        result.push(rawStmt);
      }
    }
    return result;
  }

  unwrapType(typeNode) { return this.typeLowerer.unwrapType(typeNode); }
  extractFunctionType(typeNode) { return this.typeLowerer.extractFunctionType(typeNode); }
  getOrCreateThunk(funcName) { return this.typeLowerer.getOrCreateThunk(funcName); }
  isFunctionType(typeNode) { return this.typeLowerer.isFunctionType(typeNode); }
  isUnionType(typeNode) { return this.typeLowerer.isUnionType(typeNode); }
  isStringType(typeNode) { return this.typeLowerer.isStringType(typeNode); }
  getTypeKey(typeNode) { return this.typeLowerer.getTypeKey(typeNode); }
  resolveType(typeNode) { return this.typeLowerer.resolveType(typeNode); }
  isPolymorphicInterface(typeName) { return this.typeLowerer.isPolymorphicInterface(typeName); }
  getStructName(typeNode) { return this.typeLowerer.getStructName(typeNode); }
  getEnumName(typeNode) { return this.typeLowerer.getEnumName(typeNode); }
  extractArrayTargetType(typeNode) { return this.typeLowerer.extractArrayTargetType(typeNode); }
  coerceType(val, targetType) { return this.typeLowerer.coerceType(val, targetType); }
  boxIntoUnion(slotPtr, val) { return this.typeLowerer.boxIntoUnion(slotPtr, val); }
  unboxUnion(uPtr, targetType) { return this.typeLowerer.unboxUnion(uPtr, targetType); }
  extractTypeofCheck(expr) { return this.typeLowerer.extractTypeofCheck(expr); }
  getDescendantTypeIds(targetClassName) { return this.typeLowerer.getDescendantTypeIds(targetClassName); }
  extractNarrowingCheck(expr) { return this.typeLowerer.extractNarrowingCheck(expr); }

  walkAST(node, visitor) {
    LambdaLifter.walkAST(node, visitor);
  }

  liftLambdas(rootNodes) {
    return LambdaLifter.liftLambdas(rootNodes);
  }

  deepCloneWithSubst(node, substMap, specializedName) {
    return this.monomorphizer.deepCloneWithSubst(node, substMap, specializedName);
  }

  instantiateGenericClass(baseName, typeArgs) {
    return this.monomorphizer.instantiateGenericClass(baseName, typeArgs);
  }

  instantiateGenericFunction(baseName, typeArgs) {
    return this.monomorphizer.instantiateGenericFunction(baseName, typeArgs);
  }

  instantiateGenericStruct(baseName, typeArgs) {
    return this.monomorphizer.instantiateGenericStruct(baseName, typeArgs);
  }

  isDirectMainCallStatement(stmt) {
    if (!stmt || stmt.type !== "ExpressionStatement") return false;
    let expr = stmt.expression;
    if (expr && expr.type === "AwaitExpression") {
      expr = expr.argument;
    } else if (expr && expr.type === "UnaryExpression" && expr.operator === "void") {
      expr = expr.argument;
    }
    if (expr && expr.type === "CallExpression") {
      if (expr.callee?.name === "main") {
        return true;
      }
    }
    return false;
  }

  lower(program) {
    this.lowerModules([{ filePath: "main.ts", fileName: "main.ts", program, isEntry: true }]);
  }

  lowerModules(modules) {
    this.globals = new Map();
    this.requiredItables = new Map();
    this.syntheticDecorators = new Map();
    this.staticFieldInitializers = [];

    for (const mod of modules) {
      mod.program.body = this.flattenNamespaces(mod.program.body);
    }

    for (const mod of modules) {
      if (mod.syntheticDecorators) {
        for (const [k, v] of mod.syntheticDecorators) {
          this.syntheticDecorators.set(k, v);
        }
      }
    }

    // 0. Tüm modüllerdeki en üst düzey (global) değişken tanımlarını tespit et
    for (const mod of modules) {
      this.currentComments = mod.comments || [];
      this.currentSyntheticDecorators = mod.syntheticDecorators || new Map();
      for (const rawNode of mod.program.body) {
        const isExported = rawNode.type === "ExportNamedDeclaration" || rawNode.type === "ExportDefaultDeclaration";
        const node = this.unwrapExport(rawNode);
        if (node.type === "VariableDeclaration") {
          for (const decl of node.declarations) {
            const varName = decl.id.name;

            if (mod.isEntry && !isExported && !node._namespacePrefix) {
              let referencedInFunctions = false;
              for (const other of mod.program.body) {
                const unwrapOther = this.unwrapExport(other);
                if (unwrapOther.type === "FunctionDeclaration" || unwrapOther.type === "ClassDeclaration") {
                  this.walkAST(unwrapOther, (n) => {
                    if (!referencedInFunctions && n.type === "Identifier" && n.name === varName) {
                      referencedInFunctions = true;
                    }
                  });
                }
              }
              if (!referencedInFunctions) {
                continue;
              }
            }
            let type = "f64";
            let isString = false;
            let initVal = 0;
            let structName = this.getStructName(decl.id.typeAnnotation);
            if (decl.id.typeAnnotation) {
              type = this.resolveType(decl.id.typeAnnotation);
              isString = this.isStringType(decl.id.typeAnnotation);
            }
            if (decl.init) {
              if (decl.init.type === "BooleanLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "boolean")) {
                if (!decl.id.typeAnnotation) type = "i1";
                initVal = Boolean(decl.init.value);
              } else if (decl.init.type === "NumericLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "number")) {
                const raw = decl.init.raw || String(decl.init.value);
                const isInt = !raw.includes(".") && Number.isInteger(decl.init.value);
                if (!decl.id.typeAnnotation) type = isInt ? "i64" : "f64";
                initVal = decl.init.value;
              } else if (decl.init.type === "StringLiteral" || (decl.init.type === "Literal" && typeof decl.init.value === "string")) {
                if (!decl.id.typeAnnotation) type = "!llvm.ptr";
                isString = true;
                initVal = decl.init.value;
              } else if (decl.init.type === "TemplateLiteral") {
                if (!decl.id.typeAnnotation) type = "!llvm.ptr";
                isString = true;
              } else if (decl.init.type === "NewExpression") {
                if (!decl.id.typeAnnotation) type = "!llvm.ptr";
                structName = this.getStructName(decl.id.typeAnnotation) || decl.init.callee?.name;
              } else if (decl.init.type === "ObjectExpression") {
                if (!decl.id.typeAnnotation) type = "!llvm.ptr";
                structName = this.getStructName(decl.id.typeAnnotation) || null;
              } else if (decl.init.type === "BinaryExpression" && decl.init.operator === "+") {
                const isStr = (n) => n && (n.type === "StringLiteral" || (n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");
                if (isStr(decl.init.left) || isStr(decl.init.right)) {
                  if (!decl.id.typeAnnotation) type = "!llvm.ptr";
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

    // Global process.argv ve process.argc kayıtları
    this.builder.registerGlobal("@g_process_argv", "!llvm.ptr", null);
    this.builder.registerGlobal("@g_process_argc", "i32", null);
    const argvGlobalMeta = {
      name: "process_argv",
      globalSym: "@g_process_argv",
      type: "!llvm.ptr",
      isArray: true,
      elemType: "!llvm.ptr",
      isString: true,
    };
    const argcGlobalMeta = {
      name: "process_argc",
      globalSym: "@g_process_argc",
      type: "i32",
    };
    this.globals.set("process_argv", argvGlobalMeta);
    this.globals.set("process_argc", argcGlobalMeta);
    this.globals.set("Process_argv", { ...argvGlobalMeta, name: "Process_argv" });
    this.globals.set("Process_argc", { ...argcGlobalMeta, name: "Process_argc" });

    const allParsedNodes = [];
    const entryTopLevelStatements = [];
    const nonEntryTopLevelStatements = [];

    let userMainNode = null;
    let isUserMainNoEntry = false;
    let userMainMeta = null;

    for (const mod of modules) {
      this.currentComments = mod.comments || [];
      this.currentSyntheticDecorators = mod.syntheticDecorators || new Map();
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
            let finalName = pragmas.exportName || node.id.name;
            if (node.id.name === "main") {
              if (mod.isEntry && !pragmas.noentry) {
                finalName = "user_main_entry";
              } else {
                finalName = "rts_fn_main";
              }
            }
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
        } else if ((node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") && node.id?.name === "main") {
          const pragmas = this.getPragmas(rawNode);
          if (mod.isEntry && !pragmas.noentry) {
            node.exportAlias = "user_main_entry";
          } else {
            node.exportAlias = "rts_fn_main";
          }
        }

        if (mod.isEntry && (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") && node.id?.name === "main") {
          userMainNode = node;
          const pragmas = this.getPragmas(rawNode);
          if (pragmas.noentry) {
            isUserMainNoEntry = true;
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

    this.monomorphizer.specializeAll(
      allParsedNodes,
      (node) => this.lowerInterface(node),
      (node) => this.registerTypeAlias(node)
    );

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
        let innerParamNode = null;
        if (unwrappedRet && unwrappedRet.type === "TSTypeReference" && (unwrappedRet.typeName?.name === "Promise" || unwrappedRet.typeName?.value === "Promise")) {
          innerParamNode = unwrappedRet.typeParameters?.params?.[0] || unwrappedRet.typeArguments?.params?.[0];
          innerRetType = innerParamNode ? this.resolveType(innerParamNode) : "none";
        } else if (node.returnType) {
          innerRetType = this.resolveType(node.returnType);
        } else {
          let hasReturnVal = false;
          let isClosureRet = false;
          if (node.body?.body) {
            this.walkAST(node.body, (n) => {
              if (n.type === "ReturnStatement" && n.argument) {
                hasReturnVal = true;
                if (
                  n.argument.type === "ArrowFunctionExpression" ||
                  n.argument.type === "FunctionExpression" ||
                  n.argument.type === "ClosureExpression"
                ) {
                  isClosureRet = true;
                }
              }
            });
          }
          innerRetType = isClosureRet
            ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>"
            : hasReturnVal
            ? "f64"
            : "none";
        }

        const retType = isAsync ? "!llvm.ptr" : innerRetType;
        const effectiveRetNode = isAsync && innerParamNode ? innerParamNode : node.returnType;
        const structRetName = this.getStructName(effectiveRetNode);
        const enumRetName = this.getEnumName(effectiveRetNode);
        const isRetString = this.isStringType(effectiveRetNode);
        const isRetFn = this.isFunctionType(effectiveRetNode);
        const retFnSig = isRetFn ? this.extractFunctionType(effectiveRetNode) : null;

        let typePredicate = null;
        const rawRetNode = this.unwrapType(effectiveRetNode) || effectiveRetNode;
        if (rawRetNode && (rawRetNode.type === "TSTypePredicate" || rawRetNode.typeAnnotation?.type === "TSTypePredicate")) {
          const predNode = rawRetNode.type === "TSTypePredicate" ? rawRetNode : rawRetNode.typeAnnotation;
          const paramName = predNode.parameterName?.name;
          const targetRef = predNode.typeAnnotation?.typeAnnotation || predNode.typeAnnotation;
          const targetType = targetRef?.typeName?.name || targetRef?.name;
          if (paramName && targetType) {
            typePredicate = { paramName, targetType };
          }
        }

        const rawParams = Array.isArray(node.params)
          ? node.params
          : Array.isArray(node.params?.items)
          ? node.params.items
          : [];
        const params = [];
        const paramTypes = [];
        let hasRest = false;
        let restElemType = null;

        rawParams.forEach((param, i) => {
          const isRest = param.type === "RestElement";
          const actualParam = isRest ? param.argument : param;
          const pName = actualParam.name || actualParam.pattern?.name || actualParam.id?.name || `arg_${i}`;
          const typeAnnot = param.typeAnnotation || actualParam.typeAnnotation || param.pattern?.typeAnnotation || actualParam.id?.typeAnnotation;
          const isFn = this.isFunctionType(typeAnnot);
          const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
          const isUnion = this.isUnionType(typeAnnot);
          if (isUnion) {
            this.builder.markFeature("union");
          }
          const isArr = isRest || this.unwrapType(typeAnnot)?.type === "TSArrayType";
          let arrElemType = "f64";
          let isArrString = false;
          if (isArr) {
            const unwrappedArr = this.unwrapType(typeAnnot);
            const elRaw = unwrappedArr ? this.unwrapType(unwrappedArr.elementType) : null;
            if (elRaw && (elRaw.type === "TSStringKeyword" || elRaw.typeName?.name === "string")) {
              arrElemType = "!llvm.ptr";
              isArrString = true;
            }
          }
          const isStr = isRest ? isArrString : this.isStringType(typeAnnot);
          const sName = this.getStructName(typeAnnot);
          const isPolyIface = this.isPolymorphicInterface(sName);
          const pType = isFn ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : isPolyIface ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : (isUnion || isArr || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
          const enumName = this.getEnumName(typeAnnot);
          const isChan = this.unwrapType(typeAnnot)?.typeName?.name === "Channel";
          if (isRest) {
            hasRest = true;
            restElemType = arrElemType;
          }
          params.push({ name: pName, type: pType, structName: sName, isInterface: isPolyIface, isUnion, isArray: isArr, elemType: arrElemType, isFunction: isFn, isClosure: isFn, fnSig, enumName, isChannel: isChan, isString: isStr, isRest });
          paramTypes.push(pType);
        });

        let taskContextMeta = null;
        if (isAsync) {
          const contextFields = ["i64", ...paramTypes];
          let retIdx = -1;
          if (innerRetType !== "none") {
            retIdx = contextFields.length;
            contextFields.push(innerRetType);
          }
          const statusIdx = contextFields.length;
          contextFields.push("i32");
          const taskContextType = `!llvm.struct<(${contextFields.join(", ")})>`;
          const taskContextByteSize = Math.max(contextFields.length * 8, 16);
          taskContextMeta = {
            type: taskContextType,
            fields: contextFields,
            paramTypes,
            retIdx,
            statusIdx,
            innerRetType,
            isRetString,
            structRetName,
            byteSize: taskContextByteSize,
          };
          this.asyncTaskContexts.set(funcName, taskContextMeta);
        }

        const declSig = retType === "none" ? `(${paramTypes.join(", ")})` : `(${paramTypes.join(", ")}) -> ${retType}`;
        const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
        const fnMeta = { isAsync, isDeclare, innerRetType, retType, structRetName, enumRetName, isRetString, isRetFn, retFnSig, typePredicate, params, paramTypes, mlirType, declSig, isClosure: Boolean(node.isClosure), taskContextMeta, exportAlias: node.exportAlias || null, hasRest, restElemType };
        this.functionRegistry.set(funcName, fnMeta);
        if (node === userMainNode) {
          userMainMeta = fnMeta;
        }

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

    const isWasm = Boolean(this.builder.targetInfo?.isWasm);
    const isWindows = Boolean(this.builder.targetInfo?.isWindows);
    const takesNoArgs = isWasm || isWindows;
    const mainHeader = takesNoArgs ? "func.func @main() -> i32" : "func.func @main(%argc: i32, %argv: !llvm.ptr) -> i32";

    this.builder.block(mainHeader, () => {
      this.builder.hasTerminated = false;
      this.isTopLevel = true;
      this.scopeStack = [];
      this.enterScope(true, "i32");

      // Global process.argc ve process.argv başlangıç atamaları
      const argcAddr = this.builder.nextSSA();
      this.builder.emit(`${argcAddr} = llvm.mlir.addressof @g_process_argc : !llvm.ptr`);
      const argvAddr = this.builder.nextSSA();
      this.builder.emit(`${argvAddr} = llvm.mlir.addressof @g_process_argv : !llvm.ptr`);

      let processArgvPtrSSA = null;
      if (takesNoArgs) {
        const c0_i32 = this.builder.createConstant(0, "i32");
        this.builder.store(argcAddr, c0_i32);
        const emptyArr = this.instantiateArray({ elements: [] }, "!llvm.ptr", true, null);
        this.builder.store(argvAddr, emptyArr);
        processArgvPtrSSA = emptyArr.ssa;
      } else {
        this.builder.store(argcAddr, { ssa: "%argc", type: "i32" });
        this.builder.markFeature("heap");
        this.builder.markFeature("strings");

        const argcI64 = this.builder.nextSSA();
        this.builder.emit(`${argcI64} = arith.extsi %argc : i32 to i64`);

        const c8 = this.builder.nextSSA();
        this.builder.emit(`${c8} = llvm.mlir.constant(8 : i64) : i64`);
        const elemsSz = this.builder.nextSSA();
        this.builder.emit(`${elemsSz} = arith.muli ${argcI64}, ${c8} : i64`);
        const totalSz = this.builder.nextSSA();
        this.builder.emit(`${totalSz} = arith.addi ${elemsSz}, ${c8} : i64`);

        const arrPtr = this.builder.nextSSA();
        this.builder.emit(`${arrPtr} = llvm.call @malloc(${totalSz}) : (i64) -> !llvm.ptr`);
        this.builder.emit(`llvm.store ${argcI64}, ${arrPtr} : i64, !llvm.ptr`);

        const c0Idx = this.builder.nextSSA();
        this.builder.emit(`${c0Idx} = arith.constant 0 : index`);
        const c1Idx = this.builder.nextSSA();
        this.builder.emit(`${c1Idx} = arith.constant 1 : index`);
        const limitIdx = this.builder.nextSSA();
        this.builder.emit(`${limitIdx} = arith.index_cast %argc : i32 to index`);

        this.builder.block(`scf.for %iv = ${c0Idx} to ${limitIdx} step ${c1Idx}`, () => {
          const i64SSA = this.builder.nextSSA();
          this.builder.emit(`${i64SSA} = arith.index_cast %iv : index to i64`);
          const argvElemPtr = this.builder.nextSSA();
          this.builder.emit(`${argvElemPtr} = llvm.getelementptr %argv[${i64SSA}] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr`);
          const strPtr = this.builder.nextSSA();
          this.builder.emit(`${strPtr} = llvm.load ${argvElemPtr} : !llvm.ptr -> !llvm.ptr`);
          const c1I64 = this.builder.nextSSA();
          this.builder.emit(`${c1I64} = llvm.mlir.constant(1 : i64) : i64`);
          const dstIdx = this.builder.nextSSA();
          this.builder.emit(`${dstIdx} = arith.addi ${i64SSA}, ${c1I64} : i64`);
          const dstElemPtr = this.builder.nextSSA();
          this.builder.emit(`${dstElemPtr} = llvm.getelementptr ${arrPtr}[${dstIdx}] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr`);
          this.builder.emit(`llvm.store ${strPtr}, ${dstElemPtr} : !llvm.ptr, !llvm.ptr`);
        });

        this.builder.store(argvAddr, { ssa: arrPtr, ptr: arrPtr, type: "!llvm.ptr" });
        processArgvPtrSSA = arrPtr;
      }

      for (const init of this.staticFieldInitializers) {
        const val = this.lowerExpression(init.valueNode);
        const addr = this.builder.nextSSA();
        this.builder.emit(`${addr} = llvm.mlir.addressof ${init.globalSym} : !llvm.ptr`);
        const coerced = this.coerceType(val, init.type);
        this.builder.store(addr, coerced);
        if (val.isArray) {
          const g = this.globals.get(init.globalVarName);
          if (g) {
            g.isArray = true;
            g.elemType = val.elemType || "f64";
            g.isString = val.isString || false;
            g.structName = val.structName || null;
          }
        }
      }

      for (const stmt of nonEntryTopLevelStatements) {
        this.lowerStatement(stmt);
      }

      const shouldCallUserMain = Boolean(userMainNode && !isUserMainNoEntry);

      for (const stmt of entryTopLevelStatements) {
        if (shouldCallUserMain && this.isDirectMainCallStatement(stmt)) {
          // Kullanıcı main'i override ettiğinde script içindeki doğrudan main() çağrısını atla
          continue;
        }
        this.lowerStatement(stmt);
      }

      let exitCodeSSA;
      if (shouldCallUserMain) {
        const userParams = userMainMeta?.params || [];
        let preparedArgs = [];

        if (userParams.length === 2) {
          const argcVal = isWasm ? this.builder.createConstant(0, "i32") : { ssa: "%argc", type: "i32" };
          let argvVal;
          if (isWasm) {
            const nullPtr = this.builder.nextSSA();
            this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
            argvVal = { ssa: nullPtr, ptr: nullPtr, type: "!llvm.ptr" };
          } else {
            argvVal = { ssa: "%argv", ptr: "%argv", type: "!llvm.ptr" };
          }
          const p0 = this.coerceType(argcVal, userParams[0].type);
          const p1 = this.coerceType(argvVal, userParams[1].type);
          preparedArgs = [p0, p1];
        } else if (userParams.length === 1) {
          const p0Meta = userParams[0];
          const p0TypeNode = userMainNode.params[0]?.typeAnnotation || userMainNode.params[0]?.pattern?.typeAnnotation || userMainNode.params[0]?.id?.typeAnnotation;
          const arrMeta = this.extractArrayTargetType(p0TypeNode);
          const isStringArray = (p0Meta.isArray && p0Meta.isString) || Boolean(arrMeta && arrMeta.isString);

          if (isStringArray) {
            preparedArgs = [{ ssa: processArgvPtrSSA, ptr: processArgvPtrSSA, type: "!llvm.ptr", isArray: true, isString: true }];
          } else {
            const argcVal = isWasm ? this.builder.createConstant(0, "i32") : { ssa: "%argc", type: "i32" };
            const p0 = this.coerceType(argcVal, p0Meta.type);
            preparedArgs = [p0];
          }
        }

        let res;
        const argSSAs = preparedArgs.map((a) => a.ssa || a.ptr).join(", ");
        const argTypes = (userMainMeta?.paramTypes || []).join(", ");

        if (userMainMeta?.isAsync) {
          const taskSsa = this.builder.nextSSA();
          this.builder.emit(`${taskSsa} = func.call @user_main_entry(${argSSAs}) : (${argTypes}) -> !llvm.ptr`);

          const ctxMeta = this.asyncTaskContexts.get("main") || userMainMeta.taskContextMeta;
          const taskContextType = ctxMeta?.type || "!llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>";
          const retIdx = ctxMeta ? ctxMeta.retIdx : (userMainMeta.innerRetType === "!llvm.ptr" || userMainMeta.isRetString ? 4 : 3);
          const innerRetType = ctxMeta?.innerRetType || userMainMeta.innerRetType || "f64";
          const isRetString = ctxMeta ? ctxMeta.isRetString : (userMainMeta.isRetString || userMainMeta.innerRetType === "!llvm.ptr" || userMainMeta.innerRetType === "string");

          const threadIdPtr = this.builder.nextSSA();
          this.builder.emit(`${threadIdPtr} = llvm.getelementptr ${taskSsa}[0, 0] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
          const threadId = this.builder.load(threadIdPtr, "i64");

          const nullPtr = this.builder.nextSSA();
          this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
          this.builder.emit(`llvm.call @pthread_join(${threadId.ssa}, ${nullPtr}) : (i64, !llvm.ptr) -> i32`);

          if (innerRetType === "none" || retIdx < 0) {
            this.builder.emit(`llvm.call @free(${taskSsa}) : (!llvm.ptr) -> ()`);
            res = { ssa: "", type: "none" };
          } else {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr ${taskSsa}[0, ${retIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
            const loaded = this.builder.load(resGEP, innerRetType);
            this.builder.emit(`llvm.call @free(${taskSsa}) : (!llvm.ptr) -> ()`);
            res = { ssa: loaded.ssa, type: innerRetType, isString: Boolean(isRetString) };
          }
        } else {
          const retType = userMainMeta?.retType || "none";
          if (retType === "none") {
            this.builder.emit(`func.call @user_main_entry(${argSSAs}) : (${argTypes}) -> ()`);
            res = { ssa: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call @user_main_entry(${argSSAs}) : (${argTypes}) -> ${retType}`);
            res = { ssa, type: retType };
          }
        }

        if (res && res.type !== "none" && res.ssa) {
          const coerced = this.coerceType(res, "i32");
          exitCodeSSA = coerced.ssa;
        } else {
          const zero = this.builder.createConstant(0, "i32");
          exitCodeSSA = zero.ssa;
        }
      } else {
        const zero = this.builder.createConstant(0, "i32");
        exitCodeSSA = zero.ssa;
      }

      this.exitScope();

      if (!this.builder.hasTerminated) {
        this.builder.createReturn({ ssa: exitCodeSSA, type: "i32" });
      }
      this.isTopLevel = false;
    });

    this.emitItables();
  }

  getMethodImpl(className, methodName) {
    let curr = className;
    while (curr && this.structRegistry.has(curr)) {
      const meta = this.structRegistry.get(curr);
      if (meta.methods && meta.methods.has(methodName)) {
        return { className: curr, methodMeta: meta.methods.get(methodName) };
      }
      curr = meta.superClass;
    }
    return null;
  }

  boxIntoInterface(val, ifaceName) { return this.typeLowerer.boxIntoInterface(val, ifaceName); }

  emitItables() {
    if (!this.requiredItables || this.requiredItables.size === 0) return;

    this.builder.markFeature("heap");

    for (const { className, ifaceName } of this.requiredItables.values()) {
      const itableBaseName = `itable_${className}_${ifaceName}`;
      const cacheGlobalName = `${itableBaseName}_cache`;
      const getterFnName = `rts_get_itable_${className}_${ifaceName}`;

      const ifaceMeta = this.structRegistry.get(ifaceName);
      if (!ifaceMeta) continue;

      const methodsList = ifaceMeta.methodsList || [];
      const byteSize = Math.max(methodsList.length * 8, 8);

      // 1. Static cache global
      this.builder.emit(`llvm.mlir.global internal @${cacheGlobalName}() : !llvm.ptr {`);
      this.builder.emit(`  %0 = llvm.mlir.zero : !llvm.ptr`);
      this.builder.emit(`  llvm.return %0 : !llvm.ptr`);
      this.builder.emit(`}\n`);

      // 2. Getter function
      this.builder.block(`func.func @${getterFnName}() -> !llvm.ptr`, () => {
        const addrSSA = this.builder.nextSSA();
        this.builder.emit(`${addrSSA} = llvm.mlir.addressof @${cacheGlobalName} : !llvm.ptr`);
        const cachedSSA = this.builder.nextSSA();
        this.builder.emit(`${cachedSSA} = llvm.load ${addrSSA} : !llvm.ptr -> !llvm.ptr`);
        const nullSSA = this.builder.nextSSA();
        this.builder.emit(`${nullSSA} = llvm.mlir.zero : !llvm.ptr`);
        const condSSA = this.builder.nextSSA();
        this.builder.emit(`${condSSA} = llvm.icmp "ne" ${cachedSSA}, ${nullSSA} : !llvm.ptr`);

        const cachedBlock = this.builder.nextBlock("itable_cached");
        const initBlock = this.builder.nextBlock("itable_init");

        this.builder.emitBranchConditional(condSSA, cachedBlock, initBlock);

        // Cached block
        this.builder.emitBlockLabel(cachedBlock);
        this.builder.emit(`func.return ${cachedSSA} : !llvm.ptr`);

        // Init block
        this.builder.emitBlockLabel(initBlock);
        const szSSA = this.builder.nextSSA();
        this.builder.emit(`${szSSA} = llvm.mlir.constant(${byteSize} : i64) : i64`);
        const tableSSA = this.builder.nextSSA();
        this.builder.emit(`${tableSSA} = llvm.call @malloc(${szSSA}) : (i64) -> !llvm.ptr`);

        for (let i = 0; i < methodsList.length; i++) {
          const m = methodsList[i];
          const impl = this.getMethodImpl(className, m.name);
          if (!impl) {
            throw new Error(`[Itable] '${className}' sınıfında '${m.name}' metodunun implementasyonu bulunamadı!`);
          }

          const targetFn = `@${impl.className}_${m.name}`;
          const rawParamTypes = m.params || [];
          const paramTypes = rawParamTypes.map((p) => (typeof p === "string" ? p : this.resolveType(p)));
          const retType = m.retType || "none";
          const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;

          const fnConst = this.builder.nextSSA();
          this.builder.emit(`${fnConst} = func.constant ${targetFn} : ${callableType}`);
          const fnPtr = this.builder.nextSSA();
          this.builder.emit(`${fnPtr} = builtin.unrealized_conversion_cast ${fnConst} : ${callableType} to !llvm.ptr`);

          const gepSSA = this.builder.nextSSA();
          this.builder.emit(
            `${gepSSA} = llvm.getelementptr ${tableSSA}[${i}] : (!llvm.ptr) -> !llvm.ptr, !llvm.ptr`
          );
          this.builder.emit(`llvm.store ${fnPtr}, ${gepSSA} : !llvm.ptr, !llvm.ptr`);
        }

        this.builder.emit(`llvm.store ${tableSSA}, ${addrSSA} : !llvm.ptr, !llvm.ptr`);
        this.builder.emit(`func.return ${tableSSA} : !llvm.ptr`);
      });
    }
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
    this.napiLowerer.emitNapiWrappers();
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
        const fieldType = this.resolveType(typeAnnot);
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
            const fieldType = this.resolveType(typeAnnot);
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
    const methods = new Map();
    const methodsList = [];

    // 1. Interface Kalıtımı (interface EntityHeader extends Base, Identifiable)
    const extendsList = node.extends || node.heritage || [];
    const heritageClauses = Array.isArray(extendsList) ? extendsList : [extendsList];
    for (const h of heritageClauses) {
      const parentName = h.expression?.name || h.expression?.value || h.id?.name || h.name;
      if (parentName && this.structRegistry.has(parentName)) {
        const parentMeta = this.structRegistry.get(parentName);
        for (const f of parentMeta.fields || []) {
          if (f.name !== "__type_id" && !fields.some((existing) => existing.name === f.name)) {
            fields.push({ ...f, index: fields.length });
            types.push(f.type);
          }
        }
        if (parentMeta.methodsList) {
          for (const m of parentMeta.methodsList) {
            if (!methods.has(m.name)) {
              const inheritedM = { ...m, index: methodsList.length };
              methods.set(m.name, inheritedM);
              methodsList.push(inheritedM);
            }
          }
        }
      }
    }

    // 2. Kendi Alanları ve Metotları (Own members)
    const members =
      node.members ||
      node.body?.body ||
      node.body?.members ||
      (Array.isArray(node.body) ? node.body : []);

    members.forEach((member) => {
      if (member.type === "TSMethodSignature") {
        const methodName = member.key?.name || member.key?.value || member.name;
        const rawParams = Array.isArray(member.params)
          ? member.params
          : Array.isArray(member.params?.items)
          ? member.params.items
          : [];
        const params = rawParams.map((p) => {
          const annot = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
          return this.resolveType(annot);
        });
        const paramsMeta = rawParams.map((p) => {
          const annot = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
          const sName = this.getStructName(annot);
          return { structName: sName };
        });
        const retType = this.resolveType(member.returnType);
        const isRetString = this.isStringType(member.returnType);
        const structRetName = this.getStructName(member.returnType);

        const mData = {
          name: methodName,
          params,
          paramsMeta,
          retType,
          isRetString,
          structRetName,
          index: methodsList.length,
          node: member,
        };
        methods.set(methodName, mData);
        methodsList.push(mData);
      } else if (member.type === "TSPropertySignature" || member.key) {
        const fieldName = member.key?.name || member.key?.value || member.name;
        const typeAnnot = member.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const existingIdx = fields.findIndex((f) => f.name === fieldName);
        const fieldType = isFn ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : this.resolveType(typeAnnot);
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

    const isPolymorphic = methodsList.length > 0;
    const pragmas = this.getPragmas(node);
    const isPacked = pragmas.packed;
    const mlirType = isPolymorphic
      ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>"
      : isPacked
      ? `!llvm.struct<packed (${types.join(", ")})>`
      : `!llvm.struct<(${types.join(", ")})>`;

    this.structRegistry.set(structName, {
      name: structName,
      fields,
      types,
      mlirType,
      methods,
      methodsList,
      isInterface: true,
      isPolymorphic,
      isPacked,
    });
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
      const staticMethods = new Map();
      const staticFields = new Map();

      for (const elem of bodyElements) {
        if (elem.type === "PropertyDefinition" || elem.type === "TSAbstractPropertyDefinition") {
          const fieldName = elem.key.name || elem.key.value;
          const fieldType = this.resolveType(elem.typeAnnotation);
          const structName = this.getStructName(elem.typeAnnotation);
          const isString = this.isStringType(elem.typeAnnotation);
          const isArr = this.unwrapType(elem.typeAnnotation)?.type === "TSArrayType";
          const arrMeta = isArr ? this.extractArrayTargetType(elem.typeAnnotation) : null;
          const isArrString = Boolean(arrMeta?.isString);
          const arrElemType = arrMeta?.elemType || "f64";

          if (elem.static) {
            const varName = `${name}_${fieldName}`;
            const globalSym = `@g_${varName}`;
            let initVal = 0;
            if (elem.value) {
              if (elem.value.type === "NumericLiteral" || (elem.value.type === "Literal" && typeof elem.value.value === "number")) {
                initVal = elem.value.value;
              } else if (elem.value.type === "BooleanLiteral" || (elem.value.type === "Literal" && typeof elem.value.value === "boolean")) {
                initVal = Boolean(elem.value.value);
              }
            }
            const isProcessBuiltin = (varName === "process_argc" || varName === "Process_argc" || varName === "process_argv" || varName === "Process_argv");
            if (!isProcessBuiltin) {
              this.globals.set(varName, { name: varName, globalSym, type: fieldType, isString: isString || isArrString, isArray: isArr, elemType: arrElemType, initVal, structName });
              this.builder.registerGlobal(globalSym, fieldType, initVal);
            }
            staticFields.set(fieldName, { name: fieldName, type: fieldType, structName, isString: isString || isArrString, isArray: isArr, elemType: arrElemType, globalSym: isProcessBuiltin ? (varName.endsWith("argc") ? "@g_process_argc" : "@g_process_argv") : globalSym });
            if (elem.value) {
              this.staticFieldInitializers.push({
                globalVarName: varName,
                globalSym,
                type: fieldType,
                valueNode: elem.value,
                isString: isString || isArrString,
                structName,
              });
            }
          } else {
            fields.push({ name: fieldName, type: fieldType, structName, isString: isString || isArrString, isArray: isArr, elemType: arrElemType, index: fields.length });
            types.push(fieldType);
          }
        } else if (elem.type === "MethodDefinition" || elem.type === "TSAbstractMethodDefinition") {
          const mName = elem.key.name || elem.key.value;
          const isConstructor = elem.kind === "constructor";
          const isStatic = Boolean(elem.static);
          const isAbstract = Boolean(elem.abstract || elem.type === "TSAbstractMethodDefinition");
          const retType = isConstructor ? "none" : this.resolveType(elem.value?.returnType);
          const structRetName = isConstructor ? name : this.getStructName(elem.value?.returnType);
          const isRetString = !isConstructor && this.isStringType(elem.value?.returnType);

          const rawParams = Array.isArray(elem.value?.params)
            ? elem.value.params
            : Array.isArray(elem.value?.params?.items)
            ? elem.value.params.items
            : [];
          const params = [];
          let hasRest = false;
          let restElemType = null;
          rawParams.forEach((param, i) => {
            const isRest = param.type === "RestElement";
            const actualParam = isRest ? param.argument : param;
            const pName = actualParam.name || actualParam.pattern?.name || actualParam.id?.name || `arg_${i}`;
            const typeAnnot = param.typeAnnotation || actualParam.typeAnnotation || param.pattern?.typeAnnotation || actualParam.id?.typeAnnotation;
            const isFn = this.isFunctionType(typeAnnot);
            const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
            const isUnion = this.isUnionType(typeAnnot);
            const isArr = isRest || this.unwrapType(typeAnnot)?.type === "TSArrayType";
            let arrElemType = "f64";
            let isArrString = false;
            if (isArr) {
              const unwrappedArr = this.unwrapType(typeAnnot);
              const elRaw = unwrappedArr ? this.unwrapType(unwrappedArr.elementType) : null;
              if (elRaw && (elRaw.type === "TSStringKeyword" || elRaw.typeName?.name === "string")) {
                arrElemType = "!llvm.ptr";
                isArrString = true;
              }
            }
            const isStr = isRest ? isArrString : this.isStringType(typeAnnot);
            const pType = isFn ? fnSig.mlirType : (isUnion || isArr || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
            if (isRest) {
              hasRest = true;
              restElemType = arrElemType;
            }
            params.push({ name: pName, type: pType, isUnion, isArray: isArr, elemType: arrElemType, isString: isStr, isRest, isFunction: isFn, fnSig });
          });

          const mMeta = {
            name: mName,
            className: name,
            isConstructor,
            isStatic,
            isAbstract,
            retType,
            structRetName,
            isRetString,
            hasRest,
            restElemType,
            params,
            node: elem,
          };

          if (isStatic) {
            staticMethods.set(mName, mMeta);
            const fnName = `${name}_${mName}`;
            const paramTypes = params.map((p) => p.type);
            const declSig = retType === "none" ? `(${paramTypes.join(", ")})` : `(${paramTypes.join(", ")}) -> ${retType}`;
            const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
            this.functionRegistry.set(fnName, {
              isAsync: false,
              isDeclare: false,
              innerRetType: retType,
              retType,
              structRetName,
              enumRetName: null,
              isRetString,
              isRetFn: false,
              retFnSig: null,
              hasRest,
              restElemType,
              params,
              paramTypes,
              mlirType,
              declSig,
              isClosure: false,
              taskContextMeta: null,
              exportAlias: null,
            });
          } else {
            ownMethods.set(mName, mMeta);
          }
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
        staticMethods,
        staticFields,
        isClass: true,
        isAbstract: Boolean(node.abstract),
      });
    }
  }

  emitVCallRouters() {
    this.classLowerer.emitVCallRouters();
  }

  lowerClassMethods(node) {
    const className = node.id.name;
    const bodyElements = node.body?.body || [];

    for (const elem of bodyElements) {
      if (elem.type !== "MethodDefinition" && elem.type !== "TSAbstractMethodDefinition") continue;
      if (elem.abstract || elem.type === "TSAbstractMethodDefinition" || !elem.value?.body) continue;

      const isConstructor = elem.kind === "constructor";
      const isStatic = Boolean(elem.static);
      const methodName = elem.key.name || elem.key.value;
      const fnName = isConstructor ? `${className}_constructor` : `${className}_${methodName}`;

      const fnExpr = elem.value;
      const rawParams = Array.isArray(fnExpr.params)
        ? fnExpr.params
        : Array.isArray(fnExpr.params?.items)
        ? fnExpr.params.items
        : [];

      const paramStrings = isStatic ? [] : [`%arg_this: !llvm.ptr`];
      const params = isStatic ? [] : [{ name: "this", ssa: "%arg_this", type: "!llvm.ptr", structName: className }];

      rawParams.forEach((param, i) => {
        const isRest = param.type === "RestElement";
        const actualParam = isRest ? param.argument : param;
        const pName = actualParam.name || actualParam.pattern?.name || actualParam.id?.name || `arg_${i}`;
        const typeAnnot = param.typeAnnotation || actualParam.typeAnnotation || param.pattern?.typeAnnotation || actualParam.id?.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const isUnion = this.isUnionType(typeAnnot);
        const isArr = isRest || this.unwrapType(typeAnnot)?.type === "TSArrayType";
        let arrElemType = "f64";
        let isArrString = false;
        let arrStruct = null;
        if (isArr) {
          const unwrappedArr = this.unwrapType(typeAnnot);
          const elRaw = unwrappedArr ? this.unwrapType(unwrappedArr.elementType) : null;
          if (elRaw && (elRaw.type === "TSStringKeyword" || elRaw.typeName?.name === "string")) {
            arrElemType = "!llvm.ptr";
            isArrString = true;
          } else if (elRaw && elRaw.type === "TSTypeReference") {
            const tName = elRaw.typeName?.name || elRaw.typeName?.value;
            if (["i32", "int32", "u32", "int"].includes(tName)) arrElemType = "i32";
            else if (["i64", "int64", "u64"].includes(tName)) arrElemType = "i64";
            else if (["bool", "boolean"].includes(tName)) arrElemType = "i1";
            else if (this.structRegistry.has(tName) || this.classList.some((c) => c.name === tName)) {
              const isPoly = this.isPolymorphicInterface(tName);
              arrElemType = isPoly ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : "!llvm.ptr";
              arrStruct = tName;
            }
          } else if (elRaw && elRaw.type === "TSNumberKeyword") {
            arrElemType = "f64";
          } else if (elRaw && elRaw.type === "TSBooleanKeyword") {
            arrElemType = "i1";
          }
        }
        const isStr = isRest ? isArrString : this.isStringType(typeAnnot);
        const structName = this.getStructName(typeAnnot);
        const isPolyIface = this.isPolymorphicInterface(structName);
        const pType = isFn ? fnSig.mlirType : isPolyIface ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : (isUnion || isArr || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
        const ssaArg = `%arg_${pName}`;

        paramStrings.push(`${ssaArg}: ${pType}`);
        params.push({ name: pName, ssa: ssaArg, type: pType, structName, isInterface: isPolyIface, isUnion, isArray: isArr, elemType: arrElemType, isString: isStr || isArrString, arrStruct, isFunction: isFn, fnSig, typeAnnot, isRest });
      });

      const retType = isConstructor ? "none" : this.resolveType(fnExpr.returnType);
      const structRetName = isConstructor ? null : this.getStructName(fnExpr.returnType);
      const sig = retType === "none" ? "" : ` -> ${retType}`;

      this.builder.block(`func.func @${fnName}(${paramStrings.join(", ")})${sig}`, () => {
        this.builder.hasTerminated = false;
        if (node._namespacePrefix) {
          elem.value._namespacePrefix = node._namespacePrefix;
        }
        const prevFuncNode = this.currentFunctionNode;
        this.currentFunctionNode = elem.value;
        this.enterScope(true, retType, structRetName);

        const prevSyms = new Map(this.symbolTable);
        this.symbolTable.clear();

        if (!isStatic) {
          this.symbolTable.set("this", {
            ptr: "%arg_this",
            ssa: "%arg_this",
            type: "!llvm.ptr",
            structName: className,
            isRef: true,
          });
        }

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
              elemType: p.elemType || "f64",
              isString: p.isString || false,
              structName: p.arrStruct || p.structName || null,
              isRef: true,
            });
          } else if (p.isInterface || this.isPolymorphicInterface(p.structName)) {
            const slot = this.builder.allocateStack("!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
            this.builder.store(slot.ptr, { ssa: p.ssa, type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" });
            this.symbolTable.set(p.name, {
              ptr: slot.ptr,
              ssa: p.ssa,
              type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
              structName: p.structName,
              isInterface: true,
              isSlot: true,
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
        this.currentFunctionNode = prevFuncNode;
      });
    }
  }

  // --- ASYNC & STANDART FONKSİYON LOWERING ---
  lowerFunction(node) {
    const funcName = node.id.name;
    const isAsync = Boolean(node.async);
    const fnMeta = this.functionRegistry.get(funcName);
    const pragmas = this.getPragmas(node);

    const params = [];
    const paramStrings = [];
    const paramTypes = [];

    const rawParams = Array.isArray(node.params)
      ? node.params
      : Array.isArray(node.params?.items)
      ? node.params.items
      : [];

    rawParams.forEach((param, i) => {
      const isRest = param.type === "RestElement";
      const actualParam = isRest ? param.argument : param;
      const pName = actualParam.name || actualParam.pattern?.name || actualParam.id?.name || `arg_${i}`;
      const typeAnnot = param.typeAnnotation || actualParam.typeAnnotation || param.pattern?.typeAnnotation || actualParam.id?.typeAnnotation;
      const isFn = this.isFunctionType(typeAnnot);
      const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
      const isUnion = this.isUnionType(typeAnnot);
      if (isUnion) {
        this.builder.markFeature("union");
      }
      const isArr = isRest || this.unwrapType(typeAnnot)?.type === "TSArrayType";
      let arrElemType = "f64";
      let isArrString = false;
      let arrStruct = null;
      if (isArr) {
        const unwrappedArr = this.unwrapType(typeAnnot);
        const elRaw = unwrappedArr ? this.unwrapType(unwrappedArr.elementType) : null;
        if (elRaw && (elRaw.type === "TSStringKeyword" || elRaw.typeName?.name === "string")) {
          arrElemType = "!llvm.ptr";
          isArrString = true;
        } else if (elRaw && elRaw.type === "TSTypeReference") {
          const tName = elRaw.typeName?.name || elRaw.typeName?.value;
          if (["i32", "int32", "u32", "int"].includes(tName)) arrElemType = "i32";
          else if (["i64", "int64", "u64"].includes(tName)) arrElemType = "i64";
          else if (["bool", "boolean"].includes(tName)) arrElemType = "i1";
          else if (this.structRegistry.has(tName) || this.classList.some((c) => c.name === tName)) {
            const isPoly = this.isPolymorphicInterface(tName);
            arrElemType = isPoly ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : "!llvm.ptr";
            arrStruct = tName;
          }
        } else if (elRaw && elRaw.type === "TSNumberKeyword") {
          arrElemType = "f64";
        } else if (elRaw && elRaw.type === "TSBooleanKeyword") {
          arrElemType = "i1";
        }
      }
      const isChan = this.unwrapType(typeAnnot)?.typeName?.name === "Channel";
      const isStr = isRest ? isArrString : this.isStringType(typeAnnot);
      const structName = this.getStructName(typeAnnot);
      const isPolyIface = this.isPolymorphicInterface(structName);
      const pType = isFn ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : isPolyIface ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : (isUnion || isArr || isChan || isStr) ? "!llvm.ptr" : this.resolveType(typeAnnot);

      const ssaArg = `%arg_${pName}`;
      paramStrings.push(`${ssaArg}: ${pType}`);
      paramTypes.push(pType);
      params.push({ name: pName, ssa: ssaArg, type: pType, structName, isInterface: isPolyIface, isUnion, isArray: isArr, elemType: arrElemType, isString: isStr || isArrString, arrStruct, isFunction: isFn, isClosure: isFn, fnSig, typeAnnot, isChannel: isChan, isRest });
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

      const ctxMeta = this.asyncTaskContexts.get(funcName) || fnMeta?.taskContextMeta || {
        type: `!llvm.struct<(i64${paramTypes.length ? ", " + paramTypes.join(", ") : ""}${innerRetType !== "none" ? ", " + innerRetType : ""}, i32)>`,
        retIdx: innerRetType !== "none" ? paramTypes.length + 1 : -1,
        statusIdx: innerRetType !== "none" ? paramTypes.length + 2 : paramTypes.length + 1,
        byteSize: Math.max((paramTypes.length + (innerRetType !== "none" ? 3 : 2)) * 8, 16),
      };
      const taskContextType = ctxMeta.type;

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

        if (!this.builder.hasTerminated) {
          if (innerRetType === "none") {
            this.exitScope();
            this.builder.createReturn();
          } else if (innerRetType === "!llvm.ptr") {
            const nullPtr = this.builder.nextSSA();
            this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
            this.exitScope();
            this.builder.createReturn({ ssa: nullPtr, type: "!llvm.ptr" });
          } else {
            const defVal = this.builder.createConstant(0, innerRetType);
            this.exitScope();
            this.builder.createReturn(defVal);
          }
        } else if (this.scopeStack.length > 0 && this.scopeStack[this.scopeStack.length - 1].isFunction) {
          this.scopeStack.pop();
        }
        this.symbolTable = prevSyms;
      });

      // 2. pthread runner fonksiyonu (@__async_runner_*)
      this.builder.block(`func.func @${runnerName}(%arg_ctx: !llvm.ptr) -> !llvm.ptr`, () => {
        const callArgs = [];
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          const fieldIdx = i + 1;
          const gep = this.builder.nextSSA();
          this.builder.emit(`${gep} = llvm.getelementptr %arg_ctx[0, ${fieldIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
          const loaded = this.builder.load(gep, p.type);
          callArgs.push(loaded.ssa);
        }

        const callStr = callArgs.join(", ");
        const typeStr = paramTypes.join(", ");

        if (innerRetType === "none") {
          this.builder.emit(`func.call @${innerName}(${callStr}) : (${typeStr}) -> ()`);
        } else {
          const resSSA = this.builder.nextSSA();
          this.builder.emit(`${resSSA} = func.call @${innerName}(${callStr}) : (${typeStr}) -> ${innerRetType}`);
          if (ctxMeta.retIdx >= 0) {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr %arg_ctx[0, ${ctxMeta.retIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
            this.builder.store(resGEP, { ssa: resSSA, type: innerRetType });
          }
        }

        const statusGEP = this.builder.nextSSA();
        this.builder.emit(`${statusGEP} = llvm.getelementptr %arg_ctx[0, ${ctxMeta.statusIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
        const c1 = this.builder.createConstant(1, "i32");
        this.builder.store(statusGEP, c1);

        const nullRet = this.builder.nextSSA();
        this.builder.emit(`${nullRet} = llvm.mlir.zero : !llvm.ptr`);
        this.builder.emit(`func.return ${nullRet} : !llvm.ptr`);
      });

      // 3. Çağrıcı fonksiyon (@funcName)
      const effectiveCallerName = (funcName.includes("_") && !node.exportAlias)
        ? funcName
        : (node.exportAlias || pragmas.exportName || funcName);
      this.builder.block(`func.func @${effectiveCallerName}(${paramStrings.join(", ")}) -> !llvm.ptr`, () => {
        const ctxSz = this.builder.nextSSA();
        this.builder.emit(`${ctxSz} = llvm.mlir.constant(${ctxMeta.byteSize} : i64) : i64`);
        const taskPtr = this.builder.nextSSA();
        this.builder.emit(`${taskPtr} = llvm.call @malloc(${ctxSz}) : (i64) -> !llvm.ptr`);

        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          const fieldIdx = i + 1;
          const gep = this.builder.nextSSA();
          this.builder.emit(`${gep} = llvm.getelementptr ${taskPtr}[0, ${fieldIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
          this.builder.store(gep, { ssa: p.ssa, type: p.type });
        }

        const statusGEP = this.builder.nextSSA();
        this.builder.emit(`${statusGEP} = llvm.getelementptr ${taskPtr}[0, ${ctxMeta.statusIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
        const c0 = this.builder.createConstant(0, "i32");
        this.builder.store(statusGEP, c0);

        const nullAttr = this.builder.nextSSA();
        this.builder.emit(`${nullAttr} = llvm.mlir.zero : !llvm.ptr`);

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
      const prevFuncNode = this.currentFunctionNode;
      this.currentFunctionNode = node;
      this.builder.hasTerminated = false;
      this.enterScope(true, retType, structRetName);
      const prevSyms = new Map(this.symbolTable);

      for (const p of params) {
        if (p.isFunction || p.isClosure) {
          this.symbolTable.set(p.name, {
            ssa: p.ssa,
            ptr: p.ssa,
            type: p.type,
            isFunction: true,
            isClosure: true,
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
            elemType: p.elemType || "f64",
            isString: p.isString || false,
            structName: p.arrStruct || p.structName || null,
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
        } else if (p.isInterface || this.isPolymorphicInterface(p.structName)) {
          const slot = this.builder.allocateStack("!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
          this.builder.store(slot.ptr, { ssa: p.ssa, type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" });
          this.symbolTable.set(p.name, {
            ptr: slot.ptr,
            ssa: p.ssa,
            type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
            structName: p.structName,
            isInterface: true,
            isSlot: true,
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

      // Closure ise ve serbest değişkenleri yakalamışsa, ortamdan (environment) aç (unpack)
      if (node.isClosure && node.captures && node.captures.length > 0) {
        const meta = this.closureRegistry?.get(effectiveFnName);
        const capturesMeta = meta?.captureMeta || (node.capturesMeta || []).map((c) => ({
          name: c.name,
          type: c.typeAnnotation ? this.resolveType(c.typeAnnotation) : "f64",
          isString: c.typeAnnotation ? this.isStringType(c.typeAnnotation) : false,
          structName: c.typeAnnotation ? this.getStructName(c.typeAnnotation) : null,
        }));
        const envTypes = capturesMeta.map((c) => c.type || "f64");
        const envStructType = `!llvm.struct<(${envTypes.join(", ")})>`;
        capturesMeta.forEach((cap, idx) => {
          const cType = cap.type || "f64";
          const gep = this.builder.nextSSA();
          this.builder.emit(
            `${gep} = llvm.getelementptr %arg___env[0, ${idx}] : (!llvm.ptr) -> !llvm.ptr, ${envStructType}`
          );
          this.symbolTable.set(cap.name, {
            ptr: gep,
            ssa: gep,
            type: cType,
            isString: cap.isString || false,
            structName: cap.structName || null,
            isArray: cap.isArray || false,
            elemType: cap.elemType || "f64",
            isClosure: cap.isClosure || false,
            isFunction: cap.isFunction || false,
            fnSig: cap.fnSig || null,
            isRef: true,
          });
        });
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
      this.currentFunctionNode = prevFuncNode;
    });
  }

  lowerStatement(stmt) {
    return this.statementLowerer.lowerStatement(stmt);
  }

  lowerNewExpression(expr, canStackAllocate = false) {
    return this.memoryLowerer.lowerNewExpression(expr, canStackAllocate);
  }

  inferStructName(objExpr, hintStructName = null) {
    return this.memoryLowerer.inferStructName(objExpr, hintStructName);
  }

  instantiateStruct(objExpr, structName, canStackAllocate = false) {
    return this.memoryLowerer.instantiateStruct(objExpr, structName, canStackAllocate);
  }

  instantiateArray(arrExpr, targetElemType = null, isTargetString = false, targetStructName = null) {
    return this.memoryLowerer.instantiateArray(arrExpr, targetElemType, isTargetString, targetStructName);
  }

  packRestArguments(restArgs, restParam) {
    return this.memoryLowerer.packRestArguments(restArgs, restParam);
  }

  lowerCallArguments(paramsMeta, exprArguments) {
    return this.memoryLowerer.lowerCallArguments(paramsMeta, exprArguments);
  }

  tryLowerSIMDCall(expr) {
    return this.simdLowerer.tryLowerSIMDCall(expr);
  }

  lowerCallExpression(expr) {
    return this.callLowerer.lowerCallExpression(expr);
  }

  lowerExpression(expr) {
    return this.expressionLowerer.lowerExpression(expr);
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