// src/ir/MLIRBuilder.js
import { RuntimeEmitters } from "../runtime/RuntimeEmitters.js";
import { TargetManager } from "../engine/TargetManager.js";

export class MLIRBuilder {
  constructor(targetInfo = null) {
    this.targetInfo = targetInfo;
    this.ssaCount = 0;
    this.strCount = 0;
    this.indent = 2;
    this.buffer = [];
    this.globalStrings = new Map();
    this.onAllocate = null;
    this.hasTerminated = false;

    // İhtiyaç odaklı (On-demand) runtime bayrakları
    this.usedFeatures = {
      printf: false,
      heap: false,
      map: false,
      union: false,
      threads: false,
      channels: false,
      allocators: false,
      napi: false,
      sleep: false,
      exceptions: false,
      strings: false,
      strcmp: false,
    };

    this.externalFunctions = new Map();
    this.globalVars = new Map();

    this.symNumber = this.getOrRegisterString("number");
    this.symString = this.getOrRegisterString("string");
    this.symBoolean = this.getOrRegisterString("boolean");
    this.symObject = this.getOrRegisterString("object");
    this.symTrue = this.getOrRegisterString("true");
    this.symFalse = this.getOrRegisterString("false");
  }

  setTargetInfo(targetInfo) {
    this.targetInfo = targetInfo;
  }

  emitSleep(msI32) {
    this.markFeature("sleep");
    if (this.targetInfo?.isWindows) {
      this.emit(`llvm.call @Sleep(${msI32.ssa}) : (i32) -> ()`);
    } else if (this.targetInfo?.isWasm) {
      // Freestanding WebAssembly: sleep yok, no-op
    } else {
      const c1000 = this.createConstant(1000, "i32");
      const usec = this.createArithmetic("*", msI32, c1000);
      const sleepRes = this.nextSSA();
      this.emit(`${sleepRes} = llvm.call @usleep(${usec.ssa}) : (i32) -> i32`);
    }
  }

  markFeature(feat) {
    this.usedFeatures[feat] = true;
  }

  declareExternalFunction(name, declSig) {
    this.externalFunctions.set(name, declSig);
  }

  registerGlobal(sym, type, initVal = null) {
    this.globalVars.set(sym, { type, initVal });
  }

  nextSSA() {
    return `%v${this.ssaCount++}`;
  }

  emit(line) {
    this.buffer.push(" ".repeat(this.indent) + line);
  }

  block(header, bodyFn) {
    this.emit(`${header} {`);
    this.indent += 2;
    bodyFn();
    this.indent -= 2;
    this.emit("}");
  }

  getOrRegisterString(text) {
    if (this.globalStrings.has(text)) {
      return this.globalStrings.get(text);
    }
    const sym = `@str_${this.strCount++}`;
    this.globalStrings.set(text, sym);
    return sym;
  }

  createConstant(val, type = "f64") {
    const ssa = this.nextSSA();
    let formattedVal = val;
    if (type === "f64" || type === "f32") {
      formattedVal = Number.isInteger(Number(val)) ? `${val}.0` : `${val}`;
    } else if (type === "i1") {
      formattedVal = (val === true || val === 1 || val === "1" || val === "true") ? "1" : "0";
    }
    this.emit(`${ssa} = arith.constant ${formattedVal} : ${type}`);
    return { ssa, type };
  }

  allocateStack(type = "f64") {
    const ptr = this.nextSSA();
    const one = this.createConstant(1, "i32");
    this.emit(`${ptr} = llvm.alloca ${one.ssa} x ${type} : (i32) -> !llvm.ptr`);
    return { ptr, type, isRef: true };
  }

  allocateHeap(byteSize) {
    this.markFeature("heap");
    const ptr = this.nextSSA();
    const szSSA = this.nextSSA();
    this.emit(`${szSSA} = llvm.mlir.constant(${byteSize} : i64) : i64`);
    this.emit(`${ptr} = llvm.call @malloc(${szSSA}) : (i64) -> !llvm.ptr`);
    if (this.onAllocate) {
      this.onAllocate(ptr);
    }
    return { ptr, type: "!llvm.ptr", isRef: true, isHeap: true };
  }

