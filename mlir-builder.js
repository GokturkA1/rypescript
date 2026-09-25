// mlir-builder.js
export class MLIRBuilder {
  constructor() {
    this.ssaCount = 0;
    this.strCount = 0;
    this.indent = 2;
    this.buffer = [];
    this.globalStrings = new Map();
    this.onAllocate = null;

    this.symNumber = this.getOrRegisterString("number");
    this.symString = this.getOrRegisterString("string");
    this.symBoolean = this.getOrRegisterString("boolean");
    this.symObject = this.getOrRegisterString("object");
    this.symTrue = this.getOrRegisterString("true");
    this.symFalse = this.getOrRegisterString("false");
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
      formattedVal = val ? "true" : "false";
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
      : { "+": "arith.addi", "-": "arith.subi", "*": "arith.muli", "/": "arith.divsi", "%": "arith.remsi" };

    this.emit(`${ssa} = ${opMap[op]} ${l.ssa}, ${r.ssa} : ${l.type}`);
    return { ssa, type: l.type };
  }

  createComparison(op, left, right) {
    let l = left;
    let r = right;

    if (l.type === "!llvm.ptr" || r.type === "!llvm.ptr") {
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
      bodyFn();
      this.emit("scf.yield");
    });
  }

  createReturn(val) {
    if (val && val.type !== "none") this.emit(`func.return ${val.ssa || val.ptr} : ${val.type}`);
    else this.emit("func.return");
  }

  createSprintf(fmtStr, args) {
    const sym = this.getOrRegisterString(fmtStr);
    const fmtSSA = this.nextSSA();
    this.emit(`${fmtSSA} = llvm.mlir.addressof ${sym} : !llvm.ptr`);

    const buf = this.allocateHeap(512);
    const allArgsSSA = [buf.ptr, fmtSSA, ...args.map((a) => a.ssa || a.ptr)];
    const allArgsType = ["!llvm.ptr", "!llvm.ptr", ...args.map((a) => a.type)];
    const callSSA = this.nextSSA();

    this.emit(
      `${callSSA} = llvm.call @sprintf(${allArgsSSA.join(", ")}) {var_callee_type = !llvm.func<i32 (!llvm.ptr, !llvm.ptr, ...)>} : (${allArgsType.join(", ")}) -> i32`
    );

    return { ssa: buf.ptr, ptr: buf.ptr, type: "!llvm.ptr", isString: true, isHeap: true };
  }

  printString(ptr) {
    this.emit(`func.call @rts_print_str(${ptr}) : (!llvm.ptr) -> ()`);
  }

  printF64(ssa) {
    this.emit(`func.call @rts_print_f64(${ssa}) : (f64) -> ()`);
  }

  printI32(ssa) {
    this.emit(`func.call @rts_print_i32(${ssa}) : (i32) -> ()`);
  }

  printI64(ssa) {
    this.emit(`func.call @rts_print_i64(${ssa}) : (i64) -> ()`);
  }

  printBool(ssa) {
    this.emit(`func.call @rts_print_bool(${ssa}) : (i1) -> ()`);
  }

  printUnion(ptr) {
    this.emit(`func.call @rts_print_union(${ptr}) : (!llvm.ptr) -> ()`);
  }

  printSpace() {
    this.emit(`func.call @rts_print_space() : () -> ()`);
  }

  printNewline() {
    this.emit(`func.call @rts_print_newline() : () -> ()`);
  }

  buildFullModule() {
    let header = `module attributes {llvm.data_layout = "", llvm.target_triple = "x86_64-pc-linux-gnu"} {\n`;

    header += `  llvm.func @printf(!llvm.ptr, ...) -> i32\n`;
    header += `  llvm.func @sprintf(!llvm.ptr, !llvm.ptr, ...) -> i32\n`;
    header += `  llvm.func @malloc(i64) -> !llvm.ptr\n`;
    header += `  llvm.func @calloc(i64, i64) -> !llvm.ptr\n`;
    header += `  llvm.func @free(!llvm.ptr) -> ()\n`;
    header += `  llvm.func @abort() -> ()\n`;
    header += `  llvm.func @strcmp(!llvm.ptr, !llvm.ptr) -> i32\n`;
    header += `  llvm.func @setjmp(!llvm.ptr) -> i32\n`;
    header += `  llvm.func @longjmp(!llvm.ptr, i32) -> ()\n`;
    header += `  func.func private @pthread_create(!llvm.ptr, !llvm.ptr, (!llvm.ptr) -> !llvm.ptr, !llvm.ptr) -> i32\n`;
    header += `  llvm.func @pthread_join(i64, !llvm.ptr) -> i32\n`;
    header += `  llvm.func @usleep(i32) -> i32\n\n`;

    header += `  llvm.mlir.global internal constant @fmt_f64("%f\\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_i32("%d\\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_i64("%ld\\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_str("%s\\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_space(" \\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_nl("\\0A\\00")\n`;
    header += `  llvm.mlir.global internal constant @fmt_uncaught_err("Uncaught Exception: %s\\0A\\00")\n\n`;

    header += `  llvm.mlir.global internal @rts_current_jmpbuf() : !llvm.ptr {\n`;
    header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
    header += `    llvm.return %0 : !llvm.ptr\n`;
    header += `  }\n\n`;

    header += `  llvm.mlir.global internal @rts_current_exception() : !llvm.ptr {\n`;
    header += `    %0 = llvm.mlir.zero : !llvm.ptr\n`;
    header += `    llvm.return %0 : !llvm.ptr\n`;
    header += `  }\n\n`;

    for (const [text, sym] of this.globalStrings.entries()) {
      const escaped = text
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\0A")
        .replace(/"/g, '\\"') + "\\00";
      header += `  llvm.mlir.global internal constant ${sym}("${escaped}")\n`;
    }
    header += `\n`;

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

    // --- UNION RUNTIME FONKSİYONLARI ---
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
    header += `        scf.yield\n`;
    header += `      }\n`;
    header += `      scf.yield\n`;
    header += `    }\n`;
    header += `    func.return\n`;
    header += `  }\n\n`;

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
    header += `      %fmt_i = llvm.mlir.addressof @fmt_i64 : !llvm.ptr\n`;
    header += `      %buf_sz = llvm.mlir.constant(64 : i64) : i64\n`;
    header += `      %buf = llvm.call @malloc(%buf_sz) : (i64) -> !llvm.ptr\n`;
    header += `      llvm.call @sprintf(%buf, %fmt_i, %ival) {var_callee_type = !llvm.func<i32 (!llvm.ptr, !llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr, i64) -> i32\n`;
    header += `      llvm.store %buf, %res_slot : !llvm.ptr, !llvm.ptr\n`;
    header += `      scf.yield\n`;
    header += `    } else {\n`;
    header += `      %is_f64 = arith.cmpi eq, %tag, %c2 : i32\n`;
    header += `      scf.if %is_f64 {\n`;
    header += `        %fval = llvm.load %payload_ptr : !llvm.ptr -> f64\n`;
    header += `        %fmt_f = llvm.mlir.addressof @fmt_f64 : !llvm.ptr\n`;
    header += `        %buf_sz2 = llvm.mlir.constant(64 : i64) : i64\n`;
    header += `        %buf2 = llvm.call @malloc(%buf_sz2) : (i64) -> !llvm.ptr\n`;
    header += `        llvm.call @sprintf(%buf2, %fmt_f, %fval) {var_callee_type = !llvm.func<i32 (!llvm.ptr, !llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr, f64) -> i32\n`;
    header += `        llvm.store %buf2, %res_slot : !llvm.ptr, !llvm.ptr\n`;
    header += `      } else {\n`;
    header += `        %is_str = arith.cmpi eq, %tag, %c3 : i32\n`;
    header += `        scf.if %is_str {\n`;
    header += `          %strval = llvm.load %payload_ptr : !llvm.ptr -> !llvm.ptr\n`;
    header += `          llvm.store %strval, %res_slot : !llvm.ptr, !llvm.ptr\n`;
    header += `        } else {\n`;
    header += `          %bval = llvm.load %payload_ptr : !llvm.ptr -> i64\n`;
    header += `          %fmt_i2 = llvm.mlir.addressof @fmt_i64 : !llvm.ptr\n`;
    header += `          %buf_sz3 = llvm.mlir.constant(64 : i64) : i64\n`;
    header += `          %buf3 = llvm.call @malloc(%buf_sz3) : (i64) -> !llvm.ptr\n`;
    header += `          llvm.call @sprintf(%buf3, %fmt_i2, %bval) {var_callee_type = !llvm.func<i32 (!llvm.ptr, !llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr, i64) -> i32\n`;
    header += `          llvm.store %buf3, %res_slot : !llvm.ptr, !llvm.ptr\n`;
    header += `        }\n`;
    header += `      }\n`;
    header += `    }\n`;
    header += `    %final_str = llvm.load %res_slot : !llvm.ptr -> !llvm.ptr\n`;
    header += `    func.return %final_str : !llvm.ptr\n`;
    header += `  }\n\n`;

    // --- HASH TABLE (MAP & SET) RUNTIME FONKSİYONLARI ---
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

    return header + this.buffer.join("\n") + "\n}\n";
  }
}