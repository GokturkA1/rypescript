// src/ir/lowerers/CallLowerer.js

export class CallLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  get functionRegistry() { return this.astLowerer.functionRegistry; }
  get structRegistry() { return this.astLowerer.structRegistry; }
  get spawnRunners() { return this.astLowerer.spawnRunners; }
  get monomorphizer() { return this.astLowerer.monomorphizer; }
  get symbolTable() { return this.astLowerer.symbolTable; }
  get currentFunctionNode() { return this.astLowerer.currentFunctionNode; }
  get vcallRouters() { return this.astLowerer.vcallRouters; }

  tryLowerSIMDCall(...args) { return this.astLowerer.tryLowerSIMDCall(...args); }
  lowerExpression(...args) { return this.astLowerer.lowerExpression(...args); }
  coerceType(...args) { return this.astLowerer.coerceType(...args); }
  getCurrentFunctionStructRetName(...args) { return this.astLowerer.getCurrentFunctionStructRetName(...args); }
  lowerInterface(...args) { return this.astLowerer.lowerInterface(...args); }
  extractMemberChain(...args) { return this.astLowerer.extractMemberChain(...args); }
  resolveNamespaceStruct(...args) { return this.astLowerer.resolveNamespaceStruct(...args); }
  lowerCallArguments(...args) { return this.astLowerer.lowerCallArguments(...args); }
  resolveNamespaceFunction(...args) { return this.astLowerer.resolveNamespaceFunction(...args); }
  isPolymorphicInterface(...args) { return this.astLowerer.isPolymorphicInterface(...args); }
  resolveType(...args) { return this.astLowerer.resolveType(...args); }
  boxIntoInterface(...args) { return this.astLowerer.boxIntoInterface(...args); }

  lowerCallExpression(expr) {
      const simdRes = this.tryLowerSIMDCall(expr);
      if (simdRes !== null) {
        return simdRes;
      }

      // [COMPILER_BUILTIN_STD_COMMENTED_OUT] Derleyici tarafından otomatik oluşturulan exit(code) ve process.exit(code) desteği yorum satırına alındı.
      // Artık std/process.ts veya FFI declare function exit kullanılmalıdır.
      /*
      // 1. exit(code) ve process.exit(code)
      if (
        (expr.callee.type === "Identifier" && expr.callee.name === "exit" && !this.functionRegistry.has("exit")) ||
        (expr.callee.type === "MemberExpression" && expr.callee.object?.name === "process" && (expr.callee.property?.name === "exit" || expr.callee.property?.value === "exit"))
      ) {
        this.builder.markFeature("exit");
        let codeVal = expr.arguments?.[0] ? this.lowerExpression(expr.arguments[0]) : this.builder.createConstant(0, "i32");
        const codeI32 = this.coerceType(codeVal, "i32");
        this.builder.emit(`llvm.call @exit(${codeI32.ssa}) : (i32) -> ()`);
        return { ssa: "", type: "none" };
      }
      */

      // 2. Ham Bellek İndeksleme ve Pointer Aritmetiği Intrinsics
      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_read_u8") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = expr.arguments?.[1] ? this.lowerExpression(expr.arguments[1]) : this.builder.createConstant(0, "i64");
        offVal = this.coerceType(offVal, "i64");
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i8`);
        const byteVal = this.builder.load(elemPtr, "i8");
        const extVal = this.builder.nextSSA();
        this.builder.emit(`${extVal} = arith.extui ${byteVal.ssa} : i8 to i32`);
        return { ssa: extVal, type: "i32" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_write_u8") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = this.lowerExpression(expr.arguments[1]);
        offVal = this.coerceType(offVal, "i64");
        let byteVal = this.lowerExpression(expr.arguments[2]);
        byteVal = this.coerceType(byteVal, "i32");
        const byteTrunc = this.builder.nextSSA();
        this.builder.emit(`${byteTrunc} = arith.trunci ${byteVal.ssa} : i32 to i8`);
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i8`);
        this.builder.store(elemPtr, { ssa: byteTrunc, type: "i8" });
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_read_i32") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = expr.arguments?.[1] ? this.lowerExpression(expr.arguments[1]) : this.builder.createConstant(0, "i64");
        offVal = this.coerceType(offVal, "i64");
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i32`);
        const res = this.builder.load(elemPtr, "i32");
        return res;
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_write_i32") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = this.lowerExpression(expr.arguments[1]);
        offVal = this.coerceType(offVal, "i64");
        let v = this.lowerExpression(expr.arguments[2]);
        v = this.coerceType(v, "i32");
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i32`);
        this.builder.store(elemPtr, v);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_read_f64") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = expr.arguments?.[1] ? this.lowerExpression(expr.arguments[1]) : this.builder.createConstant(0, "i64");
        offVal = this.coerceType(offVal, "i64");
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`);
        const res = this.builder.load(elemPtr, "f64");
        return res;
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_write_f64") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = this.lowerExpression(expr.arguments[1]);
        offVal = this.coerceType(offVal, "i64");
        let v = this.lowerExpression(expr.arguments[2]);
        v = this.coerceType(v, "f64");
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(`${elemPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`);
        this.builder.store(elemPtr, v);
        return { ssa: "", type: "none" };
      }

      if (expr.callee.type === "Identifier" && expr.callee.name === "ptr_add") {
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        let offVal = this.lowerExpression(expr.arguments[1]);
        offVal = this.coerceType(offVal, "i64");
        const resPtr = this.builder.nextSSA();
        this.builder.emit(`${resPtr} = llvm.getelementptr ${ptrVal.ssa || ptrVal.ptr}[${offVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i8`);
        return { ssa: resPtr, ptr: resPtr, type: "!llvm.ptr", isRef: true };
      }

      // 3. String.fromCharCode(code)
      if (
        expr.callee.type === "MemberExpression" &&
        expr.callee.object?.name === "String" &&
        (expr.callee.property?.name === "fromCharCode" || expr.callee.property?.value === "fromCharCode")
      ) {
        this.builder.markFeature("heap");
        this.builder.markFeature("strings");
        let codeVal = this.lowerExpression(expr.arguments[0]);
        codeVal = this.coerceType(codeVal, "i32");
        const byteTrunc = this.builder.nextSSA();
        this.builder.emit(`${byteTrunc} = arith.trunci ${codeVal.ssa} : i32 to i8`);
        const slot = this.builder.allocateHeap(2);
        this.builder.store(slot.ptr, { ssa: byteTrunc, type: "i8" });
        const termPtr = this.builder.nextSSA();
        this.builder.emit(`${termPtr} = llvm.getelementptr ${slot.ptr}[1] : (!llvm.ptr) -> !llvm.ptr, i8`);
        const zeroByte = this.builder.createConstant(0, "i8");
        this.builder.store(termPtr, zeroByte);
        return { ssa: slot.ptr, ptr: slot.ptr, type: "!llvm.ptr", isString: true, isHeap: true };
      }

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

      if (
        expr.callee.type === "Identifier" &&
        expr.callee.name === "join" &&
        expr.arguments?.length === 1
      ) {
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

        let structMeta = this.structRegistry.get(sName);
        if (!structMeta && this.monomorphizer) {
          const valKeyword = val.isString ? { type: "TSStringKeyword" } : (val.type === "i1" ? { type: "TSBooleanKeyword" } : { type: "TSNumberKeyword" });
          const spec = this.monomorphizer.instantiateGenericStruct("Result", [
            valKeyword,
            { type: "TSStringKeyword" },
          ]);
          if (spec?.node) {
            this.lowerInterface(spec.node);
            structMeta = this.structRegistry.get(spec.specializedName);
            sName = spec.specializedName;
          }
        }
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

        let structMeta = this.structRegistry.get(sName);
        if (!structMeta && this.monomorphizer) {
          const spec = this.monomorphizer.instantiateGenericStruct("Result", [
            { type: "TSNumberKeyword" },
            { type: "TSStringKeyword" },
          ]);
          if (spec?.node) {
            this.lowerInterface(spec.node);
            structMeta = this.structRegistry.get(spec.specializedName);
            sName = spec.specializedName;
          }
        }
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
        const msVal = this.lowerExpression(expr.arguments[0]);
        const msI32 = this.coerceType(msVal, "i32");
        this.builder.emitSleep(msI32);
        return { ssa: "", type: "none" };
      }

      // [COMPILER_BUILTIN_STD_COMMENTED_OUT] Derleyici tarafından otomatik oluşturulan yerleşik console.log implementasyonu.
      // Artık std/ (Console, console veya println) import edilerek kullanılmalıdır.
      /*
      const isConsoleLog =
        expr.callee.type === "MemberExpression" &&
        expr.callee.object?.name === "console" &&
        expr.callee.property?.name === "log";

      if (isConsoleLog) {
        expr.arguments.forEach((argNode, idx) => {
          const arg = this.lowerExpression(argNode);
          if (arg.isUnion) {
            this.builder.printUnion(arg.ssa || arg.ptr);
          } else if (arg.isVector || (arg.type && arg.type.startsWith("vector<"))) {
            this.builder.printVector(arg);
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
      */

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
        const calleeChain = this.extractMemberChain(expr.callee);
        if (calleeChain && calleeChain.length >= 2) {
          // Check static class method: e.g. ["ClassName", "method"] or ["A", "B", "ClassName", "method"]
          for (let i = calleeChain.length - 1; i >= 1; i--) {
            let classCandidate = calleeChain.slice(0, i).join("_");
            const methodCandidate = calleeChain.slice(i).join("_");
            if (!this.structRegistry.has(classCandidate) && this.currentFunctionNode?._namespacePrefix) {
              const resolvedCls = this.resolveNamespaceStruct(this.currentFunctionNode._namespacePrefix, classCandidate);
              if (resolvedCls) classCandidate = resolvedCls;
            }
            if (this.structRegistry.has(classCandidate)) {
              const clsMeta = this.structRegistry.get(classCandidate);
              if (clsMeta && clsMeta.staticMethods && clsMeta.staticMethods.has(methodCandidate)) {
                const sMeta = clsMeta.staticMethods.get(methodCandidate);
                const targetFn = `@${classCandidate}_${methodCandidate}`;
                const args = this.lowerCallArguments(sMeta?.params, expr.arguments);
                const allArgsSSA = args.map((a) => a.ssa || a.ptr).join(", ");
                const allArgsType = (sMeta?.params || []).map((p) => p.type).join(", ");
                const retType = sMeta?.retType || "none";
                if (retType === "none") {
                  this.builder.emit(`func.call ${targetFn}(${allArgsSSA}) : (${allArgsType}) -> ()`);
                  return { ssa: "", ptr: "", type: "none" };
                } else {
                  const ssa = this.builder.nextSSA();
                  this.builder.emit(`${ssa} = func.call ${targetFn}(${allArgsSSA}) : (${allArgsType}) -> ${retType}`);
                  return {
                    ssa,
                    ptr: ssa,
                    type: retType,
                    structName: sMeta?.structRetName,
                    isString: sMeta?.isRetString || false,
                    isHeap: retType === "!llvm.ptr",
                  };
                }
              }
            }
          }

          // Check namespace function: e.g. ["MyNamespace", "foo"] -> "MyNamespace_foo"
          let nsFnCandidate = calleeChain.join("_");
          if (!this.functionRegistry.has(nsFnCandidate) && this.currentFunctionNode?._namespacePrefix) {
            const resolvedFn = this.resolveNamespaceFunction(this.currentFunctionNode._namespacePrefix, nsFnCandidate);
            if (resolvedFn) nsFnCandidate = resolvedFn;
          }
          if (this.functionRegistry.has(nsFnCandidate)) {
            const fnMeta = this.functionRegistry.get(nsFnCandidate);
            const targetFn = `@${fnMeta.exportAlias || nsFnCandidate}`;
            const args = this.lowerCallArguments(fnMeta?.params, expr.arguments);
            const allArgsSSA = args.map((a) => a.ssa || a.ptr).join(", ");
            const allArgsType = (fnMeta?.paramTypes || []).join(", ");
            const retType = fnMeta?.retType || "none";
            if (retType === "none") {
              this.builder.emit(`func.call ${targetFn}(${allArgsSSA}) : (${allArgsType}) -> ()`);
              return { ssa: "", ptr: "", type: "none" };
            } else {
              const ssa = this.builder.nextSSA();
              this.builder.emit(`${ssa} = func.call ${targetFn}(${allArgsSSA}) : (${allArgsType}) -> ${retType}`);
              return {
                ssa,
                ptr: ssa,
                type: retType,
                structName: fnMeta?.structRetName,
                isString: fnMeta?.isRetString || false,
                isHeap: retType === "!llvm.ptr",
              };
            }
          }
        }

        const base = this.lowerExpression(expr.callee.object);
        const methodName = expr.callee.property.name || expr.callee.property.value;

        if (base.isString && !base.isArray) {
          if (methodName === "slice" || methodName === "substring") {
            this.builder.markFeature("strings");
            let startVal = expr.arguments?.[0] ? this.lowerExpression(expr.arguments[0]) : this.builder.createConstant(0, "i64");
            startVal = this.coerceType(startVal, "i64");
            let endVal;
            if (expr.arguments && expr.arguments.length > 1) {
              endVal = this.lowerExpression(expr.arguments[1]);
              endVal = this.coerceType(endVal, "i64");
            } else {
              endVal = this.builder.createConstant(-1, "i64");
            }
            const ssa = this.builder.nextSSA();
            this.builder.emit(
              `${ssa} = func.call @rts_str_slice(${base.ptr || base.ssa}, ${startVal.ssa}, ${endVal.ssa}) : (!llvm.ptr, i64, i64) -> !llvm.ptr`
            );
            return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
          } else if (methodName === "charCodeAt") {
            let idxVal = expr.arguments?.[0] ? this.lowerExpression(expr.arguments[0]) : this.builder.createConstant(0, "i64");
            idxVal = this.coerceType(idxVal, "i64");
            const charPtr = this.builder.nextSSA();
            this.builder.emit(`${charPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${idxVal.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, i8`);
            const charByte = this.builder.load(charPtr, "i8");
            const extSsa = this.builder.nextSSA();
            this.builder.emit(`${extSsa} = arith.extui ${charByte.ssa} : i8 to i32`);
            return { ssa: extSsa, type: "i32" };
          }
        }

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

        if (base.isInterface || (base.structName && this.isPolymorphicInterface(base.structName))) {
          const ifaceName = base.structName;
          const ifaceMeta = this.structRegistry.get(ifaceName);
          if (!ifaceMeta) {
            throw new Error(`[Itable] Arayüz bulunamadı: '${ifaceName}'`);
          }

          const methodIdx = ifaceMeta.methodsList ? ifaceMeta.methodsList.findIndex((m) => m.name === methodName) : -1;
          if (methodIdx === -1) {
            throw new Error(`[Itable] '${ifaceName}' arayüzünde '${methodName}' metodu bulunamadı!`);
          }
          const methodMeta = ifaceMeta.methodsList[methodIdx];

          // 1. Extract instancePtr and itablePtr
          let fatVal = base;
          if (!base.ssa && base.ptr) {
            fatVal = this.builder.load(base.ptr, "!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
          }

          const instancePtr = this.builder.nextSSA();
          this.builder.emit(
            `${instancePtr} = llvm.extractvalue ${fatVal.ssa || fatVal.ptr}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );
          const itablePtr = this.builder.nextSSA();
          this.builder.emit(
            `${itablePtr} = llvm.extractvalue ${fatVal.ssa || fatVal.ptr}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );

          // 2. Load function pointer from itable
          const methodPtrAddr = this.builder.nextSSA();
          this.builder.emit(
            `${methodPtrAddr} = llvm.getelementptr ${itablePtr}[${methodIdx}] : (!llvm.ptr) -> !llvm.ptr, !llvm.ptr`
          );
          const methodFnPtr = this.builder.load(methodPtrAddr, "!llvm.ptr");

          // 3. Prepare parameters and arguments
          const rawParamTypes = methodMeta.params || [];
          const paramTypes = rawParamTypes.map((p) => (typeof p === "string" ? p : this.resolveType(p)));
          const retType = methodMeta.retType || "none";

          const args = expr.arguments
            ? expr.arguments.map((a, i) => {
                let val = this.lowerExpression(a);
                const targetPType = paramTypes[i];
                const pMeta = methodMeta.paramsMeta?.[i];
                if (pMeta?.structName && this.isPolymorphicInterface(pMeta.structName) && !val.isInterface) {
                  val = this.boxIntoInterface(val, pMeta.structName);
                } else if (targetPType) {
                  val = this.coerceType(val, targetPType);
                } else if (val.type === "i64" || val.type === "i32") {
                  val = this.coerceType(val, "f64");
                }
                return val;
              })
            : [];

          const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;
          const callableSSA = this.builder.nextSSA();
          this.builder.emit(
            `${callableSSA} = builtin.unrealized_conversion_cast ${methodFnPtr.ssa} : !llvm.ptr to ${callableType}`
          );

          const allArgsSSA = [instancePtr, ...args.map((a) => a.ssa || a.ptr)].join(", ");
          if (retType === "none") {
            this.builder.emit(`func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return {
              ssa,
              ptr: ssa,
              type: retType,
              structName: methodMeta.structRetName,
              isString: methodMeta.isRetString || false,
              isHeap: retType === "!llvm.ptr",
            };
          }
        }

        if (base.structName) {
          const structMeta = this.structRegistry.get(base.structName);
          const fieldMeta = structMeta?.fields.find((f) => f.name === methodName);

          if (fieldMeta && fieldMeta.isFunction) {
            const fnSig = fieldMeta.fnSig || {};
            const fieldPtr = this.builder.nextSSA();
            this.builder.emit(
              `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
            );
            const fatVal = this.builder.load(fieldPtr, "!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
            const fnPtr = this.builder.nextSSA();
            this.builder.emit(
              `${fnPtr} = llvm.extractvalue ${fatVal.ssa}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
            );
            const envPtr = this.builder.nextSSA();
            this.builder.emit(
              `${envPtr} = llvm.extractvalue ${fatVal.ssa}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
            );

            let paramTypes = fnSig.paramTypes;
            const retType = fnSig.retType || "none";

            const args = expr.arguments ? expr.arguments.map((a, i) => {
              let val = this.lowerExpression(a);
              const targetPType = paramTypes ? paramTypes[i] : null;
              if (targetPType) {
                val = this.coerceType(val, targetPType);
              } else if (val.type === "i64" || val.type === "i32") {
                val = this.coerceType(val, "f64");
              }
              return val;
            }) : [];

            if (!paramTypes || paramTypes.length !== args.length) {
              paramTypes = args.map((a) => a.type);
            }

            const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;
            const callableSSA = this.builder.nextSSA();
            this.builder.emit(
              `${callableSSA} = builtin.unrealized_conversion_cast ${fnPtr} : !llvm.ptr to ${callableType}`
            );

            const allArgsSSA = [envPtr, ...args.map((a) => a.ssa || a.ptr)].join(", ");
            if (retType === "none") {
              this.builder.emit(`func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
              return { ssa: "", ptr: "", type: "none" };
            } else {
              const ssa = this.builder.nextSSA();
              this.builder.emit(`${ssa} = func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
              return { ssa, ptr: ssa, type: retType };
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

          const args = this.lowerCallArguments(methodMeta?.params, expr.arguments);

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
        if (localSym && !localSym.isInterface && (localSym.isFunction || localSym.isClosure || localSym.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>")) {
          const fnSig = localSym.fnSig || {};
          let fatVal;
          if (localSym.ptr && localSym.ptr !== localSym.ssa) {
            fatVal = this.builder.load(localSym.ptr, "!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
          } else {
            fatVal = { ssa: localSym.ssa || localSym.ptr };
          }

          const fnPtr = this.builder.nextSSA();
          this.builder.emit(
            `${fnPtr} = llvm.extractvalue ${fatVal.ssa}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );
          const envPtr = this.builder.nextSSA();
          this.builder.emit(
            `${envPtr} = llvm.extractvalue ${fatVal.ssa}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );

          let paramTypes = fnSig.paramTypes;
          const retType = fnSig.retType || "f64";

          const args = expr.arguments ? expr.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const targetPType = paramTypes ? paramTypes[i] : null;
            if (targetPType) {
              val = this.coerceType(val, targetPType);
            } else if (val.type === "i64" || val.type === "i32") {
              val = this.coerceType(val, "f64");
            }
            return val;
          }) : [];

          if (!paramTypes || paramTypes.length !== args.length) {
            paramTypes = args.map((a) => a.type);
          }

          const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;

          const callableSSA = this.builder.nextSSA();
          this.builder.emit(
            `${callableSSA} = builtin.unrealized_conversion_cast ${fnPtr} : !llvm.ptr to ${callableType}`
          );

          const allArgsSSA = [envPtr, ...args.map((a) => a.ssa || a.ptr)].join(", ");
          if (retType === "none") {
            this.builder.emit(`func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return { ssa, ptr: ssa, type: retType };
          }
        }
      }

      let resolvedFuncName = expr.callee.name;
      if (expr.callee.type === "Identifier" && !this.functionRegistry.has(resolvedFuncName) && this.currentFunctionNode?._namespacePrefix) {
        const nsFn = this.resolveNamespaceFunction(this.currentFunctionNode._namespacePrefix, expr.callee.name);
        if (nsFn) resolvedFuncName = nsFn;
      }

      if (expr.callee.type !== "Identifier" || !this.functionRegistry.has(resolvedFuncName)) {
        let calleeVal = this.lowerExpression(expr.callee);
        if (
          calleeVal &&
          !calleeVal.isInterface &&
          (calleeVal.isClosure ||
            calleeVal.isFunction ||
            calleeVal.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>")
        ) {
          const fnSig = calleeVal.fnSig || {};
          const fnPtr = this.builder.nextSSA();
          this.builder.emit(
            `${fnPtr} = llvm.extractvalue ${calleeVal.ssa || calleeVal.ptr}[0] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );
          const envPtr = this.builder.nextSSA();
          this.builder.emit(
            `${envPtr} = llvm.extractvalue ${calleeVal.ssa || calleeVal.ptr}[1] : !llvm.struct<(!llvm.ptr, !llvm.ptr)>`
          );

          let paramTypes = fnSig.paramTypes;
          const retType = fnSig.retType || "f64";

          const args = expr.arguments
            ? expr.arguments.map((a, i) => {
                let val = this.lowerExpression(a);
                const targetPType = paramTypes ? paramTypes[i] : null;
                if (targetPType) {
                  val = this.coerceType(val, targetPType);
                } else if (val.type === "i64" || val.type === "i32") {
                  val = this.coerceType(val, "f64");
                }
                return val;
              })
            : [];

          if (!paramTypes || paramTypes.length !== args.length) {
            paramTypes = args.map((a) => a.type);
          }

          const callableType = `(!llvm.ptr${paramTypes.length ? ", " + paramTypes.join(", ") : ""}) -> ${retType === "none" ? "()" : retType}`;

          const callableSSA = this.builder.nextSSA();
          this.builder.emit(
            `${callableSSA} = builtin.unrealized_conversion_cast ${fnPtr} : !llvm.ptr to ${callableType}`
          );

          const allArgsSSA = [envPtr, ...args.map((a) => a.ssa || a.ptr)].join(", ");
          if (retType === "none") {
            this.builder.emit(`func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call_indirect ${callableSSA}(${allArgsSSA}) : ${callableType}`);
            return { ssa, ptr: ssa, type: retType };
          }
        }
      }

      const funcName = resolvedFuncName;
      const fnMeta = this.functionRegistry.get(funcName);

      const args = this.lowerCallArguments(fnMeta?.params, expr.arguments);

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
          isFunction: Boolean(fnMeta?.isRetFn),
          isClosure: Boolean(fnMeta?.isRetFn),
          fnSig: fnMeta?.retFnSig || null,
          isPromise: Boolean(fnMeta?.isAsync),
          asyncFnName: fnMeta?.isAsync ? funcName : null,
          taskContextMeta: fnMeta?.taskContextMeta || null,
          innerRetType: fnMeta?.innerRetType || "f64",
          structName: fnMeta?.structRetName || null,
          isString: fnMeta?.isRetString || false,
          isHeap: retType === "!llvm.ptr",
        };
      }
  }
}
