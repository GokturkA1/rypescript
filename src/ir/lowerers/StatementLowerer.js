// src/ir/lowerers/StatementLowerer.js

export class StatementLowerer {
  constructor(astLowerer) {
    this.astLowerer = astLowerer;
  }

  get builder() { return this.astLowerer.builder; }
  get symbolTable() { return this.astLowerer.symbolTable; }
  get globals() { return this.astLowerer.globals; }
  get structRegistry() { return this.astLowerer.structRegistry; }
  get scopeStack() { return this.astLowerer.scopeStack; }
  get breakTargets() { return this.astLowerer.breakTargets; }
  get continueTargets() { return this.astLowerer.continueTargets; }
  get currentFunctionNode() { return this.astLowerer.currentFunctionNode; }
  set currentFunctionNode(val) { this.astLowerer.currentFunctionNode = val; }
  get currentLoopLabel() { return this.astLowerer.currentLoopLabel; }
  set currentLoopLabel(val) { this.astLowerer.currentLoopLabel = val; }
  get isTopLevel() { return this.astLowerer.isTopLevel; }
  set isTopLevel(val) { this.astLowerer.isTopLevel = val; }

  enterScope(...args) { return this.astLowerer.enterScope(...args); }
  exitScope(...args) { return this.astLowerer.exitScope(...args); }
  lowerExpression(...args) { return this.astLowerer.lowerExpression(...args); }
  isUnionType(...args) { return this.astLowerer.isUnionType(...args); }
  getStructName(...args) { return this.astLowerer.getStructName(...args); }
  checkEscape(...args) { return this.astLowerer.checkEscape(...args); }
  lowerNewExpression(...args) { return this.astLowerer.lowerNewExpression(...args); }
  inferStructName(...args) { return this.astLowerer.inferStructName(...args); }
  instantiateStruct(...args) { return this.astLowerer.instantiateStruct(...args); }
  extractArrayTargetType(...args) { return this.astLowerer.extractArrayTargetType(...args); }
  instantiateArray(...args) { return this.astLowerer.instantiateArray(...args); }
  coerceType(...args) { return this.astLowerer.coerceType(...args); }
  boxIntoUnion(...args) { return this.astLowerer.boxIntoUnion(...args); }
  markTransferred(...args) { return this.astLowerer.markTransferred(...args); }
  isPolymorphicInterface(...args) { return this.astLowerer.isPolymorphicInterface(...args); }
  extractFunctionType(...args) { return this.astLowerer.extractFunctionType(...args); }
  boxIntoInterface(...args) { return this.astLowerer.boxIntoInterface(...args); }
  resolveType(...args) { return this.astLowerer.resolveType(...args); }
  isStringType(...args) { return this.astLowerer.isStringType(...args); }
  trackDisposable(...args) { return this.astLowerer.trackDisposable(...args); }
  cleanupScopesDownTo(...args) { return this.astLowerer.cleanupScopesDownTo(...args); }
  extractNarrowingCheck(...args) { return this.astLowerer.extractNarrowingCheck(...args); }
  unboxUnion(...args) { return this.astLowerer.unboxUnion(...args); }
  getCurrentFunctionRetType(...args) { return this.astLowerer.getCurrentFunctionRetType(...args); }
  getCurrentFunctionStructRetName(...args) { return this.astLowerer.getCurrentFunctionStructRetName(...args); }
  cleanupFunctionScopes(...args) { return this.astLowerer.cleanupFunctionScopes(...args); }

  lowerStatement(stmt) {
    switch (stmt.type) {
      case "TryStatement": {
        // Eğer sadece try {} finally {} ise setjmp/longjmp ek yüküne girmeden doğrudan defer çalıştır!
        if (!stmt.handler && stmt.finalizer) {
          this.enterScope(false);
          const currentScope = this.scopeStack[this.scopeStack.length - 1];
          currentScope.deferrals.push(stmt.finalizer);
          this.lowerStatement(stmt.block);
          this.exitScope();
          break;
        }

        this.builder.markFeature("exceptions");
        const localJmpBuf = this.builder.allocateStack("!llvm.array<200 x i8>");
        const gJmpBufAddr = this.builder.nextSSA();
        this.builder.emit(`${gJmpBufAddr} = llvm.mlir.addressof @rts_current_jmpbuf : !llvm.ptr`);
        const prevJmpBuf = this.builder.load(gJmpBufAddr, "!llvm.ptr");
        this.builder.store(gJmpBufAddr, { ssa: localJmpBuf.ptr, type: "!llvm.ptr" });

        const setjmpRes = this.builder.nextSSA();
        this.builder.emit(`${setjmpRes} = llvm.call @setjmp(${localJmpBuf.ptr}) : (!llvm.ptr) -> i32`);

        const zero = this.builder.createConstant(0, "i32");
        const cmp = this.builder.createComparison("==", { ssa: setjmpRes, type: "i32" }, zero);

        this.enterScope(false);
        if (stmt.finalizer) {
          const currentScope = this.scopeStack[this.scopeStack.length - 1];
          currentScope.deferrals.push(stmt.finalizer);
        }

        this.builder.createIf(
          cmp,
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.block);
            this.builder.store(gJmpBufAddr, prevJmpBuf);
            this.exitScope();
          },
          stmt.handler
            ? () => {
                this.enterScope(false);
                this.builder.store(gJmpBufAddr, prevJmpBuf);
                const gExcAddr = this.builder.nextSSA();
                this.builder.emit(`${gExcAddr} = llvm.mlir.addressof @rts_current_exception : !llvm.ptr`);
                const thrownVal = this.builder.load(gExcAddr, "!llvm.ptr");

                const paramName = stmt.handler.param?.name || "e";
                const prevSym = this.symbolTable.get(paramName);

                const excSlot = this.builder.allocateStack("!llvm.ptr");
                this.builder.store(excSlot.ptr, thrownVal);
                this.symbolTable.set(paramName, {
                  ptr: excSlot.ptr,
                  type: "!llvm.ptr",
                  isString: true,
                  isRef: true,
                });

                this.lowerStatement(stmt.handler.body);

                if (prevSym) this.symbolTable.set(paramName, prevSym);
                else this.symbolTable.delete(paramName);
                this.exitScope();
              }
            : null
        );

        this.exitScope();
        break;
      }

