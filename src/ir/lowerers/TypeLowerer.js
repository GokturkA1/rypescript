// src/ir/lowerers/TypeLowerer.js

export class TypeLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  get typeAliasRegistry() { return this.astLowerer.typeAliasRegistry; }
  get enumRegistry() { return this.astLowerer.enumRegistry; }
  get structRegistry() { return this.astLowerer.structRegistry; }
  get classList() { return this.astLowerer.classList; }
  get thunkRegistry() { return this.astLowerer.thunkRegistry; }
  get functionRegistry() { return this.astLowerer.functionRegistry; }
  get monomorphizer() { return this.astLowerer.monomorphizer; }
  get requiredItables() { return this.astLowerer.requiredItables; }
  get currentFunctionNode() { return this.astLowerer.currentFunctionNode; }

  getNamespaceName(...args) { return this.astLowerer.getNamespaceName(...args); }
  extractMemberChain(...args) { return this.astLowerer.extractMemberChain(...args); }
  resolveNamespaceStruct(...args) { return this.astLowerer.resolveNamespaceStruct(...args); }

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

      const rawCallableType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
      const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;
      return {
        paramTypes,
        retType,
        mlirType: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
        callableType,
        rawCallableType,
      };
    }

    return null;
  }

  getOrCreateThunk(funcName) {
    const thunkName = `__thunk_${funcName}`;
    if (this.thunkRegistry.has(funcName)) {
      return this.thunkRegistry.get(funcName);
    }

    const fnMeta = this.functionRegistry.get(funcName);
    const paramTypes = fnMeta?.paramTypes || [];
    const retType = fnMeta?.retType || "none";
    const retStr = retType === "none" ? "()" : retType;
    const thunkSig = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retStr}`;

    const thunkParams = [`%arg_env: !llvm.ptr`];
    const callArgs = [];
    paramTypes.forEach((pt, i) => {
      thunkParams.push(`%arg_${i}: ${pt}`);
      callArgs.push(`%arg_${i}`);
    });

    const lines = [];
    lines.push(`  func.func @${thunkName}(${thunkParams.join(", ")}) -> ${retStr} {`);
    if (retType === "none") {
      lines.push(`    func.call @${funcName}(${callArgs.join(", ")}) : (${paramTypes.join(", ")}) -> ()`);
      lines.push(`    func.return`);
    } else {
      lines.push(`    %res = func.call @${funcName}(${callArgs.join(", ")}) : (${paramTypes.join(", ")}) -> ${retType}`);
      lines.push(`    func.return %res : ${retType}`);
    }
    lines.push(`  }`);

    this.builder.addModuleFunction(lines.join("\n"));
    const thunkInfo = { thunkName, thunkSig, paramTypes, retType };
    this.thunkRegistry.set(funcName, thunkInfo);
    return thunkInfo;
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
    return this.monomorphizer.getTypeKey(typeNode);
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
      case "TSTypePredicate":
        return "i1";
      case "TSNumberKeyword":
        return "f64";
      case "TSBooleanKeyword":
        return "i1";
      case "TSStringKeyword":
        return "!llvm.ptr";
      case "TSVoidKeyword":
      case "TSNeverKeyword":
        return "none";
      case "TSArrayType":
        return "!llvm.ptr";
      case "TSTypeReference": {
        const typeName = type.typeName?.name || type.typeName?.value || this.getNamespaceName(type.typeName);
        if (["Channel", "Arena", "Pool", "FixedBuffer", "pointer", "ptr"].includes(typeName)) return "!llvm.ptr";
        if (typeName === "f32x4") return "vector<4xf32>";
        if (typeName === "f64x2") return "vector<2xf64>";
        if (typeName === "i32x4") return "vector<4xi32>";
        if (typeName === "i64x2") return "vector<2xi64>";
        if (typeName === "f64x4") return "vector<4xf64>";
        if (typeName === "f32x8") return "vector<8xf32>";
        if (typeName === "i32x8") return "vector<8xi32>";
        if (["i64", "int64", "u64", "uint64", "usize", "isize"].includes(typeName)) return "i64";
        if (["i32", "int32", "u32", "uint32", "int"].includes(typeName)) return "i32";
        if (["byte", "u8", "i8"].includes(typeName)) return "i8";
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
          const meta = this.structRegistry.get(typeName);
          if (meta && meta.isInterface && meta.isPolymorphic) {
            return "!llvm.struct<(!llvm.ptr, !llvm.ptr)>";
          }
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

  isPolymorphicInterface(typeName) {
    if (!typeName) return false;
    const meta = this.structRegistry.get(typeName);
    return Boolean(meta && meta.isInterface && meta.isPolymorphic);
  }

  getStructName(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return null;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value || this.getNamespaceName(type.typeName) || null;
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
      const typeName = type.typeName?.name || type.typeName?.value || this.getNamespaceName(type.typeName) || null;
      if (typeName && this.enumRegistry.has(typeName)) {
        return typeName;
      }
      if (typeName && this.typeAliasRegistry.has(typeName)) {
        return this.getEnumName(this.typeAliasRegistry.get(typeName));
      }
    }
    return null;
  }

  extractArrayTargetType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return null;
    if (type.type === "TSArrayType") {
      const elRaw = this.unwrapType(type.elementType);
      if (elRaw.type === "TSStringKeyword") {
        return { elemType: "!llvm.ptr", isString: true, structName: null };
      }
      if (elRaw.type === "TSTypeReference") {
        const tName = elRaw.typeName?.name || elRaw.typeName?.value;
        if (["i32", "int32", "u32", "int"].includes(tName)) return { elemType: "i32", isString: false, structName: null };
        if (["i64", "int64", "u64"].includes(tName)) return { elemType: "i64", isString: false, structName: null };
        if (["bool", "boolean"].includes(tName)) return { elemType: "i1", isString: false, structName: null };
        if (["f64", "double"].includes(tName)) return { elemType: "f64", isString: false, structName: null };
        if (["f32", "float"].includes(tName)) return { elemType: "f32", isString: false, structName: null };
        if (this.structRegistry.has(tName) || this.classList.some((c) => c.name === tName)) {
          const isPoly = this.isPolymorphicInterface(tName);
          return {
            elemType: isPoly ? "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" : "!llvm.ptr",
            isString: false,
            structName: tName,
            isInterface: isPoly,
          };
        }
      }
      if (elRaw.type === "TSNumberKeyword") {
        return { elemType: "f64", isString: false, structName: null };
      }
      if (elRaw.type === "TSBooleanKeyword") {
        return { elemType: "i1", isString: false, structName: null };
      }
    }
    return null;
  }

  coerceType(val, targetType) {
    if (!val || val.type === targetType) return val;
    if ((targetType && targetType.startsWith("vector<")) || (val.type && val.type.startsWith("vector<"))) {
      return val;
    }

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

    // Pointer <-> Integer (llvm.ptrtoint / llvm.inttoptr)
    if (val.type === "!llvm.ptr" && (targetType === "i64" || targetType === "i32")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = llvm.ptrtoint ${val.ssa || val.ptr} : !llvm.ptr to ${targetType}`);
      return { ssa, type: targetType };
    }
    if ((val.type === "i64" || val.type === "i32") && targetType === "!llvm.ptr") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = llvm.inttoptr ${val.ssa || val.ptr} : ${val.type} to !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr" };
    }
    if (val.type === "!llvm.ptr" && targetType === "f64") {
      const iVal = this.coerceType(val, "i64");
      return this.coerceType(iVal, "f64");
    }
    if (val.type === "f64" && targetType === "!llvm.ptr") {
      const iVal = this.coerceType(val, "i64");
      return this.coerceType(iVal, "!llvm.ptr");
    }

    // i8 conversions
    if (targetType === "i8" && (val.type === "f64" || val.type === "f32")) {
      const i32Val = this.coerceType(val, "i32");
      return this.coerceType(i32Val, "i8");
    }
    if (targetType === "i8" && (val.type === "i32" || val.type === "i64")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.trunci ${val.ssa || val.ptr} : ${val.type} to i8`);
      return { ssa, type: "i8" };
    }
    if ((targetType === "f64" || targetType === "f32") && val.type === "i8") {
      const i32Val = this.coerceType(val, "i32");
      return this.coerceType(i32Val, targetType);
    }
    if ((targetType === "i32" || targetType === "i64") && val.type === "i8") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.extui ${val.ssa || val.ptr} : i8 to ${targetType}`);
      return { ssa, type: targetType };
    }

    if (targetType === "f64" && val.type === "f32") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.extf ${val.ssa} : f32 to f64`);
      return { ssa, type: "f64" };
    }
    if (targetType === "f32" && val.type === "f64") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.truncf ${val.ssa} : f64 to f32`);
      return { ssa, type: "f32" };
    }
    if (targetType === "f32" && (val.type === "i64" || val.type === "i32")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.sitofp ${val.ssa} : ${val.type} to f32`);
      return { ssa, type: "f32" };
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
    if (targetType === "i32" && (val.type === "f64" || val.type === "f32")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.fptosi ${val.ssa} : ${val.type} to i32`);
      return { ssa, type: "i32" };
    }
    if (targetType === "i32" && val.type === "i1") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.extui ${val.ssa} : i1 to i32`);
      return { ssa, type: "i32" };
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

  getDescendantTypeIds(targetClassName) {
    const ids = new Set();
    const targetMeta = this.structRegistry.get(targetClassName);
    if (targetMeta && targetMeta.typeId) {
      ids.add(targetMeta.typeId);
    }
    for (const [name, meta] of this.structRegistry.entries()) {
      if (meta.isClass && meta.typeId) {
        let curr = meta;
        while (curr && curr.superClass) {
          if (curr.superClass === targetClassName) {
            ids.add(meta.typeId);
            break;
          }
          curr = this.structRegistry.get(curr.superClass);
        }
      }
    }
    return Array.from(ids);
  }

  extractNarrowingCheck(expr) {
    if (!expr) return null;

    // 1. typeof kontrolü (örn: typeof x === "number")
    const typeofCheck = this.extractTypeofCheck(expr);
    if (typeofCheck) {
      return { kind: "typeof", ...typeofCheck };
    }

    // 2. instanceof kontrolü (örn: hero instanceof Paladin)
    if (expr.type === "BinaryExpression" && expr.operator === "instanceof") {
      let varName = null;
      if (expr.left.type === "Identifier") {
        varName = expr.left.name;
      }
      let targetType = null;
      if (expr.right.type === "Identifier") {
        targetType = expr.right.name;
      } else if (expr.right.type === "MemberExpression") {
        const chain = this.extractMemberChain(expr.right);
        if (chain) targetType = chain.join("_");
      }
      if (targetType && !this.structRegistry.has(targetType) && this.currentFunctionNode?._namespacePrefix) {
        const resolved = this.resolveNamespaceStruct(this.currentFunctionNode._namespacePrefix, targetType);
        if (resolved) targetType = resolved;
      }
      if (varName && targetType) {
        return { kind: "instanceof", varName, targetType };
      }
    }

    // 3. Type Predicate Fonksiyon Çağrısı (örn: isPaladin(hero))
    if (expr.type === "CallExpression") {
      let calleeName = null;
      if (expr.callee.type === "Identifier") {
        calleeName = expr.callee.name;
      } else if (expr.callee.type === "MemberExpression") {
        const chain = this.extractMemberChain(expr.callee);
        if (chain) calleeName = chain.join("_");
      }
      if (calleeName) {
        const fnMeta = this.functionRegistry.get(calleeName);
        if (fnMeta && fnMeta.typePredicate) {
          const pIdx = fnMeta.params?.findIndex((p) => p.name === fnMeta.typePredicate.paramName) ?? 0;
          const targetArg = expr.arguments?.[pIdx >= 0 ? pIdx : 0];
          if (targetArg && targetArg.type === "Identifier") {
            return {
              kind: "predicate",
              varName: targetArg.name,
              targetType: fnMeta.typePredicate.targetType,
            };
          }
        }
      }
    }

    return null;
  }

  boxIntoInterface(val, ifaceName) {
    if (!ifaceName || !val) return val;
    if (val.isInterface) return val;

    const ifaceMeta = this.structRegistry.get(ifaceName);
    if (!ifaceMeta || !ifaceMeta.isPolymorphic) return val;

    const className = val.structName;
    if (!className) return val;

    const key = `${className}_${ifaceName}`;
    this.requiredItables.set(key, { className, ifaceName });

    const itableFn = `@rts_get_itable_${className}_${ifaceName}`;
    const itablePtr = this.builder.nextSSA();
    this.builder.emit(`${itablePtr} = func.call ${itableFn}() : () -> !llvm.ptr`);

    const instancePtr = val.ssa || val.ptr;
    const fat0 = this.builder.nextSSA();
    this.builder.emit(`${fat0} = llvm.mlir.undef : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
    const fat1 = this.builder.nextSSA();
    this.builder.emit(`${fat1} = llvm.insertvalue ${instancePtr}, ${fat0}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
    const fat2 = this.builder.nextSSA();
    this.builder.emit(`${fat2} = llvm.insertvalue ${itablePtr}, ${fat1}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);

    return {
      ssa: fat2,
      ptr: fat2,
      type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
      isInterface: true,
      structName: ifaceName,
      isHeap: val.isHeap,
    };
  }
}
