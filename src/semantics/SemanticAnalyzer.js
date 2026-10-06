// src/semantics/SemanticAnalyzer.js
import fs from "node:fs";
import { ScopeManager } from "./ScopeManager.js";
import { BuiltinRegistry } from "./BuiltinRegistry.js";
import { TypeChecker } from "./TypeChecker.js";

/**
 * RypeScript Güçlendirilmiş Semantik Analizörü ve Tip Denetleyicisi.
 * Hataları derleme anında (Lowering aşamasına geçmeden) tespit eder ve raporlar.
 * Modülleri iki geçişte (1. İmza Toplama, 2. Gövde Denetimi) analiz eder.
 */
export class SemanticAnalyzer {
  constructor(modules, diagnosticReporter, headerFiles = []) {
    this.modules = modules;
    this.reporter = diagnosticReporter;
    this.headerFiles = headerFiles;
    this.currentFilePath = "";
    this.currentNamespace = null;

    this.scopeManager = new ScopeManager();
    this.builtins = new BuiltinRegistry();
    this.typeChecker = new TypeChecker(
      this.builtins,
      this.scopeManager,
      this.reporter,
      () => this.currentFilePath,
      (stmt) => this.checkStatement(stmt),
      () => this.currentNamespace
    );

    if (Array.isArray(headerFiles) && headerFiles.length > 0) {
      for (const h of headerFiles) {
        this.loadCHeader(h);
      }
    }
  }

  // C Başlık dosyalarındaki prototipleri semantik analizöre tanıtır
  loadCHeader(headerFilePath) {
    if (!fs.existsSync(headerFilePath)) return;
    let content = fs.readFileSync(headerFilePath, "utf8");
    content = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    content = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .replace(/extern\s+"C"\s*\{?/g, "")
      .replace(/\}/g, "");

    const protoRegex = /([a-zA-Z0-9_*]+(?:\s+[a-zA-Z0-9_*]+)*)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*;/g;
    let match;
    while ((match = protoRegex.exec(content)) !== null) {
      const rawRet = match[1].trim();
      const funcName = match[2].trim();
      const rawParamsStr = match[3].trim();
      if (["typedef", "return", "if", "while"].includes(rawRet)) continue;

      let retType = "number";
      if (rawRet === "void") retType = "void";
      else if (rawRet.includes("char*")) retType = "string";
      else if (rawRet.includes("*")) retType = "pointer";

      const params = [];
      if (rawParamsStr && rawParamsStr !== "void") {
        const rawParamList = rawParamsStr.split(",");
        rawParamList.forEach((p) => {
          const trimmed = p.trim();
          if (!trimmed) return;
          if (trimmed.includes("char*")) params.push("string");
          else if (trimmed.includes("*")) params.push("pointer");
          else params.push("number");
        });
      }

      this.builtins.functionSignatures.set(funcName, {
        params,
        returnType: retType,
        outerReturnType: retType,
        node: null,
      });
    }
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

  collectClassSignature(decl, parentPrefix = "") {
    const rawClsName = decl.id.name;
    const clsName = parentPrefix ? `${parentPrefix}_${rawClsName}` : rawClsName;
    const superClass = decl.superClass?.name || null;
    const rawTypeParams = decl.typeParameters?.params || [];
    const typeParams = rawTypeParams.map((p) => p.name?.name || p.name?.value || p.name || "");
    const isAbstract = Boolean(decl.abstract);
    const fields = new Map();
    const methods = new Map();
    const staticFields = new Map();
    const staticMethods = new Map();

    for (const member of decl.body?.body || []) {
      if (member.type === "PropertyDefinition" || member.type === "TSAbstractPropertyDefinition") {
        const fName = member.key?.name || member.key?.value;
        const fType = this.resolveType(member.typeAnnotation);
        const fReadonly = Boolean(member.readonly);
        const fAccessibility = member.accessibility || "public";
        const fAbstract = member.type === "TSAbstractPropertyDefinition" || Boolean(member.abstract);

        const fieldMeta = {
          name: fName,
          type: fType,
          readonly: fReadonly,
          accessibility: fAccessibility,
          isAbstract: fAbstract,
          declaringClass: clsName,
          node: member,
        };

        if (member.static) {
          staticFields.set(fName, fieldMeta);
        } else {
          fields.set(fName, fieldMeta);
        }
      } else if (member.type === "MethodDefinition" || member.type === "TSAbstractMethodDefinition") {
        const mName = member.key?.name || member.key?.value;
        const isConstructor = member.kind === "constructor" || mName === "constructor";
        const isStatic = Boolean(member.static);
        const mAbstract = member.type === "TSAbstractMethodDefinition" || Boolean(member.abstract) || !member.value?.body;
        const mOverride = Boolean(member.override);
        const mAccessibility = member.accessibility || "public";

        let hasRest = false;
        let restElemType = null;
        let fixedCount = 0;
        const rawParams = member.value?.params || [];
        const params = rawParams.map((p) => {
          if (p.type === "RestElement") {
            hasRest = true;
            const annot = p.typeAnnotation || p.argument?.typeAnnotation;
            const fullType = this.resolveType(annot);
            const unwrapped = this.unwrapType(annot);
            if (unwrapped?.type === "TSArrayType") {
              restElemType = this.resolveType(unwrapped.elementType);
            } else {
              restElemType = fullType && fullType.endsWith("[]") ? fullType.slice(0, -2) : "string";
            }
            return fullType;
          }
          fixedCount++;
          return this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation);
        });
        const returnType = member.value?.returnType
          ? this.resolveType(member.value.returnType)
          : isConstructor ? "void" : "void";

        const methodMeta = {
          name: mName,
          params,
          returnType,
          isConstructor,
          isStatic,
          isAbstract: mAbstract,
          isOverride: mOverride,
          accessibility: mAccessibility,
          declaringClass: clsName,
          node: member,
          hasRest,
          minArgs: fixedCount,
          restElemType,
        };

        if (isStatic) {
          staticMethods.set(mName, methodMeta);
          this.builtins.functionSignatures.set(`${clsName}_${mName}`, {
            params,
            returnType,
            outerReturnType: returnType,
            node: member,
            hasRest,
            minArgs: fixedCount,
            restElemType,
          });
        } else {
          methods.set(mName, methodMeta);
        }
      }
    }
    this.builtins.structSignatures.set(clsName, {
      name: clsName,
      superClass,
      typeParams,
      isAbstract,
      fields,
      methods,
      staticFields,
      staticMethods,
      node: decl,
      isClass: true,
    });
  }

