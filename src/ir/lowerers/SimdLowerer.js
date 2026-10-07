// src/ir/lowerers/SimdLowerer.js

export class SimdLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  lowerExpression(...args) { return this.astLowerer.lowerExpression(...args); }
  coerceType(...args) { return this.astLowerer.coerceType(...args); }

  tryLowerSIMDCall(expr) {
    const VECTOR_META = {
      f32x4: { len: 4, elem: "f32", mlirType: "vector<4xf32>", isFloat: true },
      f64x2: { len: 2, elem: "f64", mlirType: "vector<2xf64>", isFloat: true },
      i32x4: { len: 4, elem: "i32", mlirType: "vector<4xi32>", isFloat: false },
      i64x2: { len: 2, elem: "i64", mlirType: "vector<2xi64>", isFloat: false },
      f64x4: { len: 4, elem: "f64", mlirType: "vector<4xf64>", isFloat: true },
      f32x8: { len: 8, elem: "f32", mlirType: "vector<8xf32>", isFloat: true },
      i32x8: { len: 8, elem: "i32", mlirType: "vector<8xi32>", isFloat: false },
    };

    let calleeName = null;
    let memberObj = null;
    let memberProp = null;

    if (expr.callee.type === "Identifier") {
      calleeName = expr.callee.name;
    } else if (expr.callee.type === "MemberExpression" && !expr.callee.computed) {
      memberObj = expr.callee.object?.name;
      memberProp = expr.callee.property?.name || expr.callee.property?.value;
    }

    // 1. Doğrudan veya simd.f32x4(...) constructor çağrısı
    let ctorType = null;
    if (calleeName && VECTOR_META[calleeName]) {
      ctorType = calleeName;
    } else if (memberObj === "simd" && memberProp && VECTOR_META[memberProp]) {
      ctorType = memberProp;
    }

    if (ctorType) {
      const meta = VECTOR_META[ctorType];
      this.builder.markFeature("vector");
      if (!expr.arguments || expr.arguments.length === 0) {
        return this.builder.createConstant(0, meta.mlirType);
      }
      if (expr.arguments.length === 1) {
        let val = this.lowerExpression(expr.arguments[0]);
        val = this.coerceType(val, meta.elem);
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = vector.broadcast ${val.ssa || val.ptr} : ${meta.elem} to ${meta.mlirType}`);
        return { ssa, type: meta.mlirType, isVector: true };
      }
      const loweredArgs = expr.arguments.map((arg) => {
        let val = this.lowerExpression(arg);
        return this.coerceType(val, meta.elem);
      });
      while (loweredArgs.length < meta.len) {
        loweredArgs.push(this.builder.createConstant(0, meta.elem));
      }
      const ssa = this.builder.nextSSA();
      const argSSAs = loweredArgs.slice(0, meta.len).map((a) => a.ssa || a.ptr).join(", ");
      this.builder.emit(`${ssa} = vector.from_elements ${argSSAs} : ${meta.mlirType}`);
      return { ssa, type: meta.mlirType, isVector: true };
    }

    // 2. splat: f32x4.splat(v) veya simd.splat_f32x4(v)
    if ((memberObj && VECTOR_META[memberObj] && memberProp === "splat") ||
        (memberObj === "simd" && memberProp && memberProp.startsWith("splat_"))) {
      const targetType = memberObj === "simd" ? memberProp.replace("splat_", "") : memberObj;
      const meta = VECTOR_META[targetType];
      if (meta) {
        this.builder.markFeature("vector");
        let val = this.lowerExpression(expr.arguments[0]);
        val = this.coerceType(val, meta.elem);
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = vector.broadcast ${val.ssa || val.ptr} : ${meta.elem} to ${meta.mlirType}`);
        return { ssa, type: meta.mlirType, isVector: true };
      }
    }

    // 3. load: f32x4.load(ptr) veya simd.load_f32x4(ptr)
    if ((memberObj && VECTOR_META[memberObj] && memberProp === "load") ||
        (memberObj === "simd" && memberProp && memberProp.startsWith("load_"))) {
      const targetType = memberObj === "simd" ? memberProp.replace("load_", "") : memberObj;
      const meta = VECTOR_META[targetType];
      if (meta) {
        this.builder.markFeature("vector");
        const ptrVal = this.lowerExpression(expr.arguments[0]);
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.load ${ptrVal.ssa || ptrVal.ptr} : !llvm.ptr -> ${meta.mlirType}`);
        return { ssa, type: meta.mlirType, isVector: true };
      }
    }

    // 4. store: f32x4.store(ptr, vec) veya simd.store(ptr, vec)
    if ((memberObj && VECTOR_META[memberObj] && memberProp === "store") ||
        (memberObj === "simd" && memberProp === "store")) {
      this.builder.markFeature("vector");
      const ptrVal = this.lowerExpression(expr.arguments[0]);
      const vecVal = this.lowerExpression(expr.arguments[1]);
      this.builder.emit(`llvm.store ${vecVal.ssa || vecVal.ptr}, ${ptrVal.ssa || ptrVal.ptr} : ${vecVal.type}, !llvm.ptr`);
      return { ssa: "", type: "none" };
    }

    // 5. Aritmetik: simd.add / sub / mul / div veya f32x4.add / sub / mul / div
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) &&
        ["add", "sub", "mul", "div"].includes(memberProp)) {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const b = this.lowerExpression(expr.arguments[1]);
      const opMap = { add: "+", sub: "-", mul: "*", div: "/" };
      return this.builder.createArithmetic(opMap[memberProp], a, b);
    }

    // 6. fma: simd.fma(a, b, c) veya f32x4.fma(a, b, c)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "fma") {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const b = this.lowerExpression(expr.arguments[1]);
      const c = this.lowerExpression(expr.arguments[2]);
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.fma ${a.ssa || a.ptr}, ${b.ssa || b.ptr}, ${c.ssa || c.ptr} : ${a.type}`);
      return { ssa, type: a.type, isVector: true };
    }

    // 7. reduce_add / sum: simd.reduce_add(a), simd.sum(a), f32x4.reduce_add(a)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) &&
        (memberProp === "reduce_add" || memberProp === "sum")) {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const m = (a.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.reduction <add>, ${a.ssa || a.ptr} : ${a.type} into ${elemType}`);
      if (elemType === "f32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extf ${ssa} : f32 to f64`);
        return { ssa: ext, type: "f64" };
      }
      if (elemType === "i32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extsi ${ssa} : i32 to i64`);
        return { ssa: ext, type: "i64" };
      }
      return { ssa, type: elemType };
    }

    // 8. reduce_mul: simd.reduce_mul(a), f32x4.reduce_mul(a)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "reduce_mul") {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const m = (a.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.reduction <mul>, ${a.ssa || a.ptr} : ${a.type} into ${elemType}`);
      if (elemType === "f32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extf ${ssa} : f32 to f64`);
        return { ssa: ext, type: "f64" };
      }
      if (elemType === "i32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extsi ${ssa} : i32 to i64`);
        return { ssa: ext, type: "i64" };
      }
      return { ssa, type: elemType };
    }

    // 9. reduce_min: simd.reduce_min(a), f32x4.reduce_min(a)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "reduce_min") {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const m = (a.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      const isFloat = elemType.startsWith("f");
      const redKind = isFloat ? "minimumf" : "minsi";
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.reduction <${redKind}>, ${a.ssa || a.ptr} : ${a.type} into ${elemType}`);
      if (elemType === "f32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extf ${ssa} : f32 to f64`);
        return { ssa: ext, type: "f64" };
      }
      if (elemType === "i32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extsi ${ssa} : i32 to i64`);
        return { ssa: ext, type: "i64" };
      }
      return { ssa, type: elemType };
    }

    // 10. reduce_max: simd.reduce_max(a), f32x4.reduce_max(a)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "reduce_max") {
      this.builder.markFeature("vector");
      const a = this.lowerExpression(expr.arguments[0]);
      const m = (a.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      const isFloat = elemType.startsWith("f");
      const redKind = isFloat ? "maximumf" : "maxsi";
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.reduction <${redKind}>, ${a.ssa || a.ptr} : ${a.type} into ${elemType}`);
      if (elemType === "f32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extf ${ssa} : f32 to f64`);
        return { ssa: ext, type: "f64" };
      }
      if (elemType === "i32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extsi ${ssa} : i32 to i64`);
        return { ssa: ext, type: "i64" };
      }
      return { ssa, type: elemType };
    }

    // 11. extract: simd.extract(v, idx), f32x4.extract(v, idx)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "extract") {
      this.builder.markFeature("vector");
      const v = this.lowerExpression(expr.arguments[0]);
      let idxVal = this.lowerExpression(expr.arguments[1]);
      const idxI32 = this.coerceType(idxVal, "i32");
      const idxSSA = this.builder.nextSSA();
      this.builder.emit(`${idxSSA} = arith.index_cast ${idxI32.ssa} : i32 to index`);
      const m = (v.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.extract ${v.ssa || v.ptr}[${idxSSA}] : ${elemType} from ${v.type}`);
      if (elemType === "f32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extf ${ssa} : f32 to f64`);
        return { ssa: ext, type: "f64" };
      }
      if (elemType === "i32") {
        const ext = this.builder.nextSSA();
        this.builder.emit(`${ext} = arith.extsi ${ssa} : i32 to i64`);
        return { ssa: ext, type: "i64" };
      }
      return { ssa, type: elemType };
    }

    // 12. insert: simd.insert(v, idx, val), f32x4.insert(v, idx, val)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "insert") {
      this.builder.markFeature("vector");
      const v = this.lowerExpression(expr.arguments[0]);
      let idxVal = this.lowerExpression(expr.arguments[1]);
      let val = this.lowerExpression(expr.arguments[2]);
      const m = (v.type || "").match(/^vector<(\d+)x([a-z0-9]+)>$/);
      const elemType = m ? m[2] : "f32";
      val = this.coerceType(val, elemType);
      const idxI32 = this.coerceType(idxVal, "i32");
      const idxSSA = this.builder.nextSSA();
      this.builder.emit(`${idxSSA} = arith.index_cast ${idxI32.ssa} : i32 to index`);
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = vector.insert ${val.ssa || val.ptr}, ${v.ssa || v.ptr}[${idxSSA}] : ${elemType} into ${v.type}`);
      return { ssa, type: v.type, isVector: true };
    }

    // 13. sqrt: simd.sqrt(v), f32x4.sqrt(v)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "sqrt") {
      this.builder.markFeature("vector");
      const v = this.lowerExpression(expr.arguments[0]);
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = math.sqrt ${v.ssa || v.ptr} : ${v.type}`);
      return { ssa, type: v.type, isVector: true };
    }

    // 14. abs: simd.abs(v), f32x4.abs(v)
    if ((memberObj === "simd" || (memberObj && VECTOR_META[memberObj])) && memberProp === "abs") {
      this.builder.markFeature("vector");
      const v = this.lowerExpression(expr.arguments[0]);
      const isFloat = v.type.includes("f32") || v.type.includes("f64");
      const ssa = this.builder.nextSSA();
      const absOp = isFloat ? "math.absf" : "math.absi";
      this.builder.emit(`${ssa} = ${absOp} ${v.ssa || v.ptr} : ${v.type}`);
      return { ssa, type: v.type, isVector: true };
    }

    return null;
  }

}
