// semantic-analyzer.js

export class SemanticAnalyzer {
  constructor(modules, reporter) {
    this.modules = modules;
    this.reporter = reporter;
    this.currentFilePath = "";

    // Tip ve Sembol Tabloları
    this.functionSignatures = new Map();
    this.structSignatures = new Map(); // name -> { name, superClass, fields: Map(name -> type), methods: Map(...) }
    this.enumSignatures = new Map();   // name -> { name, kind: "numeric"|"string", members: Map(name -> val) }
    this.typeAliasRegistry = new Map();
    this.unionRegistry = new Map();    // name -> [type1, type2, ...]
    this.functionTypeAliases = new Set();
    this.globalSymbols = new Map();
    this.scopes = [];

    this.registerBuiltins();
  }

  registerBuiltins() {
    this.functionSignatures.set("inline", { params: [], returnType: "any" });
    this.functionSignatures.set("noinline", { params: [], returnType: "any" });
    this.functionSignatures.set("packed", { params: [], returnType: "any" });
    this.functionSignatures.set("export_name", { params: ["string"], returnType: "any" });
    this.functionSignatures.set("napi", { params: [], returnType: "any" });
    this.functionSignatures.set("unique", { params: [], returnType: "any" });
    this.functionSignatures.set("move", { params: [], returnType: "any" });

    this.functionSignatures.set("malloc", { params: ["number"], returnType: "pointer" });
    this.functionSignatures.set("free", { params: ["pointer"], returnType: "void" });
    this.functionSignatures.set("alloca", { params: ["number"], returnType: "pointer" });
    this.functionSignatures.set("sleep", { params: ["number"], returnType: "void" });
    this.functionSignatures.set("panic", { params: ["string"], returnType: "never" });
    this.functionSignatures.set("assert", { params: ["boolean", "string"], returnType: "void" });
    this.functionSignatures.set("join", { params: ["pointer"], returnType: "void" });
    this.functionSignatures.set("Ok", { params: ["any"], returnType: "Result" });
    this.functionSignatures.set("Err", { params: ["any"], returnType: "Result" });
    this.functionSignatures.set("unwrap", { params: ["any"], returnType: "any" });

    // Standart Sınıflar ve Özel Bellek Yöneticileri
    this.structSignatures.set("Result", {
      fields: new Map([
        ["ok", { type: "boolean" }],
        ["value", { type: "any" }],
        ["error", { type: "any" }],
      ]),
      methods: new Map(),
    });
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

    this.structSignatures.set("Channel", {
      fields: new Map(),
      methods: new Map([
        ["send", { params: ["any"], returnType: "void" }],
        ["recv", { params: [], returnType: "any" }],
      ]),
    });

    // Native Hash Table (Map & Set)
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
  }

  enterScope(isFunction = false, expectedReturnType = null) {
    this.scopes.push({
      isFunction,
      expectedReturnType,
      symbols: new Map(),
    });
  }

  exitScope() {
    this.scopes.pop();
  }