  emitFree(ptr) {
    this.markFeature("heap");
    this.emit(`llvm.call @free(${ptr}) : (!llvm.ptr) -> ()`);
  }

  store(ptr, val) {
    this.emit(`llvm.store ${val.ssa || val.ptr}, ${ptr} : ${val.type}, !llvm.ptr`);
  }

  load(ptr, type) {
    const ssa = this.nextSSA();
    this.emit(`${ssa} = llvm.load ${ptr} : !llvm.ptr -> ${type}`);
    return { ssa, type };
  }

  createArithmetic(op, left, right) {
    let l = left;
    let r = right;

    if ((l.type === "f64" || l.type === "f32") && (r.type === "i64" || r.type === "i32")) {
      const castSSA = this.nextSSA();
      this.emit(`${castSSA} = arith.sitofp ${r.ssa} : ${r.type} to f64`);
      r = { ssa: castSSA, type: "f64" };
    } else if ((r.type === "f64" || r.type === "f32") && (l.type === "i64" || l.type === "i32")) {
      const castSSA = this.nextSSA();
      this.emit(`${castSSA} = arith.sitofp ${l.ssa} : ${l.type} to f64`);
      l = { ssa: castSSA, type: "f64" };
    }

    const ssa = this.nextSSA();
    const isFloat = l.type === "f64" || l.type === "f32";
    const opMap = isFloat
      ? { "+": "arith.addf", "-": "arith.subf", "*": "arith.mulf", "/": "arith.divf", "%": "arith.remf" }
      : {
          "+": "arith.addi",
          "-": "arith.subi",
          "*": "arith.muli",
          "/": "arith.divsi",
          "%": "arith.remsi",
          "|": "arith.ori",
          "&": "arith.andi",
          "^": "arith.xori",
          "<<": "arith.shli",
          ">>": "arith.shrsi",
          ">>>": "arith.shrui",
        };

    if (!opMap[op]) {
      throw new Error(`[MLIRBuilder] Desteklenmeyen aritmetik/bitwise operatör: ${op}`);
    }

    this.emit(`${ssa} = ${opMap[op]} ${l.ssa}, ${r.ssa} : ${l.type}`);
    return { ssa, type: l.type };
  }

  createBitwiseNot(val) {
    const ssa = this.nextSSA();
    const minusOne = this.nextSSA();
    this.emit(`${minusOne} = arith.constant -1 : ${val.type}`);
    this.emit(`${ssa} = arith.xori ${val.ssa}, ${minusOne} : ${val.type}`);
    return { ssa, type: val.type };
  }

