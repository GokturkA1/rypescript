// src/semantics/SemanticAnalyzer.js
import { ScopeManager } from "./ScopeManager.js";
import { BuiltinRegistry } from "./BuiltinRegistry.js";
import { TypeChecker } from "./TypeChecker.js";

/**
 * RypeScript Semantik Analizörü ve Tip Denetleyicisi.
 * Modülleri iki geçişte (1. İmza Toplama, 2. Gövde Denetimi) analiz eder.
 */
export class SemanticAnalyzer {
  constructor(modules, diagnosticReporter) {
    this.modules = modules;
    this.reporter = diagnosticReporter;
    this.currentFilePath = "";

    this.scopeManager = new ScopeManager();
    this.builtins = new BuiltinRegistry();
    this.typeChecker = new TypeChecker(
      this.builtins,
      this.scopeManager,
      this.reporter,
      () => this.currentFilePath
    );
  }

  // Delegasyonlar (Geriye Dönük Uyumluluk)
  get scopes() {
    return this.scopeManager.scopes;
  }
  get functionSignatures() {
    return this.builtins.functionSignatures;
  }
  get structSignatures() {
    return this.builtins.structSignatures;
  }
  get enumSignatures() {
    return this.builtins.enumSignatures;
  }
  get typeAliasRegistry() {
    return this.builtins.typeAliasRegistry;
  }
  get unionRegistry() {
    return this.builtins.unionRegistry;
  }
  get functionTypeAliases() {
    return this.builtins.functionTypeAliases;
  }

  enterScope(isFunction = false, expectedReturnType = null) {
    this.scopeManager.enterScope(isFunction, expectedReturnType);
  }

  exitScope() {
    this.scopeManager.exitScope();
  }

  lookupSymbol(name) {
    return this.scopeManager.lookupSymbol(name);
  }

  resolveType(typeNode) {
    return this.typeChecker.resolveType(typeNode);
  }

  unwrapType(typeNode) {
    return this.typeChecker.unwrapType(typeNode);
  }

  typesAreCompatible(expected, actual) {
    return this.typeChecker.typesAreCompatible(expected, actual);
  }

  inferExpressionType(expr, expectedType = null) {
    return this.typeChecker.inferExpressionType(expr, expectedType);
  }

