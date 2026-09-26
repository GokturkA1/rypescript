// mlir-builder.js
export class MLIRBuilder {
  constructor() {
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
    this.block("scf.while : () -> ()", () => {
      const cond = condEvaluator();
      this.emit(`scf.condition(${cond.ssa})`);
    });
    this.block("do", () => {
      this.emit("^bb0:");
      this.hasTerminated = false;
      bodyFn();
      this.emit("scf.yield");
    });
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
    const isWasm = (options.format || "elf") === "wasm";
    const triple = isWasm ? "wasm32-unknown-unknown" : "x86_64-pc-linux-gnu";
    let header = `module attributes {llvm.data_layout = "", llvm.target_triple = "${triple}"} {\n`;

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

    if (this.usedFeatures.sleep) {
      header += `  llvm.func @usleep(i32) -> i32\n`;
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
      header += `  llvm.mlir.global internal thread_local @rts_current_jmpbuf() : !llvm.ptr {\n`;
      header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    llvm.return %0 : !llvm.ptr\n`;
      header += `  }\n\n`;
      header += `  llvm.mlir.global internal thread_local @rts_current_exception() : !llvm.ptr {\n`;
      header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    llvm.return %0 : !llvm.ptr\n`;
      header += `  }\n\n`;
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

    if (isWasm && needsHeap) {
      header += `  llvm.mlir.global external @__heap_base() : i8\n\n`;
      header += `  llvm.mlir.global internal @rts_heap_ptr() : !llvm.ptr {\n`;
      header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    llvm.return %0 : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  llvm.func @malloc(%size: i64) -> !llvm.ptr {\n`;
      header += `    %g = llvm.mlir.addressof @rts_heap_ptr : !llvm.ptr\n`;
      header += `    %curr = llvm.load %g : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %null = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %is_null = llvm.icmp "eq" %curr, %null : !llvm.ptr\n`;
      header += `    llvm.cond_br %is_null, ^init_heap, ^have_heap(%curr : !llvm.ptr)\n`;
      header += `  ^init_heap:\n`;
      header += `    %base = llvm.mlir.addressof @__heap_base : !llvm.ptr\n`;
      header += `    llvm.br ^have_heap(%base : !llvm.ptr)\n`;
      header += `  ^have_heap(%ptr: !llvm.ptr):\n`;
      header += `    %c7 = llvm.mlir.constant(7 : i64) : i64\n`;
      header += `    %c8 = llvm.mlir.constant(8 : i64) : i64\n`;
      header += `    %s1 = llvm.add %size, %c7 : i64\n`;
      header += `    %rem = llvm.urem %s1, %c8 : i64\n`;
      header += `    %aligned = llvm.sub %s1, %rem : i64\n`;
      header += `    %next = llvm.getelementptr %ptr[%aligned] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %next, %g : !llvm.ptr, !llvm.ptr\n`;
      header += `    llvm.return %ptr : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  llvm.func @free(%ptr: !llvm.ptr) {\n`;
      header += `    llvm.return\n`;
      header += `  }\n\n`;

      header += `  llvm.func @calloc(%num: i64, %size: i64) -> !llvm.ptr {\n`;
      header += `    %total = llvm.mul %num, %size : i64\n`;
      header += `    %ptr = llvm.call @malloc(%total) : (i64) -> !llvm.ptr\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %zero_byte = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `    llvm.br ^loop(%c0 : i64)\n`;
      header += `  ^loop(%idx: i64):\n`;
      header += `    %cond = llvm.icmp "slt" %idx, %total : i64\n`;
      header += `    llvm.cond_br %cond, ^body, ^done\n`;
      header += `  ^body:\n`;
      header += `    %byte_ptr = llvm.getelementptr %ptr[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %zero_byte, %byte_ptr : i8, !llvm.ptr\n`;
      header += `    %next_idx = llvm.add %idx, %c1 : i64\n`;
      header += `    llvm.br ^loop(%next_idx : i64)\n`;
      header += `  ^done:\n`;
      header += `    llvm.return %ptr : !llvm.ptr\n`;
      header += `  }\n\n`;

      if (this.usedFeatures.map) {
        header += `  llvm.func @strcmp(%s1: !llvm.ptr, %s2: !llvm.ptr) -> i32 {\n`;
        header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
        header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
        header += `    %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
        header += `    %c0_i32 = llvm.mlir.constant(0 : i32) : i32\n`;
        header += `    llvm.br ^loop(%c0 : i64)\n`;
        header += `  ^loop(%idx: i64):\n`;
        header += `    %p1 = llvm.getelementptr %s1[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
        header += `    %p2 = llvm.getelementptr %s2[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
        header += `    %c1_val = llvm.load %p1 : !llvm.ptr -> i8\n`;
        header += `    %c2_val = llvm.load %p2 : !llvm.ptr -> i8\n`;
        header += `    %diff = llvm.sub %c1_val, %c2_val : i8\n`;
        header += `    %diff_i32 = llvm.sext %diff : i8 to i32\n`;
        header += `    %is_diff = llvm.icmp "ne" %diff_i32, %c0_i32 : i32\n`;
        header += `    llvm.cond_br %is_diff, ^ret(%diff_i32 : i32), ^check_null\n`;
        header += `  ^check_null:\n`;
        header += `    %is_null = llvm.icmp "eq" %c1_val, %c0_i8 : i8\n`;
        header += `    llvm.cond_br %is_null, ^ret(%c0_i32 : i32), ^next\n`;
        header += `  ^next:\n`;
        header += `    %next_idx = llvm.add %idx, %c1 : i64\n`;
        header += `    llvm.br ^loop(%next_idx : i64)\n`;
        header += `  ^ret(%res: i32):\n`;
        header += `    llvm.return %res : i32\n`;
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

    // --- FREESTANDING STRING İŞLEMLERİ (Host Bağımsız String Motoru) ---
    if (this.usedFeatures.strings || this.usedFeatures.union) {
      // 1. @rts_strlen
      header += `  func.func @rts_strlen(%arg0: !llvm.ptr) -> i64 {\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %null = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %is_null = llvm.icmp "eq" %arg0, %null : !llvm.ptr\n`;
      header += `    %idx_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c0, %idx_slot : i64, !llvm.ptr\n`;
      header += `    scf.if %is_null {\n`;
      header += `    } else {\n`;
      header += `      scf.while : () -> () {\n`;
      header += `        %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `        %c_ptr = llvm.getelementptr %arg0[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `        %ch = llvm.load %c_ptr : !llvm.ptr -> i8\n`;
      header += `        %cond = arith.cmpi ne, %ch, %c0_i8 : i8\n`;
      header += `        scf.condition(%cond)\n`;
      header += `      } do {\n`;
      header += `      ^bb0:\n`;
      header += `        %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `        %next = arith.addi %idx, %c1 : i64\n`;
      header += `        llvm.store %next, %idx_slot : i64, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `    func.return %res : i64\n`;
      header += `  }\n\n`;

      // 2. @rts_str_concat
      header += `  func.func @rts_str_concat(%s1: !llvm.ptr, %s2: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %len1 = func.call @rts_strlen(%s1) : (!llvm.ptr) -> i64\n`;
      header += `    %len2 = func.call @rts_strlen(%s2) : (!llvm.ptr) -> i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %tot1 = arith.addi %len1, %len2 : i64\n`;
      header += `    %tot = arith.addi %tot1, %c1 : i64\n`;
      header += `    %buf = llvm.call @malloc(%tot) : (i64) -> !llvm.ptr\n`;
      header += `    %i_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c0, %i_slot : i64, !llvm.ptr\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %cond = arith.cmpi slt, %i, %len1 : i64\n`;
      header += `      scf.condition(%cond)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %src = llvm.getelementptr %s1[%i] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %ch = llvm.load %src : !llvm.ptr -> i8\n`;
      header += `      %dst = llvm.getelementptr %buf[%i] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %ch, %dst : i8, !llvm.ptr\n`;
      header += `      %next = arith.addi %i, %c1 : i64\n`;
      header += `      llvm.store %next, %i_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    llvm.store %c0, %i_slot : i64, !llvm.ptr\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %cond = arith.cmpi slt, %i, %len2 : i64\n`;
      header += `      scf.condition(%cond)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %src = llvm.getelementptr %s2[%i] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %ch = llvm.load %src : !llvm.ptr -> i8\n`;
      header += `      %dst_idx = arith.addi %len1, %i : i64\n`;
      header += `      %dst = llvm.getelementptr %buf[%dst_idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %ch, %dst : i8, !llvm.ptr\n`;
      header += `      %next = arith.addi %i, %c1 : i64\n`;
      header += `      llvm.store %next, %i_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `    %end_ptr = llvm.getelementptr %buf[%tot1] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %c0_i8, %end_ptr : i8, !llvm.ptr\n`;
      header += `    func.return %buf : !llvm.ptr\n`;
      header += `  }\n\n`;

      // 3. @rts_i64_to_str (Freestanding itoa)
      header += `  func.func @rts_i64_to_str(%val: i64) -> !llvm.ptr {\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c10 = llvm.mlir.constant(10 : i64) : i64\n`;
      header += `    %c48_i8 = llvm.mlir.constant(48 : i8) : i8\n`;
      header += `    %c45_i8 = llvm.mlir.constant(45 : i8) : i8\n`;
      header += `    %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %is_zero = arith.cmpi eq, %val, %c0 : i64\n`;
      header += `    %c2 = llvm.mlir.constant(2 : i64) : i64\n`;
      header += `    %c32_i32 = arith.constant 32 : i32\n`;
      header += `    %tmp = llvm.alloca %c32_i32 x i8 : (i32) -> !llvm.ptr\n`;
      header += `    %v_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    %pos_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    %is_neg = arith.cmpi slt, %val, %c0 : i64\n`;
      header += `    scf.if %is_neg {\n`;
      header += `      %abs = arith.subi %c0, %val : i64\n`;
      header += `      llvm.store %abs, %v_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      llvm.store %val, %v_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    llvm.store %c0, %pos_slot : i64, !llvm.ptr\n`;
      header += `    scf.if %is_zero {\n`;
      header += `      %p = llvm.getelementptr %tmp[0] : (!llvm.ptr) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %c48_i8, %p : i8, !llvm.ptr\n`;
      header += `      %c1_64 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `      llvm.store %c1_64, %pos_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      scf.while : () -> () {\n`;
      header += `        %v = llvm.load %v_slot : !llvm.ptr -> i64\n`;
      header += `        %cond = arith.cmpi ne, %v, %c0 : i64\n`;
      header += `        scf.condition(%cond)\n`;
      header += `      } do {\n`;
      header += `      ^bb0:\n`;
      header += `        %v = llvm.load %v_slot : !llvm.ptr -> i64\n`;
      header += `        %pos = llvm.load %pos_slot : !llvm.ptr -> i64\n`;
      header += `        %rem = arith.remui %v, %c10 : i64\n`;
      header += `        %rem_i8 = arith.trunci %rem : i64 to i8\n`;
      header += `        %ch = arith.addi %rem_i8, %c48_i8 : i8\n`;
      header += `        %p = llvm.getelementptr %tmp[%pos] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `        llvm.store %ch, %p : i8, !llvm.ptr\n`;
      header += `        %next_pos = arith.addi %pos, %c1 : i64\n`;
      header += `        llvm.store %next_pos, %pos_slot : i64, !llvm.ptr\n`;
      header += `        %next_v = arith.divui %v, %c10 : i64\n`;
      header += `        llvm.store %next_v, %v_slot : i64, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %digit_count = llvm.load %pos_slot : !llvm.ptr -> i64\n`;
      header += `    %extra = arith.select %is_neg, %c1, %c0 : i64\n`;
      header += `    %total_len = arith.addi %digit_count, %extra : i64\n`;
      header += `    %buf_sz = arith.addi %total_len, %c1 : i64\n`;
      header += `    %out_buf = llvm.call @malloc(%buf_sz) : (i64) -> !llvm.ptr\n`;
      header += `    scf.if %is_neg {\n`;
      header += `      %out_zero = llvm.getelementptr %out_buf[0] : (!llvm.ptr) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %c45_i8, %out_zero : i8, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %i_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c0, %i_slot : i64, !llvm.ptr\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %cond = arith.cmpi slt, %i, %digit_count : i64\n`;
      header += `      scf.condition(%cond)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %i = llvm.load %i_slot : !llvm.ptr -> i64\n`;
      header += `      %rev_idx = arith.subi %digit_count, %i : i64\n`;
      header += `      %src_idx = arith.subi %rev_idx, %c1 : i64\n`;
      header += `      %src_p = llvm.getelementptr %tmp[%src_idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %ch = llvm.load %src_p : !llvm.ptr -> i8\n`;
      header += `      %dst_idx = arith.addi %extra, %i : i64\n`;
      header += `      %dst_p = llvm.getelementptr %out_buf[%dst_idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %ch, %dst_p : i8, !llvm.ptr\n`;
      header += `      %next_i = arith.addi %i, %c1 : i64\n`;
      header += `      llvm.store %next_i, %i_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %term = llvm.getelementptr %out_buf[%total_len] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %c0_i8, %term : i8, !llvm.ptr\n`;
      header += `    func.return %out_buf : !llvm.ptr\n`;
      header += `  }\n\n`;

      // 4. @rts_f64_to_str (Freestanding ftoa: kesir yoksa tam sayı, varsa 4 basamak)
      header += `  func.func @rts_f64_to_str(%val: f64) -> !llvm.ptr {\n`;
      header += `    %c0_f64 = arith.constant 0.0 : f64\n`;
      header += `    %val_is_neg = arith.cmpf olt, %val, %c0_f64 : f64\n`;
      header += `    %abs_val = scf.if %val_is_neg -> (f64) {\n`;
      header += `      %neg = arith.subf %c0_f64, %val : f64\n`;
      header += `      scf.yield %neg : f64\n`;
      header += `    } else {\n`;
      header += `      scf.yield %val : f64\n`;
      header += `    }\n`;
      header += `    %i_part = arith.fptosi %abs_val : f64 to i64\n`;
      header += `    %i_f64 = arith.sitofp %i_part : i64 to f64\n`;
      header += `    %diff = arith.subf %abs_val, %i_f64 : f64\n`;
      header += `    %s_int_raw = func.call @rts_i64_to_str(%i_part) : (i64) -> !llvm.ptr\n`;
      header += `    %s_int = scf.if %val_is_neg -> (!llvm.ptr) {\n`;
      header += `      %c2 = llvm.mlir.constant(2 : i64) : i64\n`;
      header += `      %minus_buf = llvm.call @malloc(%c2) : (i64) -> !llvm.ptr\n`;
      header += `      %c45_i8 = llvm.mlir.constant(45 : i8) : i8\n`;
      header += `      %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `      llvm.store %c45_i8, %minus_buf : i8, !llvm.ptr\n`;
      header += `      %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `      %m_term = llvm.getelementptr %minus_buf[%c1] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %c0_i8, %m_term : i8, !llvm.ptr\n`;
      header += `      %neg_s = func.call @rts_str_concat(%minus_buf, %s_int_raw) : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr\n`;
      header += `      scf.yield %neg_s : !llvm.ptr\n`;
      header += `    } else {\n`;
      header += `      scf.yield %s_int_raw : !llvm.ptr\n`;
      header += `    }\n`;
      header += `    %is_zero = arith.cmpf oeq, %diff, %c0_f64 : f64\n`;
      header += `    %res = scf.if %is_zero -> (!llvm.ptr) {\n`;
      header += `      scf.yield %s_int : !llvm.ptr\n`;
      header += `    } else {\n`;
      header += `      %c1_i32 = arith.constant 1 : i32\n`;
      header += `      %c0_i64 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `      %c1_i64 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `      %c4_i64 = llvm.mlir.constant(4 : i64) : i64\n`;
      header += `      %c6_i64 = llvm.mlir.constant(6 : i64) : i64\n`;
      header += `      %frac_buf = llvm.call @malloc(%c6_i64) : (i64) -> !llvm.ptr\n`;
      header += `      %c46_i8 = llvm.mlir.constant(46 : i8) : i8\n`;
      header += `      %c48_i8 = llvm.mlir.constant(48 : i8) : i8\n`;
      header += `      %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `      llvm.store %c46_i8, %frac_buf : i8, !llvm.ptr\n`;
      header += `      %c10_f64 = arith.constant 10.0 : f64\n`;
      header += `      %cur_diff_slot = llvm.alloca %c1_i32 x f64 : (i32) -> !llvm.ptr\n`;
      header += `      llvm.store %diff, %cur_diff_slot : f64, !llvm.ptr\n`;
      header += `      %idx_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `      llvm.store %c0_i64, %idx_slot : i64, !llvm.ptr\n`;
      header += `      scf.while : () -> () {\n`;
      header += `        %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `        %cond = arith.cmpi slt, %idx, %c4_i64 : i64\n`;
      header += `        scf.condition(%cond)\n`;
      header += `      } do {\n`;
      header += `      ^bb0:\n`;
      header += `        %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `        %cur_d = llvm.load %cur_diff_slot : !llvm.ptr -> f64\n`;
      header += `        %d10 = arith.mulf %cur_d, %c10_f64 : f64\n`;
      header += `        %digit = arith.fptosi %d10 : f64 to i64\n`;
      header += `        %digit_f64 = arith.sitofp %digit : i64 to f64\n`;
      header += `        %next_d = arith.subf %d10, %digit_f64 : f64\n`;
      header += `        llvm.store %next_d, %cur_diff_slot : f64, !llvm.ptr\n`;
      header += `        %digit_i8 = arith.trunci %digit : i64 to i8\n`;
      header += `        %char_val = arith.addi %digit_i8, %c48_i8 : i8\n`;
      header += `        %pos = arith.addi %idx, %c1_i64 : i64\n`;
      header += `        %dst = llvm.getelementptr %frac_buf[%pos] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `        llvm.store %char_val, %dst : i8, !llvm.ptr\n`;
      header += `        %next_idx = arith.addi %idx, %c1_i64 : i64\n`;
      header += `        llvm.store %next_idx, %idx_slot : i64, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      %c5_i64 = llvm.mlir.constant(5 : i64) : i64\n`;
      header += `      %term = llvm.getelementptr %frac_buf[%c5_i64] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %c0_i8, %term : i8, !llvm.ptr\n`;
      header += `      %full = func.call @rts_str_concat(%s_int, %frac_buf) : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr\n`;
      header += `      scf.yield %full : !llvm.ptr\n`;
      header += `    }\n`;
      header += `    func.return %res : !llvm.ptr\n`;
      header += `  }\n\n`;
    }

    if (this.usedFeatures.printf) {
      header += `  func.func @rts_print_f64(%arg0: f64) {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_f64 : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %arg0) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, f64) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_i32(%arg0: i32) {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_i32 : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %arg0) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, i32) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_i64(%arg0: i64) {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_i64 : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %arg0) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, i64) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_str(%arg0: !llvm.ptr) {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_str : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %arg0) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_ptr(%arg0: !llvm.ptr) {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_ptr : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %arg0) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_bool(%arg0: i1) {\n`;
      header += `    %str_t = llvm.mlir.addressof ${this.symTrue} : !llvm.ptr\n`;
      header += `    %str_f = llvm.mlir.addressof ${this.symFalse} : !llvm.ptr\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_str : !llvm.ptr\n`;
      header += `    %c1 = arith.constant 1 : i32\n`;
      header += `    %slot = llvm.alloca %c1 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    scf.if %arg0 {\n`;
      header += `      llvm.store %str_t, %slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      llvm.store %str_f, %slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %val = llvm.load %slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt, %val) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_space() {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_space : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_print_newline() {\n`;
      header += `    %fmt = llvm.mlir.addressof @fmt_nl : !llvm.ptr\n`;
      header += `    llvm.call @printf(%fmt) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;
    }

    // --- UNION RUNTIME FONKSİYONLARI ---
    if (this.usedFeatures.union) {
      header += `  func.func @rts_union_typeof(%arg0: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %tag_ptr = llvm.getelementptr %arg0[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %tag = llvm.load %tag_ptr : !llvm.ptr -> i32\n`;
      header += `    %c1 = arith.constant 1 : i32\n`;
      header += `    %c2 = arith.constant 2 : i32\n`;
      header += `    %c3 = arith.constant 3 : i32\n`;
      header += `    %c4 = arith.constant 4 : i32\n`;
      header += `    %str_num = llvm.mlir.addressof ${this.symNumber} : !llvm.ptr\n`;
      header += `    %str_str = llvm.mlir.addressof ${this.symString} : !llvm.ptr\n`;
      header += `    %str_bool = llvm.mlir.addressof ${this.symBoolean} : !llvm.ptr\n`;
      header += `    %str_obj = llvm.mlir.addressof ${this.symObject} : !llvm.ptr\n`;
      header += `    %res_slot = llvm.alloca %c1 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %str_obj, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %is_i64 = arith.cmpi eq, %tag, %c1 : i32\n`;
      header += `    %is_f64 = arith.cmpi eq, %tag, %c2 : i32\n`;
      header += `    %is_num = arith.ori %is_i64, %is_f64 : i1\n`;
      header += `    scf.if %is_num {\n`;
      header += `      llvm.store %str_num, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      %is_str = arith.cmpi eq, %tag, %c3 : i32\n`;
      header += `      scf.if %is_str {\n`;
      header += `        llvm.store %str_str, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %is_b = arith.cmpi eq, %tag, %c4 : i32\n`;
      header += `        scf.if %is_b {\n`;
      header += `          llvm.store %str_bool, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `          scf.yield\n`;
      header += `        }\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %res_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    func.return %res : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_union_get_number(%arg0: !llvm.ptr) -> f64 {\n`;
      header += `    %tag_ptr = llvm.getelementptr %arg0[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %tag = llvm.load %tag_ptr : !llvm.ptr -> i32\n`;
      header += `    %payload_ptr = llvm.getelementptr %arg0[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %c1 = arith.constant 1 : i32\n`;
      header += `    %is_int = arith.cmpi eq, %tag, %c1 : i32\n`;
      header += `    %res_slot = llvm.alloca %c1 x f64 : (i32) -> !llvm.ptr\n`;
      header += `    scf.if %is_int {\n`;
      header += `      %ival = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
      header += `      %fval = arith.sitofp %ival : i64 to f64\n`;
      header += `      llvm.store %fval, %res_slot : f64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      %fval2 = llvm.load %payload_ptr : !llvm.ptr -> f64\n`;
      header += `      llvm.store %fval2, %res_slot : f64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %res_slot : !llvm.ptr -> f64\n`;
      header += `    func.return %res : f64\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_union_get_string(%arg0: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %payload_ptr = llvm.getelementptr %arg0[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %str = llvm.load %payload_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    func.return %str : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_union_get_bool(%arg0: !llvm.ptr) -> i1 {\n`;
      header += `    %payload_ptr = llvm.getelementptr %arg0[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %b = llvm.load %payload_ptr : !llvm.ptr -> i1\n`;
      header += `    func.return %b : i1\n`;
      header += `  }\n\n`;

      if (this.usedFeatures.printf) {
        header += `  func.func @rts_print_union(%arg0: !llvm.ptr) {\n`;
        header += `    %tag_ptr = llvm.getelementptr %arg0[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
        header += `    %tag = llvm.load %tag_ptr : !llvm.ptr -> i32\n`;
        header += `    %payload_ptr = llvm.getelementptr %arg0[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
        header += `    %c1 = arith.constant 1 : i32\n`;
        header += `    %c2 = arith.constant 2 : i32\n`;
        header += `    %c3 = arith.constant 3 : i32\n`;
        header += `    %is_i64 = arith.cmpi eq, %tag, %c1 : i32\n`;
        header += `    scf.if %is_i64 {\n`;
        header += `      %ival = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
        header += `      func.call @rts_print_i64(%ival) : (i64) -> ()\n`;
        header += `      scf.yield\n`;
        header += `    } else {\n`;
        header += `      %is_f64 = arith.cmpi eq, %tag, %c2 : i32\n`;
        header += `      scf.if %is_f64 {\n`;
        header += `        %fval = llvm.load %payload_ptr : !llvm.ptr -> f64\n`;
        header += `        func.call @rts_print_f64(%fval) : (f64) -> ()\n`;
        header += `        scf.yield\n`;
        header += `      } else {\n`;
        header += `        %is_str = arith.cmpi eq, %tag, %c3 : i32\n`;
        header += `        scf.if %is_str {\n`;
        header += `          %strval = llvm.load %payload_ptr : !llvm.ptr -> !llvm.ptr\n`;
        header += `          func.call @rts_print_str(%strval) : (!llvm.ptr) -> ()\n`;
        header += `          scf.yield\n`;
        header += `        } else {\n`;
        header += `          %bval = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
        header += `          func.call @rts_print_i64(%bval) : (i64) -> ()\n`;
        header += `          scf.yield\n`;
        header += `        }\n`;
        header += `      }\n`;
        header += `      scf.yield\n`;
        header += `    }\n`;
        header += `    func.return\n`;
        header += `  }\n\n`;
      }

      header += `  func.func @rts_union_to_string(%arg0: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %tag_ptr = llvm.getelementptr %arg0[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %tag = llvm.load %tag_ptr : !llvm.ptr -> i32\n`;
      header += `    %payload_ptr = llvm.getelementptr %arg0[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>\n`;
      header += `    %c1 = arith.constant 1 : i32\n`;
      header += `    %c2 = arith.constant 2 : i32\n`;
      header += `    %c3 = arith.constant 3 : i32\n`;
      header += `    %res_slot = llvm.alloca %c1 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %is_i64 = arith.cmpi eq, %tag, %c1 : i32\n`;
      header += `    scf.if %is_i64 {\n`;
      header += `      %ival = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
      header += `      %str = func.call @rts_i64_to_str(%ival) : (i64) -> !llvm.ptr\n`;
      header += `      llvm.store %str, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    } else {\n`;
      header += `      %is_f64 = arith.cmpi eq, %tag, %c2 : i32\n`;
      header += `      scf.if %is_f64 {\n`;
      header += `        %fval = llvm.load %payload_ptr : !llvm.ptr -> f64\n`;
      header += `        %str = func.call @rts_f64_to_str(%fval) : (f64) -> !llvm.ptr\n`;
      header += `        llvm.store %str, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      } else {\n`;
      header += `        %is_str = arith.cmpi eq, %tag, %c3 : i32\n`;
      header += `        scf.if %is_str {\n`;
      header += `          %strval = llvm.load %payload_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `          llvm.store %strval, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        } else {\n`;
      header += `          %bval = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
      header += `          %str = func.call @rts_i64_to_str(%bval) : (i64) -> !llvm.ptr\n`;
      header += `          llvm.store %str, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        }\n`;
      header += `      }\n`;
      header += `    }\n`;
      header += `    %final_str = llvm.load %res_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    func.return %final_str : !llvm.ptr\n`;
      header += `  }\n\n`;
    }

    // --- HASH TABLE (MAP & SET) RUNTIME FONKSİYONLARI ---
    if (this.usedFeatures.map) {
      header += `  func.func @rts_hash_str(%arg0: !llvm.ptr) -> i64 {\n`;
      header += `    %c5381 = llvm.mlir.constant(5381 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %c5 = llvm.mlir.constant(5 : i64) : i64\n`;
      header += `    %c0_i8 = llvm.mlir.constant(0 : i8) : i8\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %h_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c5381, %h_slot : i64, !llvm.ptr\n`;
      header += `    %idx_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c0, %idx_slot : i64, !llvm.ptr\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `      %c_ptr = llvm.getelementptr %arg0[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %ch = llvm.load %c_ptr : !llvm.ptr -> i8\n`;
      header += `      %cond = arith.cmpi ne, %ch, %c0_i8 : i8\n`;
      header += `      scf.condition(%cond)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %idx = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `      %c_ptr = llvm.getelementptr %arg0[%idx] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %ch = llvm.load %c_ptr : !llvm.ptr -> i8\n`;
      header += `      %ch_i64 = arith.extui %ch : i8 to i64\n`;
      header += `      %h = llvm.load %h_slot : !llvm.ptr -> i64\n`;
      header += `      %h_shl = arith.shli %h, %c5 : i64\n`;
      header += `      %h_add = arith.addi %h_shl, %h : i64\n`;
      header += `      %new_h = arith.addi %h_add, %ch_i64 : i64\n`;
      header += `      llvm.store %new_h, %h_slot : i64, !llvm.ptr\n`;
      header += `      %next_idx = arith.addi %idx, %c1 : i64\n`;
      header += `      llvm.store %next_idx, %idx_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %h_slot : !llvm.ptr -> i64\n`;
      header += `    func.return %res : i64\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_new() -> !llvm.ptr {\n`;
      header += `    %sz_map = llvm.mlir.constant(24 : i64) : i64\n`;
      header += `    %map = llvm.call @malloc(%sz_map) : (i64) -> !llvm.ptr\n`;
      header += `    %cap = llvm.mlir.constant(64 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    llvm.store %cap, %cap_ptr : i64, !llvm.ptr\n`;
      header += `    %sz_ptr = llvm.getelementptr %map[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    llvm.store %c0, %sz_ptr : i64, !llvm.ptr\n`;
      header += `    %c8 = llvm.mlir.constant(8 : i64) : i64\n`;
      header += `    %buckets = llvm.call @calloc(%cap, %c8) : (i64, i64) -> !llvm.ptr\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    llvm.store %buckets, %buckets_ptr : !llvm.ptr, !llvm.ptr\n`;
      header += `    func.return %map : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_set_str_f64(%map: !llvm.ptr, %key: !llvm.ptr, %val: f64) {\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %cap = llvm.load %cap_ptr : !llvm.ptr -> i64\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %buckets = llvm.load %buckets_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %h = func.call @rts_hash_str(%key) : (!llvm.ptr) -> i64\n`;
      header += `    %b_idx = arith.remui %h, %cap : i64\n`;
      header += `    %bucket_slot = llvm.getelementptr %buckets[%b_idx] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %curr_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %init_head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %init_head, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %found_slot = llvm.alloca %c1_i32 x i1 : (i32) -> !llvm.ptr\n`;
      header += `    %false_val = arith.constant false\n`;
      header += `    llvm.store %false_val, %found_slot : i1, !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %c0_i32 = arith.constant 0 : i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %has_curr = llvm.icmp "ne" %curr, %null_ptr : !llvm.ptr\n`;
      header += `      scf.condition(%has_curr)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %k_ptr = llvm.getelementptr %curr[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      %curr_key = llvm.load %k_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %cmp = llvm.call @strcmp(%curr_key, %key) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      %is_eq = arith.cmpi eq, %cmp, %c0_i32 : i32\n`;
      header += `      scf.if %is_eq {\n`;
      header += `        %v_ptr = llvm.getelementptr %curr[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        llvm.store %val, %v_ptr : f64, !llvm.ptr\n`;
      header += `        %true_val = arith.constant true\n`;
      header += `        llvm.store %true_val, %found_slot : i1, !llvm.ptr\n`;
      header += `        llvm.store %null_ptr, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %next_ptr = llvm.getelementptr %curr[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %next = llvm.load %next_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %next, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %was_found = llvm.load %found_slot : !llvm.ptr -> i1\n`;
      header += `    %not_found = arith.cmpi eq, %was_found, %false_val : i1\n`;
      header += `    scf.if %not_found {\n`;
      header += `      %sz_entry = llvm.mlir.constant(32 : i64) : i64\n`;
      header += `      %new_node = llvm.call @malloc(%sz_entry) : (i64) -> !llvm.ptr\n`;
      header += `      %head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %n_next = llvm.getelementptr %new_node[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %head, %n_next : !llvm.ptr, !llvm.ptr\n`;
      header += `      %n_key = llvm.getelementptr %new_node[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %key, %n_key : !llvm.ptr, !llvm.ptr\n`;
      header += `      %n_val = llvm.getelementptr %new_node[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %val, %n_val : f64, !llvm.ptr\n`;
      header += `      %n_val_ptr = llvm.getelementptr %new_node[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %null_ptr, %n_val_ptr : !llvm.ptr, !llvm.ptr\n`;
      header += `      llvm.store %new_node, %bucket_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      %size_slot = llvm.getelementptr %map[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `      %old_size = llvm.load %size_slot : !llvm.ptr -> i64\n`;
      header += `      %c1_i64 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `      %new_size = arith.addi %old_size, %c1_i64 : i64\n`;
      header += `      llvm.store %new_size, %size_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_set_str_str(%map: !llvm.ptr, %key: !llvm.ptr, %val: !llvm.ptr) {\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %cap = llvm.load %cap_ptr : !llvm.ptr -> i64\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %buckets = llvm.load %buckets_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %h = func.call @rts_hash_str(%key) : (!llvm.ptr) -> i64\n`;
      header += `    %b_idx = arith.remui %h, %cap : i64\n`;
      header += `    %bucket_slot = llvm.getelementptr %buckets[%b_idx] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %curr_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %init_head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %init_head, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %found_slot = llvm.alloca %c1_i32 x i1 : (i32) -> !llvm.ptr\n`;
      header += `    %false_val = arith.constant false\n`;
      header += `    llvm.store %false_val, %found_slot : i1, !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %c0_i32 = arith.constant 0 : i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %has_curr = llvm.icmp "ne" %curr, %null_ptr : !llvm.ptr\n`;
      header += `      scf.condition(%has_curr)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %k_ptr = llvm.getelementptr %curr[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      %curr_key = llvm.load %k_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %cmp = llvm.call @strcmp(%curr_key, %key) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      %is_eq = arith.cmpi eq, %cmp, %c0_i32 : i32\n`;
      header += `      scf.if %is_eq {\n`;
      header += `        %v_ptr = llvm.getelementptr %curr[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        llvm.store %val, %v_ptr : !llvm.ptr, !llvm.ptr\n`;
      header += `        %true_val = arith.constant true\n`;
      header += `        llvm.store %true_val, %found_slot : i1, !llvm.ptr\n`;
      header += `        llvm.store %null_ptr, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %next_ptr = llvm.getelementptr %curr[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %next = llvm.load %next_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %next, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %was_found = llvm.load %found_slot : !llvm.ptr -> i1\n`;
      header += `    %not_found = arith.cmpi eq, %was_found, %false_val : i1\n`;
      header += `    scf.if %not_found {\n`;
      header += `      %sz_entry = llvm.mlir.constant(32 : i64) : i64\n`;
      header += `      %new_node = llvm.call @malloc(%sz_entry) : (i64) -> !llvm.ptr\n`;
      header += `      %head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %n_next = llvm.getelementptr %new_node[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %head, %n_next : !llvm.ptr, !llvm.ptr\n`;
      header += `      %n_key = llvm.getelementptr %new_node[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %key, %n_key : !llvm.ptr, !llvm.ptr\n`;
      header += `      %c0_f64 = arith.constant 0.0 : f64\n`;
      header += `      %n_val = llvm.getelementptr %new_node[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %c0_f64, %n_val : f64, !llvm.ptr\n`;
      header += `      %n_val_ptr = llvm.getelementptr %new_node[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      llvm.store %val, %n_val_ptr : !llvm.ptr, !llvm.ptr\n`;
      header += `      llvm.store %new_node, %bucket_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `      %size_slot = llvm.getelementptr %map[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `      %old_size = llvm.load %size_slot : !llvm.ptr -> i64\n`;
      header += `      %c1_i64 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `      %new_size = arith.addi %old_size, %c1_i64 : i64\n`;
      header += `      llvm.store %new_size, %size_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_get_str_f64(%map: !llvm.ptr, %key: !llvm.ptr) -> f64 {\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %cap = llvm.load %cap_ptr : !llvm.ptr -> i64\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %buckets = llvm.load %buckets_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %h = func.call @rts_hash_str(%key) : (!llvm.ptr) -> i64\n`;
      header += `    %b_idx = arith.remui %h, %cap : i64\n`;
      header += `    %bucket_slot = llvm.getelementptr %buckets[%b_idx] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %curr_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %init_head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %init_head, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %res_slot = llvm.alloca %c1_i32 x f64 : (i32) -> !llvm.ptr\n`;
      header += `    %c0_f64 = arith.constant 0.0 : f64\n`;
      header += `    llvm.store %c0_f64, %res_slot : f64, !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %c0_i32 = arith.constant 0 : i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %has_curr = llvm.icmp "ne" %curr, %null_ptr : !llvm.ptr\n`;
      header += `      scf.condition(%has_curr)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %k_ptr = llvm.getelementptr %curr[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      %curr_key = llvm.load %k_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %cmp = llvm.call @strcmp(%curr_key, %key) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      %is_eq = arith.cmpi eq, %cmp, %c0_i32 : i32\n`;
      header += `      scf.if %is_eq {\n`;
      header += `        %v_ptr = llvm.getelementptr %curr[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %val = llvm.load %v_ptr : !llvm.ptr -> f64\n`;
      header += `        llvm.store %val, %res_slot : f64, !llvm.ptr\n`;
      header += `        llvm.store %null_ptr, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %next_ptr = llvm.getelementptr %curr[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %next = llvm.load %next_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %next, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %res_slot : !llvm.ptr -> f64\n`;
      header += `    func.return %res : f64\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_get_str_str(%map: !llvm.ptr, %key: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %cap = llvm.load %cap_ptr : !llvm.ptr -> i64\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %buckets = llvm.load %buckets_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %h = func.call @rts_hash_str(%key) : (!llvm.ptr) -> i64\n`;
      header += `    %b_idx = arith.remui %h, %cap : i64\n`;
      header += `    %bucket_slot = llvm.getelementptr %buckets[%b_idx] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %curr_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %init_head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %init_head, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %res_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %null_ptr, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %c0_i32 = arith.constant 0 : i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %has_curr = llvm.icmp "ne" %curr, %null_ptr : !llvm.ptr\n`;
      header += `      scf.condition(%has_curr)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %k_ptr = llvm.getelementptr %curr[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      %curr_key = llvm.load %k_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %cmp = llvm.call @strcmp(%curr_key, %key) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      %is_eq = arith.cmpi eq, %cmp, %c0_i32 : i32\n`;
      header += `      scf.if %is_eq {\n`;
      header += `        %v_ptr = llvm.getelementptr %curr[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %val = llvm.load %v_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %val, %res_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        llvm.store %null_ptr, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %next_ptr = llvm.getelementptr %curr[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %next = llvm.load %next_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %next, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %res_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    func.return %res : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_has_str(%map: !llvm.ptr, %key: !llvm.ptr) -> i1 {\n`;
      header += `    %cap_ptr = llvm.getelementptr %map[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %cap = llvm.load %cap_ptr : !llvm.ptr -> i64\n`;
      header += `    %buckets_ptr = llvm.getelementptr %map[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %buckets = llvm.load %buckets_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %h = func.call @rts_hash_str(%key) : (!llvm.ptr) -> i64\n`;
      header += `    %b_idx = arith.remui %h, %cap : i64\n`;
      header += `    %bucket_slot = llvm.getelementptr %buckets[%b_idx] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %curr_slot = llvm.alloca %c1_i32 x !llvm.ptr : (i32) -> !llvm.ptr\n`;
      header += `    %init_head = llvm.load %bucket_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %init_head, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `    %res_slot = llvm.alloca %c1_i32 x i1 : (i32) -> !llvm.ptr\n`;
      header += `    %false_val = arith.constant false\n`;
      header += `    llvm.store %false_val, %res_slot : i1, !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %c0_i32 = arith.constant 0 : i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %has_curr = llvm.icmp "ne" %curr, %null_ptr : !llvm.ptr\n`;
      header += `      scf.condition(%has_curr)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %curr = llvm.load %curr_slot : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %k_ptr = llvm.getelementptr %curr[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `      %curr_key = llvm.load %k_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `      %cmp = llvm.call @strcmp(%curr_key, %key) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      %is_eq = arith.cmpi eq, %cmp, %c0_i32 : i32\n`;
      header += `      scf.if %is_eq {\n`;
      header += `        %true_val = arith.constant true\n`;
      header += `        llvm.store %true_val, %res_slot : i1, !llvm.ptr\n`;
      header += `        llvm.store %null_ptr, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      } else {\n`;
      header += `        %next_ptr = llvm.getelementptr %curr[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, f64, !llvm.ptr)>\n`;
      header += `        %next = llvm.load %next_ptr : !llvm.ptr -> !llvm.ptr\n`;
      header += `        llvm.store %next, %curr_slot : !llvm.ptr, !llvm.ptr\n`;
      header += `        scf.yield\n`;
      header += `      }\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.load %res_slot : !llvm.ptr -> i1\n`;
      header += `    func.return %res : i1\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_map_size(%map: !llvm.ptr) -> i64 {\n`;
      header += `    %sz_ptr = llvm.getelementptr %map[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, i64, !llvm.ptr)>\n`;
      header += `    %sz = llvm.load %sz_ptr : !llvm.ptr -> i64\n`;
      header += `    func.return %sz : i64\n`;
      header += `  }\n\n`;
    }

    // --- THREAD-SAFE CHANNEL RUNTIME FONKSİYONLARI ---
    if (this.usedFeatures.channels) {
      // 1. @rts_chan_new(capacity: i64) -> !llvm.ptr
      header += `  func.func @rts_chan_new(%cap: i64) -> !llvm.ptr {\n`;
      header += `    %c64 = llvm.mlir.constant(64 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %c8 = llvm.mlir.constant(8 : i64) : i64\n`;
      header += `    %null = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %chan = llvm.call @malloc(%c64) : (i64) -> !llvm.ptr\n`;
      header += `    %mtx = llvm.call @malloc(%c64) : (i64) -> !llvm.ptr\n`;
      header += `    llvm.call @pthread_mutex_init(%mtx, %null) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    %p_mtx = llvm.getelementptr %chan[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %mtx, %p_mtx : !llvm.ptr, !llvm.ptr\n`;
      header += `    %cv_r = llvm.call @malloc(%c64) : (i64) -> !llvm.ptr\n`;
      header += `    llvm.call @pthread_cond_init(%cv_r, %null) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    %p_cv_r = llvm.getelementptr %chan[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %cv_r, %p_cv_r : !llvm.ptr, !llvm.ptr\n`;
      header += `    %cv_s = llvm.call @malloc(%c64) : (i64) -> !llvm.ptr\n`;
      header += `    llvm.call @pthread_cond_init(%cv_s, %null) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `    %p_cv_s = llvm.getelementptr %chan[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %cv_s, %p_cv_s : !llvm.ptr, !llvm.ptr\n`;
      header += `    %is_zero = arith.cmpi sle, %cap, %c0 : i64\n`;
      header += `    %real_cap = arith.select %is_zero, %c1, %cap : i64\n`;
      header += `    %buf_bytes = arith.muli %real_cap, %c8 : i64\n`;
      header += `    %buf = llvm.call @malloc(%buf_bytes) : (i64) -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %chan[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %buf, %p_buf : !llvm.ptr, !llvm.ptr\n`;
      header += `    %p_head = llvm.getelementptr %chan[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_head : i64, !llvm.ptr\n`;
      header += `    %p_tail = llvm.getelementptr %chan[0, 5] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_tail : i64, !llvm.ptr\n`;
      header += `    %p_cnt = llvm.getelementptr %chan[0, 6] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_cnt : i64, !llvm.ptr\n`;
      header += `    %p_cap = llvm.getelementptr %chan[0, 7] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    llvm.store %real_cap, %p_cap : i64, !llvm.ptr\n`;
      header += `    func.return %chan : !llvm.ptr\n`;
      header += `  }\n\n`;

      // 2. @rts_chan_send_f64(chan: !llvm.ptr, val: f64)
      header += `  func.func @rts_chan_send_f64(%chan: !llvm.ptr, %val: f64) {\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %p_mtx = llvm.getelementptr %chan[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %mtx = llvm.load %p_mtx : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cv_s = llvm.getelementptr %chan[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cv_s = llvm.load %p_cv_s : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cv_r = llvm.getelementptr %chan[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cv_r = llvm.load %p_cv_r : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %chan[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_tail = llvm.getelementptr %chan[0, 5] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %p_cnt = llvm.getelementptr %chan[0, 6] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %p_cap = llvm.getelementptr %chan[0, 7] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cap = llvm.load %p_cap : !llvm.ptr -> i64\n`;
      header += `    llvm.call @pthread_mutex_lock(%mtx) : (!llvm.ptr) -> i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %cnt = llvm.load %p_cnt : !llvm.ptr -> i64\n`;
      header += `      %full = arith.cmpi sge, %cnt, %cap : i64\n`;
      header += `      scf.condition(%full)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      llvm.call @pthread_cond_wait(%cv_s, %mtx) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %tail = llvm.load %p_tail : !llvm.ptr -> i64\n`;
      header += `    %slot = llvm.getelementptr %buf[%tail] : (!llvm.ptr, i64) -> !llvm.ptr, f64\n`;
      header += `    llvm.store %val, %slot : f64, !llvm.ptr\n`;
      header += `    %next_tail = arith.addi %tail, %c1 : i64\n`;
      header += `    %wrap_tail = arith.remui %next_tail, %cap : i64\n`;
      header += `    llvm.store %wrap_tail, %p_tail : i64, !llvm.ptr\n`;
      header += `    %cnt_now = llvm.load %p_cnt : !llvm.ptr -> i64\n`;
      header += `    %new_cnt = arith.addi %cnt_now, %c1 : i64\n`;
      header += `    llvm.store %new_cnt, %p_cnt : i64, !llvm.ptr\n`;
      header += `    llvm.call @pthread_cond_signal(%cv_r) : (!llvm.ptr) -> i32\n`;
      header += `    llvm.call @pthread_mutex_unlock(%mtx) : (!llvm.ptr) -> i32\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      // 3. @rts_chan_recv_f64(chan: !llvm.ptr) -> f64
      header += `  func.func @rts_chan_recv_f64(%chan: !llvm.ptr) -> f64 {\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %p_mtx = llvm.getelementptr %chan[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %mtx = llvm.load %p_mtx : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cv_r = llvm.getelementptr %chan[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cv_r = llvm.load %p_cv_r : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cv_s = llvm.getelementptr %chan[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cv_s = llvm.load %p_cv_s : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %chan[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_head = llvm.getelementptr %chan[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %p_cnt = llvm.getelementptr %chan[0, 6] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %p_cap = llvm.getelementptr %chan[0, 7] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i64, i64, i64, i64)>\n`;
      header += `    %cap = llvm.load %p_cap : !llvm.ptr -> i64\n`;
      header += `    llvm.call @pthread_mutex_lock(%mtx) : (!llvm.ptr) -> i32\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %cnt = llvm.load %p_cnt : !llvm.ptr -> i64\n`;
      header += `      %empty = arith.cmpi eq, %cnt, %c0 : i64\n`;
      header += `      scf.condition(%empty)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      llvm.call @pthread_cond_wait(%cv_r, %mtx) : (!llvm.ptr, !llvm.ptr) -> i32\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %head = llvm.load %p_head : !llvm.ptr -> i64\n`;
      header += `    %slot = llvm.getelementptr %buf[%head] : (!llvm.ptr, i64) -> !llvm.ptr, f64\n`;
      header += `    %val = llvm.load %slot : !llvm.ptr -> f64\n`;
      header += `    %next_head = arith.addi %head, %c1 : i64\n`;
      header += `    %wrap_head = arith.remui %next_head, %cap : i64\n`;
      header += `    llvm.store %wrap_head, %p_head : i64, !llvm.ptr\n`;
      header += `    %cnt_now = llvm.load %p_cnt : !llvm.ptr -> i64\n`;
      header += `    %new_cnt = arith.subi %cnt_now, %c1 : i64\n`;
      header += `    llvm.store %new_cnt, %p_cnt : i64, !llvm.ptr\n`;
      header += `    llvm.call @pthread_cond_signal(%cv_s) : (!llvm.ptr) -> i32\n`;
      header += `    llvm.call @pthread_mutex_unlock(%mtx) : (!llvm.ptr) -> i32\n`;
      header += `    func.return %val : f64\n`;
      header += `  }\n\n`;
    }

    // --- ÖZEL BELLEK YÖNETİCİLERİ (CUSTOM ALLOCATORS) ---
    if (this.usedFeatures.allocators) {
      // 1. ARENA ALLOCATOR (!llvm.struct<(!llvm.ptr, i64, i64)>: buffer, capacity, offset)
      header += `  func.func @rts_arena_new(%cap: i64) -> !llvm.ptr {\n`;
      header += `    %c24 = llvm.mlir.constant(24 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1024 = llvm.mlir.constant(1024 : i64) : i64\n`;
      header += `    %is_le = arith.cmpi sle, %cap, %c0 : i64\n`;
      header += `    %real_cap = arith.select %is_le, %c1024, %cap : i64\n`;
      header += `    %arena = llvm.call @malloc(%c24) : (i64) -> !llvm.ptr\n`;
      header += `    %buf = llvm.call @malloc(%real_cap) : (i64) -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %arena[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %buf, %p_buf : !llvm.ptr, !llvm.ptr\n`;
      header += `    %p_cap = llvm.getelementptr %arena[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %real_cap, %p_cap : i64, !llvm.ptr\n`;
      header += `    %p_off = llvm.getelementptr %arena[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return %arena : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_arena_alloc(%arena: !llvm.ptr, %size: i64) -> !llvm.ptr {\n`;
      header += `    %c7 = llvm.mlir.constant(7 : i64) : i64\n`;
      header += `    %c_mask = llvm.mlir.constant(-8 : i64) : i64\n`;
      header += `    %s1 = arith.addi %size, %c7 : i64\n`;
      header += `    %aligned_sz = arith.andi %s1, %c_mask : i64\n`;
      header += `    %p_buf = llvm.getelementptr %arena[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cap = llvm.getelementptr %arena[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %cap = llvm.load %p_cap : !llvm.ptr -> i64\n`;
      header += `    %p_off = llvm.getelementptr %arena[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %off = llvm.load %p_off : !llvm.ptr -> i64\n`;
      header += `    %new_off = arith.addi %off, %aligned_sz : i64\n`;
      header += `    %overflow = arith.cmpi ugt, %new_off, %cap : i64\n`;
      header += `    scf.if %overflow {\n`;
      header += `      llvm.call @abort() : () -> ()\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.getelementptr %buf[%off] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %new_off, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return %res : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_arena_reset(%arena: !llvm.ptr) {\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %p_off = llvm.getelementptr %arena[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_arena_destroy(%arena: !llvm.ptr) {\n`;
      header += `    %p_buf = llvm.getelementptr %arena[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.call @free(%buf) : (!llvm.ptr) -> ()\n`;
      header += `    llvm.call @free(%arena) : (!llvm.ptr) -> ()\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      // 2. POOL ALLOCATOR (!llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>: buffer, free_list_head, chunk_sz, chunk_cnt)
      header += `  func.func @rts_pool_new(%chunk_sz: i64, %chunk_cnt: i64) -> !llvm.ptr {\n`;
      header += `    %c32 = llvm.mlir.constant(32 : i64) : i64\n`;
      header += `    %c8 = llvm.mlir.constant(8 : i64) : i64\n`;
      header += `    %c7 = llvm.mlir.constant(7 : i64) : i64\n`;
      header += `    %c_mask = llvm.mlir.constant(-8 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %c1 = llvm.mlir.constant(1 : i64) : i64\n`;
      header += `    %s1 = arith.addi %chunk_sz, %c7 : i64\n`;
      header += `    %aligned_sz = arith.andi %s1, %c_mask : i64\n`;
      header += `    %is_sz_small = arith.cmpi slt, %aligned_sz, %c8 : i64\n`;
      header += `    %real_sz = arith.select %is_sz_small, %c8, %aligned_sz : i64\n`;
      header += `    %total_bytes = arith.muli %real_sz, %chunk_cnt : i64\n`;
      header += `    %pool = llvm.call @malloc(%c32) : (i64) -> !llvm.ptr\n`;
      header += `    %buf = llvm.call @malloc(%total_bytes) : (i64) -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %pool[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %buf, %p_buf : !llvm.ptr, !llvm.ptr\n`;
      header += `    %p_head = llvm.getelementptr %pool[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %buf, %p_head : !llvm.ptr, !llvm.ptr\n`;
      header += `    %p_sz = llvm.getelementptr %pool[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %real_sz, %p_sz : i64, !llvm.ptr\n`;
      header += `    %p_cnt = llvm.getelementptr %pool[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %chunk_cnt, %p_cnt : i64, !llvm.ptr\n`;
      header += `    %c1_i32 = arith.constant 1 : i32\n`;
      header += `    %idx_slot = llvm.alloca %c1_i32 x i64 : (i32) -> !llvm.ptr\n`;
      header += `    llvm.store %c0, %idx_slot : i64, !llvm.ptr\n`;
      header += `    %last_idx = arith.subi %chunk_cnt, %c1 : i64\n`;
      header += `    scf.while : () -> () {\n`;
      header += `      %i = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `      %cond = arith.cmpi slt, %i, %last_idx : i64\n`;
      header += `      scf.condition(%cond)\n`;
      header += `    } do {\n`;
      header += `    ^bb0:\n`;
      header += `      %i = llvm.load %idx_slot : !llvm.ptr -> i64\n`;
      header += `      %byte_off = arith.muli %i, %real_sz : i64\n`;
      header += `      %curr_chunk = llvm.getelementptr %buf[%byte_off] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      %next_i = arith.addi %i, %c1 : i64\n`;
      header += `      %next_byte_off = arith.muli %next_i, %real_sz : i64\n`;
      header += `      %next_chunk = llvm.getelementptr %buf[%next_byte_off] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `      llvm.store %next_chunk, %curr_chunk : !llvm.ptr, !llvm.ptr\n`;
      header += `      llvm.store %next_i, %idx_slot : i64, !llvm.ptr\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %last_byte_off = arith.muli %last_idx, %real_sz : i64\n`;
      header += `    %last_chunk = llvm.getelementptr %buf[%last_byte_off] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %null_ptr, %last_chunk : !llvm.ptr, !llvm.ptr\n`;
      header += `    func.return %pool : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_pool_alloc(%pool: !llvm.ptr) -> !llvm.ptr {\n`;
      header += `    %p_head = llvm.getelementptr %pool[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    %head = llvm.load %p_head : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %null_ptr = llvm.mlir.zero : !llvm.ptr\n`;
      header += `    %is_null = llvm.icmp "eq" %head, %null_ptr : !llvm.ptr\n`;
      header += `    scf.if %is_null {\n`;
      header += `      llvm.call @abort() : () -> ()\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %next = llvm.load %head : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %next, %p_head : !llvm.ptr, !llvm.ptr\n`;
      header += `    func.return %head : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_pool_free(%pool: !llvm.ptr, %chunk: !llvm.ptr) {\n`;
      header += `    %p_head = llvm.getelementptr %pool[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    %curr_head = llvm.load %p_head : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.store %curr_head, %chunk : !llvm.ptr, !llvm.ptr\n`;
      header += `    llvm.store %chunk, %p_head : !llvm.ptr, !llvm.ptr\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_pool_destroy(%pool: !llvm.ptr) {\n`;
      header += `    %p_buf = llvm.getelementptr %pool[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, !llvm.ptr, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.call @free(%buf) : (!llvm.ptr) -> ()\n`;
      header += `    llvm.call @free(%pool) : (!llvm.ptr) -> ()\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      // 3. FIXED BUFFER ALLOCATOR (!llvm.struct<(!llvm.ptr, i64, i64)>: buffer, capacity, offset)
      header += `  func.func @rts_fixed_buffer_new(%cap: i64) -> !llvm.ptr {\n`;
      header += `    %c24 = llvm.mlir.constant(24 : i64) : i64\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %fb = llvm.call @malloc(%c24) : (i64) -> !llvm.ptr\n`;
      header += `    %buf = llvm.call @malloc(%cap) : (i64) -> !llvm.ptr\n`;
      header += `    %p_buf = llvm.getelementptr %fb[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %buf, %p_buf : !llvm.ptr, !llvm.ptr\n`;
      header += `    %p_cap = llvm.getelementptr %fb[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %cap, %p_cap : i64, !llvm.ptr\n`;
      header += `    %p_off = llvm.getelementptr %fb[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return %fb : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_fixed_buffer_alloc(%fb: !llvm.ptr, %size: i64) -> !llvm.ptr {\n`;
      header += `    %c7 = llvm.mlir.constant(7 : i64) : i64\n`;
      header += `    %c_mask = llvm.mlir.constant(-8 : i64) : i64\n`;
      header += `    %s1 = arith.addi %size, %c7 : i64\n`;
      header += `    %aligned_sz = arith.andi %s1, %c_mask : i64\n`;
      header += `    %p_buf = llvm.getelementptr %fb[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    %p_cap = llvm.getelementptr %fb[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %cap = llvm.load %p_cap : !llvm.ptr -> i64\n`;
      header += `    %p_off = llvm.getelementptr %fb[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %off = llvm.load %p_off : !llvm.ptr -> i64\n`;
      header += `    %new_off = arith.addi %off, %aligned_sz : i64\n`;
      header += `    %overflow = arith.cmpi ugt, %new_off, %cap : i64\n`;
      header += `    scf.if %overflow {\n`;
      header += `      llvm.call @abort() : () -> ()\n`;
      header += `      scf.yield\n`;
      header += `    }\n`;
      header += `    %res = llvm.getelementptr %buf[%off] : (!llvm.ptr, i64) -> !llvm.ptr, i8\n`;
      header += `    llvm.store %new_off, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return %res : !llvm.ptr\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_fixed_buffer_reset(%fb: !llvm.ptr) {\n`;
      header += `    %c0 = llvm.mlir.constant(0 : i64) : i64\n`;
      header += `    %p_off = llvm.getelementptr %fb[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    llvm.store %c0, %p_off : i64, !llvm.ptr\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;

      header += `  func.func @rts_fixed_buffer_destroy(%fb: !llvm.ptr) {\n`;
      header += `    %p_buf = llvm.getelementptr %fb[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(!llvm.ptr, i64, i64)>\n`;
      header += `    %buf = llvm.load %p_buf : !llvm.ptr -> !llvm.ptr\n`;
      header += `    llvm.call @free(%buf) : (!llvm.ptr) -> ()\n`;
      header += `    llvm.call @free(%fb) : (!llvm.ptr) -> ()\n`;
      header += `    func.return\n`;
      header += `  }\n\n`;
    }

    return header + this.buffer.join("\n") + "\n}\n";
  }
}