  createComparison(op, left, right) {
    let l = left;
    let r = right;

    if (l.isString && r.isString) {
      this.markFeature("strcmp");
      const cmpRes = this.nextSSA();
      this.emit(`${cmpRes} = llvm.call @strcmp(${l.ssa || l.ptr}, ${r.ssa || r.ptr}) : (!llvm.ptr, !llvm.ptr) -> i32`);
      const zero = this.createConstant(0, "i32");
      const ssa = this.nextSSA();
      const predMap = { "<": "slt", "<=": "sle", ">": "sgt", ">=": "sge", "==": "eq", "===": "eq", "!=": "ne", "!==": "ne" };
      const pred = predMap[op] || "eq";
      this.emit(`${ssa} = arith.cmpi ${pred}, ${cmpRes}, ${zero.ssa} : i32`);
      return { ssa, type: "i1" };
    }

    if (l.type === "!llvm.ptr" || r.type === "!llvm.ptr") {
      // Eğer bir taraf pointer, diğer taraf integer 0 (null) ise tamsayıyı null pointer'a dönüştür
      if (l.type === "!llvm.ptr" && r.type !== "!llvm.ptr") {
        const nullPtr = this.nextSSA();
        this.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        r = { ssa: nullPtr, type: "!llvm.ptr" };
      } else if (r.type === "!llvm.ptr" && l.type !== "!llvm.ptr") {
        const nullPtr = this.nextSSA();
        this.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        l = { ssa: nullPtr, type: "!llvm.ptr" };
      }

      const ssa = this.nextSSA();
      const predMap = { "==": "eq", "===": "eq", "!=": "ne", "!==": "ne" };
      const pred = predMap[op] || "eq";
      this.emit(`${ssa} = llvm.icmp "${pred}" ${l.ssa || l.ptr}, ${r.ssa || r.ptr} : !llvm.ptr`);
      return { ssa, type: "i1" };
    }

    if ((l.type === "f64" || l.type === "f32") && (r.type === "i64" || r.type === "i32")) {
      const castSSA = this.nextSSA();
      this.emit(`${castSSA} = arith.sitofp ${r.ssa} : ${r.type} to f64`);
      r = { ssa: castSSA, type: "f64" };
    } else if ((r.type === "f64" || r.type === "f32") && (l.type === "i64" || l.type === "i32")) {
      const castSSA = this.nextSSA();
      this.emit(`${castSSA} = arith.sitofp ${l.ssa} : ${l.type} to f64`);
      l = { ssa: castSSA, type: "f64" };
    }

    const ssa = this.nextSSA();
    const isFloat = l.type === "f64" || l.type === "f32";
    if (isFloat) {
      const predMap = { "<": "olt", "<=": "ole", ">": "ogt", ">=": "oge", "==": "oeq", "===": "oeq", "!=": "one", "!==": "one" };
      this.emit(`${ssa} = arith.cmpf ${predMap[op]}, ${l.ssa}, ${r.ssa} : ${l.type}`);
    } else {
      const predMap = { "<": "slt", "<=": "sle", ">": "sgt", ">=": "sge", "==": "eq", "===": "eq", "!=": "ne", "!==": "ne" };
      this.emit(`${ssa} = arith.cmpi ${predMap[op]}, ${l.ssa}, ${r.ssa} : ${l.type}`);
    }
    return { ssa, type: "i1" };
  }

  createLogical(op, left, right) {
    const ssa = this.nextSSA();
    const mlirOp = op === "&&" ? "arith.andi" : "arith.ori";
    this.emit(`${ssa} = ${mlirOp} ${left.ssa}, ${right.ssa} : i1`);
    return { ssa, type: "i1" };
  }

  createIf(cond, thenFn, elseFn = null) {
    if (elseFn) {
      this.block(`scf.if ${cond.ssa}`, () => { thenFn(); this.emit("scf.yield"); });
      this.block("else", () => { elseFn(); this.emit("scf.yield"); });
    } else {
      this.block(`scf.if ${cond.ssa}`, () => { thenFn(); this.emit("scf.yield"); });
    }
  }

  createWhile(condEvaluator, bodyFn) {
    const condBlock = this.nextBlock("while_cond");
    const bodyBlock = this.nextBlock("while_body");
    const exitBlock = this.nextBlock("while_exit");

    this.emitBranch(condBlock);
    this.emitBlockLabel(condBlock);
    this.hasTerminated = false;
    const cond = condEvaluator();
    this.emitBranchConditional(cond.ssa, bodyBlock, exitBlock);

    this.emitBlockLabel(bodyBlock);
    this.hasTerminated = false;
    bodyFn();
    if (!this.hasTerminated) {
      this.emitBranch(condBlock);
    }

    this.emitBlockLabel(exitBlock);
    this.hasTerminated = false;
  }

  createReturn(val) {
    this.hasTerminated = true;
    if (val && val.type !== "none") this.emit(`func.return ${val.ssa || val.ptr} : ${val.type}`);
    else this.emit("func.return");
  }

  nextBlock(prefix = "bb") {
    return `^${prefix}_${this.ssaCount++}`;
  }

  emitBlockLabel(label) {
    this.buffer.push(`  ${label}:`);
  }

  emitBranch(targetBlock) {
    this.emit(`cf.br ${targetBlock}`);
  }

  emitBranchConditional(condSSA, trueBlock, falseBlock) {
    this.emit(`cf.cond_br ${condSSA}, ${trueBlock}, ${falseBlock}`);
  }