  analyze() {
    // --- 1. GEÇİŞ: Genel Tanımları (İmzaları) Topla ---
    for (const mod of this.modules) {
      this.currentFilePath = mod.filePath;
      for (const rawNode of mod.program.body) {
        const decl =
          (rawNode.type === "ExportNamedDeclaration" || rawNode.type === "ExportDefaultDeclaration") &&
          rawNode.declaration
            ? rawNode.declaration
            : rawNode;

        if (decl.type === "TSEnumDeclaration") {
          const enumName = decl.id.name;
          const members = new Map();
          let kind = "numeric";
          for (const m of decl.members || []) {
            const mName = m.id?.name ?? m.id?.value;
            const initVal = m.initializer?.value ?? m.init?.value;
            if (typeof initVal === "string") kind = "string";
            members.set(mName, initVal);
          }
          this.builtins.enumSignatures.set(enumName, { name: enumName, kind, members });
        }

        if (decl.type === "TSInterfaceDeclaration") {
          const structName = decl.id.name;
          const fields = new Map();
          for (const member of decl.body?.body || []) {
            if (member.type === "TSPropertySignature") {
              const fName = member.key?.name || member.key?.value;
              const fType = this.resolveType(member.typeAnnotation);
              fields.set(fName, { type: fType, node: member });
            }
          }
          this.builtins.structSignatures.set(structName, {
            name: structName,
            fields,
            methods: new Map(),
            node: decl,
          });
        }

        if (decl.type === "TSTypeAliasDeclaration") {
          const aliasName = decl.id.name;
          let inner = decl.typeAnnotation;
          this.builtins.typeAliasRegistry.set(aliasName, inner);

          if (
            inner.type === "TSTypeReference" &&
            (inner.typeName?.name === "Untagged" || inner.typeName?.value === "Untagged")
          ) {
            const typeArg = inner.typeParameters?.params?.[0] || inner.typeArguments?.params?.[0];
            if (typeArg) {
              inner = typeArg;
            }
          }

          if (inner.type === "TSIntersectionType") {
            const mergedFields = new Map();
            for (const t of inner.types || []) {
              const tName = t.typeName?.name || t.typeName?.value;
              if (tName && this.builtins.structSignatures.has(tName)) {
                const parentMeta = this.builtins.structSignatures.get(tName);
                for (const [fName, fData] of parentMeta.fields.entries()) {
                  mergedFields.set(fName, fData);
                }
              }
            }
            this.builtins.structSignatures.set(aliasName, {
              name: aliasName,
              fields: mergedFields,
              methods: new Map(),
              node: decl,
            });
          } else if (inner.type === "TSTypeLiteral") {
            const rawMembers =
              inner.members ||
              inner.body?.body ||
              inner.body?.members ||
              (Array.isArray(inner.body) ? inner.body : []);
            const fields = new Map();
            for (const member of rawMembers) {
              const fName = member.key?.name || member.key?.value || member.name || member.id?.name;
              const fType = this.resolveType(member.typeAnnotation);
              fields.set(fName, { type: fType, node: member });
            }
            this.builtins.structSignatures.set(aliasName, {
              name: aliasName,
              fields: mergedFields || fields,
              methods: new Map(),
              node: decl,
            });
          } else if (inner.type === "TSUnionType") {
            const variants = (inner.types || []).map((t) => this.resolveType(t));
            this.builtins.unionRegistry.set(aliasName, variants);
          } else if (inner.type === "TSFunctionType") {
            this.builtins.functionTypeAliases.add(aliasName);
          }
        }

        if (decl.type === "ClassDeclaration") {
          const clsName = decl.id.name;
          const superClass = decl.superClass?.name || null;
          const fields = new Map();
          const methods = new Map();
          for (const member of decl.body?.body || []) {
            if (member.type === "PropertyDefinition") {
              const fName = member.key?.name || member.key?.value;
              const fType = this.resolveType(member.typeAnnotation);
              fields.set(fName, { type: fType, node: member });
            } else if (member.type === "MethodDefinition") {
              const mName = member.key?.name || member.key?.value;
              const params = (member.value?.params || []).map((p) =>
                this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation)
              );
              const returnType = member.value?.returnType ? this.resolveType(member.value.returnType) : "void";
              methods.set(mName, { params, returnType, node: member });
            }
          }
          this.builtins.structSignatures.set(clsName, {
            name: clsName,
            superClass,
            fields,
            methods,
            node: decl,
          });
        }

        if (decl.type === "FunctionDeclaration") {
          const fnName = decl.id.name;
          const isAsync = Boolean(decl.async);
          const rawTypeParams = decl.typeParameters?.params || [];
          const typeParams = rawTypeParams.map((p) => p.name?.name || p.name?.value || p.name || "");
          const params = (decl.params || []).map((p) => {
            const annot = p.typeAnnotation || p.pattern?.typeAnnotation;
            return this.resolveType(annot);
          });

          let innerReturnType = "any";
          let outerReturnType = "any";

          if (decl.returnType) {
            const unwrapped = this.unwrapType(decl.returnType);
            const typeName = unwrapped?.typeName?.name || unwrapped?.typeName?.value;
            if (typeName === "Promise") {
              const innerParam = unwrapped.typeParameters?.params?.[0] || unwrapped.typeArguments?.params?.[0];
              innerReturnType = innerParam ? this.resolveType(innerParam) : "any";
              outerReturnType = "pointer";
            } else {
              innerReturnType = this.resolveType(decl.returnType);
              outerReturnType = isAsync ? "pointer" : innerReturnType;
            }
          } else {
            innerReturnType = isAsync ? "number" : "any";
            outerReturnType = isAsync ? "pointer" : innerReturnType;
          }

          this.builtins.functionSignatures.set(fnName, {
            params,
            returnType: innerReturnType,
            outerReturnType,
            typeParams,
            node: decl,
          });
        }
      }
    }

    // --- 2. GEÇİŞ: Fonksiyon ve Blok Gövdelerini Denetle ---
    for (const mod of this.modules) {
      this.currentFilePath = mod.filePath;
      this.enterScope(false);

      for (const rawNode of mod.program.body) {
        const decl =
          (rawNode.type === "ExportNamedDeclaration" || rawNode.type === "ExportDefaultDeclaration") &&
          rawNode.declaration
            ? rawNode.declaration
            : rawNode;
        this.checkStatement(decl);
      }

      this.exitScope();
    }

