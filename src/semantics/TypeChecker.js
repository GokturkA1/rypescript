// src/semantics/TypeChecker.js

/**
 * Tip uyumluluğu (typesAreCompatible), çıkarım (inferExpressionType)
 * ve statik denetim mantığını yöneten motor.
 */
export class TypeChecker {
  constructor(builtinRegistry, scopeManager, reporter, getCurrentFilePath = () => "", checkStatement = null) {
    this.builtins = builtinRegistry;
    this.scopeManager = scopeManager;
    this.reporter = reporter;
    this.getCurrentFilePath = getCurrentFilePath;
    this.checkStatementCallback = checkStatement;
  }

  setCheckStatement(fn) {
    this.checkStatementCallback = fn;
  }

  get currentFilePath() {
    return this.getCurrentFilePath();
  }

  unwrapType(typeNode) {
    if (!typeNode) return null;
    let curr = typeNode;
    while (curr && (curr.type === "TSTypeAnnotation" || curr.type === "TSType") && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    return curr;
  }

  resolveType(typeNode) {
    if (!typeNode) return "any";
    let curr = typeNode;
    while (curr && (curr.type === "TSTypeAnnotation" || curr.type === "TSType") && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    if (!curr) return "any";

    switch (curr.type) {
      case "TSNumberKeyword":
        return "number";
      case "TSStringKeyword":
        return "string";
      case "TSBooleanKeyword":
        return "boolean";
      case "TSVoidKeyword":
        return "void";
      case "TSAnyKeyword":
        return "any";
      case "TSNeverKeyword":
        return "never";
      case "TSNullKeyword":
        return "null";
      case "TSUndefinedKeyword":
        return "undefined";
      case "TSArrayType": {
        const elem = this.resolveType(curr.elementType);
        return `${elem}[]`;
      }
      case "TSFunctionType":
        return "function";
      case "TSTypeReference": {
        const name = curr.typeName?.name || curr.typeName?.value;
        if (!name) return "any";
        if (["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8"].includes(name)) return name;
        if (["i64", "i32", "f64", "f32"].includes(name)) return "number";
        if (name === "bool") return "boolean";
        if (name === "Array") {
          const param = curr.typeParameters?.params?.[0] || curr.typeArguments?.params?.[0];
          const elem = param ? this.resolveType(param) : "any";
          return `${elem}[]`;
        }
        if (name === "Promise") {
          const param = curr.typeParameters?.params?.[0] || curr.typeArguments?.params?.[0];
          const inner = param ? this.resolveType(param) : "any";
          return `Promise<${inner}>`;
        }
        if (name === "Result") {
          return "Result";
        }
        if (name === "Untagged") {
          const param = curr.typeParameters?.params?.[0] || curr.typeArguments?.params?.[0];
          return param ? this.resolveType(param) : "any";
        }
        const rawParams = curr.typeParameters?.params || curr.typeArguments?.params;
        if (rawParams && rawParams.length > 0) {
          const typeArgs = rawParams.map((p) => this.resolveType(p));
          return `${name}<${typeArgs.join(", ")}>`;
        }
        return name;
      }
      default:
        return "any";
    }
  }

  getBaseTypeName(type) {
    if (!type || typeof type !== "string") return type;
    const idx = type.indexOf("<");
    return idx === -1 ? type : type.slice(0, idx);
  }

  getTypeArguments(type) {
    if (!type || typeof type !== "string") return [];
    const open = type.indexOf("<");
    const close = type.lastIndexOf(">");
    if (open === -1 || close === -1 || close <= open) return [];
    return type
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim());
  }

  getSubstitutions(structMeta, typeStr) {
    const subst = new Map();
    if (!structMeta?.typeParams || !typeStr) return subst;
    const typeArgs = this.getTypeArguments(typeStr);
    structMeta.typeParams.forEach((tp, i) => {
      if (typeArgs[i]) subst.set(tp, typeArgs[i]);
    });
    return subst;
  }

  getMethodFromHierarchy(typeName, methodName) {
    let curr = typeName;
    while (curr && this.builtins.structSignatures.has(curr)) {
      const meta = this.builtins.structSignatures.get(curr);
      if (meta.methods && meta.methods.has(methodName)) {
        return meta.methods.get(methodName);
      }
      curr = meta.superClass;
    }
    return null;
  }

  getFieldFromHierarchy(typeName, fieldName) {
    let curr = typeName;
    while (curr && this.builtins.structSignatures.has(curr)) {
      const meta = this.builtins.structSignatures.get(curr);
      if (meta.fields && meta.fields.has(fieldName)) {
        return meta.fields.get(fieldName);
      }
      curr = meta.superClass;
    }
    return null;
  }

  implementsInterface(actualTypeName, ifaceName) {
    if (!actualTypeName || !ifaceName) return false;
    const ifaceBase = this.getBaseTypeName(ifaceName);
    const ifaceMeta = this.builtins.structSignatures.get(ifaceBase);
    if (!ifaceMeta || !ifaceMeta.isInterface) return false;

    if (actualTypeName === "null" || actualTypeName === "undefined") return true;

    const actBase = this.getBaseTypeName(actualTypeName);
    const actMeta = this.builtins.structSignatures.get(actBase);
    if (!actMeta) return false;

    // 1. Check all methods declared in the interface
    if (ifaceMeta.methods && ifaceMeta.methods.size > 0) {
      for (const [mName, mExpected] of ifaceMeta.methods.entries()) {
        const mActual = this.getMethodFromHierarchy(actBase, mName);
        if (!mActual) return false;

        const expParams = mExpected.params || [];
        const actParams = mActual.params || [];
        if (actParams.length < expParams.length) {
          return false;
        }

        for (let i = 0; i < expParams.length; i++) {
          if (!this.typesAreCompatible(actParams[i], expParams[i])) {
            return false;
          }
        }

        if (mExpected.returnType && mExpected.returnType !== "void") {
          if (!this.typesAreCompatible(mExpected.returnType, mActual.returnType)) {
            return false;
          }
        }
      }
    }

    // 2. Check all fields declared in the interface (for pure data or mixed interfaces)
    if (ifaceMeta.fields && ifaceMeta.fields.size > 0) {
      for (const [fName, fExpected] of ifaceMeta.fields.entries()) {
        const fActual = this.getFieldFromHierarchy(actBase, fName);
        if (!fActual) return false;
        if (!this.typesAreCompatible(fExpected.type, fActual.type)) {
          return false;
        }
      }
    }

    return true;
  }

  typesAreCompatible(expected, actual) {
    if (!expected || !actual) return true;
    if (expected === "any" || actual === "any") return true;
    if (expected === actual) return true;
    if (expected === "void" && actual === "void") return true;
    if (expected === "never") return false;
    if (actual === "never") return true;

    // Tip parametresi uyumluluğu (örn. henüz çözümlenmemiş T veya U)
    if (expected.length === 1 && expected >= "A" && expected <= "Z") return true;
    if (actual.length === 1 && actual >= "A" && actual <= "Z") return true;

    // Generic Struct / Interface uyumluluğu (Storage<number> <=> Storage<number> veya Storage)
    const expBase = this.getBaseTypeName(expected);
    const actBase = this.getBaseTypeName(actual);
    if (expBase === actBase && this.builtins.structSignatures.has(expBase)) {
      const expArgs = this.getTypeArguments(expected);
      const actArgs = this.getTypeArguments(actual);
      if (expArgs.length === 0 || actArgs.length === 0) return true;
      if (expArgs.length === actArgs.length) {
        return expArgs.every((ea, i) => this.typesAreCompatible(ea, actArgs[i]));
      }
    }

    // null / undefined atanabilirliği
    if (actual === "null" || actual === "undefined") {
      if (
        expected === "pointer" ||
        expected.endsWith("*") ||
        this.builtins.structSignatures.has(expected) ||
        expected.endsWith("[]") ||
        expected === "array"
      ) {
        return true;
      }
    }

    if (expected === "pointer" && actual.endsWith("*")) return true;
    if (actual === "pointer" && (expected === "pointer" || this.builtins.structSignatures.has(expected))) return true;
    if (expected === "pointer" && (actual === "pointer" || this.builtins.structSignatures.has(actual))) return true;

    // Dizi uyumluluğu
    if (expected === "array" && (actual === "array" || actual.endsWith("[]"))) return true;
    if (actual === "array" && (expected === "array" || expected.endsWith("[]"))) return true;
    if (expected.endsWith("[]") && actual.endsWith("[]")) {
      const expElem = expected.slice(0, -2);
      const actElem = actual.slice(0, -2);
      return this.typesAreCompatible(expElem, actElem);
    }

    // Promise uyumluluğu
    if (expected.startsWith("Promise<") && actual.startsWith("Promise<")) {
      const expInner = expected.slice(8, -1);
      const actInner = actual.slice(8, -1);
      return this.typesAreCompatible(expInner, actInner);
    }
    if (expected === "pointer" && actual.startsWith("Promise<")) return true;

    // 1. Enum Uyumluluğu
    if (this.builtins.enumSignatures.has(expected)) {
      const en = this.builtins.enumSignatures.get(expected);
      if (en.kind === "string" && actual === "string") return true;
      if (en.kind === "numeric" && actual === "number") return true;
    }
    if (this.builtins.enumSignatures.has(actual)) {
      const en = this.builtins.enumSignatures.get(actual);
      if (en.kind === "string" && expected === "string") return true;
      if (en.kind === "numeric" && expected === "number") return true;
    }

    // 2. Union Type Alias Uyumluluğu
    if (this.builtins.unionRegistry.has(expected)) {
      const variants = this.builtins.unionRegistry.get(expected);
      if (variants.some((v) => this.typesAreCompatible(v, actual))) return true;
    }
    if (this.builtins.unionRegistry.has(actual)) {
      const variants = this.builtins.unionRegistry.get(actual);
      if (variants.every((v) => this.typesAreCompatible(expected, v))) return true;
    }

    // 3. Tip Takma Adı Çözümleme
    if (this.builtins.typeAliasRegistry.has(expected)) {
      const resolvedExpected = this.resolveType(this.builtins.typeAliasRegistry.get(expected));
      if (resolvedExpected !== expected && this.typesAreCompatible(resolvedExpected, actual)) return true;
    }
    if (this.builtins.typeAliasRegistry.has(actual)) {
      const resolvedActual = this.resolveType(this.builtins.typeAliasRegistry.get(actual));
      if (resolvedActual !== actual && this.typesAreCompatible(expected, resolvedActual)) return true;
    }

    // 4. Sınıf Kalıtım Hiyerarşisi (Polymorphism: Warrior extends Entity)
    let curr = actual;
    while (curr && this.builtins.structSignatures.has(curr)) {
      const meta = this.builtins.structSignatures.get(curr);
      if (meta.superClass === expected) return true;
      curr = meta.superClass;
    }

    // 4.1. Interface Tabanlı Yapısal Polimorfizm (Structural Subtyping / Duck Typing)
    const expBaseName = this.getBaseTypeName(expected);
    if (this.builtins.structSignatures.has(expBaseName)) {
      const expMeta = this.builtins.structSignatures.get(expBaseName);
      if (expMeta.isInterface && this.implementsInterface(actual, expBaseName)) {
        return true;
      }
    }

    // 5. Birinci Sınıf Fonksiyon Tipleri
    if ((expected === "function" || this.builtins.functionTypeAliases.has(expected)) && actual === "function") return true;

    return false;
  }

  inferExpressionType(expr, expectedType = null) {
    if (!expr) return "void";

    // 1. Değişmezler (Literals)
    if (expr.type === "NullLiteral" || (expr.type === "Literal" && expr.value === null)) {
      return "null";
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
      for (const e of expr.expressions || []) {
        this.inferExpressionType(e);
      }
      return "string";
    }

    // 2. Dizi İfadesi (ArrayExpression)
    if (expr.type === "ArrayExpression") {
      let expectedElemType = expectedType && expectedType.endsWith("[]") ? expectedType.slice(0, -2) : null;
      let inferredElemType = expectedElemType;

      for (let i = 0; i < (expr.elements || []).length; i++) {
        const el = expr.elements[i];
        if (!el) continue;
        const elType = this.inferExpressionType(el, expectedElemType);
        if (!inferredElemType && elType !== "any") {
          inferredElemType = elType;
        }
        if (expectedElemType && elType !== "any" && !this.typesAreCompatible(expectedElemType, elType)) {
          this.reporter.addError(
            this.currentFilePath,
            el,
            `Dizi elemanı tür uyuşmazlığı: '${expectedElemType}' beklenirken '${elType}' verildi.`
          );
        }
      }
      return `${inferredElemType || "any"}[]`;
    }

    // 3. Fonksiyon İfadeleri (Arrow / Function Expression)
    if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
      const fnExpectedRet = expr.returnType ? this.resolveType(expr.returnType) : null;
      this.scopeManager.enterScope({ isFunction: true, expectedReturnType: fnExpectedRet });

      for (const p of expr.params || []) {
        const pName = p.name || p.pattern?.name;
        const pType = this.resolveType(p.typeAnnotation || p.pattern?.typeAnnotation);
        this.scopeManager.registerSymbol(pName, { type: pType, isParam: true, defNode: p });
      }

      if (expr.body?.type === "BlockStatement") {
        if (this.checkStatementCallback) {
          for (const s of expr.body.body || []) {
            this.checkStatementCallback(s);
          }
        }
      } else if (expr.body) {
        const actualRet = this.inferExpressionType(expr.body, fnExpectedRet);
        if (fnExpectedRet && fnExpectedRet !== "any" && !this.typesAreCompatible(fnExpectedRet, actualRet)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.body,
            `Dönüş türü uyuşmazlığı: Fonksiyon '${fnExpectedRet}' döndürmeli, ancak '${actualRet}' döndürüldü.`
          );
        }
      }

      this.scopeManager.exitScope();
      return "function";
    }