  lookupSymbol(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].symbols.has(name)) {
        return this.scopes[i].symbols.get(name);
      }
    }
    if (this.globalSymbols.has(name)) {
      return this.globalSymbols.get(name);
    }
    return null;
  }

  resolveType(typeNode) {
    if (!typeNode) return "any";
    let curr = typeNode;
    while (curr && (curr.type === "TSTypeAnnotation" || curr.type === "TSType") && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    if (!curr) return "any";

    switch (curr.type) {
      case "TSNumberKeyword": return "number";
      case "TSStringKeyword": return "string";
      case "TSBooleanKeyword": return "boolean";
      case "TSVoidKeyword": return "void";
      case "TSArrayType": return "array";
      case "TSTypeReference": {
        const name = curr.typeName?.name || curr.typeName?.value;
        if (["i64", "i32", "f64", "f32"].includes(name)) return "number";
        if (name === "bool") return "boolean";
        if (name === "Promise") {
          return "pointer";
        }
        return name || "pointer";
      }
      default: return "any";
    }
  }

  typesAreCompatible(expected, actual) {
    if (!expected || !actual) return true;
    if (expected === "any" || actual === "any") return true;
    if (expected === actual) return true;
    if (expected === "pointer" && actual.endsWith("*")) return true;
    if (actual === "pointer" && (expected === "pointer" || this.structSignatures.has(expected))) return true;
    if (expected === "pointer" && (actual === "pointer" || this.structSignatures.has(actual))) return true;

    // 1. Enum Uyumluluğu
    if (this.enumSignatures.has(expected)) {
      const en = this.enumSignatures.get(expected);
      if (en.kind === "string" && actual === "string") return true;
      if (en.kind === "numeric" && actual === "number") return true;
    }
    if (this.enumSignatures.has(actual)) {
      const en = this.enumSignatures.get(actual);
      if (en.kind === "string" && expected === "string") return true;
      if (en.kind === "numeric" && expected === "number") return true;
    }

    // 2. Union Type Alias Uyumluluğu (Örn: FlexibleData = string | number)
    if (this.unionRegistry.has(expected)) {
      const variants = this.unionRegistry.get(expected);
      if (variants.some((v) => this.typesAreCompatible(v, actual))) return true;
    }
    if (this.unionRegistry.has(actual)) {
      const variants = this.unionRegistry.get(actual);
      if (variants.every((v) => this.typesAreCompatible(expected, v))) return true;
    }

    // 3. Tip Takma Adı Çözümleme (Örn: EntityID = number)
    if (this.typeAliasRegistry.has(expected)) {
      const resolvedExpected = this.resolveType(this.typeAliasRegistry.get(expected));
      if (this.typesAreCompatible(resolvedExpected, actual)) return true;
    }
    if (this.typeAliasRegistry.has(actual)) {
      const resolvedActual = this.resolveType(this.typeAliasRegistry.get(actual));
      if (this.typesAreCompatible(expected, resolvedActual)) return true;
    }

    // 4. Sınıf Kalıtım Hiyerarşisi (Polymorphism: Warrior extends Entity)
    let curr = actual;
    while (curr && this.structSignatures.has(curr)) {
      const meta = this.structSignatures.get(curr);
      if (meta.superClass === expected) return true;
      curr = meta.superClass;
    }

    // 5. Birinci Sınıf Fonksiyon ve Dizi Tipleri
    if ((expected === "function" || this.functionTypeAliases.has(expected)) && actual === "function") return true;
    if (expected === "array" && actual === "array") return true;
    if (expected === "number" && actual === "number") return true;

    return false;
  }

  analyze() {
    for (const mod of this.modules) {
      this.currentFilePath = mod.filePath;
      for (const rawNode of mod.program.body) {
        const decl = (rawNode.type === "ExportNamedDeclaration" || rawNode.type === "ExportDefaultDeclaration") && rawNode.declaration
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
          this.enumSignatures.set(enumName, { name: enumName, kind, members });
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
          this.structSignatures.set(structName, { name: structName, fields, methods: new Map(), node: decl });
        }

        if (decl.type === "TSTypeAliasDeclaration") {
          const aliasName = decl.id.name;
          let inner = decl.typeAnnotation;
          this.typeAliasRegistry.set(aliasName, inner);

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
              if (tName && this.structSignatures.has(tName)) {
                const parentMeta = this.structSignatures.get(tName);
                for (const [fName, fData] of parentMeta.fields.entries()) {
                  mergedFields.set(fName, fData);
                }
              }
            }
            this.structSignatures.set(aliasName, { name: aliasName, fields: mergedFields, methods: new Map(), node: decl });
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
            this.structSignatures.set(aliasName, { name: aliasName, fields, methods: new Map(), node: decl });
          } else if (inner.type === "TSUnionType") {
            const variants = (inner.types || []).map((t) => this.resolveType(t));
            this.unionRegistry.set(aliasName, variants);
          } else if (inner.type === "TSFunctionType") {
            this.functionTypeAliases.add(aliasName);
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
              const params = (member.value?.params || []).map((p) => this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation));
              const returnType = member.value?.returnType ? this.resolveType(member.value.returnType) : "void";
              methods.set(mName, { params, returnType, node: member });
            }
          }
          this.structSignatures.set(clsName, { name: clsName, superClass, fields, methods, node: decl });
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

          this.functionSignatures.set(fnName, { 
            params, 
            returnType: innerReturnType, 
            outerReturnType, 
            typeParams, 
            node: decl 
          });
        }
      }
    }

    for (const mod of this.modules) {
      this.currentFilePath = mod.filePath;
      this.enterScope(false);

      for (const rawNode of mod.program.body) {
        const decl = (rawNode.type === "ExportNamedDeclaration" || rawNode.type === "ExportDefaultDeclaration") && rawNode.declaration
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
          scope.symbols.set(varName, {
            type: finalType,
            defNode: decl,
          });
        }
        break;
      }

      case "FunctionDeclaration": {
        const fnMeta = this.functionSignatures.get(stmt.id.name);
        const retType = fnMeta ? fnMeta.returnType : "any";
        this.enterScope(true, retType);

        for (const p of stmt.params || []) {
          const pName = p.name || p.pattern?.name;
          const pType = this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation);
          this.scopes[this.scopes.length - 1].symbols.set(pName, {
            type: pType,
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
            this.scopes[this.scopes.length - 1].symbols.set(pName, { type: "string" });
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

  unwrapType(typeNode) {
    if (!typeNode) return null;
    let curr = typeNode;
    while (curr && (curr.type === "TSTypeAnnotation" || curr.type === "TSType") && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    return curr;
  }

  inferExpressionType(expr, expectedType = null) {
    if (!expr) return "void";

    if (expr.type === "NullLiteral" || (expr.type === "Literal" && expr.value === null)) {
      return "pointer";
    }
    if (expr.type === "NumericLiteral" || (expr.type === "Literal" && typeof expr.value === "number")) {
      return "number";
    }
    if (expr.type === "StringLiteral" || (expr.type === "Literal" && typeof expr.value === "string")) {
      return "string";
    }
    if (expr.type === "BooleanLiteral" || (expr.type === "Literal" && typeof expr.value === "boolean")) {
      return "boolean";
    }
    if (expr.type === "TemplateLiteral") {
      return "string";
    }
    if (expr.type === "ArrayExpression") {
      return "array";
    }
    if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
      return "function";
    }
    if (expr.type === "AwaitExpression") {
      if (expr.argument.type === "Identifier") {
        const sym = this.lookupSymbol(expr.argument.name);
        if (sym?.defNode?.id?.typeAnnotation) {
          const unwrapped = this.unwrapType(sym.defNode.id.typeAnnotation);
          const typeName = unwrapped?.typeName?.name || unwrapped?.typeName?.value;
          if (typeName === "Promise") {
            const innerParam = unwrapped.typeParameters?.params?.[0] || unwrapped.typeArguments?.params?.[0];
            if (innerParam) return this.resolveType(innerParam);
          }
        }
      }
      if (expr.argument.type === "CallExpression" && expr.argument.callee.type === "Identifier") {
        const fnMeta = this.functionSignatures.get(expr.argument.callee.name);
        if (fnMeta?.returnType) return fnMeta.returnType;
      }
      const argType = this.inferExpressionType(expr.argument);
      if (argType && argType.startsWith("Promise<") && argType.endsWith(">")) {
        return argType.slice(8, -1);
      }
      return expectedType || "any";
    }
    if (expr.type === "UnaryExpression") {
      if (expr.operator === "!" || expr.operator === "delete") return "boolean";
      if (expr.operator === "typeof") return "string";
      if (expr.operator === "-" || expr.operator === "+" || expr.operator === "~") {
        this.inferExpressionType(expr.argument);
        return "number";
      }
      return "any";
    }
    if (expr.type === "UpdateExpression") {
      this.inferExpressionType(expr.argument);
      return "number";
    }

    if (expr.type === "Identifier") {
      if (expr.name === "undefined") {
        return "any";
      }
      if (this.enumSignatures.has(expr.name)) {
        return expr.name;
      }

      const sym = this.lookupSymbol(expr.name);
      if (!sym) {
        if (!this.functionSignatures.has(expr.name) && expr.name !== "console") {
          this.reporter.addError(this.currentFilePath, expr, `Tanımsız değişken: '${expr.name}'`);
        }
        return "any";
      }
      return sym.type;
    }

    if (expr.type === "ObjectExpression") {
      if (expectedType && this.structSignatures.has(expectedType)) {
        const structMeta = this.structSignatures.get(expectedType);
        const providedProps = new Set();

        for (const prop of expr.properties || []) {
          const pName = prop.key?.name || prop.key?.value;
          providedProps.add(pName);

          if (!structMeta.fields.has(pName)) {
            this.reporter.addError(
              this.currentFilePath,
              prop.key || prop,
              `Bilinmeyen alan: '${pName}', '${expectedType}' interface'inde tanımlı değil.`
            );
            continue;
          }

          const expectedField = structMeta.fields.get(pName);
          const actualFieldType = this.inferExpressionType(prop.value, expectedField.type);

          if (!this.typesAreCompatible(expectedField.type, actualFieldType)) {
            this.reporter.addError(
              this.currentFilePath,
              prop.value,
              `'${expectedType}.${pName}' alanı için tür uyuşmazlığı: '${expectedField.type}' beklenirken '${actualFieldType}' verildi.`
            );
          }
        }

        for (const [fName, fMeta] of structMeta.fields.entries()) {
          if (!providedProps.has(fName)) {
            this.reporter.addError(
              this.currentFilePath,
              expr,
              `Eksik alan: '${expectedType}' nesnesi için zorunlu olan '${fName}: ${fMeta.type}' alanı tanımlanmadı.`
            );
          }
        }

        return expectedType;
      }
      return "object";
    }

    if (expr.type === "MemberExpression") {
      let baseType = null;
      let isEnum = false;

      if (expr.object.type === "Identifier" && this.enumSignatures.has(expr.object.name)) {
        baseType = expr.object.name;
        isEnum = true;
      } else {
        baseType = this.inferExpressionType(expr.object);
      }
      const propName = expr.property?.name || expr.property?.value;

      if (isEnum) {
        if (expr.computed) return "string";
        const en = this.enumSignatures.get(baseType);
        return en.kind === "string" ? "string" : "number";
      }

      if ((baseType === "array" || baseType === "string") && propName === "length") {
        return "number";
      }
      if (baseType === "array" && expr.computed) {
        return "number";
      }

      if (this.structSignatures.has(baseType)) {
        const structMeta = this.structSignatures.get(baseType);
        if (structMeta.fields.has(propName)) {
          return structMeta.fields.get(propName).type;
        }
        if (structMeta.methods.has(propName)) {
          return structMeta.methods.get(propName).returnType;
        }

        let curr = structMeta.superClass;
        while (curr && this.structSignatures.has(curr)) {
          const parentMeta = this.structSignatures.get(curr);
          if (parentMeta.fields.has(propName)) return parentMeta.fields.get(propName).type;
          if (parentMeta.methods.has(propName)) return parentMeta.methods.get(propName).returnType;
          curr = parentMeta.superClass;
        }

        this.reporter.addError(
          this.currentFilePath,
          expr.property,
          `'${baseType}' türünde '${propName}' alanı veya metodu bulunamadı!`
        );
        return "any";
      }

      if (baseType !== "any" && baseType !== "object" && baseType !== "array" && expr.object.name !== "console") {
        this.reporter.addError(
          this.currentFilePath,
          expr.object,
          `'${baseType}' ilkel bir türdür; üzerinde '${propName}' alanı okunamaz.`
        );
      }
      return "any";
    }

    if (expr.type === "AssignmentExpression") {
      const targetType = this.inferExpressionType(expr.left);
      const valType = this.inferExpressionType(expr.right, targetType);

      if (targetType !== "any" && valType !== "any" && !this.typesAreCompatible(targetType, valType)) {
        this.reporter.addError(
          this.currentFilePath,
          expr.right,
          `Atama tür uyuşmazlığı: '${targetType}' türündeki hedefe '${valType}' atanamaz.`
        );
      }
      return targetType;
    }

    if (expr.type === "CallExpression") {
      const callee = expr.callee;

      if (callee.type === "MemberExpression") {
        const objType = this.inferExpressionType(callee.object);
        const method = callee.property?.name || callee.property?.value;

        if (callee.object.name === "console" && method === "log") {
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          return "void";
        }

        if (this.structSignatures.has(objType)) {
          const structMeta = this.structSignatures.get(objType);
          if (structMeta?.methods.has(method)) {
            return structMeta.methods.get(method).returnType;
          }
          let curr = structMeta.superClass;
          while (curr && this.structSignatures.has(curr)) {
            const parentMeta = this.structSignatures.get(curr);
            if (parentMeta.methods.has(method)) return parentMeta.methods.get(method).returnType;
            curr = parentMeta.superClass;
          }
        }
        return "any";
      }

      if (callee.type === "Identifier") {
        const fnName = callee.name;

        if (fnName === "borrow") {
          return this.inferExpressionType(expr.arguments[0]);
        }

        const localSym = this.lookupSymbol(fnName);
        if (localSym && (localSym.type === "function" || this.functionTypeAliases.has(localSym.type))) {
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          return "number";
        }

        const fnMeta = this.functionSignatures.get(fnName);
        if (fnMeta) {
          const actualArgs = expr.arguments || [];
          const rawTypeArgs = expr.typeParameters?.params || expr.typeArguments?.params || [];

          const subst = new Map();
          if (fnMeta.typeParams && fnMeta.typeParams.length > 0) {
            fnMeta.typeParams.forEach((tpName, i) => {
              if (rawTypeArgs[i]) {
                subst.set(tpName, this.resolveType(rawTypeArgs[i]));
              }
            });
            if (subst.size === 0) {
              fnMeta.params.forEach((pType, i) => {
                if (fnMeta.typeParams.includes(pType) && actualArgs[i]) {
                  const inferredArg = this.inferExpressionType(actualArgs[i]);
                  if (inferredArg !== "any") subst.set(pType, inferredArg);
                }
              });
            }
          }

          const substitute = (t) => (subst.has(t) ? subst.get(t) : t);
          const expectedParams = fnMeta.params.map(substitute);
          const returnType = substitute(fnMeta.outerReturnType || fnMeta.returnType);

          if (actualArgs.length !== expectedParams.length) {
            this.reporter.addError(
              this.currentFilePath,
              expr,
              `Argüman sayısı uyuşmazlığı: '${fnName}' ${expectedParams.length} argüman beklerken ${actualArgs.length} verildi.`
            );
          }

          actualArgs.forEach((arg, idx) => {
            const expectedParamType = expectedParams[idx];
            const actualArgType = this.inferExpressionType(arg, expectedParamType);

            if (expectedParamType && !this.typesAreCompatible(expectedParamType, actualArgType)) {
              this.reporter.addError(
                this.currentFilePath,
                arg,
                `'${fnName}' için geçersiz argüman türü: Parametre ${idx + 1} için '${expectedParamType}' beklenirken '${actualArgType}' verildi.`
              );
            }
          });

          return returnType;
        }
      }
      return "any";
    }

    if (expr.type === "NewExpression") {
      const clsName = expr.callee.name;
      return clsName || "pointer";
    }

    return "any";
  }
}