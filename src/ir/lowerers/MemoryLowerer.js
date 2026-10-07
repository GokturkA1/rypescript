// src/ir/lowerers/MemoryLowerer.js

export class MemoryLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  get structRegistry() { return this.astLowerer.structRegistry; }
  get currentFunctionNode() { return this.astLowerer.currentFunctionNode; }

  walkAST(...args) { return this.astLowerer.walkAST(...args); }
  extractMemberChain(...args) { return this.astLowerer.extractMemberChain(...args); }
  resolveNamespaceStruct(...args) { return this.astLowerer.resolveNamespaceStruct(...args); }
  coerceType(...args) { return this.astLowerer.coerceType(...args); }
  lowerExpression(...args) { return this.astLowerer.lowerExpression(...args); }
  unwrapType(...args) { return this.astLowerer.unwrapType(...args); }
  boxIntoUnion(...args) { return this.astLowerer.boxIntoUnion(...args); }
  unboxUnion(...args) { return this.astLowerer.unboxUnion(...args); }
  isPolymorphicInterface(...args) { return this.astLowerer.isPolymorphicInterface(...args); }
  boxIntoInterface(...args) { return this.astLowerer.boxIntoInterface(...args); }

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


  lowerNewExpression(expr, canStackAllocate = false) {
    let className = expr.callee.name;
    if (!className && expr.callee.type === "MemberExpression") {
      const chain = this.extractMemberChain(expr.callee);
      if (chain) className = chain.join("_");
    }

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

    if (!this.structRegistry.has(className) && this.currentFunctionNode?._namespacePrefix) {
      const resolved = this.resolveNamespaceStruct(this.currentFunctionNode._namespacePrefix, className);
      if (resolved) className = resolved;
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
        if (paramMeta?.structName && this.isPolymorphicInterface(paramMeta.structName) && !val.isInterface) {
          val = this.boxIntoInterface(val, paramMeta.structName);
        } else if (paramMeta && !val.isFunction) {
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
      origPtr: slot.ptr,
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
    if (!objExpr || !objExpr.properties) {
      return hintStructName || null;
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

      if (fieldMeta.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>" || val.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>") {
        // Struct alanı fat pointer taşıyor - doğrudan sakla
      } else if (fieldMeta.isFunction && (val.isFunction || val.type !== "!llvm.ptr")) {
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

  instantiateArray(arrExpr, targetElemType = null, isTargetString = false, targetStructName = null) {
    const len = arrExpr.elements.length;
    const loweredElements = arrExpr.elements.map((elem) => this.lowerExpression(elem));

    let elemType = targetElemType;
    let isStringElem = isTargetString;
    let structNameElem = targetStructName;
    const isPolyIface = this.isPolymorphicInterface(targetStructName);
    if (isPolyIface) {
      elemType = "!llvm.struct<(!llvm.ptr, !llvm.ptr)>";
    }

    if (!elemType && loweredElements.length > 0) {
      const first = loweredElements[0];
      if (first.isString) {
        elemType = "!llvm.ptr";
        isStringElem = true;
      } else if (first.structName) {
        elemType = "!llvm.ptr";
        structNameElem = first.structName;
      } else if (first.type === "!llvm.ptr") {
        elemType = "!llvm.ptr";
      } else if (first.type === "i32") {
        elemType = "i32";
      } else if (first.type === "i64") {
        elemType = "i64";
      } else if (first.type === "i1") {
        elemType = "i1";
      } else {
        elemType = "f64";
      }
    }
    if (!elemType) elemType = "f64";

    const isI32 = elemType === "i32";
    const isFatPtr = elemType === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>";
    const byteSize = isI32 ? Math.max(8 + len * 4, 16) : isFatPtr ? Math.max((len + 1) * 16, 16) : Math.max((len + 1) * 8, 16);
    const heapSlot = this.builder.allocateHeap(byteSize);

    const lenConst = this.builder.nextSSA();
    this.builder.emit(`${lenConst} = llvm.mlir.constant(${len} : i64) : i64`);
    this.builder.emit(`llvm.store ${lenConst}, ${heapSlot.ptr} : i64, !llvm.ptr`);

    loweredElements.forEach((val, index) => {
      let finalVal = val;
      if (isPolyIface && !finalVal.isInterface) {
        finalVal = this.boxIntoInterface(finalVal, targetStructName);
      } else if (isStringElem) {
        finalVal = this.coerceType(finalVal, "!llvm.ptr");
      } else {
        finalVal = this.coerceType(finalVal, elemType);
      }

      const idxConst = this.builder.nextSSA();
      const elemPtr = this.builder.nextSSA();

      if (isI32) {
        this.builder.emit(`${idxConst} = llvm.mlir.constant(${index + 2} : i64) : i64`);
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, i32`
        );
      } else {
        this.builder.emit(`${idxConst} = llvm.mlir.constant(${index + 1} : i64) : i64`);
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`
        );
      }
      this.builder.store(elemPtr, finalVal);
    });

    return {
      ssa: heapSlot.ptr,
      ptr: heapSlot.ptr,
      type: "!llvm.ptr",
      length: len,
      arrayLen: len,
      elemType,
      isString: isStringElem,
      structName: structNameElem,
      isInterface: false,
      isHeap: true,
      isArray: true,
      isRef: true,
    };
  }

  packRestArguments(restArgs, restParam) {
    if (restArgs.length === 1 && restArgs[0].type === "SpreadElement") {
      return this.lowerExpression(restArgs[0].argument);
    }

    const len = restArgs.length;
    const isString = restParam ? (restParam.isString || restParam.isArray) : true;
    const isI32 = restParam?.elemType === "i32";
    const byteSize = isI32 ? Math.max(8 + len * 4, 16) : Math.max((len + 1) * 8, 16);
    const heapSlot = this.builder.allocateHeap(byteSize);

    const lenConst = this.builder.nextSSA();
    this.builder.emit(`${lenConst} = llvm.mlir.constant(${len} : i64) : i64`);
    this.builder.emit(`llvm.store ${lenConst}, ${heapSlot.ptr} : i64, !llvm.ptr`);

    restArgs.forEach((argNode, index) => {
      let val = this.lowerExpression(argNode);
      if (isString && !val.isString) {
        val = this.builder.convertToString(val);
      } else if (isI32) {
        val = this.coerceType(val, "i32");
      } else if (isString) {
        val = this.coerceType(val, "!llvm.ptr");
      } else {
        val = this.coerceType(val, restParam?.elemType || "f64");
      }

      const idxConst = this.builder.nextSSA();
      const elemPtr = this.builder.nextSSA();

      if (isI32) {
        const i32Off = index + 2;
        this.builder.emit(`${idxConst} = llvm.mlir.constant(${i32Off} : i64) : i64`);
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, i32`);
        this.builder.emit(`llvm.store ${val.ssa}, ${elemPtr} : i32, !llvm.ptr`);
      } else {
        const off = index + 1;
        this.builder.emit(`${idxConst} = llvm.mlir.constant(${off} : i64) : i64`);
        const elemType = isString ? "!llvm.ptr" : restParam?.elemType || "f64";
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`);
        this.builder.emit(`llvm.store ${val.ssa || val.ptr}, ${elemPtr} : ${elemType}, !llvm.ptr`);
      }
    });

    return {
      ssa: heapSlot.ptr,
      ptr: heapSlot.ptr,
      type: "!llvm.ptr",
      isArray: true,
      elemType: restParam?.elemType || (isString ? "!llvm.ptr" : "f64"),
      isString,
      isRef: true,
      isHeap: true,
    };
  }

  lowerCallArguments(paramsMeta, exprArguments) {
    if (!paramsMeta || paramsMeta.length === 0) {
      return exprArguments ? exprArguments.map((a) => this.lowerExpression(a)) : [];
    }

    const hasRest = paramsMeta.some((p) => p.isRest);
    const actualArgs = exprArguments || [];

    if (!hasRest) {
      return actualArgs.map((a, i) => {
        const isBorrowCall = a.type === "CallExpression" && a.callee?.name === "borrow";
        const actualArgNode = isBorrowCall ? a.arguments[0] : a;
        let val = this.lowerExpression(actualArgNode);
        if (isBorrowCall) val.isBorrowed = true;

        const paramMeta = paramsMeta[i];
        if (paramMeta?.isUnion && !val.isUnion) {
          const uSlot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
          this.boxIntoUnion(uSlot.ptr, val);
          return { ssa: uSlot.ptr, ptr: uSlot.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (val.isUnion) {
          return { ssa: val.ssa || val.ptr, ptr: val.ssa || val.ptr, type: "!llvm.ptr", isUnion: true };
        }
        if (paramMeta?.structName && this.isPolymorphicInterface(paramMeta.structName) && !val.isInterface) {
          val = this.boxIntoInterface(val, paramMeta.structName);
        } else if (paramMeta && !val.isFunction) {
          val = this.coerceType(val, paramMeta.type);
        }
        return val;
      });
    }

    const restIdx = paramsMeta.findIndex((p) => p.isRest);
    const fixedParams = paramsMeta.slice(0, restIdx);
    const restParam = paramsMeta[restIdx];

    const result = [];
    for (let i = 0; i < fixedParams.length; i++) {
      const a = actualArgs[i];
      let val = this.lowerExpression(a);
      const paramMeta = fixedParams[i];
      if (paramMeta?.structName && this.isPolymorphicInterface(paramMeta.structName) && !val.isInterface) {
        val = this.boxIntoInterface(val, paramMeta.structName);
      } else if (paramMeta && !val.isFunction) {
        val = this.coerceType(val, paramMeta.type);
      }
      result.push(val);
    }

    const restArgs = actualArgs.slice(fixedParams.length);
    result.push(this.packRestArguments(restArgs, restParam));
    return result;
  }

}