    // 4. Await İfadesi
    if (expr.type === "AwaitExpression") {
      if (expr.argument.type === "Identifier") {
        const sym = this.scopeManager.lookupSymbol(expr.argument.name);
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
        const fnMeta = this.builtins.functionSignatures.get(expr.argument.callee.name);
        if (fnMeta?.returnType) return fnMeta.returnType;
      }
      const argType = this.inferExpressionType(expr.argument);
      if (argType && argType.startsWith("Promise<") && argType.endsWith(">")) {
        return argType.slice(8, -1);
      }
      return expectedType || "any";
    }

    // 5. Tekli Operatörler (UnaryExpression)
    if (expr.type === "UnaryExpression") {
      if (expr.operator === "!" || expr.operator === "delete") {
        this.inferExpressionType(expr.argument);
        return "boolean";
      }
      if (expr.operator === "typeof") {
        this.inferExpressionType(expr.argument);
        return "string";
      }
      if (expr.operator === "-" || expr.operator === "+" || expr.operator === "~") {
        const argType = this.inferExpressionType(expr.argument);
        const isVectorType = ["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8"].includes(argType);
        if (isVectorType && (expr.operator === "-" || expr.operator === "+")) {
          return argType;
        }
        if (argType !== "number" && argType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.argument,
            `'${expr.operator}' tekli operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${argType}' verildi).`
          );
        }
        return "number";
      }
      return "any";
    }

    // 6. Güncelleme Operatörleri (UpdateExpression: ++, --)
    if (expr.type === "UpdateExpression") {
      if (expr.argument.type === "Identifier") {
        const sym = this.scopeManager.lookupSymbol(expr.argument.name);
        if (sym?.isConst) {
          this.reporter.addError(
            this.currentFilePath,
            expr.argument,
            `'${expr.argument.name}' bir sabittir (const); '${expr.operator}' operatörü ile değiştirilemez.`
          );
        } else if (!sym && !this.builtins.functionSignatures.has(expr.argument.name)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.argument,
            `Tanımsız değişken: '${expr.argument.name}'`
          );
        }
      }
      const argType = this.inferExpressionType(expr.argument);
      if (argType !== "number" && argType !== "any") {
        this.reporter.addError(
          this.currentFilePath,
          expr.argument,
          `'${expr.operator}' güncelleme operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${argType}' verildi).`
        );
      }
      return "number";
    }

    // 7. İkili Operatörler (BinaryExpression)
    if (expr.type === "BinaryExpression") {
      const leftType = this.inferExpressionType(expr.left);
      const rightType = this.inferExpressionType(expr.right);
      const op = expr.operator;

      const isVectorType = (t) => ["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8"].includes(t);
      if (isVectorType(leftType) && leftType === rightType) {
        if (["+", "-", "*", "/"].includes(op)) {
          return leftType;
        }
        if (["===", "==", "!==", "!="].includes(op)) {
          return "boolean";
        }
      }

      // 7.1. Toplama ve String Birleştirme (+)
      if (op === "+") {
        if (leftType === "string" || rightType === "string") {
          return "string";
        }
        if (leftType === "number" && rightType === "number") {
          return "number";
        }
        if (leftType === "any" || rightType === "any") {
          return expectedType || "number";
        }
        this.reporter.addError(
          this.currentFilePath,
          expr,
          `'+' operatörü '${leftType}' ve '${rightType}' türleri üzerinde uygulanamaz. Yalnızca sayılar veya metinler (string) desteklenir.`
        );
        return "number";
      }

      // 7.2. Aritmetik Operatörler (-, *, /, %)
      if (["-", "*", "/", "%"].includes(op)) {
        if (leftType !== "number" && leftType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${op}' aritmetik operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${leftType}' verildi).`
          );
        }
        if (rightType !== "number" && rightType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.right,
            `'${op}' aritmetik operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${rightType}' verildi).`
          );
        }
        return "number";
      }

      // 7.3. Bitwise Operatörler (&, |, ^, <<, >>, >>>)
      if (["&", "|", "^", "<<", ">>", ">>>"].includes(op)) {
        if (leftType !== "number" && leftType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${op}' bitwise operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${leftType}' verildi).`
          );
        }
        if (rightType !== "number" && rightType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.right,
            `'${op}' bitwise operatörü yalnızca sayı türleri üzerinde kullanılabilir ('${rightType}' verildi).`
          );
        }
        return "number";
      }

      // 7.4. Karşılaştırma Operatörleri (<, <=, >, >=)
      if (["<", "<=", ">", ">="].includes(op)) {
        const bothNumbers = (leftType === "number" || leftType === "any") && (rightType === "number" || rightType === "any");
        const bothStrings = (leftType === "string" || leftType === "any") && (rightType === "string" || rightType === "any");
        if (!bothNumbers && !bothStrings) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `'${op}' karşılaştırma operatörü uyumsuz türler arasında kullanılamaz ('${leftType}' ve '${rightType}').`
          );
        }
        return "boolean";
      }

      // 7.5. Eşitlik Operatörleri (==, !=, ===, !==)
      if (["==", "!=", "===", "!=="].includes(op)) {
        if (
          (leftType === "number" && rightType === "string") ||
          (leftType === "string" && rightType === "number") ||
          (leftType === "boolean" && (rightType === "string" || rightType === "number")) ||
          ((leftType === "string" || leftType === "number") && rightType === "boolean")
        ) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `Uyumsuz tür karşılaştırması: '${leftType}' ile '${rightType}' türleri hiçbir zaman eşit olamaz.`
          );
        }
        return "boolean";
      }

      return "any";
    }

    // 8. Mantıksal Operatörler (&&, ||, ??)
    if (expr.type === "LogicalExpression") {
      this.inferExpressionType(expr.left);
      this.inferExpressionType(expr.right);
      return "boolean";
    }

    // 9. Koşul Operatörü (ConditionalExpression: a ? b : c)
    if (expr.type === "ConditionalExpression") {
      this.inferExpressionType(expr.test, "boolean");
      const thenType = this.inferExpressionType(expr.consequent, expectedType);
      const elseType = this.inferExpressionType(expr.alternate, expectedType);
      if (thenType !== "any" && elseType !== "any" && this.typesAreCompatible(thenType, elseType)) {
        return thenType;
      }
      return expectedType || thenType || elseType || "any";
    }

    // 10. This İfadesi (ThisExpression)
    if (expr.type === "ThisExpression" || (expr.type === "Identifier" && expr.name === "this")) {
      if (!this.scopeManager.isInClass()) {
        this.reporter.addError(
          this.currentFilePath,
          expr,
          `'this' anahtar sözcüğü yalnızca sınıf metotları veya yapıcıları içinde kullanılabilir.`
        );
        return "any";
      }
      const cls = this.scopeManager.getCurrentClass();
      return cls?.name || "pointer";
    }

    // 11. Değişken ve Sembol Tanımlayıcıları (Identifier)
    if (expr.type === "Identifier") {
      if (expr.name === "undefined") return "undefined";
      if (expr.name === "NaN" || expr.name === "Infinity") return "number";
      if (expr.name === "console") return "any";
      if (expr.name === "Math") return "Math";
      if (expr.name === "borrow") return "any";

      // Enum kontrolü
      if (this.builtins.enumSignatures.has(expr.name)) {
        return expr.name;
      }

      // Kapsamdaki sembol kontrolü
      const sym = this.scopeManager.lookupSymbol(expr.name);
      if (sym) {
        return sym.type;
      }

      // Vektör ve SIMD Namespace kontrolü
      if (["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8", "simd"].includes(expr.name)) {
        return expr.name;
      }

      // Genel fonksiyon kontrolü
      if (this.builtins.functionSignatures.has(expr.name)) {
        return "function";
      }

      // Sınıf / Interface kontrolü
      if (this.builtins.structSignatures.has(expr.name)) {
        return expr.name;
      }

      this.reporter.addError(this.currentFilePath, expr, `Tanımsız değişken: '${expr.name}'`);
      return "any";
    }

    // 11. Nesne Değişmezi (ObjectExpression: { a: 1, b: 'hi' })
    if (expr.type === "ObjectExpression") {
      const structName = this.getBaseTypeName(expectedType);
      if (structName && this.builtins.structSignatures.has(structName)) {
        const structMeta = this.builtins.structSignatures.get(structName);
        const subst = this.getSubstitutions(structMeta, expectedType);
        const substitute = (t) => (subst.has(t) ? subst.get(t) : t);
        const providedProps = new Set();

        for (const prop of expr.properties || []) {
          const pName = prop.key?.name || prop.key?.value;
          providedProps.add(pName);

          if (!structMeta.fields.has(pName)) {
            this.reporter.addError(
              this.currentFilePath,
              prop.key || prop,
              `Bilinmeyen alan: '${pName}', '${expectedType}' yapısında tanımlı değil.`
            );
            continue;
          }

          const rawExpectedField = structMeta.fields.get(pName);
          const expectedFieldType = substitute(rawExpectedField.type);
          const actualFieldType = this.inferExpressionType(prop.value, expectedFieldType);

          if (!this.typesAreCompatible(expectedFieldType, actualFieldType)) {
            this.reporter.addError(
              this.currentFilePath,
              prop.value,
              `'${expectedType}.${pName}' alanı için tür uyuşmazlığı: '${expectedFieldType}' beklenirken '${actualFieldType}' verildi.`
            );
          }
        }

        for (const [fName, fMeta] of structMeta.fields.entries()) {
          if (!providedProps.has(fName)) {
            this.reporter.addError(
              this.currentFilePath,
              expr,
              `Eksik alan: '${expectedType}' nesnesi için zorunlu olan '${fName}: ${substitute(fMeta.type)}' alanı tanımlanmadı.`
            );
          }
        }

        return expectedType;
      }
      return "object";
    }

    // 12. Üye Erişimi (MemberExpression: obj.prop veya arr[idx])
    if (expr.type === "MemberExpression") {
      let baseType = null;
      let isEnum = false;

      if (expr.object.type === "Identifier" && this.builtins.enumSignatures.has(expr.object.name)) {
        baseType = expr.object.name;
        isEnum = true;
      } else {
        baseType = this.inferExpressionType(expr.object);
      }
      const propName = expr.property?.name || expr.property?.value;

      // Enum eleman erişimi
      if (isEnum) {
        if (expr.computed) return "string";
        const en = this.builtins.enumSignatures.get(baseType);
        if (!en.members.has(propName)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.property,
            `'${baseType}' enum'ında '${propName}' üyesi bulunamadı!`
          );
        }
        return en.kind === "string" ? "string" : "number";
      }

      // Dizi eleman / length erişimi
      if (baseType === "array" || baseType.endsWith("[]")) {
        if (propName === "length" && !expr.computed) {
          return "number";
        }
        if (expr.computed) {
          const indexType = this.inferExpressionType(expr.property, "number");
          if (indexType !== "number" && indexType !== "any") {
            this.reporter.addError(
              this.currentFilePath,
              expr.property,
              `Dizi indeksi sayısal bir tür olmalıdır, '${indexType}' verildi.`
            );
          }
          return baseType.endsWith("[]") ? baseType.slice(0, -2) : "number";
        }
      }

      // String length / index erişimi
      if (baseType === "string") {
        if (propName === "length" && !expr.computed) {
          return "number";
        }
        if (expr.computed) {
          const indexType = this.inferExpressionType(expr.property, "number");
          if (indexType !== "number" && indexType !== "any") {
            this.reporter.addError(
              this.currentFilePath,
              expr.property,
              `Karakter dizisi indeksi sayısal bir tür olmalıdır, '${indexType}' verildi.`
            );
          }
          return "string";
        }
      }

      // Vektör eleman erişimi (v[idx])
      if (["f32x4", "f64x2", "i32x4", "i64x2", "f64x4", "f32x8", "i32x8"].includes(baseType)) {
        if (expr.computed) {
          return "number";
        }
      }

      // Struct / Interface / Class üye erişimi
      const structName = this.getBaseTypeName(baseType);
      if (this.builtins.structSignatures.has(structName)) {
        const structMeta = this.builtins.structSignatures.get(structName);
        const subst = this.getSubstitutions(structMeta, baseType);
        const substitute = (t) => (subst.has(t) ? subst.get(t) : t);

        if (structMeta.fields.has(propName)) {
          return substitute(structMeta.fields.get(propName).type);
        }
        if (structMeta.methods.has(propName)) {
          return substitute(structMeta.methods.get(propName).returnType);
        }

        let curr = structMeta.superClass;
        while (curr && this.builtins.structSignatures.has(curr)) {
          const parentMeta = this.builtins.structSignatures.get(curr);
          if (parentMeta.fields?.has(propName)) return substitute(parentMeta.fields.get(propName).type);
          if (parentMeta.methods?.has(propName)) return substitute(parentMeta.methods.get(propName).returnType);
          curr = parentMeta.superClass;
        }

        this.reporter.addError(
          this.currentFilePath,
          expr.property,
          `'${baseType}' türünde '${propName}' alanı veya metodu bulunamadı!`
        );
        return "void";
      }

      if (
        baseType !== "any" &&
        baseType !== "object" &&
        baseType !== "pointer" &&
        expr.object.name !== "console" &&
        expr.object.name !== "Math"
      ) {
        this.reporter.addError(
          this.currentFilePath,
          expr.object,
          `'${baseType}' ilkel bir türdür; üzerinde '${propName}' alanı okunamaz.`
        );
      }
      return "any";
    }

    // 13. Atama İfadeleri (AssignmentExpression: x = val, x += val)
    if (expr.type === "AssignmentExpression") {
      // Hedefin yazılabilirliği (const kontrolü)
      if (expr.left.type === "Identifier") {
        const targetName = expr.left.name;
        const sym = this.scopeManager.lookupSymbol(targetName);
        if (sym?.isConst) {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${targetName}' bir sabittir (const); yeniden değer atanamaz.`
          );
        } else if (this.builtins.functionSignatures.has(targetName)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${targetName}' bir fonksiyondur; yeniden değer atanamaz.`
          );
        } else if (this.builtins.structSignatures.has(targetName) || this.builtins.enumSignatures.has(targetName)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${targetName}' bir tip/sınıftır; değişken gibi değer atanamaz.`
          );
        } else if (!sym) {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `Atama yapılan tanımsız değişken: '${targetName}'`
          );
        }
      }

      const targetType = this.inferExpressionType(expr.left);
      const op = expr.operator;

      let expectedValType = targetType;
      if (op === "+=") {
        expectedValType = targetType === "string" ? "any" : "number";
      } else if (op !== "=") {
        expectedValType = "number";
        if (targetType !== "number" && targetType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.left,
            `'${op}' bileşik atama operatörü yalnızca sayısal türler üzerinde kullanılabilir ('${targetType}' verildi).`
          );
        }
      }

      const valType = this.inferExpressionType(expr.right, expectedValType);

      if (op === "=") {
        if (targetType !== "any" && valType !== "any" && !this.typesAreCompatible(targetType, valType)) {
          this.reporter.addError(
            this.currentFilePath,
            expr.right,
            `Atama tür uyuşmazlığı: '${targetType}' türündeki hedefe '${valType}' atanamaz.`
          );
        }
      } else if (op === "+=") {
        if (targetType === "number" && valType !== "number" && valType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.right,
            `'+=' operatöründe sayısal hedefe '${valType}' eklenemez.`
          );
        }
      } else {
        if (valType !== "number" && valType !== "any") {
          this.reporter.addError(
            this.currentFilePath,
            expr.right,
            `'${op}' operatöründe sağ taraf bir sayı olmalıdır ('${valType}' verildi).`
          );
        }
      }
      return targetType;
    }

    // 14. Çağrı İfadeleri (CallExpression)
    if (expr.type === "CallExpression") {
      const callee = expr.callee;

      // 14.1. super(...) çağrısı
      if (callee.type === "Super") {
        if (!this.scopeManager.isInClass()) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `'super()' çağrısı yalnızca sınıf yapıcıları içinde kullanılabilir.`
          );
          return "void";
        }
        const clsMeta = this.scopeManager.getCurrentClass();
        if (!clsMeta?.superClass) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `'${clsMeta?.name || "Sınıf"}' bir üst sınıfa (superClass) sahip değil; 'super()' çağrılamaz.`
          );
          return "void";
        }
        const parentMeta = this.builtins.structSignatures.get(clsMeta.superClass);
        const parentConstructor = parentMeta?.methods?.get("constructor");
        if (parentConstructor) {
          const actualArgs = expr.arguments || [];
          const expectedParams = parentConstructor.params || [];
          if (actualArgs.length !== expectedParams.length) {
            this.reporter.addError(
              this.currentFilePath,
              expr,
              `'super()' argüman sayısı uyuşmazlığı: Üst sınıf yapıcısı ${expectedParams.length} argüman beklerken ${actualArgs.length} verildi.`
            );
          }
          actualArgs.forEach((arg, idx) => {
            const expectedParamType = expectedParams[idx];
            const actualArgType = this.inferExpressionType(arg, expectedParamType);
            if (expectedParamType && !this.typesAreCompatible(expectedParamType, actualArgType)) {
              this.reporter.addError(
                this.currentFilePath,
                arg,
                `'super()' için geçersiz argüman türü: Parametre ${idx + 1} için '${expectedParamType}' beklenirken '${actualArgType}' verildi.`
              );
            }
          });
        }
        return "void";
      }

      // 14.2. super.method(...) çağrısı
      if (callee.type === "MemberExpression" && callee.object?.type === "Super") {
        if (!this.scopeManager.isInClass()) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `'super' yalnızca sınıf metotları içinde kullanılabilir.`
          );
          return "any";
        }
        const clsMeta = this.scopeManager.getCurrentClass();
        if (!clsMeta?.superClass) {
          this.reporter.addError(
            this.currentFilePath,
            callee,
            `'${clsMeta?.name || "Sınıf"}' bir üst sınıfa (superClass) sahip değil; 'super' erişimi yapılamaz.`
          );
          return "any";
        }
        const methodName = callee.property?.name || callee.property?.value;
        const parentMeta = this.builtins.structSignatures.get(clsMeta.superClass);
        const parentMethod = parentMeta?.methods?.get(methodName);
        if (!parentMethod) {
          this.reporter.addError(
            this.currentFilePath,
            callee.property,
            `Üst sınıf '${clsMeta.superClass}' üzerinde '${methodName}' metodu bulunamadı!`
          );
          return "any";
        }
        const actualArgs = expr.arguments || [];
        const expectedParams = parentMethod.params || [];
        if (actualArgs.length !== expectedParams.length) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `'super.${methodName}()' argüman sayısı uyuşmazlığı: ${expectedParams.length} argüman beklerken ${actualArgs.length} verildi.`
          );
        }
        actualArgs.forEach((arg, idx) => {
          const expectedParamType = expectedParams[idx];
          const actualArgType = this.inferExpressionType(arg, expectedParamType);
          if (expectedParamType && !this.typesAreCompatible(expectedParamType, actualArgType)) {
            this.reporter.addError(
              this.currentFilePath,
              arg,
              `'super.${methodName}()' için geçersiz argüman: Parametre ${idx + 1} için '${expectedParamType}' beklenirken '${actualArgType}' verildi.`
            );
          }
        });
        return parentMethod.returnType || "any";
      }

      // 14.3. Metot Çağrısı (obj.method(...))
      if (callee.type === "MemberExpression") {
        const objType = this.inferExpressionType(callee.object);
        const method = callee.property?.name || callee.property?.value;

        if (callee.object.name === "console" && ["log", "warn", "error"].includes(method)) {
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          return "void";
        }

        const structName = this.getBaseTypeName(objType);
        if (this.builtins.structSignatures.has(structName)) {
          const structMeta = this.builtins.structSignatures.get(structName);
          const subst = this.getSubstitutions(structMeta, objType);
          const substitute = (t) => (subst.has(t) ? subst.get(t) : t);

          let methodMeta = structMeta?.methods?.get(method);
          let curr = structMeta?.superClass;
          while (!methodMeta && curr && this.builtins.structSignatures.has(curr)) {
            const parentMeta = this.builtins.structSignatures.get(curr);
            if (parentMeta.methods?.has(method)) {
              methodMeta = parentMeta.methods.get(method);
              break;
            }
            curr = parentMeta.superClass;
          }

          if (!methodMeta) {
            if (structMeta.fields?.has(method)) {
              for (const a of expr.arguments || []) this.inferExpressionType(a);
              const fieldMeta = structMeta.fields.get(method);
              const fnSig = this.builtins.functionSignatures.get(fieldMeta?.type);
              return fnSig?.returnType || "number";
            }
            this.reporter.addError(
              this.currentFilePath,
              callee.property,
              `'${objType}' türünde '${method}' metodu bulunamadı!`
            );
            for (const a of expr.arguments || []) this.inferExpressionType(a);
            return "void";
          }

          const actualArgs = expr.arguments || [];
          const rawParams = methodMeta.params || [];
          const expectedParams = rawParams.map(substitute);
          const minArgs = methodMeta.minArgs !== undefined ? methodMeta.minArgs : expectedParams.length;
          if (actualArgs.length < minArgs || actualArgs.length > expectedParams.length) {
            this.reporter.addError(
              this.currentFilePath,
              expr,
              `Argüman sayısı uyuşmazlığı: '${objType}.${method}' ${expectedParams.length} argüman beklerken ${actualArgs.length} verildi.`
            );
          }
          actualArgs.forEach((arg, idx) => {
            const expectedParamType = expectedParams[idx];
            const actualArgType = this.inferExpressionType(arg, expectedParamType);
            if (expectedParamType && !this.typesAreCompatible(expectedParamType, actualArgType)) {
              this.reporter.addError(
                this.currentFilePath,
                arg,
                `'${objType}.${method}' için geçersiz argüman türü: Parametre ${idx + 1} için '${expectedParamType}' beklenirken '${actualArgType}' verildi.`
              );
            }
          });
          if (structName === "simd") {
            const firstArgType = actualArgs.length > 0 ? this.inferExpressionType(actualArgs[0]) : null;
            if (["add", "sub", "mul", "div", "fma", "insert", "sqrt", "abs"].includes(method) && firstArgType) {
              return firstArgType;
            }
          }
          return substitute(methodMeta.returnType || "void");
        }
        return "any";
      }

      // 14.4. Doğrudan Fonksiyon Çağrısı (fn(...))
      if (callee.type === "Identifier") {
        const fnName = callee.name;

        if (fnName === "borrow") {
          if (!expr.arguments || expr.arguments.length !== 1) {
            this.reporter.addError(this.currentFilePath, expr, "borrow() fonksiyonu tam olarak 1 argüman bekler.");
            return "any";
          }
          return this.inferExpressionType(expr.arguments[0]);
        }

        if (fnName === "unwrap") {
          if (!expr.arguments || expr.arguments.length !== 1) {
            this.reporter.addError(this.currentFilePath, expr, "unwrap() fonksiyonu tam olarak 1 argüman bekler.");
            return "any";
          }
          const argType = this.inferExpressionType(expr.arguments[0]);
          if (argType !== "Result" && argType !== "any") {
            this.reporter.addError(
              this.currentFilePath,
              expr.arguments[0],
              `unwrap() yalnızca 'Result' türü üzerinde çağrılabilir, '${argType}' verildi.`
            );
          }
          return "any";
        }

        if (fnName === "sleep") {
          if (!expr.arguments || expr.arguments.length !== 1) {
            this.reporter.addError(this.currentFilePath, expr, "sleep() fonksiyonu tam olarak 1 argüman bekler.");
          } else {
            const argType = this.inferExpressionType(expr.arguments[0], "number");
            if (argType !== "number" && argType !== "any") {
              this.reporter.addError(
                this.currentFilePath,
                expr.arguments[0],
                `sleep() fonksiyonu sayısal bir milisaniye değeri bekler, '${argType}' verildi.`
              );
            }
          }
          return "void";
        }

        if (fnName === "panic") {
          if (expr.arguments?.[0]) this.inferExpressionType(expr.arguments[0], "string");
          return "never";
        }

        if (fnName === "assert") {
          if (expr.arguments?.[0]) this.inferExpressionType(expr.arguments[0], "boolean");
          if (expr.arguments?.[1]) this.inferExpressionType(expr.arguments[1], "string");
          return "void";
        }

        const localSym = this.scopeManager.lookupSymbol(fnName);
        if (localSym && (localSym.type === "function" || localSym.type === "any" || this.builtins.functionTypeAliases.has(localSym.type))) {
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          const fnSig = this.builtins.functionSignatures.get(localSym.type);
          return fnSig?.returnType || "number";
        }

        const fnMeta = this.builtins.functionSignatures.get(fnName);
        if (!fnMeta) {
          this.reporter.addError(this.currentFilePath, callee, `Tanımsız fonksiyon çağrısı: '${fnName}()'`);
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          return "any";
        }

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

        const minArgs = fnMeta.minArgs !== undefined ? fnMeta.minArgs : expectedParams.length;
        if (actualArgs.length < minArgs || actualArgs.length > expectedParams.length) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `Argüman sayısı uyuşmazlığı: '${fnName}' ${minArgs === expectedParams.length ? expectedParams.length : `${minArgs}-${expectedParams.length}`} argüman beklerken ${actualArgs.length} verildi.`
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

      }
      this.inferExpressionType(callee);
      for (const a of expr.arguments || []) this.inferExpressionType(a);
      return "any";
    }

    // 15. New İfadesi (NewExpression: new Cls(...))
    if (expr.type === "NewExpression") {
      const clsName = expr.callee.name;
      if (!clsName || !this.builtins.structSignatures.has(clsName)) {
        this.reporter.addError(
          this.currentFilePath,
          expr.callee,
          `Tanımsız sınıf veya yapı: '${clsName}'`
        );
        return "any";
      }

      const structMeta = this.builtins.structSignatures.get(clsName);
      const constructorMethod = structMeta.methods?.get("constructor");
      if (constructorMethod) {
        const actualArgs = expr.arguments || [];
        const rawTypeArgs = expr.typeParameters?.params || expr.typeArguments?.params || [];
        const subst = new Map();
        if (structMeta.typeParams && structMeta.typeParams.length > 0) {
          structMeta.typeParams.forEach((tpName, i) => {
            if (rawTypeArgs[i]) {
              subst.set(tpName, this.resolveType(rawTypeArgs[i]));
            }
          });
        }

        const substitute = (t) => (subst.has(t) ? subst.get(t) : t);
        const expectedParams = (constructorMethod.params || []).map(substitute);

        if (actualArgs.length !== expectedParams.length) {
          this.reporter.addError(
            this.currentFilePath,
            expr,
            `Yapıcı (constructor) argüman sayısı uyuşmazlığı: '${clsName}' ${expectedParams.length} argüman beklerken ${actualArgs.length} verildi.`
          );
        }
        actualArgs.forEach((arg, idx) => {
          const expectedParamType = expectedParams[idx];
          const actualArgType = this.inferExpressionType(arg, expectedParamType);
          if (expectedParamType && !this.typesAreCompatible(expectedParamType, actualArgType)) {
            this.reporter.addError(
              this.currentFilePath,
              arg,
              `'${clsName}' yapıcısı için geçersiz argüman türü: Parametre ${idx + 1} için '${expectedParamType}' beklenirken '${actualArgType}' verildi.`
            );
          }
        });
      }
      return clsName;
    }

    return "any";
  }
}
