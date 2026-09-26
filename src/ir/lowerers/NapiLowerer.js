// src/ir/lowerers/NapiLowerer.js

export class NapiLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  emitNapiWrappers() {
    const { napiFunctions, functionRegistry, builder } = this.astLowerer;
    if (!napiFunctions || napiFunctions.length === 0) return;
    builder.markFeature("napi");

    for (const fn of napiFunctions) {
      const origName = fn.origName;
      const fnMeta = functionRegistry.get(origName);
      if (!fnMeta) continue;

      const wrapperName = `__napi_wrap_${origName}`;
      fn.wrapperName = wrapperName;

      // 1. Thunk Fonksiyonu: func.func @__napi_wrap_*(%env: !llvm.ptr, %info: !llvm.ptr) -> !llvm.ptr
      builder.block(`func.func @${wrapperName}(%arg_env: !llvm.ptr, %arg_info: !llvm.ptr) -> !llvm.ptr`, () => {
        const paramCount = fnMeta.params?.length || 0;
        const c_param_cnt = builder.nextSSA();
        builder.emit(`${c_param_cnt} = llvm.mlir.constant(${paramCount} : i64) : i64`);

        // argc slotu (i64)
        const argcSlot = builder.allocateStack("i64");
        builder.store(argcSlot.ptr, { ssa: c_param_cnt, type: "i64" });

        // args slot dizisi
        const arrSize = Math.max(paramCount, 1);
        const argsArray = builder.allocateStack(`!llvm.array<${arrSize} x !llvm.ptr>`);
        const nullPtr = builder.nextSSA();
        builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);

        // napi_get_cb_info(env, info, &argc, args, NULL, NULL)
        builder.emit(
          `llvm.call @napi_get_cb_info(%arg_env, %arg_info, ${argcSlot.ptr}, ${argsArray.ptr}, ${nullPtr}, ${nullPtr}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32`
        );

        // Parametreleri JS değerlerinden yerel tiplere çek
        const callArgs = [];
        for (let i = 0; i < paramCount; i++) {
          const p = fnMeta.params[i];
          const elemGEP = builder.nextSSA();
          builder.emit(`${elemGEP} = llvm.getelementptr ${argsArray.ptr}[0, ${i}] : (!llvm.ptr) -> !llvm.ptr, !llvm.array<${arrSize} x !llvm.ptr>`);
          const napiVal = builder.load(elemGEP, "!llvm.ptr");

          if (p.type === "f64" || p.type === "i64" || p.type === "i32") {
            const outSlot = builder.allocateStack("f64");
            builder.emit(`llvm.call @napi_get_value_double(%arg_env, ${napiVal.ssa}, ${outSlot.ptr}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32`);
            let loaded = builder.load(outSlot.ptr, "f64");
            if (p.type === "i64") loaded = this.astLowerer.coerceType(loaded, "i64");
            if (p.type === "i32") loaded = this.astLowerer.coerceType(loaded, "i32");
            callArgs.push(loaded.ssa);
          } else if (p.type === "i1") {
            const outSlot = builder.allocateStack("i1");
            builder.emit(`llvm.call @napi_get_value_bool(%arg_env, ${napiVal.ssa}, ${outSlot.ptr}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr) -> i32`);
            const loaded = builder.load(outSlot.ptr, "i1");
            callArgs.push(loaded.ssa);
          } else {
            const c256 = builder.nextSSA();
            builder.emit(`${c256} = llvm.mlir.constant(256 : i64) : i64`);
            const strBuf = builder.allocateStack("!llvm.array<256 x i8>");
            const copiedLen = builder.allocateStack("i64");
            builder.emit(
              `llvm.call @napi_get_value_string_utf8(%arg_env, ${napiVal.ssa}, ${strBuf.ptr}, ${c256}, ${copiedLen.ptr}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32`
            );
            callArgs.push(strBuf.ptr);
          }
        }

        // Asıl fonksiyonu çağır
        const callTarget = fn.exportName || origName;
        const callSig = fnMeta.declSig;
        const retType = fnMeta.retType;

        let nativeResultSSA = null;
        if (retType === "none") {
          builder.emit(`func.call @${callTarget}(${callArgs.join(", ")}) : ${callSig}`);
          builder.emit(`func.return ${nullPtr} : !llvm.ptr`);
          return;
        } else {
          nativeResultSSA = builder.nextSSA();
          builder.emit(`${nativeResultSSA} = func.call @${callTarget}(${callArgs.join(", ")}) : ${callSig}`);
        }

        // Dönen sonucu JS nesnesine sar
        const jsRetSlot = builder.allocateStack("!llvm.ptr");

        if (retType === "f64" || retType === "i64" || retType === "i32") {
          let asF64 = { ssa: nativeResultSSA, type: retType };
          if (retType !== "f64") asF64 = this.astLowerer.coerceType(asF64, "f64");
          builder.emit(`llvm.call @napi_create_double(%arg_env, ${asF64.ssa}, ${jsRetSlot.ptr}) : (!llvm.ptr, f64, !llvm.ptr) -> i32`);
        } else if (retType === "i1") {
          builder.emit(`llvm.call @napi_get_boolean(%arg_env, ${nativeResultSSA}, ${jsRetSlot.ptr}) : (!llvm.ptr, i1, !llvm.ptr) -> i32`);
        } else if (retType === "!llvm.ptr" || fnMeta.isRetString) {
          const len64 = builder.nextSSA();
          builder.emit(`${len64} = func.call @rts_strlen(${nativeResultSSA}) : (!llvm.ptr) -> i64`);
          builder.emit(
            `llvm.call @napi_create_string_utf8(%arg_env, ${nativeResultSSA}, ${len64}, ${jsRetSlot.ptr}) : (!llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32`
          );
        } else {
          builder.emit(`llvm.store ${nullPtr}, ${jsRetSlot.ptr} : !llvm.ptr, !llvm.ptr`);
        }

        const finalJsVal = builder.load(jsRetSlot.ptr, "!llvm.ptr");
        builder.emit(`func.return ${finalJsVal.ssa} : !llvm.ptr`);
      });
    }

    // 2. Modül Kayıt Noktası: func.func @napi_register_module_v1(%env: !llvm.ptr, %exports: !llvm.ptr) -> !llvm.ptr
    builder.block(`func.func @napi_register_module_v1(%arg_env: !llvm.ptr, %arg_exports: !llvm.ptr) -> !llvm.ptr`, () => {
      const fnCount = napiFunctions.length;
      const propArray = builder.allocateStack(`!llvm.array<${fnCount} x !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i32, !llvm.ptr)>>`);
      const nullPtr = builder.nextSSA();
      builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
      const zeroI32 = builder.createConstant(0, "i32");

      napiFunctions.forEach((fn, idx) => {
        const nameSym = builder.getOrRegisterString(fn.exportName);
        const nameAddr = builder.nextSSA();
        builder.emit(`${nameAddr} = llvm.mlir.addressof ${nameSym} : !llvm.ptr`);

        const wrapperAddr = builder.nextSSA();
        builder.emit(`${wrapperAddr} = func.constant @${fn.wrapperName} : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr`);

        const wrapperPtr = builder.nextSSA();
        builder.emit(
          `${wrapperPtr} = builtin.unrealized_conversion_cast ${wrapperAddr} : (!llvm.ptr, !llvm.ptr) -> !llvm.ptr to !llvm.ptr`
        );

        const storeField = (fIdx, val, valType) => {
          const p = builder.nextSSA();
          builder.emit(`${p} = llvm.getelementptr ${propArray.ptr}[0, ${idx}, ${fIdx}] : (!llvm.ptr) -> !llvm.ptr, !llvm.array<${fnCount} x !llvm.struct<(!llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, !llvm.ptr, i32, !llvm.ptr)>>`);
          builder.emit(`llvm.store ${val}, ${p} : ${valType}, !llvm.ptr`);
        };

        // Tüm 8 alanı eksiksiz ve güvenli bir şekilde ilklendir (Sıfırla)
        storeField(0, nameAddr, "!llvm.ptr");    // utf8name
        storeField(1, nullPtr, "!llvm.ptr");     // name
        storeField(2, wrapperPtr, "!llvm.ptr");  // method
        storeField(3, nullPtr, "!llvm.ptr");     // getter
        storeField(4, nullPtr, "!llvm.ptr");     // setter
        storeField(5, nullPtr, "!llvm.ptr");     // value
        storeField(6, zeroI32.ssa, "i32");       // attributes
        storeField(7, nullPtr, "!llvm.ptr");     // data
      });

      const countConst = builder.nextSSA();
      builder.emit(`${countConst} = llvm.mlir.constant(${fnCount} : i64) : i64`);

      builder.emit(
        `llvm.call @napi_define_properties(%arg_env, %arg_exports, ${countConst}, ${propArray.ptr}) : (!llvm.ptr, !llvm.ptr, i64, !llvm.ptr) -> i32`
      );

      builder.emit(`func.return %arg_exports : !llvm.ptr`);
    });
  }

  static emitNapiWrappers(astLowerer) {
    new NapiLowerer(astLowerer).emitNapiWrappers();
  }
}
