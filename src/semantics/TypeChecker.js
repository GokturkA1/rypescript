// src/semantics/TypeChecker.js

/**
 * Tip uyumluluğu (typesAreCompatible), çıkarım (inferExpressionType)
 * ve statik denetim mantığını yöneten motor.
 */
export class TypeChecker {
  constructor(builtinRegistry, scopeManager, reporter, getCurrentFilePath = () => "") {
    this.builtins = builtinRegistry;
    this.scopeManager = scopeManager;
    this.reporter = reporter;
    this.getCurrentFilePath = getCurrentFilePath;
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
      case "TSArrayType":
        return "array";
      case "TSTypeReference": {
        const name = curr.typeName?.name || curr.typeName?.value;
        if (["i64", "i32", "f64", "f32"].includes(name)) return "number";
        if (name === "bool") return "boolean";
        if (name === "Promise") {
          return "pointer";
        }
        return name || "pointer";
      }
      default:
        return "any";
    }
  }

  typesAreCompatible(expected, actual) {
    if (!expected || !actual) return true;
    if (expected === "any" || actual === "any") return true;
    if (expected === actual) return true;
    if (expected === "pointer" && actual.endsWith("*")) return true;
    if (actual === "pointer" && (expected === "pointer" || this.builtins.structSignatures.has(expected))) return true;
    if (expected === "pointer" && (actual === "pointer" || this.builtins.structSignatures.has(actual))) return true;

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

    // 2. Union Type Alias Uyumluluğu (Örn: FlexibleData = string | number)
    if (this.builtins.unionRegistry.has(expected)) {
      const variants = this.builtins.unionRegistry.get(expected);
      if (variants.some((v) => this.typesAreCompatible(v, actual))) return true;
    }
    if (this.builtins.unionRegistry.has(actual)) {
      const variants = this.builtins.unionRegistry.get(actual);
      if (variants.every((v) => this.typesAreCompatible(expected, v))) return true;
    }

    // 3. Tip Takma Adı Çözümleme (Örn: EntityID = number)
    if (this.builtins.typeAliasRegistry.has(expected)) {
      const resolvedExpected = this.resolveType(this.builtins.typeAliasRegistry.get(expected));
      if (this.typesAreCompatible(resolvedExpected, actual)) return true;
    }
    if (this.builtins.typeAliasRegistry.has(actual)) {
      const resolvedActual = this.resolveType(this.builtins.typeAliasRegistry.get(actual));
      if (this.typesAreCompatible(expected, resolvedActual)) return true;
    }

    // 4. Sınıf Kalıtım Hiyerarşisi (Polymorphism: Warrior extends Entity)
    let curr = actual;
    while (curr && this.builtins.structSignatures.has(curr)) {
      const meta = this.builtins.structSignatures.get(curr);
      if (meta.superClass === expected) return true;
      curr = meta.superClass;
    }

    // 5. Birinci Sınıf Fonksiyon ve Dizi Tipleri
    if ((expected === "function" || this.builtins.functionTypeAliases.has(expected)) && actual === "function") return true;
    if (expected === "array" && actual === "array") return true;
    if (expected === "number" && actual === "number") return true;

    return false;
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
      if (this.builtins.enumSignatures.has(expr.name)) {
        return expr.name;
      }

      const sym = this.scopeManager.lookupSymbol(expr.name);
      if (!sym) {
        if (!this.builtins.functionSignatures.has(expr.name) && expr.name !== "console") {
          this.reporter.addError(this.currentFilePath, expr, `Tanımsız değişken: '${expr.name}'`);
        }
        return "any";
      }
      return sym.type;
    }

    if (expr.type === "ObjectExpression") {
      if (expectedType && this.builtins.structSignatures.has(expectedType)) {
        const structMeta = this.builtins.structSignatures.get(expectedType);
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

      if (expr.object.type === "Identifier" && this.builtins.enumSignatures.has(expr.object.name)) {
        baseType = expr.object.name;
        isEnum = true;
      } else {
        baseType = this.inferExpressionType(expr.object);
      }
      const propName = expr.property?.name || expr.property?.value;

      if (isEnum) {
        if (expr.computed) return "string";
        const en = this.builtins.enumSignatures.get(baseType);
        return en.kind === "string" ? "string" : "number";
      }

      if ((baseType === "array" || baseType === "string") && propName === "length") {
        return "number";
      }
      if (baseType === "array" && expr.computed) {
        return "number";
      }

      if (this.builtins.structSignatures.has(baseType)) {
        const structMeta = this.builtins.structSignatures.get(baseType);
        if (structMeta.fields.has(propName)) {
          return structMeta.fields.get(propName).type;
        }
        if (structMeta.methods.has(propName)) {
          return structMeta.methods.get(propName).returnType;
        }

        let curr = structMeta.superClass;
        while (curr && this.builtins.structSignatures.has(curr)) {
          const parentMeta = this.builtins.structSignatures.get(curr);
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

        if (this.builtins.structSignatures.has(objType)) {
          const structMeta = this.builtins.structSignatures.get(objType);
          if (structMeta?.methods.has(method)) {
            return structMeta.methods.get(method).returnType;
          }
          let curr = structMeta.superClass;
          while (curr && this.builtins.structSignatures.has(curr)) {
            const parentMeta = this.builtins.structSignatures.get(curr);
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

        const localSym = this.scopeManager.lookupSymbol(fnName);
        if (localSym && (localSym.type === "function" || this.builtins.functionTypeAliases.has(localSym.type))) {
          for (const a of expr.arguments || []) this.inferExpressionType(a);
          return "number";
        }

        const fnMeta = this.builtins.functionSignatures.get(fnName);
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