  createStringConcat(left, right) {
    this.markFeature("strings");
    this.markFeature("heap");
    const ssa = this.nextSSA();
    this.emit(
      `${ssa} = func.call @rts_str_concat(${left.ssa || left.ptr}, ${right.ssa || right.ptr}) : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr`
    );
    return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
  }

  convertToString(val) {
    if (val.isString) return val;
    this.markFeature("strings");
    this.markFeature("heap");

    if (val.isNull) {
      const nullStr = this.getOrRegisterString("null");
      const ssa = this.nextSSA();
      this.emit(`${ssa} = llvm.mlir.addressof ${nullStr} : !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
    }

    if (val.isUndefined) {
      const undefStr = this.getOrRegisterString("undefined");
      const ssa = this.nextSSA();
      this.emit(`${ssa} = llvm.mlir.addressof ${undefStr} : !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: false };
    }

    if (val.type === "i64" || val.type === "i32") {
      let intVal = val;
      if (val.type === "i32") {
        const ssa = this.nextSSA();
        this.emit(`${ssa} = arith.extsi ${val.ssa} : i32 to i64`);
        intVal = { ssa, type: "i64" };
      }
      const ssa = this.nextSSA();
      this.emit(`${ssa} = func.call @rts_i64_to_str(${intVal.ssa}) : (i64) -> !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
    }

    if (val.type === "f64" || val.type === "f32") {
      let floatVal = val;
      if (val.type === "f32") {
        const ssa = this.nextSSA();
        this.emit(`${ssa} = arith.extf ${val.ssa} : f32 to f64`);
        floatVal = { ssa, type: "f64" };
      }
      const ssa = this.nextSSA();
      this.emit(`${ssa} = func.call @rts_f64_to_str(${floatVal.ssa}) : (f64) -> !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
    }

    if (val.type === "i1") {
      const sym = this.nextSSA();
      const strT = this.getOrRegisterString("true");
      const strF = this.getOrRegisterString("false");
      const tPtr = this.nextSSA();
      const fPtr = this.nextSSA();
      this.emit(`${tPtr} = llvm.mlir.addressof ${strT} : !llvm.ptr`);
      this.emit(`${fPtr} = llvm.mlir.addressof ${strF} : !llvm.ptr`);
      const slot = this.allocateStack("!llvm.ptr");
      this.createIf(
        val,
        () => this.emit(`llvm.store ${tPtr}, ${slot.ptr} : !llvm.ptr, !llvm.ptr`),
        () => this.emit(`llvm.store ${fPtr}, ${slot.ptr} : !llvm.ptr, !llvm.ptr`)
      );
      return this.load(slot.ptr, "!llvm.ptr");
    }

    if (val.isUnion) {
      this.markFeature("union");
      const ssa = this.nextSSA();
      this.emit(`${ssa} = func.call @rts_union_to_string(${val.ssa || val.ptr}) : (!llvm.ptr) -> !llvm.ptr`);
      return { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
    }

    if (val.type === "!llvm.ptr") {
      const nullPtr = this.nextSSA();
      this.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
      const isNullSSA = this.nextSSA();
      this.emit(`${isNullSSA} = llvm.icmp "eq" ${val.ssa || val.ptr}, ${nullPtr} : !llvm.ptr`);

      const nullStr = this.getOrRegisterString("null");
      const nullStrSSA = this.nextSSA();
      this.emit(`${nullStrSSA} = llvm.mlir.addressof ${nullStr} : !llvm.ptr`);

      const objStr = this.getOrRegisterString("[object Object]");
      const objStrSSA = this.nextSSA();
      this.emit(`${objStrSSA} = llvm.mlir.addressof ${objStr} : !llvm.ptr`);

      const slot = this.allocateStack("!llvm.ptr");
      this.createIf(
        { ssa: isNullSSA, type: "i1" },
        () => this.emit(`llvm.store ${nullStrSSA}, ${slot.ptr} : !llvm.ptr, !llvm.ptr`),
        () => this.emit(`llvm.store ${objStrSSA}, ${slot.ptr} : !llvm.ptr, !llvm.ptr`)
      );
      const res = this.load(slot.ptr, "!llvm.ptr");
      res.isString = true;
      return res;
    }

    return val;
  }

  printString(ptr) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_str(${ptr}) : (!llvm.ptr) -> ()`);
  }

  printF64(ssa) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_f64(${ssa}) : (f64) -> ()`);
  }

