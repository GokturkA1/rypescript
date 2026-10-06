// src/ir/lowerers/ClassLowerer.js

export class ClassLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  emitVCallRouters() {
    const { classList, structRegistry, vcallRouters, builder } = this.astLowerer;
    if (!classList || classList.length === 0) return;

    for (const baseCls of classList) {
      const baseMeta = structRegistry.get(baseCls.name);
      if (!baseMeta) continue;

      for (const [mName, mMeta] of baseMeta.methods.entries()) {
        if (mMeta.isConstructor || mMeta.isStatic) continue;

        const overrides = [];
        for (const subCls of classList) {
          if (subCls.name === baseCls.name) continue;
          let curr = structRegistry.get(subCls.name);
          let isDescendant = false;
          while (curr && curr.superClass) {
            if (curr.superClass === baseCls.name) {
              isDescendant = true;
              break;
            }
            curr = structRegistry.get(curr.superClass);
          }

          if (isDescendant) {
            const subMeta = structRegistry.get(subCls.name);
            if (subMeta && subMeta.methods.has(mName)) {
              overrides.push(subMeta);
            }
          }
        }

        if (overrides.length === 0) continue;

        const routerName = `${baseCls.name}_vcall_${mName}`;
        vcallRouters.add(routerName);

        const retType = mMeta.retType;
        const sig = retType === "none" ? "" : ` -> ${retType}`;

        const methodParams = mMeta.params || [];
        const paramSigList = [`%arg_this: !llvm.ptr`, ...methodParams.map((p, idx) => `%arg_${idx}: ${p.type}`)];
        const callArgsList = [`%arg_this`, ...methodParams.map((p, idx) => `%arg_${idx}`)];
        const callTypesList = [`!llvm.ptr`, ...methodParams.map((p) => p.type)];

        builder.block(`func.func @${routerName}(${paramSigList.join(", ")})${sig}`, () => {
          const typeIdSSA = builder.nextSSA();
          builder.emit(`${typeIdSSA} = llvm.load %arg_this : !llvm.ptr -> i32`);

          const isAbstractMethod = Boolean(mMeta.isAbstract);
          let resSlot = null;
          if (retType !== "none") {
            resSlot = builder.allocateStack(retType);
            if (!isAbstractMethod) {
              const defVal = builder.nextSSA();
              builder.emit(
                `${defVal} = func.call @${baseCls.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ${retType}`
              );
              builder.emit(`llvm.store ${defVal}, ${resSlot.ptr} : ${retType}, !llvm.ptr`);
            }
          } else {
            if (!isAbstractMethod) {
              builder.emit(
                `func.call @${baseCls.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ()`
              );
            }
          }

          for (const ov of overrides) {
            const cId = builder.nextSSA();
            const cmp = builder.nextSSA();
            builder.emit(`${cId} = arith.constant ${ov.typeId} : i32`);
            builder.emit(`${cmp} = arith.cmpi eq, ${typeIdSSA}, ${cId} : i32`);

            builder.createIf({ ssa: cmp }, () => {
              if (retType !== "none") {
                const subVal = builder.nextSSA();
                builder.emit(
                  `${subVal} = func.call @${ov.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ${retType}`
                );
                builder.emit(`llvm.store ${subVal}, ${resSlot.ptr} : ${retType}, !llvm.ptr`);
              } else {
                builder.emit(
                  `func.call @${ov.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ()`
                );
              }
            });
          }

          if (retType !== "none") {
            const finalVal = builder.load(resSlot.ptr, retType);
            builder.emit(`func.return ${finalVal.ssa} : ${retType}`);
          } else {
            builder.createReturn();
          }
        });
      }
    }
  }

  static emitVCallRouters(astLowerer) {
    new ClassLowerer(astLowerer).emitVCallRouters();
  }
}