      case "ThrowStatement": {
        const excVal = this.lowerExpression(stmt.argument);
        const gExcAddr = this.builder.nextSSA();
        this.builder.emit(`${gExcAddr} = llvm.mlir.addressof @rts_current_exception : !llvm.ptr`);
        this.builder.store(gExcAddr, { ssa: excVal.ssa || excVal.ptr, type: "!llvm.ptr" });

        const gJmpBufAddr = this.builder.nextSSA();
        this.builder.emit(`${gJmpBufAddr} = llvm.mlir.addressof @rts_current_jmpbuf : !llvm.ptr`);
        const currJmpBuf = this.builder.load(gJmpBufAddr, "!llvm.ptr");

        const nullPtr = this.builder.nextSSA();
        this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);
        const isNull = this.builder.createComparison("==", currJmpBuf, { ssa: nullPtr, type: "!llvm.ptr" });

        this.builder.createIf(
          isNull,
          () => {
            this.builder.markFeature("printf");
            const fmtErr = this.builder.nextSSA();
            this.builder.emit(`${fmtErr} = llvm.mlir.addressof @fmt_uncaught_err : !llvm.ptr`);
            this.builder.emit(`llvm.call @printf(${fmtErr}, ${excVal.ssa || excVal.ptr}) {var_callee_type = !llvm.func<i32 (!llvm.ptr, ...)>} : (!llvm.ptr, !llvm.ptr) -> i32`);
            this.builder.emit(`llvm.call @abort() : () -> ()`);
          },
          () => {
            const one = this.builder.createConstant(1, "i32");
            this.builder.emit(`llvm.call @longjmp(${currJmpBuf.ssa}, ${one.ssa}) : (!llvm.ptr, i32) -> ()`);
          }
        );
        break;
      }

      case "VariableDeclaration": {
        const isUsing = stmt.kind === "using";
        for (const decl of stmt.declarations) {
          const varName = decl.id.name;
          const isUnion = this.isUnionType(decl.id.typeAnnotation);
          const explicitStruct = this.getStructName(decl.id.typeAnnotation);

          // ESCAPE KONTROLÜ: Nesne fonksiyon dışına sızmıyorsa stack'e yükselt
          let canStackAllocate = false;
          if (decl.init) {
            if (decl.init.type === "NewExpression") {
              const cls = decl.init.callee.name;
              if (cls !== "Map" && cls !== "Set") {
                const escapes = this.checkEscape(varName, this.currentFunctionNode);
                if (!escapes) {
                  canStackAllocate = true;
                }
              }
            } else if (decl.init.type === "ObjectExpression") {
              const escapes = this.checkEscape(varName, this.currentFunctionNode);
              if (!escapes) {
                canStackAllocate = true;
              }
            }
          }

          // Modül seviyesinde küresel bir değişkense:
          if (!isUnion && this.isTopLevel && !this.currentFunctionNode && this.globals && this.globals.has(varName) && this.scopeStack.length === 1) {
            const g = this.globals.get(varName);
            if (decl.init) {
              let val;
              if (decl.init.type === "NewExpression") {
                val = this.lowerNewExpression(decl.init, false);
              } else if (decl.init.type === "ObjectExpression") {
                const sName = this.inferStructName(decl.init, explicitStruct);
                const ptr = this.instantiateStruct(decl.init, sName, false);
                val = {
                  ssa: ptr,
                  ptr: ptr,
                  type: "!llvm.ptr",
                  structName: sName,
                  isRef: true,
                  isHeap: true,
                  isStack: false,
                };
              } else if (decl.init.type === "ArrayExpression") {
                const arrTarget = this.extractArrayTargetType(decl.id.typeAnnotation);
                val = this.instantiateArray(decl.init, arrTarget?.elemType, arrTarget?.isString, arrTarget?.structName);
              } else {
                val = this.lowerExpression(decl.init);
              }

              const addr = this.builder.nextSSA();
              this.builder.emit(`${addr} = llvm.mlir.addressof ${g.globalSym} : !llvm.ptr`);
              const coerced = this.coerceType(val, g.type);
              this.builder.store(addr, coerced);

              const finalStruct = explicitStruct || val.structName || g.structName;
              if (finalStruct) g.structName = finalStruct;
              if (val.isArray || (decl.init && decl.init.type === "ArrayExpression")) {
                const arrTarget = this.extractArrayTargetType(decl.id.typeAnnotation);
                g.isArray = true;
                g.elemType = arrTarget?.elemType || val.elemType || "f64";
                g.isString = arrTarget?.isString || val.isString || false;
                g.structName = arrTarget?.structName || val.structName || null;
              }
              if (val.isMap) g.isMap = true;
              if (val.isSet) g.isSet = true;
              if (val.isString) {
                g.isString = true;
                g.type = "!llvm.ptr";
              }
              this.symbolTable.set(varName, {
                ptr: addr,
                ssa: (val.isFunction || val.isClosure) ? null : addr,
                type: g.type,
                isGlobal: true,
                isSlot: true,
                structName: g.structName,
                isString: g.isString,
                isArray: g.isArray,
                elemType: g.elemType,
                isMap: Boolean(g.isMap || val.isMap),
                isSet: Boolean(g.isSet || val.isSet),
                valType: val.valType,
                isFunction: Boolean(val.isFunction || val.isClosure),
                isClosure: Boolean(val.isClosure || val.isFunction),
                fnSig: val.fnSig,
              });
            }
            continue;
          }

          if (isUnion) {
            const slot = this.builder.allocateStack("!llvm.struct<(i32, i64)>");
            if (decl.init) {
              const val = this.lowerExpression(decl.init);
              this.boxIntoUnion(slot.ptr, val);
            }
            this.symbolTable.set(varName, {
              ptr: slot.ptr,
              ssa: slot.ptr,
              type: "!llvm.ptr",
              isUnion: true,
              unionNode: decl.id.typeAnnotation,
            });
          } else if (decl.init) {
            let val;
            if (decl.init.type === "NewExpression" && canStackAllocate) {
              val = this.lowerNewExpression(decl.init, true);
            } else if (decl.init.type === "ObjectExpression") {
              const sName = this.inferStructName(decl.init, explicitStruct);
              const ptr = this.instantiateStruct(decl.init, sName, canStackAllocate);
              val = {
                ssa: ptr,
                ptr: ptr,
                type: "!llvm.ptr",
                structName: sName,
                isRef: true,
                isHeap: !canStackAllocate,
                isStack: canStackAllocate,
              };
            } else if (decl.init.type === "ArrayExpression") {
              const arrTarget = this.extractArrayTargetType(decl.id.typeAnnotation);
              val = this.instantiateArray(decl.init, arrTarget?.elemType, arrTarget?.isString, arrTarget?.structName);
            } else {
              val = this.lowerExpression(decl.init);
            }

            if (val.isArena || val.isPool || val.isFixedBuffer) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isArena: val.isArena,
                isPool: val.isPool,
                isFixedBuffer: val.isFixedBuffer,
                isRef: true,
              });
            } else if (val.isChannel) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isChannel: true,
                isRef: true,
              });
              if (decl.init.type === "Identifier" && !val.isBorrowed) {
                const srcSym = this.symbolTable.get(decl.init.name);
                if (srcSym) {
                  srcSym.isMoved = true;
                  this.markTransferred(srcSym.ptr || srcSym.ssa);
                }
              }
            } else if (val.isMap || val.isSet) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isMap: val.isMap,
                isSet: val.isSet,
                valType: val.valType,
                isRef: true,
              });
            } else if (val.isPromise) {
              this.symbolTable.set(varName, {
                ptr: val.ssa || val.ptr,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isPromise: true,
                innerRetType: val.innerRetType,
                isRef: true,
              });
            } else if (!val.isInterface && !this.isPolymorphicInterface(explicitStruct) && (val.isFunction || val.isClosure || val.type === "!llvm.struct<(!llvm.ptr, !llvm.ptr)>")) {
              const slot = this.builder.allocateStack("!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
              this.builder.store(slot.ptr, val);
              const explicitFnSig = this.extractFunctionType(decl.id.typeAnnotation);
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                ssa: val.ssa,
                type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
                isClosure: true,
                isFunction: true,
                fnSig: explicitFnSig || val.fnSig || null,
              });
            } else if (val.isArray || (decl.init && decl.init.type === "ArrayExpression")) {
              const arrTarget = this.extractArrayTargetType(decl.id.typeAnnotation);
              const explicitElemType = arrTarget?.elemType;
              const isExplicitString = arrTarget?.isString;
              const explicitStruct = arrTarget?.structName;

              this.symbolTable.set(varName, {
                ptr: val.ptr || val.ssa,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isArray: true,
                arrayLen: val.arrayLen || val.length,
                elemType: explicitElemType || val.elemType || "f64",
                isString: isExplicitString || val.isString || false,
                structName: explicitStruct || val.structName || null,
                isRef: true,
              });
            } else if (!val.isArray && explicitStruct && this.isPolymorphicInterface(explicitStruct)) {
              if (!val.isInterface) {
                val = this.boxIntoInterface(val, explicitStruct);
              }
              const slot = this.builder.allocateStack("!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
              this.builder.store(slot.ptr, val);
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                ssa: val.ssa,
                type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
                structName: explicitStruct,
                isInterface: true,
                isRef: true,
                isSlot: true,
                isHeap: val.isHeap,
              });
            } else if (!val.isArray && (val.isInterface || (val.structName && this.isPolymorphicInterface(val.structName)))) {
              const slot = this.builder.allocateStack("!llvm.struct<(!llvm.ptr, !llvm.ptr)>");
              this.builder.store(slot.ptr, val);
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                ssa: val.ssa,
                type: "!llvm.struct<(!llvm.ptr, !llvm.ptr)>",
                structName: val.structName,
                isInterface: true,
                isRef: true,
                isSlot: true,
                isHeap: val.isHeap,
              });
            } else if (decl.init.type === "NewExpression") {
              if (stmt.kind === "let") {
                const slot = this.builder.allocateStack("!llvm.ptr");
                this.builder.store(slot.ptr, val);
                this.symbolTable.set(varName, {
                  ptr: slot.ptr,
                  type: "!llvm.ptr",
                  structName: val.structName,
                  isRef: true,
                  isSlot: true,
                  isHeap: val.isHeap,
                  isStack: val.isStack,
                  origPtr: val.origPtr || val.ssa || val.ptr,
                });
              } else {
                this.symbolTable.set(varName, {
                  ptr: val.ssa,
                  type: "!llvm.ptr",
                  structName: val.structName,
                  isRef: true,
                  origPtr: val.origPtr || val.ssa || val.ptr,
                });
              }
            } else {
              const finalStruct = explicitStruct || val.structName;

              if (finalStruct) {
                if (stmt.kind === "let") {
                  const slot = this.builder.allocateStack("!llvm.ptr");
                  this.builder.store(slot.ptr, val);
                  this.symbolTable.set(varName, {
                    ptr: slot.ptr,
                    type: "!llvm.ptr",
                    structName: finalStruct,
                    isRef: true,
                    isSlot: true,
                    isHeap: val.isHeap,
                    isStack: val.isStack,
                    origPtr: val.origPtr || val.ssa || val.ptr,
                  });
                } else {
                  this.symbolTable.set(varName, {
                    ptr: val.ssa || val.ptr,
                    type: "!llvm.ptr",
                    structName: finalStruct,
                    isRef: true,
                    isHeap: val.isHeap,
                    isStack: val.isStack,
                    origPtr: val.origPtr || val.ssa || val.ptr,
                  });
                }

                // Move Semantiği: Sağdaki ifade doğrudan bir Identifier ise sahipliği taşı
                if (decl.init.type === "Identifier" && !val.isBorrowed) {
                  const srcSym = this.symbolTable.get(decl.init.name);
                  if (srcSym && (srcSym.isHeap || srcSym.structName || srcSym.isChannel)) {
                    srcSym.isMoved = true;
                    // Taşıma yapıldığı için önceki sahibinin çift free yapmasını önle
                    this.markTransferred(srcSym.ptr || srcSym.ssa);
                  }
                }
              } else {
                let targetType = val.type;
                if (decl.id.typeAnnotation) {
                  const resolved = this.resolveType(decl.id.typeAnnotation);
                  if (resolved && resolved !== "none") {
                    targetType = resolved;
                  }
                }
                const coerced = this.coerceType(val, targetType);
                const slot = this.builder.allocateStack(targetType);
                this.builder.store(slot.ptr, coerced);
                this.symbolTable.set(varName, {
                  ptr: slot.ptr,
                  type: targetType,
                  isRef: true,
                  isString: coerced.isString || this.isStringType(decl.id.typeAnnotation),
                  isPromise: Boolean(val.isPromise),
                  asyncFnName: val.asyncFnName || null,
                  taskContextMeta: val.taskContextMeta || null,
                  innerRetType: val.innerRetType || null,
                  structName: val.structName || null,
                  isSlot: true,
                  isVector: Boolean(val.isVector || (targetType && targetType.startsWith("vector<"))),
                });
              }
            }

            if (isUsing) {
              const sym = this.symbolTable.get(varName);
              const targetPtr = val.ptr || val.ssa || sym?.ptr;
              const isAlloc = Boolean(sym?.isArena || val.isArena || sym?.isPool || val.isPool || sym?.isFixedBuffer || val.isFixedBuffer);
              if (targetPtr && (val.isHeap || val.isStack || sym?.structName || sym?.isMap || sym?.isSet || val.isArray || isAlloc)) {
                this.trackDisposable(targetPtr, sym?.structName || val.structName, Boolean(val.isStack), {
                  isArena: Boolean(sym?.isArena || val.isArena),
                  isPool: Boolean(sym?.isPool || val.isPool),
                  isFixedBuffer: Boolean(sym?.isFixedBuffer || val.isFixedBuffer),
                });
              }
            }
          } else {
            // decl.init bulunmayan değişken tanımları (örn: let outer: Counter; veya let x: number;)
            const resolvedType = decl.id.typeAnnotation ? this.resolveType(decl.id.typeAnnotation) : "f64";
            const isString = this.isStringType(decl.id.typeAnnotation);
            const finalStruct = explicitStruct || (this.structRegistry.has(resolvedType) ? resolvedType : null);

            if (finalStruct || resolvedType === "!llvm.ptr") {
              const slot = this.builder.allocateStack("!llvm.ptr");
              const zeroPtr = this.builder.nextSSA();
              this.builder.emit(`${zeroPtr} = llvm.mlir.zero : !llvm.ptr`);
              this.builder.store(slot.ptr, { ssa: zeroPtr, type: "!llvm.ptr" });
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                type: "!llvm.ptr",
                structName: finalStruct,
                isRef: true,
                isSlot: true,
                isHeap: false,
                isString: isString,
              });
            } else {
              const slot = this.builder.allocateStack(resolvedType);
              const zeroConst = this.builder.createConstant(0, resolvedType);
              this.builder.store(slot.ptr, zeroConst);
              this.symbolTable.set(varName, {
                ptr: slot.ptr,
                type: resolvedType,
                isRef: true,
                isString: isString,
                isVector: Boolean(resolvedType && resolvedType.startsWith("vector<")),
              });
            }
          }
        }
        break;
      }

      case "ExpressionStatement": {
        if (stmt.expression.type === "CallExpression" && stmt.expression.callee.type === "Super") {
          const thisSym = this.symbolTable.get("this");
          const classMeta = this.structRegistry.get(thisSym.structName);
          if (!classMeta.superClass) {
            throw new Error(`[Lowering] '${classMeta.name}' bir üst sınıfa sahip değil!`);
          }

          const superConstructor = `${classMeta.superClass}_constructor`;
          const parentMeta = this.structRegistry.get(classMeta.superClass);
          const ctorMeta = parentMeta?.methods?.get("constructor");

          const args = stmt.expression.arguments ? stmt.expression.arguments.map((a, i) => {
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
            if (paramMeta && !val.isFunction) {
              val = this.coerceType(val, paramMeta.type);
            }
            return val;
          }) : [];
          const allArgsSSA = [thisSym.ptr, ...args.map((a) => a.ssa || a.ptr)];
          const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

          this.builder.emit(
            `func.call @${superConstructor}(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`
          );
          return;
        }

        this.lowerExpression(stmt.expression);
        break;
      }

      case "EmptyStatement": {
        break;
      }

      case "LabeledStatement": {
        const prevLabel = this.currentLoopLabel;
        this.currentLoopLabel = stmt.label?.name || null;
        this.lowerStatement(stmt.body);
        this.currentLoopLabel = prevLabel;
        break;
      }

      case "ForStatement": {
        this.enterScope(false);
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            this.lowerStatement(stmt.init);
          } else {
            this.lowerExpression(stmt.init);
          }
        }

        const condBlock = this.builder.nextBlock("for_cond");
        const bodyBlock = this.builder.nextBlock("for_body");
        const stepBlock = this.builder.nextBlock("for_step");
        const exitBlock = this.builder.nextBlock("for_exit");
        const bodyDepth = this.scopeStack.length;

        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        this.breakTargets.push({ label: exitBlock, cleanupDepth: bodyDepth, name: loopLabel });
        this.continueTargets.push({ label: stepBlock, cleanupDepth: bodyDepth, name: loopLabel });

        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(condBlock);
        this.builder.hasTerminated = false;
        const cond = stmt.test ? this.lowerExpression(stmt.test) : this.builder.createConstant(1, "i1");
        this.builder.emitBranchConditional(cond.ssa, bodyBlock, exitBlock);

        this.builder.emitBlockLabel(bodyBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);
        this.lowerStatement(stmt.body);
        this.exitScope();
        if (!this.builder.hasTerminated) {
          this.builder.emitBranch(stepBlock);
        }

        this.builder.emitBlockLabel(stepBlock);
        this.builder.hasTerminated = false;
        if (stmt.update) {
          this.lowerExpression(stmt.update);
        }
        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(exitBlock);
        this.builder.hasTerminated = false;

        this.continueTargets.pop();
        this.breakTargets.pop();
        this.exitScope();
        break;
      }

      case "ForOfStatement": {
        this.enterScope(false);
        const arr = this.lowerExpression(stmt.right);
        const lenSSA = this.builder.nextSSA();
        this.builder.emit(`${lenSSA} = llvm.load ${arr.ptr || arr.ssa} : !llvm.ptr -> i64`);

        const idxSlot = this.builder.allocateStack("i64");
        const c0 = this.builder.createConstant(0, "i64");
        this.builder.store(idxSlot.ptr, c0);

        const condBlock = this.builder.nextBlock("for_of_cond");
        const bodyBlock = this.builder.nextBlock("for_of_body");
        const stepBlock = this.builder.nextBlock("for_of_step");
        const exitBlock = this.builder.nextBlock("for_of_exit");
        const bodyDepth = this.scopeStack.length;

        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        this.breakTargets.push({ label: exitBlock, cleanupDepth: bodyDepth, name: loopLabel });
        this.continueTargets.push({ label: stepBlock, cleanupDepth: bodyDepth, name: loopLabel });

        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(condBlock);
        this.builder.hasTerminated = false;
        const curIdx = this.builder.load(idxSlot.ptr, "i64");
        const condSSA = this.builder.nextSSA();
        this.builder.emit(`${condSSA} = arith.cmpi slt, ${curIdx.ssa}, ${lenSSA} : i64`);
        this.builder.emitBranchConditional(condSSA, bodyBlock, exitBlock);

        this.builder.emitBlockLabel(bodyBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);

        const curIdxForElem = this.builder.load(idxSlot.ptr, "i64");
        const elemType = arr.elemType || "f64";
        const isI32 = elemType === "i32";
        const offsetConst = this.builder.createConstant(isI32 ? 2 : 1, "i64");
        const realIdx = this.builder.createArithmetic("+", curIdxForElem, offsetConst);
        const elemPtr = this.builder.nextSSA();
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${arr.ptr || arr.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, ${elemType}`
        );
        const elemVal = this.builder.load(elemPtr, elemType);
        if (arr.isString) elemVal.isString = true;
        if (arr.structName) elemVal.structName = arr.structName;

        if (stmt.left.type === "VariableDeclaration") {
          const decl = stmt.left.declarations[0];
          const varName = decl.id.name;
          const slot = this.builder.allocateStack(elemVal.type);
          this.builder.store(slot.ptr, elemVal);
          this.symbolTable.set(varName, {
            ptr: slot.ptr,
            type: elemVal.type,
            isRef: true,
            isSlot: true,
            isString: elemVal.isString,
            structName: elemVal.structName,
          });
        } else if (stmt.left.type === "Identifier") {
          const sym = this.symbolTable.get(stmt.left.name);
          if (sym) {
            this.builder.store(sym.ptr, elemVal);
          }
        }

        this.lowerStatement(stmt.body);
        this.exitScope();
        if (!this.builder.hasTerminated) {
          this.builder.emitBranch(stepBlock);
        }

        this.builder.emitBlockLabel(stepBlock);
        this.builder.hasTerminated = false;
        const curIdxForStep = this.builder.load(idxSlot.ptr, "i64");
        const c1 = this.builder.createConstant(1, "i64");
        const nextIdx = this.builder.createArithmetic("+", curIdxForStep, c1);
        this.builder.store(idxSlot.ptr, nextIdx);
        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(exitBlock);
        this.builder.hasTerminated = false;

        this.continueTargets.pop();
        this.breakTargets.pop();
        this.exitScope();
        break;
      }

      case "ForInStatement": {
        this.enterScope(false);
        const arr = this.lowerExpression(stmt.right);
        const lenSSA = this.builder.nextSSA();
        this.builder.emit(`${lenSSA} = llvm.load ${arr.ptr || arr.ssa} : !llvm.ptr -> i64`);

        const idxSlot = this.builder.allocateStack("i64");
        const c0 = this.builder.createConstant(0, "i64");
        this.builder.store(idxSlot.ptr, c0);

        const condBlock = this.builder.nextBlock("for_in_cond");
        const bodyBlock = this.builder.nextBlock("for_in_body");
        const stepBlock = this.builder.nextBlock("for_in_step");
        const exitBlock = this.builder.nextBlock("for_in_exit");
        const bodyDepth = this.scopeStack.length;

        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        this.breakTargets.push({ label: exitBlock, cleanupDepth: bodyDepth, name: loopLabel });
        this.continueTargets.push({ label: stepBlock, cleanupDepth: bodyDepth, name: loopLabel });

        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(condBlock);
        this.builder.hasTerminated = false;
        const curIdx = this.builder.load(idxSlot.ptr, "i64");
        const condSSA = this.builder.nextSSA();
        this.builder.emit(`${condSSA} = arith.cmpi slt, ${curIdx.ssa}, ${lenSSA} : i64`);
        this.builder.emitBranchConditional(condSSA, bodyBlock, exitBlock);

        this.builder.emitBlockLabel(bodyBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);

        const curIdxForElem = this.builder.load(idxSlot.ptr, "i64");
        const idxF64 = this.coerceType(curIdxForElem, "f64");

        if (stmt.left.type === "VariableDeclaration") {
          const decl = stmt.left.declarations[0];
          const varName = decl.id.name;
          const slot = this.builder.allocateStack("f64");
          this.builder.store(slot.ptr, idxF64);
          this.symbolTable.set(varName, {
            ptr: slot.ptr,
            type: "f64",
            isRef: true,
            isSlot: true,
          });
        } else if (stmt.left.type === "Identifier") {
          const sym = this.symbolTable.get(stmt.left.name);
          if (sym) {
            this.builder.store(sym.ptr, idxF64);
          }
        }

        this.lowerStatement(stmt.body);
        this.exitScope();
        if (!this.builder.hasTerminated) {
          this.builder.emitBranch(stepBlock);
        }

        this.builder.emitBlockLabel(stepBlock);
        this.builder.hasTerminated = false;
        const curIdxForStep = this.builder.load(idxSlot.ptr, "i64");
        const c1 = this.builder.createConstant(1, "i64");
        const nextIdx = this.builder.createArithmetic("+", curIdxForStep, c1);
        this.builder.store(idxSlot.ptr, nextIdx);
        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(exitBlock);
        this.builder.hasTerminated = false;

        this.continueTargets.pop();
        this.breakTargets.pop();
        this.exitScope();
        break;
      }

      case "WhileStatement": {
        const condBlock = this.builder.nextBlock("while_cond");
        const bodyBlock = this.builder.nextBlock("while_body");
        const exitBlock = this.builder.nextBlock("while_exit");
        const bodyDepth = this.scopeStack.length;

        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        this.breakTargets.push({ label: exitBlock, cleanupDepth: bodyDepth, name: loopLabel });
        this.continueTargets.push({ label: condBlock, cleanupDepth: bodyDepth, name: loopLabel });

        this.builder.emitBranch(condBlock);

        this.builder.emitBlockLabel(condBlock);
        this.builder.hasTerminated = false;
        const cond = this.lowerExpression(stmt.test);
        this.builder.emitBranchConditional(cond.ssa, bodyBlock, exitBlock);

        this.builder.emitBlockLabel(bodyBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);
        this.lowerStatement(stmt.body);
        this.exitScope();
        if (!this.builder.hasTerminated) {
          this.builder.emitBranch(condBlock);
        }

        this.builder.emitBlockLabel(exitBlock);
        this.builder.hasTerminated = false;

        this.continueTargets.pop();
        this.breakTargets.pop();
        break;
      }

      case "DoWhileStatement": {
        const bodyBlock = this.builder.nextBlock("dowhile_body");
        const condBlock = this.builder.nextBlock("dowhile_cond");
        const exitBlock = this.builder.nextBlock("dowhile_exit");
        const bodyDepth = this.scopeStack.length;

        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        this.breakTargets.push({ label: exitBlock, cleanupDepth: bodyDepth, name: loopLabel });
        this.continueTargets.push({ label: condBlock, cleanupDepth: bodyDepth, name: loopLabel });

        this.builder.emitBranch(bodyBlock);

        this.builder.emitBlockLabel(bodyBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);
        this.lowerStatement(stmt.body);
        this.exitScope();
        if (!this.builder.hasTerminated) {
          this.builder.emitBranch(condBlock);
        }

        this.builder.emitBlockLabel(condBlock);
        this.builder.hasTerminated = false;
        const cond = this.lowerExpression(stmt.test);
        this.builder.emitBranchConditional(cond.ssa, bodyBlock, exitBlock);

        this.builder.emitBlockLabel(exitBlock);
        this.builder.hasTerminated = false;

        this.continueTargets.pop();
        this.breakTargets.pop();
        break;
      }

      case "SwitchStatement": {
        const discVal = this.lowerExpression(stmt.discriminant);
        const cases = stmt.cases || [];
        const switchExitBlock = this.builder.nextBlock("switch_exit");
        const loopLabel = this.currentLoopLabel;
        this.currentLoopLabel = null;
        const breakTarget = {
          label: switchExitBlock,
          cleanupDepth: this.scopeStack.length,
          referenced: cases.findIndex((c) => c.test === null) < 0,
          name: loopLabel,
        };
        this.breakTargets.push(breakTarget);

        const bodyBlocks = cases.map((c, i) => this.builder.nextBlock(`switch_case_body_${i}`));
        const defaultIndex = cases.findIndex((c) => c.test === null);
        const defaultTarget = defaultIndex >= 0 ? bodyBlocks[defaultIndex] : switchExitBlock;

        const testedItems = [];
        for (let i = 0; i < cases.length; i++) {
          if (cases[i].test !== null) {
            testedItems.push({ caseNode: cases[i], index: i });
          }
        }

        if (testedItems.length === 0) {
          this.builder.emitBranch(defaultTarget);
        } else {
          for (let k = 0; k < testedItems.length; k++) {
            const { caseNode, index } = testedItems[k];
            const testVal = this.lowerExpression(caseNode.test);
            const cmp = this.builder.createComparison("===", discVal, testVal);
            const nextCheck = (k + 1 < testedItems.length) ? this.builder.nextBlock("switch_check") : defaultTarget;
            this.builder.emitBranchConditional(cmp.ssa, bodyBlocks[index], nextCheck);

            if (k + 1 < testedItems.length) {
              this.builder.emitBlockLabel(nextCheck);
              this.builder.hasTerminated = false;
            }
          }
        }

        for (let i = 0; i < cases.length; i++) {
          this.builder.emitBlockLabel(bodyBlocks[i]);
          this.builder.hasTerminated = false;
          this.enterScope(false);
          const stmts = cases[i].consequent || [];
          for (const s of stmts) {
            if (this.builder.hasTerminated) break;
            this.lowerStatement(s);
          }
          this.exitScope();

          if (!this.builder.hasTerminated) {
            if (i + 1 < cases.length) {
              this.builder.emitBranch(bodyBlocks[i + 1]);
            } else {
              breakTarget.referenced = true;
              this.builder.emitBranch(switchExitBlock);
            }
          }
        }

        this.breakTargets.pop();
        if (breakTarget.referenced) {
          this.builder.emitBlockLabel(switchExitBlock);
          this.builder.hasTerminated = false;
        } else {
          this.builder.hasTerminated = true;
        }
        break;
      }

      case "BreakStatement": {
        if (this.breakTargets.length === 0) {
          throw new Error("[Lowering] 'break' statement outside of switch or loop!");
        }
        let target = this.breakTargets[this.breakTargets.length - 1];
        if (stmt.label) {
          const found = this.breakTargets.slice().reverse().find((t) => t.name === stmt.label.name);
          if (found) target = found;
        }
        if (target.cleanupDepth !== undefined) {
          this.cleanupScopesDownTo(target.cleanupDepth);
        }
        if (typeof target === "object") {
          target.referenced = true;
          this.builder.emitBranch(target.label);
        } else {
          this.builder.emitBranch(target);
        }
        this.builder.hasTerminated = true;
        break;
      }

      case "ContinueStatement": {
        if (this.continueTargets.length === 0) {
          throw new Error("[Lowering] 'continue' statement outside of loop!");
        }
        let target = this.continueTargets[this.continueTargets.length - 1];
        if (stmt.label) {
          const found = this.continueTargets.slice().reverse().find((t) => t.name === stmt.label.name);
          if (found) target = found;
        }
        if (target.cleanupDepth !== undefined) {
          this.cleanupScopesDownTo(target.cleanupDepth);
        }
        const label = typeof target === "object" ? target.label : target;
        this.builder.emitBranch(label);
        this.builder.hasTerminated = true;
        break;
      }

      case "IfStatement": {
        const narrowingCheck = this.extractNarrowingCheck(stmt.test);
        let originalSym = null;
        let narrowedVarName = null;

        if (narrowingCheck) {
          const sym = this.symbolTable.get(narrowingCheck.varName);
          if (sym) {
            narrowedVarName = narrowingCheck.varName;
            originalSym = sym;
          }
        }

        const cond = this.lowerExpression(stmt.test);
        const thenBlock = this.builder.nextBlock("then");
        const elseBlock = stmt.alternate ? this.builder.nextBlock("else") : null;
        const mergeBlock = this.builder.nextBlock("merge");

        const falseTarget = elseBlock || mergeBlock;
        this.builder.emitBranchConditional(cond.ssa, thenBlock, falseTarget);

        // --- THEN BLOĞU ---
        this.builder.emitBlockLabel(thenBlock);
        this.builder.hasTerminated = false;
        this.enterScope(false);
        if (narrowedVarName && narrowingCheck) {
          if (narrowingCheck.kind === "typeof" && originalSym.isUnion) {
            const unboxed = this.unboxUnion(originalSym.ptr || originalSym.ssa, narrowingCheck.targetType);
            if (unboxed) {
              this.symbolTable.set(narrowedVarName, unboxed);
            }
          } else if (narrowingCheck.kind === "instanceof" || narrowingCheck.kind === "predicate") {
            this.symbolTable.set(narrowedVarName, {
              ...originalSym,
              structName: narrowingCheck.targetType,
            });
          }
        }
        this.lowerStatement(stmt.consequent);
        if (narrowedVarName) {
          this.symbolTable.set(narrowedVarName, originalSym);
        }
        this.exitScope();

        const thenTerminated = this.builder.hasTerminated;
        if (!thenTerminated) {
          this.builder.emitBranch(mergeBlock);
        }

        // --- ELSE BLOĞU ---
        let elseTerminated = false;
        if (elseBlock) {
          this.builder.emitBlockLabel(elseBlock);
          this.builder.hasTerminated = false;
          this.enterScope(false);
          if (narrowedVarName && narrowingCheck && narrowingCheck.kind === "typeof" && originalSym.isUnion) {
            let otherType = null;
            if (narrowingCheck.targetType === "string") otherType = "number";
            else if (narrowingCheck.targetType === "number") otherType = "string";

            if (otherType) {
              const unboxed = this.unboxUnion(originalSym.ptr || originalSym.ssa, otherType);
              if (unboxed) {
                this.symbolTable.set(narrowedVarName, unboxed);
              }
            }
          }
          this.lowerStatement(stmt.alternate);
          if (narrowedVarName) {
            this.symbolTable.set(narrowedVarName, originalSym);
          }
          this.exitScope();

          elseTerminated = this.builder.hasTerminated;
          if (!elseTerminated) {
            this.builder.emitBranch(mergeBlock);
          }
        }

        // --- MERGE BLOĞU ---
        if (!thenTerminated || (elseBlock && !elseTerminated) || !elseBlock) {
          this.builder.emitBlockLabel(mergeBlock);
          this.builder.hasTerminated = false;
        } else {
          this.builder.hasTerminated = true;
        }
        break;
      }

      case "BlockStatement": {
        this.enterScope(false);
        for (const s of stmt.body) {
          if (this.builder.hasTerminated) break;
          this.lowerStatement(s);
        }
        this.exitScope();
        break;
      }

      case "ReturnStatement": {
        const expectedRet = this.getCurrentFunctionRetType();
        const expectedStruct = this.getCurrentFunctionStructRetName();
        if (stmt.argument) {
          let val = this.lowerExpression(stmt.argument);
          if (expectedStruct && this.isPolymorphicInterface(expectedStruct)) {
            if (!val.isInterface) {
              val = this.boxIntoInterface(val, expectedStruct);
            }
          } else if (expectedRet && expectedRet !== "none") {
            val = this.coerceType(val, expectedRet);
          }
          if (val.origPtr) {
            this.markTransferred(val.origPtr);
          }
          if (val.type === "!llvm.ptr" || val.isHeap) {
            this.markTransferred(val.ssa || val.ptr);
          }
          if (val.isClosure && val.envPtr) {
            this.markTransferred(val.envPtr);
          }
          this.cleanupFunctionScopes();
          this.builder.createReturn(val);
        } else {
          this.cleanupFunctionScopes();
          this.builder.createReturn();
        }
        break;
      }
    }
  }
}