  printI32(ssa) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_i32(${ssa}) : (i32) -> ()`);
  }

  printI64(ssa) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_i64(${ssa}) : (i64) -> ()`);
  }

  printBool(ssa) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_bool(${ssa}) : (i1) -> ()`);
  }

  printUnion(ptr) {
    this.markFeature("printf");
    this.markFeature("union");
    this.emit(`func.call @rts_print_union(${ptr}) : (!llvm.ptr) -> ()`);
  }

  printSpace() {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_space() : () -> ()`);
  }

  printNewline() {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_newline() : () -> ()`);
  }

  printPointer(ptr) {
    this.markFeature("printf");
    this.emit(`func.call @rts_print_ptr(${ptr}) : (!llvm.ptr) -> ()`);
  }

  buildFullModule(options = {}) {
    const targetInfo = options.targetInfo || this.targetInfo || TargetManager.resolve(options);
    const isWasm = targetInfo.isWasm;
    const triple = targetInfo.triple;
    const dataLayout = targetInfo.dataLayout || "";
    let header = `module attributes {llvm.data_layout = "${dataLayout}", llvm.target_triple = "${triple}"} {\n`;

    const needsHeap =
      this.usedFeatures.heap ||
      this.usedFeatures.map ||
      this.usedFeatures.strings ||
      this.usedFeatures.union ||
      this.usedFeatures.channels ||
      this.usedFeatures.allocators ||
      this.usedFeatures.napi ||
      this.usedFeatures.threads;

    // 1. Dış Bağımlılıklar (sprintf tamamen kaldırıldı!)
    if (this.usedFeatures.printf) {
      header += `  llvm.func @printf(!llvm.ptr, ...) -> i32\n`;
    }

    if (this.usedFeatures.napi) {
      header += `  llvm.func @napi_get_cb_info(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_get_value_double(!llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_create_double(!llvm.ptr, f64, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_get_value_string_utf8(!llvm.ptr, !llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_create_string_utf8(!llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_get_value_bool(!llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_get_boolean(!llvm.ptr, i1, !llvm.ptr) -> i32\n`;
      header += `  llvm.func @napi_define_properties(!llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32\n`;
    }

    if (!isWasm) {
      if (needsHeap) {
        header += `  llvm.func @malloc(i64) -> !llvm.ptr\n`;
        header += `  llvm.func @free(!llvm.ptr) -> ()\n`;
      }
      if (this.usedFeatures.map) {
        header += `  llvm.func @calloc(i64, i64) -> !llvm.ptr\n`;
      }
      if (this.usedFeatures.map || this.usedFeatures.strcmp) {
        header += `  llvm.func @strcmp(!llvm.ptr, !llvm.ptr) -> i32\n`;
      }
    }

    if (this.usedFeatures.exceptions) {
      if (isWasm) {
        // Freestanding WASM: Libc'siz anında CPU trap (WASM unreachable opcode)
        header += `  llvm.func @abort() {\n`;
        header += `    llvm.unreachable\n`;
        header += `  }\n\n`;
      } else {
        header += `  llvm.func @abort() -> ()\n`;
        header += `  llvm.func @setjmp(!llvm.ptr) -> i32\n`;
        header += `  llvm.func @longjmp(!llvm.ptr, i32) -> ()\n`;
      }
    }

    if (!isWasm) {
      if (this.usedFeatures.threads || this.usedFeatures.channels) {
        header += `  func.func private @pthread_create(!llvm.ptr, !llvm.ptr, (!llvm.ptr) -> !llvm.ptr, !llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_join(i64, !llvm.ptr) -> i32\n`;
      }

      if (this.usedFeatures.channels) {
        header += `  llvm.func @pthread_mutex_init(!llvm.ptr, !llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_mutex_lock(!llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_mutex_unlock(!llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_cond_init(!llvm.ptr, !llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_cond_wait(!llvm.ptr, !llvm.ptr) -> i32\n`;
        header += `  llvm.func @pthread_cond_signal(!llvm.ptr) -> i32\n`;
      }
    }

    if (this.usedFeatures.sleep) {
      if (targetInfo.isWindows) {
        header += `  llvm.func @Sleep(i32) -> ()\n`;
      } else if (!isWasm) {
        header += `  llvm.func @usleep(i32) -> i32\n`;
      }
    }
    header += `\n`;

    // declare ile tanımlanmış harici FFI fonksiyonları
    for (const [name, sig] of this.externalFunctions.entries()) {
      header += `  func.func private @${name}${sig}\n`;
    }
    if (this.externalFunctions.size > 0) header += `\n`;

    if (this.usedFeatures.printf) {
      header += `  llvm.mlir.global internal constant @fmt_f64("%f\\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_i32("%d\\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_i64("%ld\\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_str("%s\\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_ptr("%p\\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_space(" \\00")\n`;
      header += `  llvm.mlir.global internal constant @fmt_nl("\\0A\\00")\n`;
    }

    if (this.usedFeatures.exceptions) {
      header += `  llvm.mlir.global internal constant @fmt_uncaught_err("Uncaught Exception: %s\\0A\\00")\n\n`;
      const threadLocalAttr = isWasm ? "" : "thread_local ";
      header += `  llvm.mlir.global internal ${threadLocalAttr}@rts_current_jmpbuf() : !llvm.ptr {\n`;
      header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    llvm.return %0 : !llvm.ptr\n`;
      header += `  }\n\n`;
      header += `  llvm.mlir.global internal ${threadLocalAttr}@rts_current_exception() : !llvm.ptr {\n`;
      header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    llvm.return %0 : !llvm.ptr\n`;
      header += `  }\n\n`;
    }

    // Windows MSVC Floating-Point ABI uyumluluğu (_fltused sembolü)
    if (targetInfo.isWindows) {
      header += `  llvm.mlir.global external @_fltused(1 : i32) : i32\n\n`;
    }

    // Modül Seviyesindeki Global Değişkenler
    for (const [sym, info] of (this.globalVars || new Map()).entries()) {
      const type = info.type;
      if (type === "i1") {
        const val = (info.initVal === true || info.initVal === 1 || info.initVal === "true") ? 1 : 0;
        header += `  llvm.mlir.global internal ${sym}() : i1 {\n`;
        header += `    %0 = llvm.mlir.constant(${val} : i1) : i1\n`;
        header += `    llvm.return %0 : i1\n`;
        header += `  }\n\n`;
      } else if (type === "i64" || type === "i32") {
        const val = typeof info.initVal === "number" ? Math.floor(info.initVal) : 0;
        header += `  llvm.mlir.global internal ${sym}() : ${type} {\n`;
        header += `    %0 = llvm.mlir.constant(${val} : ${type}) : ${type}\n`;
        header += `    llvm.return %0 : ${type}\n`;
        header += `  }\n\n`;
      } else if (type === "f64" || type === "f32") {
        const val = typeof info.initVal === "number" ? (Number.isInteger(info.initVal) ? `${info.initVal}.0` : `${info.initVal}`) : "0.0";
        header += `  llvm.mlir.global internal ${sym}() : ${type} {\n`;
        header += `    %0 = llvm.mlir.constant(${val} : ${type}) : ${type}\n`;
        header += `    llvm.return %0 : ${type}\n`;
        header += `  }\n\n`;
      } else {
        header += `  llvm.mlir.global internal ${sym}() : !llvm.ptr {\n`;
        header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
        header += `    llvm.return %0 : !llvm.ptr\n`;
        header += `  }\n\n`;
      }
    }

    for (const [text, sym] of this.globalStrings.entries()) {
      const escaped = text
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\0A")
        .replace(/"/g, '\\"') + "\\00";
      header += `  llvm.mlir.global internal constant ${sym}("${escaped}")\n`;
    }
    header += `\n`;

    header += RuntimeEmitters.emitAll(this, isWasm, needsHeap);

    return header + this.buffer.join("\n") + "\n}\n";
  }
}