  collectNamespaceSignatures(moduleDecl, parentPrefix = "") {
    const nsName = this.getNamespaceName(moduleDecl.id);
    const fullPrefix = parentPrefix ? `${parentPrefix}_${nsName}` : nsName;
    const ns = this.builtins.registerNamespace(fullPrefix);
    const prevNs = this.currentNamespace;
    this.currentNamespace = fullPrefix;

    const bodyList = moduleDecl.body?.body || [];
    for (const rawStmt of bodyList) {
      const stmt = (rawStmt.type === "ExportNamedDeclaration" || rawStmt.type === "ExportDefaultDeclaration") && rawStmt.declaration
        ? rawStmt.declaration
        : rawStmt;
      if (!stmt) continue;

      if (stmt.type === "FunctionDeclaration" || stmt.type === "TSDeclareFunction") {
        const fnName = stmt.id.name;
        const mangled = `${fullPrefix}_${fnName}`;
        const params = (stmt.params || []).map((p) => this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation));
        const returnType = stmt.returnType ? this.resolveType(stmt.returnType) : "void";

        let typePredicate = null;
        const rawRet = stmt.returnType?.typeAnnotation || stmt.returnType;
        if (rawRet && (rawRet.type === "TSTypePredicate" || rawRet.typeAnnotation?.type === "TSTypePredicate")) {
          const predNode = rawRet.type === "TSTypePredicate" ? rawRet : rawRet.typeAnnotation;
          const paramName = predNode.parameterName?.name;
          const targetNode = predNode.typeAnnotation?.typeAnnotation || predNode.typeAnnotation;
          const targetType = targetNode?.typeName?.name || targetNode?.typeName?.value || this.resolveType(targetNode);
          typePredicate = { paramName, targetType };
        }

        this.builtins.functionSignatures.set(mangled, {
          params,
          returnType,
          outerReturnType: returnType,
          typePredicate,
          node: stmt,
        });
        ns.functions.set(fnName, { mangled, params, returnType, typePredicate, node: stmt });
      } else if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations) {
          const vName = d.id.name;
          const mangled = `${fullPrefix}_${vName}`;
          const vType = d.id.typeAnnotation ? this.resolveType(d.id.typeAnnotation) : "any";
          ns.variables.set(vName, { mangled, type: vType, node: d });
        }
      } else if (stmt.type === "ClassDeclaration") {
        this.collectClassSignature(stmt, fullPrefix);
        ns.classes.set(stmt.id.name, { mangled: `${fullPrefix}_${stmt.id.name}`, node: stmt });
      } else if (stmt.type === "TSModuleDeclaration") {
        this.collectNamespaceSignatures(stmt, fullPrefix);
      }
    }
    this.currentNamespace = prevNs;
  }

  checkNamespace(moduleDecl, parentPrefix = "") {
    const nsName = this.getNamespaceName(moduleDecl.id);
    const fullPrefix = parentPrefix ? `${parentPrefix}_${nsName}` : nsName;
    const prevNs = this.currentNamespace;
    this.currentNamespace = fullPrefix;

    const bodyList = moduleDecl.body?.body || [];
    for (const rawStmt of bodyList) {
      const stmt = (rawStmt.type === "ExportNamedDeclaration" || rawStmt.type === "ExportDefaultDeclaration") && rawStmt.declaration
        ? rawStmt.declaration
        : rawStmt;
      if (!stmt) continue;
      if (stmt.type === "TSModuleDeclaration") {
        this.checkNamespace(stmt, fullPrefix);
      } else {
        this.checkStatement(stmt);
      }
    }

    this.currentNamespace = prevNs;
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

  enterScope(options = false, expectedReturnType = null) {
    this.scopeManager.enterScope(options, expectedReturnType);
  }

  exitScope() {
    return this.scopeManager.exitScope();
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

  extractFunctionType(typeNode) {
    const unwrapped = this.unwrapType(typeNode);
    if (!unwrapped) return null;
    if (unwrapped.type === "TSFunctionType") {
      const rawParams = Array.isArray(unwrapped.params)
        ? unwrapped.params
        : Array.isArray(unwrapped.params?.items)
        ? unwrapped.params.items
        : [];
      const paramTypes = rawParams.map((p) => {
        const annot = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
        return this.resolveType(annot);
      });
      const returnType = this.resolveType(unwrapped.returnType);
      return { paramTypes, returnType };
    }
    return null;
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
          if (this.builtins.enumSignatures.has(enumName)) {
            const existing = this.builtins.enumSignatures.get(enumName);
            this.reporter.addError(
              this.currentFilePath,
              decl.id,
              `'${enumName}' enum'ı zaten tanımlanmış.`,
              existing?.node?.id,
              `İlk tanım burada yer alıyor.`
            );
          }
          const rawMembers =
            decl.members ||
            decl.body?.members ||
            decl.body?.body ||
            decl.elements ||
            decl.body?.elements ||
            (Array.isArray(decl.body) ? decl.body : []);

          const members = new Map();
          let kind = "numeric";
          for (const m of rawMembers) {
            const mName =
              m.id?.name ??
              m.id?.value ??
              m.key?.name ??
              m.key?.value ??
              m.name;
            if (!mName) continue;
            const initVal = m.initializer?.value ?? m.init?.value;
            if (typeof initVal === "string") kind = "string";
            members.set(mName, initVal);
          }
          this.builtins.enumSignatures.set(enumName, { name: enumName, kind, members, node: decl });
        }

        if (decl.type === "TSInterfaceDeclaration") {
          const structName = decl.id.name;
          const fields = new Map();
          const methods = new Map();

          // Üst arayüzlerden alanları ve metotları miras al (interface extends ...)
          if (decl.extends && Array.isArray(decl.extends)) {
            for (const heritage of decl.extends) {
              const pName = heritage.expression?.name || heritage.id?.name;
              if (pName && this.builtins.structSignatures.has(pName)) {
                const pMeta = this.builtins.structSignatures.get(pName);
                for (const [fName, fData] of pMeta.fields.entries()) {
                  fields.set(fName, fData);
                }
                if (pMeta.methods) {
                  for (const [mName, mData] of pMeta.methods.entries()) {
                    methods.set(mName, mData);
                  }
                }
              }
            }
          }

          for (const member of decl.body?.body || []) {
            if (member.type === "TSPropertySignature") {
              const fName = member.key?.name || member.key?.value;
              const typeAnnot = member.typeAnnotation;
              const fnType = this.extractFunctionType(typeAnnot);
              const fType = this.resolveType(typeAnnot);
              fields.set(fName, { type: fType, isFunction: Boolean(fnType), fnType, node: member });
            } else if (member.type === "TSMethodSignature") {
              const mName = member.key?.name || member.key?.value;
              const rawParams = member.params || [];
              const params = rawParams.map((p) => {
                const annot = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
                return this.resolveType(annot);
              });
              const retType = this.resolveType(member.returnType);
              methods.set(mName, {
                name: mName,
                params,
                returnType: retType,
                node: member,
              });
            }
          }
          const rawTypeParams = decl.typeParameters?.params || [];
          const typeParams = rawTypeParams.map((p) => p.name?.name || p.name?.value || p.name || "");
          this.builtins.structSignatures.set(structName, {
            name: structName,
            typeParams,
            fields,
            methods,
            isInterface: true,
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
              fields: fields,
              methods: new Map(),
              node: decl,
            });
          } else if (inner.type === "TSUnionType") {
            const variants = (inner.types || []).map((t) => this.resolveType(t));
            this.builtins.unionRegistry.set(aliasName, variants);
          } else if (inner.type === "TSFunctionType") {
            this.builtins.functionTypeAliases.add(aliasName);
            const retType = this.resolveType(inner.returnType);
            this.builtins.functionSignatures.set(aliasName, {
              returnType: retType,
              outerReturnType: retType,
              params: (inner.parameters || inner.params || []).map((p) => this.resolveType(p.typeAnnotation)),
            });
          }
        }

        if (decl.type === "ClassDeclaration") {
          this.collectClassSignature(decl);
        }

        if (decl.type === "TSModuleDeclaration") {
          this.collectNamespaceSignatures(decl);
        }

        if (decl.type === "FunctionDeclaration" || decl.type === "TSDeclareFunction") {
          const fnName = decl.id.name;
          const isAsync = Boolean(decl.async);
          const isAmbient = Boolean(decl.declare || !decl.body);

          if (this.builtins.functionSignatures.has(fnName)) {
            const existing = this.builtins.functionSignatures.get(fnName);
            if (existing.node && !existing.node.declare && !isAmbient) {
              this.reporter.addError(
                this.currentFilePath,
                decl.id,
                `'${fnName}' fonksiyonu zaten tanımlanmış.`,
                existing.node?.id,
                `İlk tanım burada yer alıyor.`
              );
            }
          }

          const rawTypeParams = decl.typeParameters?.params || [];
          const typeParams = rawTypeParams.map((p) => p.name?.name || p.name?.value || p.name || "");
          let hasRest = false;
          let restElemType = null;
          let fixedCount = 0;
          const rawParams = decl.params || [];
          const params = rawParams.map((p) => {
            if (p.type === "RestElement") {
              hasRest = true;
              const annot = p.typeAnnotation || p.argument?.typeAnnotation;
              const fullType = this.resolveType(annot);
              const unwrapped = this.unwrapType(annot);
              if (unwrapped?.type === "TSArrayType") {
                restElemType = this.resolveType(unwrapped.elementType);
              } else {
                restElemType = fullType && fullType.endsWith("[]") ? fullType.slice(0, -2) : "string";
              }
              return fullType;
            }
            fixedCount++;
            const annot = p.typeAnnotation || p.pattern?.typeAnnotation;
            return this.resolveType(annot);
          });

          let innerReturnType = "void";
          let outerReturnType = "void";

          let typePredicate = null;
          if (decl.returnType) {
            const rawRet = decl.returnType?.typeAnnotation || decl.returnType;
            if (rawRet && (rawRet.type === "TSTypePredicate" || rawRet.typeAnnotation?.type === "TSTypePredicate")) {
              const predNode = rawRet.type === "TSTypePredicate" ? rawRet : rawRet.typeAnnotation;
              const paramName = predNode.parameterName?.name;
              const targetNode = predNode.typeAnnotation?.typeAnnotation || predNode.typeAnnotation;
              const targetType = targetNode?.typeName?.name || targetNode?.typeName?.value || this.resolveType(targetNode);
              typePredicate = { paramName, targetType };
            }

            const unwrapped = this.unwrapType(decl.returnType);
            const typeName = unwrapped?.typeName?.name || unwrapped?.typeName?.value;
            if (typeName === "Promise") {
              const innerParam = unwrapped.typeParameters?.params?.[0] || unwrapped.typeArguments?.params?.[0];
              innerReturnType = innerParam ? this.resolveType(innerParam) : "void";
              outerReturnType = `Promise<${innerReturnType}>`;
            } else {
              innerReturnType = this.resolveType(decl.returnType);
              outerReturnType = isAsync ? `Promise<${innerReturnType}>` : innerReturnType;
            }
          } else {
            innerReturnType = isAsync ? "number" : "void";
            outerReturnType = isAsync ? `Promise<${innerReturnType}>` : innerReturnType;
          }

          this.builtins.functionSignatures.set(fnName, {
            params,
            returnType: innerReturnType,
            outerReturnType,
            typeParams,
            typePredicate,
            node: decl,
            hasRest,
            minArgs: fixedCount,
            restElemType,
          });
        }
      }
    }

    // --- 2. GEÇİŞ: Fonksiyon, Metot ve Blok Gövdelerini Denetle ---
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
        const isConst = stmt.kind === "const";
        for (const decl of stmt.declarations) {
          const varName = decl.id.name;

          if (this.scopeManager.hasSymbolInCurrentScope(varName)) {
            const existing = this.scopeManager.lookupSymbolInCurrentScope(varName);
            this.reporter.addError(
              this.currentFilePath,
              decl.id,
              `'${varName}' değişkeni bu kapsamda zaten tanımlanmış.`,
              existing?.defNode?.id || existing?.defNode,
              `İlk tanım burada yapılmıştı.`
            );
          }

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

          this.scopeManager.registerSymbol(varName, {
            type: finalType,
            isConst,
            defNode: decl,
          });
        }
        break;
      }

      case "FunctionDeclaration": {
        const fnMeta = this.builtins.functionSignatures.get(stmt.id.name);
        const retType = fnMeta ? fnMeta.returnType : "any";
        this.enterScope(true, retType);

        // Parametre isim çakışması ve kayıt kontrolü
        const paramNames = new Set();
        for (const p of stmt.params || []) {
          const isRest = p.type === "RestElement";
          const pName = isRest ? (p.argument?.name || p.argument?.pattern?.name) : (p.name || p.pattern?.name);
          if (paramNames.has(pName)) {
            this.reporter.addError(
              this.currentFilePath,
              p,
              `'${pName}' parametresi '${stmt.id.name}' fonksiyonunda birden fazla kez tanımlanmış.`
            );
          }
          paramNames.add(pName);

          const annot = isRest ? (p.typeAnnotation || p.argument?.typeAnnotation) : (p.typeAnnotation || p.pattern?.typeAnnotation);
          const pType = this.resolveType(annot);
          this.scopeManager.registerSymbol(pName, {
            type: pType,
            isParam: true,
            defNode: p,
          });
        }

        if (stmt.body?.body) {
          for (const s of stmt.body.body) {
            this.checkStatement(s);
          }
        }

        this.exitScope();
        break;
      }

      case "ClassDeclaration": {
        const rawClsName = stmt.id.name;
        const clsName = this.currentNamespace ? `${this.currentNamespace}_${rawClsName}` : rawClsName;
        const structMeta = this.builtins.structSignatures.get(clsName);

        // Üst sınıf kontrolü
        if (stmt.superClass) {
          const superName = stmt.superClass.name;
          if (!this.builtins.structSignatures.has(superName)) {
            this.reporter.addError(
              this.currentFilePath,
              stmt.superClass,
              `Bilinmeyen üst sınıf: '${superName}'`
            );
          }
        }

        // Arayüz implementasyon kontrolü (implements ...)
        if (stmt.implements && Array.isArray(stmt.implements)) {
          for (const impl of stmt.implements) {
            const ifaceName = impl.expression?.name || impl.expression?.value || impl.name;
            if (ifaceName && !this.builtins.structSignatures.has(ifaceName)) {
              this.reporter.addError(
                this.currentFilePath,
                impl,
                `Bilinmeyen arayüz: '${ifaceName}'`
              );
            } else if (ifaceName && !this.typeChecker.implementsInterface(clsName, ifaceName)) {
              this.reporter.addError(
                this.currentFilePath,
                impl,
                `'${clsName}' sınıfı '${ifaceName}' arayüzünün gereksinimlerini karşılamıyor.`
              );
            }
          }
        }

        // Somut sınıf ise üst sınıflardaki tüm soyut metotların ezilip ezilmediğini denetle
        if (!structMeta.isAbstract) {
          let currSuper = structMeta.superClass;
          while (currSuper && this.builtins.structSignatures.has(currSuper)) {
            const superMeta = this.builtins.structSignatures.get(currSuper);
            if (superMeta.methods) {
              for (const [mName, mMeta] of superMeta.methods.entries()) {
                if (mMeta.isAbstract) {
                  let isImplemented = false;
                  let c = clsName;
                  while (c && c !== currSuper && this.builtins.structSignatures.has(c)) {
                    const sm = this.builtins.structSignatures.get(c);
                    if (sm.methods?.has(mName) && !sm.methods.get(mName).isAbstract) {
                      isImplemented = true;
                      break;
                    }
                    c = sm.superClass;
                  }
                  if (!isImplemented) {
                    this.reporter.addError(
                      this.currentFilePath,
                      stmt.id,
                      `Somut sınıf '${clsName}', üst sınıftaki soyut metot '${mName}' metodunu uygulamalıdır (override etmelidir).`
                    );
                  }
                }
              }
            }
            currSuper = superMeta.superClass;
          }
        }

        this.scopeManager.enterScope({ isClass: true, classMeta: structMeta });

        // Sınıf alanları ve metot gövdelerini denetle
        for (const member of stmt.body?.body || []) {
          if (member.type === "PropertyDefinition" || member.type === "TSAbstractPropertyDefinition") {
            if (member.value) {
              const propType = member.typeAnnotation ? this.resolveType(member.typeAnnotation) : null;
              const initType = this.inferExpressionType(member.value, propType);
              if (propType && initType !== "any" && !this.typesAreCompatible(propType, initType)) {
                this.reporter.addError(
                  this.currentFilePath,
                  member.value,
                  `Sınıf alanı '${member.key?.name}' için tür uyuşmazlığı: '${propType}' beklenirken '${initType}' atandı.`
                );
              }
            }
          } else if (member.type === "MethodDefinition" || member.type === "TSAbstractMethodDefinition") {
            const mName = member.key?.name || member.key?.value;
            const isConstructor = member.kind === "constructor" || mName === "constructor";
            const isStatic = Boolean(member.static);
            const isAbstract = member.type === "TSAbstractMethodDefinition" || Boolean(member.abstract) || !member.value?.body;

            if (member.override) {
              let foundInSuper = false;
              let currSuper = structMeta.superClass;
              while (currSuper && this.builtins.structSignatures.has(currSuper)) {
                const superMeta = this.builtins.structSignatures.get(currSuper);
                if (superMeta.methods?.has(mName)) {
                  foundInSuper = true;
                  break;
                }
                currSuper = superMeta.superClass;
              }
              if (!foundInSuper) {
                this.reporter.addError(
                  this.currentFilePath,
                  member.key || member,
                  `'${mName}' metodu 'override' olarak işaretlenmiş ancak üst sınıfta ezilecek bir metot bulunamadı.`
                );
              }
            }

            if (isAbstract) {
              if (!structMeta.isAbstract) {
                this.reporter.addError(
                  this.currentFilePath,
                  member.key || member,
                  `Soyut metot '${mName}' yalnızca soyut ('abstract') sınıflar içinde tanımlanabilir.`
                );
              }
              continue; // Soyut metotların gövdesi yoktur, analizi atla
            }

            const methodMeta = isStatic ? structMeta?.staticMethods?.get(mName) : structMeta?.methods?.get(mName);
            const retType = isConstructor ? "void" : methodMeta?.returnType || "void";

            this.scopeManager.enterScope({
              isFunction: true,
              isStaticMethod: isStatic,
              expectedReturnType: retType,
              isConstructor,
            });

            // Metot içinde 'this' sınıf tipini temsil eder (Yalnızca instance metotlarda)
            if (!isStatic) {
              this.scopeManager.registerSymbol("this", {
                type: clsName,
                isConst: true,
              });
            }

            // Parametreleri kaydet
            const mParamNames = new Set();
            for (const p of member.value?.params || []) {
              const isRest = p.type === "RestElement";
              const pName = isRest ? (p.argument?.name || p.argument?.pattern?.name) : (p.name || p.pattern?.name);
              if (mParamNames.has(pName)) {
                this.reporter.addError(
                  this.currentFilePath,
                  p,
                  `'${pName}' parametresi '${clsName}.${mName}' metodunda birden fazla kez tanımlanmış.`
                );
              }
              mParamNames.add(pName);

              const annot = isRest ? (p.typeAnnotation || p.argument?.typeAnnotation) : (p.typeAnnotation || p.pattern?.typeAnnotation);
              const pType = this.resolveType(annot);
              this.scopeManager.registerSymbol(pName, {
                type: pType,
                isParam: true,
                defNode: p,
              });
            }

            // Metot gövdesini denetle
            if (member.value?.body?.body) {
              for (const s of member.value.body.body) {
                this.checkStatement(s);
              }
            }

            this.scopeManager.exitScope();
          }
        }

        this.scopeManager.exitScope();
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
        this.enterScope({ isLoop: true });
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") this.checkStatement(stmt.init);
          else this.inferExpressionType(stmt.init);
        }
        if (stmt.test) this.inferExpressionType(stmt.test, "boolean");
        if (stmt.update) this.inferExpressionType(stmt.update);
        this.checkStatement(stmt.body);
        this.exitScope();
        break;
      }

      case "WhileStatement": {
        this.enterScope({ isLoop: true });
        if (stmt.test) this.inferExpressionType(stmt.test, "boolean");
        this.checkStatement(stmt.body);
        this.exitScope();
        break;
      }

      case "DoWhileStatement": {
        this.enterScope({ isLoop: true });
        this.checkStatement(stmt.body);
        if (stmt.test) this.inferExpressionType(stmt.test, "boolean");
        this.exitScope();
        break;
      }

      case "ForOfStatement":
      case "ForInStatement": {
        this.enterScope({ isLoop: true });
        if (stmt.left) {
          if (stmt.left.type === "VariableDeclaration") this.checkStatement(stmt.left);
          else this.inferExpressionType(stmt.left);
        }
        if (stmt.right) this.inferExpressionType(stmt.right);
        this.checkStatement(stmt.body);
        this.exitScope();
        break;
      }

      case "IfStatement": {
        this.inferExpressionType(stmt.test, "boolean");

        // Type Narrowing:
        // 1. typeof x === "string" / "number"
        // 2. hero instanceof Paladin
        // 3. isPaladin(hero)
        let narrowedSymbol = null;
        if (
          stmt.test?.type === "BinaryExpression" &&
          (stmt.test.operator === "===" || stmt.test.operator === "==")
        ) {
          let unary = null;
          let lit = null;
          if (stmt.test.left?.type === "UnaryExpression" && stmt.test.left.operator === "typeof") {
            unary = stmt.test.left;
            lit = stmt.test.right;
          } else if (stmt.test.right?.type === "UnaryExpression" && stmt.test.right.operator === "typeof") {
            unary = stmt.test.right;
            lit = stmt.test.left;
          }

          if (unary?.argument?.type === "Identifier" && lit && typeof lit.value === "string") {
            const varName = unary.argument.name;
            const targetType = lit.value; // "string", "number", "boolean", "object"
            narrowedSymbol = { varName, targetType };
          }
        } else if (stmt.test?.type === "BinaryExpression" && stmt.test.operator === "instanceof") {
          if (stmt.test.left?.type === "Identifier") {
            let targetType = null;
            if (stmt.test.right?.type === "Identifier") {
              targetType = stmt.test.right.name;
            } else if (stmt.test.right?.type === "MemberExpression") {
              const chain = this.typeChecker.extractMemberChain(stmt.test.right);
              if (chain) targetType = chain.join("_");
            }
            if (targetType) {
              narrowedSymbol = { varName: stmt.test.left.name, targetType };
            }
          }
        } else if (stmt.test?.type === "CallExpression") {
          let fnName = stmt.test.callee?.name;
          if (!fnName && stmt.test.callee?.type === "MemberExpression") {
            const chain = this.typeChecker.extractMemberChain(stmt.test.callee);
            if (chain) fnName = chain.join("_");
          }
          if (fnName) {
            let fnMeta = this.builtins.functionSignatures.get(fnName);
            if (!fnMeta && this.currentNamespace) {
              const parts = this.currentNamespace.split("_");
              for (let len = parts.length; len >= 1; len--) {
                const c = `${parts.slice(0, len).join("_")}_${fnName}`;
                if (this.builtins.functionSignatures.has(c)) {
                  fnMeta = this.builtins.functionSignatures.get(c);
                  break;
                }
              }
            }
            if (fnMeta && fnMeta.typePredicate) {
              const arg = stmt.test.arguments?.[0];
              if (arg && arg.type === "Identifier") {
                narrowedSymbol = { varName: arg.name, targetType: fnMeta.typePredicate.targetType };
              }
            }
          }
        }

        // Consequent (then) bloğunu analiz et
        this.enterScope(false);
        if (narrowedSymbol) {
          const currentSym = this.scopeManager.lookupSymbol(narrowedSymbol.varName);
          this.scopeManager.registerSymbol(narrowedSymbol.varName, {
            ...(currentSym || {}),
            type: narrowedSymbol.targetType,
            isNarrowed: true,
          });
        }
        this.checkStatement(stmt.consequent);
        this.exitScope();

        // Alternate (else) bloğunu analiz et
        if (stmt.alternate) {
          this.enterScope(false);
          this.checkStatement(stmt.alternate);
          this.exitScope();
        }
        break;
      }

      case "SwitchStatement": {
        const discType = this.inferExpressionType(stmt.discriminant);
        this.enterScope({ isSwitch: true });
        for (const scase of stmt.cases || []) {
          if (scase.test) {
            const testType = this.inferExpressionType(scase.test, discType);
            if (discType !== "any" && testType !== "any" && !this.typesAreCompatible(discType, testType)) {
              this.reporter.addError(
                this.currentFilePath,
                scase.test,
                `Switch case tür uyuşmazlığı: İfade '${discType}' türündeyken case '${testType}' ile karşılaştırılıyor.`
              );
            }
          }
          for (const s of scase.consequent || []) {
            this.checkStatement(s);
          }
        }
        this.exitScope();
        break;
      }

      case "BreakStatement": {
        if (!this.scopeManager.isInLoop() && !this.scopeManager.isInSwitch()) {
          this.reporter.addError(
            this.currentFilePath,
            stmt,
            `'break' ifadesi yalnızca bir döngü (for, while) veya switch bloğu içinde kullanılabilir.`
          );
        }
        break;
      }

      case "ContinueStatement": {
        if (!this.scopeManager.isInLoop()) {
          this.reporter.addError(
            this.currentFilePath,
            stmt,
            `'continue' ifadesi yalnızca bir döngü (for, while) bloğu içinde kullanılabilir.`
          );
        }
        break;
      }

      case "TryStatement": {
        this.checkStatement(stmt.block);
        if (stmt.handler) {
          this.enterScope(false);
          if (stmt.handler.param) {
            const pName = stmt.handler.param.name;
            this.scopeManager.registerSymbol(pName, { type: "string" });
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
        if (!this.scopeManager.isInFunction()) {
          this.reporter.addError(
            this.currentFilePath,
            stmt,
            `'return' ifadesi yalnızca bir fonksiyon veya metot gövdesi içinde kullanılabilir.`
          );
          break;
        }

        const fnScope = this.scopeManager.scopes.slice().reverse().find((s) => s.isFunction);
        if (fnScope?.isConstructor && stmt.argument) {
          this.reporter.addError(
            this.currentFilePath,
            stmt.argument,
            `Yapıcı (constructor) metotlar bir değer döndüremez.`
          );
          break;
        }

        const expectedRet = fnScope?.expectedReturnType;
        let actualRet = "void";
        if (stmt.argument) {
          actualRet = this.inferExpressionType(stmt.argument, expectedRet);
        }

        if (expectedRet && expectedRet !== "any") {
          if (expectedRet === "void" && stmt.argument) {
            this.reporter.addError(
              this.currentFilePath,
              stmt.argument,
              `Dönüş türü uyuşmazlığı: 'void' dönüş türüne sahip fonksiyonda değer döndürülemez.`
            );
          } else if (expectedRet !== "void" && !stmt.argument) {
            this.reporter.addError(
              this.currentFilePath,
              stmt,
              `Dönüş türü uyuşmazlığı: '${expectedRet}' döndürmesi gereken fonksiyonda boş 'return' kullanılamaz.`
            );
          } else if (!this.typesAreCompatible(expectedRet, actualRet)) {
            this.reporter.addError(
              this.currentFilePath,
              stmt.argument || stmt,
              `Dönüş türü uyuşmazlığı: Fonksiyon '${expectedRet}' döndürmeli, ancak '${actualRet}' döndürüldü.`
            );
          }
        }
        break;
      }

      case "ExpressionStatement": {
        this.inferExpressionType(stmt.expression);
        break;
      }

      case "TSModuleDeclaration": {
        this.checkNamespace(stmt);
        break;
      }

      case "EmptyStatement": {
        break;
      }

      case "LabeledStatement": {
        this.checkStatement(stmt.body);
        break;
      }
    }
  }
}