    return this.reporter;
  }

  checkStatement(stmt) {
    if (!stmt) return;

    switch (stmt.type) {
      case "VariableDeclaration": {
        for (const decl of stmt.declarations) {
          const varName = decl.id.name;
          const explicitType = decl.id.typeAnnotation ? this.resolveType(decl.id.typeAnnotation) : null;
          let inferredType = "any";

          if (decl.init) {
            inferredType = this.inferExpressionType(decl.init, explicitType);
          }

          const finalType = explicitType || inferredType;

          if (explicitType && inferredType !== "any" && !this.typesAreCompatible(explicitType, inferredType)) {
            this.reporter.addError(
              this.currentFilePath,
              decl.init || decl.id,
              `Tür uyuşmazlığı: '${explicitType}' beklenen değişkene '${inferredType}' atandı.`
            );
          }

          const scope = this.scopes[this.scopes.length - 1];
          if (scope) {
            scope.symbols.set(varName, {
              type: finalType,
              defNode: decl,
            });
          }
        }
        break;
      }

      case "FunctionDeclaration": {
        const fnMeta = this.builtins.functionSignatures.get(stmt.id.name);
        const retType = fnMeta ? fnMeta.returnType : "any";
        this.enterScope(true, retType);

        for (const p of stmt.params || []) {
          const pName = p.name || p.pattern?.name;
          const pType = this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation);
          const scope = this.scopes[this.scopes.length - 1];
          if (scope) {
            scope.symbols.set(pName, {
              type: pType,
              defNode: p,
            });
          }
        }

        if (stmt.body?.body) {
          for (const s of stmt.body.body) {
            this.checkStatement(s);
          }
        }

        this.exitScope();
        break;
      }

      case "BlockStatement": {
        this.enterScope(false);
        for (const s of stmt.body || []) {
          this.checkStatement(s);
        }
        this.exitScope();
        break;
      }

      case "ForStatement": {
        this.enterScope(false);
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") this.checkStatement(stmt.init);
          else this.inferExpressionType(stmt.init);
        }
        if (stmt.test) this.inferExpressionType(stmt.test);
        if (stmt.update) this.inferExpressionType(stmt.update);
        this.checkStatement(stmt.body);
        this.exitScope();
        break;
      }

      case "WhileStatement": {
        this.enterScope(false);
        if (stmt.test) this.inferExpressionType(stmt.test);
        this.checkStatement(stmt.body);
        this.exitScope();
        break;
      }

      case "IfStatement": {
        this.inferExpressionType(stmt.test);
        this.checkStatement(stmt.consequent);
        if (stmt.alternate) this.checkStatement(stmt.alternate);
        break;
      }

      case "TryStatement": {
        this.checkStatement(stmt.block);
        if (stmt.handler) {
          this.enterScope(false);
          if (stmt.handler.param) {
            const pName = stmt.handler.param.name;
            const scope = this.scopes[this.scopes.length - 1];
            if (scope) {
              scope.symbols.set(pName, { type: "string" });
            }
          }
          this.checkStatement(stmt.handler.body);
          this.exitScope();
        }
        if (stmt.finalizer) {
          this.checkStatement(stmt.finalizer);
        }
        break;
      }

      case "ThrowStatement": {
        if (stmt.argument) this.inferExpressionType(stmt.argument);
        break;
      }

      case "ReturnStatement": {
        let actualRet = "void";
        if (stmt.argument) {
          const fnScope = this.scopes.slice().reverse().find((s) => s.isFunction);
          actualRet = this.inferExpressionType(stmt.argument, fnScope?.expectedReturnType);
        }

        const fnScope = this.scopes.slice().reverse().find((s) => s.isFunction);
        if (fnScope && fnScope.expectedReturnType && fnScope.expectedReturnType !== "any") {
          if (!this.typesAreCompatible(fnScope.expectedReturnType, actualRet)) {
            this.reporter.addError(
              this.currentFilePath,
              stmt.argument || stmt,
              `Dönüş türü uyuşmazlığı: Fonksiyon '${fnScope.expectedReturnType}' döndürmeli, ancak '${actualRet}' döndürüldü.`
            );
          }
        }
        break;
      }

      case "ExpressionStatement": {
        this.inferExpressionType(stmt.expression);
        break;
      }
    }
  }
}
