// src/ir/lowerers/ExpressionLowerer.js

export class ExpressionLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  get symbolTable() { return this.astLowerer.symbolTable; }
  get globals() { return this.astLowerer.globals; }
  get structRegistry() { return this.astLowerer.structRegistry; }
  get functionRegistry() { return this.astLowerer.functionRegistry; }
  get closureRegistry() { return this.astLowerer.closureRegistry; }
  get enumRegistry() { return this.astLowerer.enumRegistry; }
  get asyncTaskContexts() { return this.astLowerer.asyncTaskContexts; }
  get currentFunctionNode() { return this.astLowerer.currentFunctionNode; }

  resolveType(...args) { return this.astLowerer.resolveType(...args); }
  coerceType(...args) { return this.astLowerer.coerceType(...args); }
  markTransferred(...args) { return this.astLowerer.markTransferred(...args); }
  instantiateArray(...args) { return this.astLowerer.instantiateArray(...args); }
  inferStructName(...args) { return this.astLowerer.inferStructName(...args); }
  instantiateStruct(...args) { return this.astLowerer.instantiateStruct(...args); }
  lowerNewExpression(...args) { return this.astLowerer.lowerNewExpression(...args); }
  resolveNamespaceGlobal(...args) { return this.astLowerer.resolveNamespaceGlobal(...args); }
  extractMemberChain(...args) { return this.astLowerer.extractMemberChain(...args); }
  isPolymorphicInterface(...args) { return this.astLowerer.isPolymorphicInterface(...args); }
  resolveNamespaceFunction(...args) { return this.astLowerer.resolveNamespaceFunction(...args); }
  getOrCreateThunk(...args) { return this.astLowerer.getOrCreateThunk(...args); }
  boxIntoUnion(...args) { return this.astLowerer.boxIntoUnion(...args); }
  boxIntoInterface(...args) { return this.astLowerer.boxIntoInterface(...args); }
  resolveNamespaceStruct(...args) { return this.astLowerer.resolveNamespaceStruct(...args); }
  getDescendantTypeIds(...args) { return this.astLowerer.getDescendantTypeIds(...args); }
  lowerCallExpression(...args) { return this.astLowerer.lowerCallExpression(...args); }

  lowerExpression(expr) {
    if (!expr) return { ssa: "", type: "none" };

    if (
      expr.type === "ParenthesizedExpression" ||
      expr.type === "NonNullExpression" ||
      expr.type === "TSNonNullExpression" ||
      expr.type === "ChainExpression" ||
      expr.type === "TSSatisfiesExpression"
    ) {
      return this.lowerExpression(expr.expression);
    }

    if (expr.type === "SequenceExpression") {
      let last = { ssa: "", type: "none" };
      for (const e of expr.expressions || []) {
        last = this.lowerExpression(e);
      }
      return last;
    }

    if (expr.type === "TSAsExpression" || expr.type === "TSTypeAssertion") {
      const val = this.lowerExpression(expr.expression);
      if (expr.typeAnnotation) {
        const targetType = this.resolveType(expr.typeAnnotation);
        return this.coerceType(val, targetType);
      }
      return val;
    }

    // --- ADIM 7: AWAIT İFADESİ (pthread_join) ---
    if (expr.type === "AwaitExpression") {
      const task = this.lowerExpression(expr.argument);
      const asyncFnName = task.asyncFnName || (expr.argument.type === "CallExpression" ? expr.argument.callee?.name : null);
      const ctxMeta = (asyncFnName ? this.asyncTaskContexts.get(asyncFnName) : null) || task.taskContextMeta;

      const taskContextType = ctxMeta?.type || "!llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>";
      const retIdx = ctxMeta ? ctxMeta.retIdx : (task.innerRetType === "!llvm.ptr" || task.isString ? 4 : 3);
      const innerRetType = ctxMeta?.innerRetType || task.innerRetType || "f64";
      const isRetString = ctxMeta ? ctxMeta.isRetString : (task.isString || task.innerRetType === "!llvm.ptr" || task.innerRetType === "string");
      const structName = ctxMeta ? ctxMeta.structRetName : task.structName;

      const threadIdPtr = this.builder.nextSSA();
      this.builder.emit(`${threadIdPtr} = llvm.getelementptr ${task.ssa || task.ptr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
      const threadId = this.builder.load(threadIdPtr, "i64");

      const nullPtr = this.builder.nextSSA();
      this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);

      const joinRes = this.builder.nextSSA();
      this.builder.emit(`${joinRes} = llvm.call @pthread_join(${threadId.ssa}, ${nullPtr}) : (i64, !llvm.ptr) -> i32`);

      if (innerRetType === "none" || retIdx < 0) {
        this.builder.emit(`llvm.call @free(${task.ssa || task.ptr}) : (!llvm.ptr) -> ()`);
        return { ssa: "", type: "none" };
      }

      const resGEP = this.builder.nextSSA();
      this.builder.emit(`${resGEP} = llvm.getelementptr ${task.ssa || task.ptr}[0, ${retIdx}] : (!llvm.ptr) -> !llvm.ptr, ${taskContextType}`);
      const loaded = this.builder.load(resGEP, innerRetType);

      // Görev tamamlandıktan ve sonuç okunduktan sonra TaskContext serbest bırakılır (zero-leak)
      this.builder.emit(`llvm.call @free(${task.ssa || task.ptr}) : (!llvm.ptr) -> ()`);

      return {
        ssa: loaded.ssa,
        ptr: loaded.ssa,
        type: innerRetType,
        isString: Boolean(isRetString),
        structName: structName || null,
      };
    }

    if (expr.type === "ClosureExpression") {
      const lambdaName = expr.lambdaName;
      const captures = expr.captures || [];
      const captureMeta = [];
      const captureValues = [];

      for (const capName of captures) {
        if (this.symbolTable.has(capName)) {
          const sym = this.symbolTable.get(capName);
          let val;
          if (sym.ptr && sym.ptr !== sym.ssa) {
            val = this.builder.load(sym.ptr, sym.type);
            if (sym.isString) val.isString = true;
            if (sym.structName) val.structName = sym.structName;
            if (sym.isArray) {
              val.isArray = true;
              val.elemType = sym.elemType;
            }
          } else {
            val = {
              ssa: sym.ssa || sym.ptr,
              ptr: sym.ssa || sym.ptr,
              type: sym.type,
              isString: sym.isString,
              structName: sym.structName,
            };
          }
          captureMeta.push({
            name: capName,
            type: sym.type,
            isString: Boolean(sym.isString),
            structName: sym.structName || null,
            isArray: Boolean(sym.isArray),
            elemType: sym.elemType || "f64",
            isClosure: Boolean(sym.isClosure),
            isFunction: Boolean(sym.isFunction),
            fnSig: sym.fnSig || null,
          });
          captureValues.push(val);
        }
      }

      if (!this.closureRegistry) {
        this.closureRegistry = new Map();
      }
      this.closureRegistry.set(lambdaName, { captureMeta });

      let envPtr;
      if (captures.length > 0) {
        this.builder.markFeature("heap");
        const envTypes = captureMeta.map((c) => c.type);
        const envStructType = `!llvm.struct<(${envTypes.join(", ")})>`;
        const byteSize = Math.max(captureMeta.length * 8, 8);
        const envAlloc = this.builder.allocateHeap(byteSize);
        envPtr = envAlloc.ptr;
        this.markTransferred(envPtr);

        for (let i = 0; i < captureValues.length; i++) {
          const val = captureValues[i];
          const gep = this.builder.nextSSA();
          this.builder.emit(
            `${gep} = llvm.getelementptr ${envPtr}[0, ${i}] : (!llvm.ptr) -> !llvm.ptr, ${envStructType}`
          );
          this.builder.store(gep, val);
        }
      } else {
        envPtr = this.builder.nextSSA();
        this.builder.emit(`${envPtr} = llvm.mlir.zero : !llvm.ptr`);
      }

      const fnMeta = this.functionRegistry.get(lambdaName);
      const paramTypes = fnMeta?.paramTypes ? fnMeta.paramTypes.slice(1) : (expr.params || []).map((p) => this.resolveType(p.typeAnnotation));
      const retType = fnMeta?.retType || (expr.returnType ? this.resolveType(expr.returnType) : "f64");
      const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;

      const fnConst = this.builder.nextSSA();
      this.builder.emit(`${fnConst} = func.constant @${lambdaName} : ${callableType}`);
      const fnPtr = this.builder.nextSSA();
      this.builder.emit(`${fnPtr} = builtin.unrealized_conversion_cast ${fnConst} : ${callableType} to !llvm.ptr`);

      const fat0 = this.builder.nextSSA();
      this.builder.emit(`${fat0} = llvm.mlir.undef : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
      const fat1 = this.builder.nextSSA();
      this.builder.emit(`${fat1} = llvm.insertvalue ${fnPtr}, ${fat0}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
      const fat2 = this.builder.nextSSA();
      this.builder.emit(`${fat2} = llvm.insertvalue ${envPtr}, ${fat1}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);

      return {
        ssa: fat2,
        ptr: fat2,
        type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
        isClosure: true,
        isFunction: true,
        envPtr,
        fnSig: {
          paramTypes,
          retType,
          mlirType: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
          callableType,
        },
      };
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
        isString: arrMeta.isString,
        structName: arrMeta.structName,
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

    if (expr.type === "SpreadElement") {
      return this.lowerExpression(expr.argument);
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
      if (val.isVector || (val.type && val.type.startsWith("vector<"))) {
        this.builder.markFeature("vector");
        const ssa = this.builder.nextSSA();
        const isFloat = val.type.includes("f32") || val.type.includes("f64");
        if (isFloat) {
          this.builder.emit(`${ssa} = arith.negf ${val.ssa || val.ptr} : ${val.type}`);
        } else {
          const zero = this.builder.nextSSA();
          this.builder.emit(`${zero} = arith.constant dense<0> : ${val.type}`);
          this.builder.emit(`${ssa} = arith.subi ${zero}, ${val.ssa || val.ptr} : ${val.type}`);
        }
        return { ssa, type: val.type, isVector: true };
      }
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

    if (expr.type === "UnaryExpression" && expr.operator === "void") {
      this.lowerExpression(expr.argument);
      const nullPtr = this.builder.nextSSA();
      this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
      return { ssa: nullPtr, ptr: nullPtr, type: "!llvm.ptr" };
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
        } else if (this.globals) {
          let globalName = expr.argument.name;
          if (!this.globals.has(globalName) && this.currentFunctionNode?._namespacePrefix) {
            const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, expr.argument.name);
            if (resolved) globalName = resolved;
          }
          if (this.globals.has(globalName)) {
            const g = this.globals.get(globalName);
            const addr = this.builder.nextSSA();
            this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
            ptr = addr;
            type = g.type;
          }
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
        if (!expr.argument.computed) {
          const chain = this.extractMemberChain(expr.argument);
          if (chain && chain.length >= 2) {
            let globalKey = chain.join("_");
            if (this.globals && !this.globals.has(globalKey) && this.currentFunctionNode?._namespacePrefix) {
              const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, globalKey);
              if (resolved) globalKey = resolved;
            }
            if (this.globals && this.globals.has(globalKey)) {
              const g = this.globals.get(globalKey);
              const addr = this.builder.nextSSA();
              this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
              const oldVal = this.builder.load(addr, g.type);
              const step = g.type === "i64" || g.type === "i32" ? 1 : 1.0;
              const one = this.builder.createConstant(step, g.type);
              const newVal = this.builder.createArithmetic(op, oldVal, one);
              this.builder.store(addr, newVal);
              return expr.prefix ? newVal : oldVal;
            }
          }
        }

        const base = this.lowerExpression(expr.argument.object);
        if (expr.argument.computed) {
          let idxVal = this.lowerExpression(expr.argument.property);
          idxVal = this.coerceType(idxVal, "i64");

          const elemType = base.elemType || "f64";
          const isI32 = elemType === "i32";
          const idxOffset = isI32 ? 2 : 1;
          const offsetConst = this.builder.createConstant(idxOffset, "i64");
          const realIdx = this.builder.createArithmetic("+", idxVal, offsetConst);

          const elemPtr = this.builder.nextSSA();
          this.builder.emit(
            `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`
          );
          const oldVal = this.builder.load(elemPtr, elemType);
          const step = elemType === "i64" || elemType === "i32" ? 1 : 1.0;
          const one = this.builder.createConstant(step, elemType);
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

        if (!sym.isArray && (sym.isInterface || this.isPolymorphicInterface(sym.structName))) {
          if (sym.isSlot) {
            const loaded = this.builder.load(sym.ptr, "!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
            return {
              ssa: loaded.ssa,
              ptr: sym.ptr,
              type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
              structName: sym.structName,
              isInterface: true,
              isSlot: true,
            };
          }
          return {
            ssa: sym.ssa || sym.ptr,
            ptr: sym.ptr || sym.ssa,
            type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
            structName: sym.structName,
            isInterface: true,
          };
        }
        if (sym.isFunction || sym.isClosure || sym.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>") {
          if (sym.ptr && sym.ptr !== sym.ssa) {
            const loaded = this.builder.load(sym.ptr, "!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
            return {
              ssa: loaded.ssa,
              ptr: sym.ptr,
              type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
              isClosure: true,
              isFunction: true,
              fnSig: sym.fnSig,
            };
          }
          return {
            ssa: sym.ssa,
            ptr: sym.ptr || sym.ssa,
            type: sym.type || "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
            isClosure: true,
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
              origPtr: sym.origPtr,
              type: "!llvm.ptr",
              structName: sym.structName,
              isArray: sym.isArray,
              elemType: sym.elemType || "f64",
              isString: sym.isString || false,
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
            origPtr: sym.origPtr,
            type: "!llvm.ptr",
            structName: sym.structName,
            isArray: sym.isArray,
            elemType: sym.elemType || "f64",
            isString: sym.isString || false,
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
        if (sym.origPtr) loaded.origPtr = sym.origPtr;
        if (sym.isString) loaded.isString = true;
        if (sym.isVector || (sym.type && sym.type.startsWith("vector<"))) loaded.isVector = true;
        return loaded;
      }

      let globalName = expr.name;
      if (this.globals && !this.globals.has(globalName) && this.currentFunctionNode?._namespacePrefix) {
        const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, expr.name);
        if (resolved) globalName = resolved;
      }

      if (this.globals && this.globals.has(globalName)) {
        const g = this.globals.get(globalName);
        const addr = this.builder.nextSSA();
        this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
        const loaded = this.builder.load(addr, g.type);
        if (g.isString) loaded.isString = true;
        if (g.structName) {
          loaded.structName = g.structName;
          loaded.ptr = loaded.ssa;
          if (g.isInterface || this.isPolymorphicInterface(g.structName)) {
            loaded.isInterface = true;
          }
        }
        if (g.isArray) {
          loaded.isArray = true;
          loaded.ptr = loaded.ssa;
          loaded.elemType = g.elemType || "f64";
          loaded.isString = g.isString || false;
        }
        if (g.isMap) loaded.isMap = true;
        if (g.isSet) loaded.isSet = true;
        if (globalName === "process_argc") {
          return this.coerceType(loaded, "f64");
        }
        return loaded;
      }

      let fnRefName = expr.name;
      if (!this.functionRegistry.has(fnRefName) && this.currentFunctionNode?._namespacePrefix) {
        const resolvedFn = this.resolveNamespaceFunction(this.currentFunctionNode._namespacePrefix, expr.name);
        if (resolvedFn) fnRefName = resolvedFn;
      }

      if (this.functionRegistry.has(fnRefName)) {
        const thunk = this.getOrCreateThunk(fnRefName);
        const fnConst = this.builder.nextSSA();
        this.builder.emit(`${fnConst} = func.constant @${thunk.thunkName} : ${thunk.thunkSig}`);
        const fnPtr = this.builder.nextSSA();
        this.builder.emit(`${fnPtr} = builtin.unrealized_conversion_cast ${fnConst} : ${thunk.thunkSig} to !llvm.ptr`);

        const envNull = this.builder.nextSSA();
        this.builder.emit(`${envNull} = llvm.mlir.zero : !llvm.ptr`);

        const fat0 = this.builder.nextSSA();
        this.builder.emit(`${fat0} = llvm.mlir.undef : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
        const fat1 = this.builder.nextSSA();
        this.builder.emit(`${fat1} = llvm.insertvalue ${fnPtr}, ${fat0}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);
        const fat2 = this.builder.nextSSA();
        this.builder.emit(`${fat2} = llvm.insertvalue ${envNull}, ${fat1}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`);

        return {
          ssa: fat2,
          ptr: fat2,
          type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
          isClosure: true,
          isFunction: true,
          fnSig: {
            paramTypes: thunk.paramTypes,
            retType: thunk.retType,
            mlirType: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
            callableType: thunk.thunkSig,
          },
        };
      }

      throw new Error(`[Lowering] Tanımsız değişken veya fonksiyon: ${expr.name}`);
    }

    if (expr.type === "MemberExpression" || expr.type === "OptionalMemberExpression") {
      if (!expr.computed) {
        const chain = this.extractMemberChain(expr);
        if (chain && chain.length >= 2) {
          let globalKey = chain.join("_");
          if (this.globals && !this.globals.has(globalKey) && this.currentFunctionNode?._namespacePrefix) {
            const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, globalKey);
            if (resolved) globalKey = resolved;
          }
          if (this.globals && this.globals.has(globalKey)) {
            const g = this.globals.get(globalKey);
            const isProcessArgc = (globalKey === "process_argc" || globalKey === "Process_argc");
            const isProcessArgv = (globalKey === "process_argv" || globalKey === "Process_argv");
            const gSym = isProcessArgc ? "@g_process_argc" : isProcessArgv ? "@g_process_argv" : g.globalSym;
            const loadType = isProcessArgc ? "i32" : (isProcessArgv ? "!llvm.ptr" : g.type);

            const addr = this.builder.nextSSA();
            this.builder.emit(`${addr} = llvm.mlir.addressof ${gSym} : !llvm.ptr`);
            const loaded = this.builder.load(addr, loadType);
            if (g.isString || isProcessArgv) loaded.isString = true;
            if (g.structName) {
              loaded.structName = g.structName;
              loaded.ptr = loaded.ssa;
              if (g.isInterface || this.isPolymorphicInterface(g.structName)) {
                loaded.isInterface = true;
              }
            }
            if (g.isArray || isProcessArgv) {
              loaded.isArray = true;
              loaded.ptr = loaded.ssa;
              loaded.elemType = isProcessArgv ? "!llvm.ptr" : (g.elemType || "f64");
              loaded.isString = isProcessArgv ? true : (g.isString || false);
            }
            if (isProcessArgc) {
              return this.coerceType(loaded, "f64");
            }
            return loaded;
          }
        }
      }

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

      const isStructWithLength = base.structName && this.structRegistry.get(base.structName)?.fields.some((f) => f.name === "length");
      if (!isStructWithLength && !expr.computed && (expr.property.name || expr.property.value) === "length") {
        if (base.isString && !base.isArray) {
          this.builder.markFeature("strings");
          const ssa = this.builder.nextSSA();
          this.builder.emit(`${ssa} = func.call @rts_strlen(${base.ptr || base.ssa}) : (!llvm.ptr) -> i64`);
          return { ssa, type: "i64" };
        }
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.load ${base.ptr || base.ssa} : !llvm.ptr -> i64`);
        return { ssa, type: "i64" };
      }

      if (base.isVector || (base.type && base.type.startsWith("vector<"))) {
        if (expr.computed) {
          this.builder.markFeature("vector");
          let idxVal = this.lowerExpression(expr.property);
          const idxI32 = this.coerceType(idxVal, "i32");
          const idxSSA = this.builder.nextSSA();
          this.builder.emit(`${idxSSA} = arith.index_cast ${idxI32.ssa} : i32 to index`);
          const m = base.type.match(/^vector<(\d+)x([a-z0-9]+)>$/);
          const elemType = m ? m[2] : "f32";
          const resSSA = this.builder.nextSSA();
          this.builder.emit(`${resSSA} = vector.extract ${base.ssa || base.ptr}[${idxSSA}] : ${elemType} from ${base.type}`);
          return { ssa: resSSA, type: elemType };
        }
      }

      if (expr.computed) {
        let idxVal = this.lowerExpression(expr.property);
        idxVal = this.coerceType(idxVal, "i64");

        if (base.isString && !base.isArray) {
          this.builder.markFeature("strings");
          const charPtr = this.builder.nextSSA();
          this.builder.emit(`${charPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${idxVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i8`);
          const charByte = this.builder.load(charPtr, "i8");
          const buf = this.builder.allocateHeap(2);
          this.builder.store(buf.ptr, charByte);
          const termPtr = this.builder.nextSSA();
          this.builder.emit(`${termPtr} = llvm.getelementptr ${buf.ptr}[1] : (!llvm.ptr) -> !llvm.ptr, i8`);
          const zeroByte = this.builder.createConstant(0, "i8");
          this.builder.store(termPtr, zeroByte);
          return { ssa: buf.ptr, ptr: buf.ptr, type: "!llvm.ptr", isString: true, isHeap: true };
        }

        const elemType = base.elemType || "f64";
        const isI32 = elemType === "i32";
        const offsetConst = this.builder.createConstant(isI32 ? 2 : 1, "i64");
        const realIdx = this.builder.createArithmetic("+", idxVal, offsetConst);

        const elemPtr = this.builder.nextSSA();
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`
        );
        const loaded = this.builder.load(elemPtr, elemType);
        if (elemType === "!llvm.ptr" && base.isString) {
          loaded.isString = true;
        }
        if (base.structName) {
          loaded.structName = base.structName;
          if (this.isPolymorphicInterface(base.structName)) {
            loaded.isInterface = true;
          }
        }
        return loaded;
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
        if (fieldMeta.isArray) {
          res.isArray = true;
          res.elemType = fieldMeta.elemType || "!llvm.ptr";
          res.isString = fieldMeta.isString;
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
        if (!expr.left.computed) {
          const chain = this.extractMemberChain(expr.left);
          if (chain && chain.length >= 2) {
            let globalKey = chain.join("_");
            if (this.globals && !this.globals.has(globalKey) && this.currentFunctionNode?._namespacePrefix) {
              const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, globalKey);
              if (resolved) globalKey = resolved;
            }
            if (this.globals && this.globals.has(globalKey)) {
              const g = this.globals.get(globalKey);
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
              return rhs;
            }
          }
        }

        const base = this.lowerExpression(expr.left.object);

        if (expr.left.computed && (base.isVector || (base.type && base.type.startsWith("vector<")))) {
          this.builder.markFeature("vector");
          let idxVal = this.lowerExpression(expr.left.property);
          const idxI32 = this.coerceType(idxVal, "i32");
          const idxSSA = this.builder.nextSSA();
          this.builder.emit(`${idxSSA} = arith.index_cast ${idxI32.ssa} : i32 to index`);
          const m = base.type.match(/^vector<(\d+)x([a-z0-9]+)>$/);
          const elemType = m ? m[2] : "f32";
          rhs = this.coerceType(rhs, elemType);
          const updatedSSA = this.builder.nextSSA();
          this.builder.emit(`${updatedSSA} = vector.insert ${rhs.ssa || rhs.ptr}, ${base.ssa || base.ptr}[${idxSSA}] : ${elemType} into ${base.type}`);
          const updatedVec = { ssa: updatedSSA, type: base.type, isVector: true };
          if (expr.left.object.type === "Identifier" && this.symbolTable.has(expr.left.object.name)) {
            const sym = this.symbolTable.get(expr.left.object.name);
            this.builder.store(sym.ptr, updatedVec);
          }
          return updatedVec;
        }

        if (expr.left.computed) {
          let idxVal = this.lowerExpression(expr.left.property);
          idxVal = this.coerceType(idxVal, "i64");
          const elemType = base.elemType || "f64";
          const isI32 = elemType === "i32";
          const offsetConst = this.builder.createConstant(isI32 ? 2 : 1, "i64");
          const realIdx = this.builder.createArithmetic("+", idxVal, offsetConst);

          const elemPtr = this.builder.nextSSA();
          this.builder.emit(
            `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`
          );
          if (isCompound) {
            let curVal = this.builder.load(elemPtr, elemType);
            if (base.isString) curVal.isString = true;
            if (op === "+" && (curVal.isString || rhs.isString)) {
              const leftStr = this.builder.convertToString(curVal);
              const rightStr = this.builder.convertToString(rhs);
              rhs = this.builder.createStringConcat(leftStr, rightStr);
            } else if (["|", "&", "^", "<<", ">>", ">>>"].includes(op)) {
              const lInt = this.coerceType(curVal, "i64");
              const rInt = this.coerceType(rhs, "i64");
              rhs = this.builder.createArithmetic(op, lInt, rInt);
              rhs = this.coerceType(rhs, elemType);
            } else {
              rhs = this.builder.createArithmetic(op, curVal, rhs);
              rhs = this.coerceType(rhs, elemType);
            }
          } else {
            if (base.isString) {
              rhs = this.coerceType(rhs, "!llvm.ptr");
            } else {
              rhs = this.coerceType(rhs, elemType);
            }
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
            if (!sym.isArray && (sym.isInterface || this.isPolymorphicInterface(sym.structName))) {
              if (!rhs.isInterface) {
                rhs = this.boxIntoInterface(rhs, sym.structName);
              }
            } else {
              rhs = this.coerceType(rhs, sym.type);
            }
          }
          this.builder.store(sym.ptr, rhs);
          if (rhs.isString) sym.isString = true;
          if (rhs.origPtr || rhs.type === "!llvm.ptr" || rhs.isHeap) {
            sym.origPtr = rhs.origPtr || rhs.ssa || rhs.ptr;
            this.markTransferred(rhs.origPtr || rhs.ssa || rhs.ptr);
          }
          return rhs;
        } else if (this.globals) {
          let globalName = expr.left.name;
          if (!this.globals.has(globalName) && this.currentFunctionNode?._namespacePrefix) {
            const resolved = this.resolveNamespaceGlobal(this.currentFunctionNode._namespacePrefix, expr.left.name);
            if (resolved) globalName = resolved;
          }
          if (this.globals.has(globalName)) {
            const g = this.globals.get(globalName);
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
              if (!g.isArray && (g.isInterface || this.isPolymorphicInterface(g.structName))) {
                if (!rhs.isInterface) {
                  rhs = this.boxIntoInterface(rhs, g.structName);
                }
              } else {
                rhs = this.coerceType(rhs, g.type);
              }
            }
            this.builder.store(addr, rhs);
            if (rhs.isString) g.isString = true;
            if (rhs.type === "!llvm.ptr" || rhs.isHeap) {
              this.markTransferred(rhs.ssa || rhs.ptr);
            }
            return rhs;
          }
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
      if (expr.operator === "instanceof") {
        let targetClassName = null;
        if (expr.right.type === "Identifier") {
          targetClassName = expr.right.name;
        } else if (expr.right.type === "MemberExpression") {
          const chain = this.extractMemberChain(expr.right);
          if (chain) targetClassName = chain.join("_");
        }
        if (targetClassName && !this.structRegistry.has(targetClassName) && this.currentFunctionNode?._namespacePrefix) {
          const resolved = this.resolveNamespaceStruct(this.currentFunctionNode._namespacePrefix, targetClassName);
          if (resolved) targetClassName = resolved;
        }
        const lhs = this.lowerExpression(expr.left);
        if (lhs.type !== "!llvm.ptr" && !lhs.ptr) {
          return this.builder.createConstant(0, "i1");
        }
        const objPtr = lhs.ssa || lhs.ptr;

        const resSlot = this.builder.allocateStack("i1");
        const falseVal = this.builder.createConstant(0, "i1");
        this.builder.store(resSlot.ptr, falseVal);

        const checkBlock = this.builder.nextBlock("inst_check");
        const doneBlock = this.builder.nextBlock("inst_done");

        const nullSSA = this.builder.nextSSA();
        this.builder.emit(`${nullSSA} = llvm.mlir.zero : !llvm.ptr`);
        const notNull = this.builder.nextSSA();
        this.builder.emit(`${notNull} = llvm.icmp "ne" ${objPtr}, ${nullSSA} : !llvm.ptr`);

        this.builder.emitBranchConditional(notNull, checkBlock, doneBlock);

        this.builder.emitBlockLabel(checkBlock);
        this.builder.hasTerminated = false;

        const targetIds = targetClassName ? this.getDescendantTypeIds(targetClassName) : [];
        if (targetIds.length === 0) {
          this.builder.emitBranch(doneBlock);
        } else {
          const typeIdSSA = this.builder.nextSSA();
          this.builder.emit(`${typeIdSSA} = llvm.load ${objPtr} : !llvm.ptr -> i32`);

          let combinedSSA = null;
          for (const tid of targetIds) {
            const tidSSA = this.builder.createConstant(tid, "i32");
            const cmpSSA = this.builder.nextSSA();
            this.builder.emit(`${cmpSSA} = arith.cmpi eq, ${typeIdSSA}, ${tidSSA.ssa} : i32`);
            if (!combinedSSA) {
              combinedSSA = cmpSSA;
            } else {
              const orSSA = this.builder.nextSSA();
              this.builder.emit(`${orSSA} = arith.ori ${combinedSSA}, ${cmpSSA} : i1`);
              combinedSSA = orSSA;
            }
          }
          this.builder.store(resSlot.ptr, { ssa: combinedSSA, type: "i1" });
          this.builder.emitBranch(doneBlock);
        }

        this.builder.emitBlockLabel(doneBlock);
        this.builder.hasTerminated = false;
        return this.builder.load(resSlot.ptr, "i1");
      }

      if (expr.operator === "in") {
        const rhs = this.lowerExpression(expr.right);
        if (rhs.isMap || rhs.isSet) {
          const lhs = this.lowerExpression(expr.left);
          const keyStr = this.builder.convertToString(lhs);
          const ssa = this.builder.nextSSA();
          this.builder.emit(`${ssa} = func.call @rts_map_has_str(${rhs.ptr || rhs.ssa}, ${keyStr.ssa || keyStr.ptr}) : (!llvm.ptr, !llvm.ptr) -> i1`);
          return { ssa, type: "i1" };
        }

        let propName = null;
        if (expr.left.type === "StringLiteral" || (expr.left.type === "Literal" && typeof expr.left.value === "string")) {
          propName = expr.left.value;
        } else if (expr.left.type === "Identifier") {
          propName = expr.left.name;
        }

        const sName = rhs.structName;
        const structMeta = sName ? this.structRegistry.get(sName) : null;
        if (structMeta && propName) {
          let hasMember = false;
          let currMeta = structMeta;
          while (currMeta) {
            if (
              currMeta.fields?.some((f) => f.name === propName) ||
              currMeta.methods?.has(propName) ||
              currMeta.staticFields?.has(propName) ||
              currMeta.staticMethods?.has(propName)
            ) {
              hasMember = true;
              break;
            }
            currMeta = currMeta.superClass ? this.structRegistry.get(currMeta.superClass) : null;
          }
          return this.builder.createConstant(hasMember ? 1 : 0, "i1");
        }

        if (rhs.isInterface && propName) {
          return this.builder.createConstant(1, "i1");
        }

        return this.builder.createConstant(0, "i1");
      }

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

    if (expr.type === "CallExpression" || expr.type === "OptionalCallExpression") {
      return this.lowerCallExpression(expr);
    }

    if (expr.type === "ConditionalExpression") {
      const cond = this.coerceType(this.lowerExpression(expr.test), "i1");
      const trueVal = this.lowerExpression(expr.consequent);
      const falseVal = this.lowerExpression(expr.alternate);

      let targetType = trueVal.type;
      if (trueVal.type !== falseVal.type) {
        if (trueVal.type === "!llvm.ptr" || falseVal.type === "!llvm.ptr") {
          targetType = "!llvm.ptr";
        } else if (trueVal.type === "f64" || falseVal.type === "f64") {
          targetType = "f64";
        }
      }

      const coercedTrue = this.coerceType(trueVal, targetType);
      const coercedFalse = this.coerceType(falseVal, targetType);

      const ssa = this.builder.nextSSA();
      if (targetType === "!llvm.ptr" || (targetType && targetType.startsWith("!llvm."))) {
        this.builder.emit(
          `${ssa} = llvm.select ${cond.ssa}, ${coercedTrue.ssa || coercedTrue.ptr}, ${coercedFalse.ssa || coercedFalse.ptr} : i1, ${targetType}`
        );
      } else {
        this.builder.emit(
          `${ssa} = arith.select ${cond.ssa}, ${coercedTrue.ssa || coercedTrue.ptr}, ${coercedFalse.ssa || coercedFalse.ptr} : ${targetType}`
        );
      }

      return {
        ssa,
        ptr: ssa,
        type: targetType,
        isString: Boolean(trueVal.isString || falseVal.isString),
        structName: trueVal.structName || falseVal.structName || null,
        isArray: Boolean(trueVal.isArray || falseVal.isArray),
        elemType: trueVal.elemType || falseVal.elemType || null,
        isHeap: targetType === "!llvm.ptr",
      };
    }

    throw new Error(`[Lowering] Desteklenmeyen ifade: ${expr.type}`);
  }
}
