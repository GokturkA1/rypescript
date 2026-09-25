// ast-lowerer.js
export class ASTLowering {
  constructor(builder) {
    this.builder = builder;
    this.symbolTable = new Map();
    this.structRegistry = new Map();
    this.functionRegistry = new Map();
    this.classList = [];
    this.vcallRouters = new Set();

    this.typeAliasRegistry = new Map();
    this.enumRegistry = new Map();

    // Generics Şablon Havuzları
    this.genericClassTemplates = new Map();
    this.genericFunctionTemplates = new Map();
    this.specializedClasses = new Set();
    this.specializedFunctions = new Set();

    this.scopeStack = [];
    this.builder.onAllocate = (ptr) => this.trackHeap(ptr);
  }

  enterScope(isFunction = false) {
    this.scopeStack.push({
      isFunction,
      heapAllocations: new Set(),
      transferred: new Set(),
    });
  }

  exitScope() {
    if (this.scopeStack.length === 0) return;
    const scope = this.scopeStack.pop();
    for (const ptr of scope.heapAllocations) {
      if (!scope.transferred.has(ptr)) {
        this.builder.emitFree(ptr);
      }
    }
  }

  trackHeap(ptr) {
    if (this.scopeStack.length > 0) {
      const current = this.scopeStack[this.scopeStack.length - 1];
      current.heapAllocations.add(ptr);
    }
  }

  markTransferred(ptr) {
    if (!ptr) return;
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].heapAllocations.has(ptr)) {
        this.scopeStack[i].transferred.add(ptr);
        break;
      }
    }
  }

  cleanupFunctionScopes() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      for (const ptr of scope.heapAllocations) {
        if (!scope.transferred.has(ptr)) {
          this.builder.emitFree(ptr);
        }
      }
      if (scope.isFunction) break;
    }
  }

  unwrapExport(node) {
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") && node.declaration) {
      return node.declaration;
    }
    return node;
  }

  unwrapType(typeNode) {
    if (!typeNode) return null;
    let curr = typeNode;
    while (curr && curr.typeAnnotation) {
      curr = curr.typeAnnotation;
    }
    return curr;
  }

  extractFunctionType(typeNode) {
    const unwrapped = this.unwrapType(typeNode);
    if (!unwrapped) return null;

    if (unwrapped.type === "TSTypeReference") {
      const typeName = unwrapped.typeName?.name || unwrapped.typeName?.value;
      if (this.typeAliasRegistry.has(typeName)) {
        return this.extractFunctionType(this.typeAliasRegistry.get(typeName));
      }
    }

    if (unwrapped.type === "TSFunctionType") {
      const rawParams = unwrapped.parameters || unwrapped.params || [];
      const paramTypes = rawParams.map((p) => {
        const pAnnot = p.typeAnnotation;
        return this.resolveType(pAnnot);
      });

      const retAnnot = unwrapped.returnType;
      let retType = this.resolveType(retAnnot);
      if (!retType) retType = "none";

      const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
      return {
        paramTypes,
        retType,
        mlirType,
      };
    }

    return null;
  }

  isFunctionType(typeNode) {
    return this.extractFunctionType(typeNode) !== null;
  }

  isUnionType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return false;
    if (type.type === "TSUnionType") return true;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value;
      if (this.typeAliasRegistry.has(typeName)) {
        return this.isUnionType(this.typeAliasRegistry.get(typeName));
      }
    }
    return false;
  }

  isStringType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return false;
    if (type.type === "TSStringKeyword") return true;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value;
      if (this.enumRegistry.has(typeName)) {
        return this.enumRegistry.get(typeName).kind === "string";
      }
      if (this.typeAliasRegistry.has(typeName)) {
        return this.isStringType(this.typeAliasRegistry.get(typeName));
      }
    }
    return false;
  }

  getTypeKey(typeNode) {
    const t = this.unwrapType(typeNode);
    if (!t) return "f64";
    switch (t.type) {
      case "TSNumberKeyword":
        return "f64";
      case "TSStringKeyword":
        return "str";
      case "TSBooleanKeyword":
        return "bool";
      case "TSVoidKeyword":
        return "void";
      case "TSTypeReference": {
        const name = t.typeName?.name || t.typeName?.value;
        if (this.enumRegistry.has(name)) {
          return this.enumRegistry.get(name).kind === "string" ? "str" : "i64";
        }
        if (this.typeAliasRegistry.has(name)) {
          return this.getTypeKey(this.typeAliasRegistry.get(name));
        }
        return name || "ptr";
      }
      default:
        return "f64";
    }
  }

  resolveType(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return "f64";

    const fnType = this.extractFunctionType(type);
    if (fnType) {
      return fnType.mlirType;
    }

    if (type.type === "TSUnionType") {
      return "!llvm.ptr";
    }

    switch (type.type) {
      case "TSNumberKeyword":
        return "f64";
      case "TSBooleanKeyword":
        return "i1";
      case "TSStringKeyword":
        return "!llvm.ptr";
      case "TSVoidKeyword":
        return "none";
      case "TSArrayType":
        return "!llvm.ptr";
      case "TSTypeReference": {
        const typeName = type.typeName?.name || type.typeName?.value;
        if (typeName === "Promise") {
          return "!llvm.ptr";
        }
        if (this.enumRegistry.has(typeName)) {
          const en = this.enumRegistry.get(typeName);
          return en.kind === "string" ? "!llvm.ptr" : "i64";
        }
        if (this.structRegistry.has(typeName)) {
          return "!llvm.ptr";
        }
        if (this.classList.some((c) => c.name === typeName)) {
          return "!llvm.ptr";
        }
        if (this.typeAliasRegistry.has(typeName)) {
          return this.resolveType(this.typeAliasRegistry.get(typeName));
        }
        return "!llvm.ptr";
      }
      default:
        return "f64";
    }
  }

  getStructName(typeNode) {
    const type = this.unwrapType(typeNode);
    if (!type) return null;
    if (type.type === "TSTypeReference") {
      const typeName = type.typeName?.name || type.typeName?.value || null;
      if (!typeName) return null;
      if (this.enumRegistry.has(typeName)) {
        return null;
      }
      if (this.structRegistry.has(typeName)) {
        return typeName;
      }
      if (this.classList.some((c) => c.name === typeName)) {
        return typeName;
      }
      if (this.typeAliasRegistry.has(typeName)) {
        return this.getStructName(this.typeAliasRegistry.get(typeName));
      }
      return null;
    }
    return null;
  }

  coerceType(val, targetType) {
    if (!val || val.type === targetType) return val;

    if (targetType === "f64" && (val.type === "i64" || val.type === "i32")) {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.sitofp ${val.ssa} : ${val.type} to f64`);
      return { ssa, type: "f64" };
    }
    if (targetType === "i64" && val.type === "f64") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.fptosi ${val.ssa} : f64 to i64`);
      return { ssa, type: "i64" };
    }
    if (targetType === "i64" && val.type === "i32") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.extsi ${val.ssa} : i32 to i64`);
      return { ssa, type: "i64" };
    }
    if (targetType === "i32" && val.type === "i64") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = arith.trunci ${val.ssa} : i64 to i32`);
      return { ssa, type: "i32" };
    }
    return val;
  }

  boxIntoUnion(slotPtr, val) {
    if (val.isUnion) {
      const srcTagPtr = this.builder.nextSSA();
      this.builder.emit(`${srcTagPtr} = llvm.getelementptr ${val.ptr || val.ssa}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      const tag = this.builder.load(srcTagPtr, "i32");
      const dstTagPtr = this.builder.nextSSA();
      this.builder.emit(`${dstTagPtr} = llvm.getelementptr ${slotPtr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      this.builder.store(dstTagPtr, tag);

      const srcPayloadPtr = this.builder.nextSSA();
      this.builder.emit(`${srcPayloadPtr} = llvm.getelementptr ${val.ptr || val.ssa}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      const payload = this.builder.load(srcPayloadPtr, "i64");
      const dstPayloadPtr = this.builder.nextSSA();
      this.builder.emit(`${dstPayloadPtr} = llvm.getelementptr ${slotPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
      this.builder.store(dstPayloadPtr, payload);
      return;
    }

    let tag = 5;
    if (val.isString || val.type === "!llvm.ptr") {
      tag = 3;
    } else if (val.type === "i64" || val.type === "i32") {
      tag = 1;
    } else if (val.type === "f64" || val.type === "f32") {
      tag = 2;
    } else if (val.type === "i1") {
      tag = 4;
    }

    const tagConst = this.builder.nextSSA();
    this.builder.emit(`${tagConst} = arith.constant ${tag} : i32`);
    const tagPtr = this.builder.nextSSA();
    this.builder.emit(`${tagPtr} = llvm.getelementptr ${slotPtr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
    this.builder.emit(`llvm.store ${tagConst}, ${tagPtr} : i32, !llvm.ptr`);

    const payloadPtr = this.builder.nextSSA();
    this.builder.emit(`${payloadPtr} = llvm.getelementptr ${slotPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i32, i64)>`);
    if (tag === 1 && val.type === "i32") {
      val = this.coerceType(val, "i64");
    }
    this.builder.store(payloadPtr, val);
  }

  unboxUnion(uPtr, targetType) {
    if (targetType === "string") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_string(${uPtr}) : (!llvm.ptr) -> !llvm.ptr`);
      const slot = this.builder.allocateStack("!llvm.ptr");
      this.builder.store(slot.ptr, { ssa, type: "!llvm.ptr" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "!llvm.ptr", isString: true, isRef: true };
    } else if (targetType === "number") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_number(${uPtr}) : (!llvm.ptr) -> f64`);
      const slot = this.builder.allocateStack("f64");
      this.builder.store(slot.ptr, { ssa, type: "f64" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "f64", isRef: true };
    } else if (targetType === "boolean") {
      const ssa = this.builder.nextSSA();
      this.builder.emit(`${ssa} = func.call @rts_union_get_bool(${uPtr}) : (!llvm.ptr) -> i1`);
      const slot = this.builder.allocateStack("i1");
      this.builder.store(slot.ptr, { ssa, type: "i1" });
      return { ptr: slot.ptr, ssa: slot.ptr, type: "i1", isRef: true };
    }
    return null;
  }

  extractTypeofCheck(expr) {
    if (!expr || expr.type !== "BinaryExpression") return null;
    if (expr.operator !== "===" && expr.operator !== "==") return null;

    let varName = null;
    let targetType = null;

    if (
      expr.left.type === "UnaryExpression" &&
      expr.left.operator === "typeof" &&
      expr.left.argument.type === "Identifier" &&
      (expr.right.type === "StringLiteral" || (expr.right.type === "Literal" && typeof expr.right.value === "string"))
    ) {
      varName = expr.left.argument.name;
      targetType = expr.right.value;
    } else if (
      expr.right.type === "UnaryExpression" &&
      expr.right.operator === "typeof" &&
      expr.right.argument.type === "Identifier" &&
      (expr.left.type === "StringLiteral" || (expr.left.type === "Literal" && typeof expr.left.value === "string"))
    ) {
      varName = expr.right.argument.name;
      targetType = expr.left.value;
    }

    if (varName && targetType) {
      return { varName, targetType };
    }
    return null;
  }

  walkAST(node, visitor) {
    if (!node || typeof node !== "object") return;
    visitor(node);
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) this.walkAST(item, visitor);
      } else if (child && typeof child === "object") {
        this.walkAST(child, visitor);
      }
    }
  }

  liftLambdas(rootNodes) {
    const lifted = [];
    let lambdaId = 0;

    const inferReturnType = (rawBody) => {
      if (rawBody.type !== "BlockStatement") {
        return { type: "TSTypeAnnotation", typeAnnotation: { type: "TSNumberKeyword" } };
      }
      let hasReturnWithArg = false;
      this.walkAST(rawBody, (n) => {
        if (n.type === "ReturnStatement" && n.argument) {
          hasReturnWithArg = true;
        }
      });
      return hasReturnWithArg
        ? { type: "TSTypeAnnotation", typeAnnotation: { type: "TSNumberKeyword" } }
        : { type: "TSTypeAnnotation", typeAnnotation: { type: "TSVoidKeyword" } };
    };

    const recurse = (node) => {
      if (!node || typeof node !== "object") return;

      if (node.type === "ClassDeclaration" || node.type === "MethodDefinition") {
        if (node.body?.body) {
          for (const member of node.body.body) {
            if (member.type === "MethodDefinition" && member.value?.body) {
              recurse(member.value.body);
            }
          }
        }
        return;
      }

      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const child = node[key];

        if (Array.isArray(child)) {
          for (let i = 0; i < child.length; i++) {
            const item = child[i];
            if (item && (item.type === "ArrowFunctionExpression" || item.type === "FunctionExpression")) {
              recurse(item);
              const lambdaName = `__lambda_${lambdaId++}`;
              const body = item.body.type === "BlockStatement"
                ? item.body
                : { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: item.body }] };

              const retType = item.returnType || inferReturnType(item.body);

              const fnDecl = {
                type: "FunctionDeclaration",
                id: { type: "Identifier", name: lambdaName },
                params: item.params || [],
                returnType: retType,
                body: body,
              };
              lifted.push(fnDecl);
              child[i] = { type: "Identifier", name: lambdaName };
            } else {
              recurse(item);
            }
          }
        } else if (child && typeof child === "object") {
          if (child.type === "ArrowFunctionExpression" || child.type === "FunctionExpression") {
            recurse(child);
            const lambdaName = `__lambda_${lambdaId++}`;
            const body = child.body.type === "BlockStatement"
              ? child.body
              : { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: child.body }] };

            const retType = child.returnType || inferReturnType(child.body);

            const fnDecl = {
              type: "FunctionDeclaration",
              id: { type: "Identifier", name: lambdaName },
              params: child.params || [],
              returnType: retType,
              body: body,
            };
            lifted.push(fnDecl);
            node[key] = { type: "Identifier", name: lambdaName };
          } else {
            recurse(child);
          }
        }
      }
    };

    for (const n of rootNodes) {
      recurse(n);
    }
    return lifted;
  }

  deepCloneWithSubst(node, substMap, specializedName) {
    if (!node || typeof node !== "object") return node;

    if (Array.isArray(node)) {
      return node.map((item) => this.deepCloneWithSubst(item, substMap, specializedName));
    }

    if (node.type === "TSTypeReference") {
      const typeName = node.typeName?.name || node.typeName?.value;
      if (typeName && substMap.has(typeName)) {
        return JSON.parse(JSON.stringify(substMap.get(typeName)));
      }
    }

    const cloned = {};
    for (const key of Object.keys(node)) {
      cloned[key] = this.deepCloneWithSubst(node[key], substMap, specializedName);
    }

    if ((cloned.type === "ClassDeclaration" || cloned.type === "FunctionDeclaration") && specializedName) {
      cloned.id = { type: "Identifier", name: specializedName };
      delete cloned.typeParameters;
    }

    return cloned;
  }

  instantiateGenericClass(baseName, typeArgs) {
    const templateNode = this.genericClassTemplates.get(baseName);
    if (!templateNode) return baseName;

    const typeKeys = typeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedClasses.has(specializedName)) {
      return specializedName;
    }
    this.specializedClasses.add(specializedName);

    const substMap = new Map();
    const rawParams = templateNode.typeParameters?.params || [];
    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const concreteType = typeArgs[i] || { type: "TSNumberKeyword" };
      substMap.set(pName, concreteType);
    });

    const specializedClassNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedClassNode };
  }

  instantiateGenericFunction(baseName, typeArgs) {
    const templateNode = this.genericFunctionTemplates.get(baseName);
    if (!templateNode) return baseName;

    const typeKeys = typeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedFunctions.has(specializedName)) {
      return specializedName;
    }
    this.specializedFunctions.add(specializedName);

    const substMap = new Map();
    const rawParams = templateNode.typeParameters?.params || [];
    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const concreteType = typeArgs[i] || { type: "TSNumberKeyword" };
      substMap.set(pName, concreteType);
    });

    const specializedFnNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedFnNode };
  }

  lower(program) {
    this.lowerModules([{ filePath: "main.ts", fileName: "main.ts", program, isEntry: true }]);
  }

  lowerModules(modules) {
    const allParsedNodes = [];
    const entryTopLevelStatements = [];
    const nonEntryTopLevelStatements = [];

    for (const mod of modules) {
      for (const rawNode of mod.program.body) {
        if (rawNode.type === "ImportDeclaration") continue;

        const node = this.unwrapExport(rawNode);

        const hasTypeParams =
          Boolean(node.typeParameters?.params?.length > 0) ||
          Boolean(node.typeParameters && Array.isArray(node.typeParameters.params));

        if (node.type === "ClassDeclaration" && hasTypeParams) {
          this.genericClassTemplates.set(node.id.name, node);
        } else if (node.type === "FunctionDeclaration" && hasTypeParams) {
          this.genericFunctionTemplates.set(node.id.name, node);
        } else {
          allParsedNodes.push(node);
          if (
            node.type !== "TSInterfaceDeclaration" &&
            node.type !== "TSTypeAliasDeclaration" &&
            node.type !== "TSEnumDeclaration" &&
            node.type !== "ClassDeclaration" &&
            node.type !== "FunctionDeclaration"
          ) {
            if (mod.isEntry) {
              entryTopLevelStatements.push(node);
            } else {
              nonEntryTopLevelStatements.push(node);
            }
          }
        }
      }
    }

    const liftedLambdas = this.liftLambdas(allParsedNodes);
    for (const l of liftedLambdas) {
      allParsedNodes.push(l);
    }

    const synthesizedClasses = [];
    const synthesizedFunctions = [];

    const scanAndSpecialize = (rootNode) => {
      this.walkAST(rootNode, (n) => {
        if (n.type === "TSTypeReference") {
          const typeName = n.typeName?.name || n.typeName?.value;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (typeName && this.genericClassTemplates.has(typeName) && typeParams) {
            const spec = this.instantiateGenericClass(typeName, typeParams);
            if (spec && spec.node) {
              synthesizedClasses.push(spec.node);
            }
            n.typeName.name = spec.specializedName || spec;
            delete n.typeParameters;
            delete n.typeArguments;
          }
        } else if (n.type === "NewExpression") {
          const calleeName = n.callee?.name;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (calleeName && this.genericClassTemplates.has(calleeName) && typeParams) {
            const spec = this.instantiateGenericClass(calleeName, typeParams);
            if (spec && spec.node) {
              synthesizedClasses.push(spec.node);
            }
            n.callee.name = spec.specializedName || spec;
            delete n.typeParameters;
            delete n.typeArguments;
          }
        } else if (n.type === "CallExpression") {
          const calleeName = n.callee?.name;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (calleeName && this.genericFunctionTemplates.has(calleeName) && typeParams) {
            const spec = this.instantiateGenericFunction(calleeName, typeParams);
            if (spec && spec.node) {
              synthesizedFunctions.push(spec.node);
            }
            n.callee.name = spec.specializedName || spec;
            delete n.typeParameters;
            delete n.typeArguments;
          }
        }
      });
    };

    for (const n of allParsedNodes) {
      scanAndSpecialize(n);
    }

    for (const clsNode of synthesizedClasses) {
      scanAndSpecialize(clsNode);
      allParsedNodes.push(clsNode);
    }
    for (const fnNode of synthesizedFunctions) {
      scanAndSpecialize(fnNode);
      allParsedNodes.push(fnNode);
    }

    for (const node of allParsedNodes) {
      if (node.type === "TSEnumDeclaration") {
        this.registerEnum(node);
      } else if (node.type === "TSInterfaceDeclaration") {
        this.lowerInterface(node);
      }
    }

    for (const node of allParsedNodes) {
      if (node.type === "TSTypeAliasDeclaration") {
        this.registerTypeAlias(node);
      }
    }

    const rawClasses = allParsedNodes.filter((n) => n.type === "ClassDeclaration");
    this.resolveClassHierarchy(rawClasses);

    for (const node of allParsedNodes) {
      if (node.type === "FunctionDeclaration") {
        const funcName = node.id.name;
        const isAsync = Boolean(node.async);

        let innerRetType = "f64";
        const unwrappedRet = this.unwrapType(node.returnType);
        if (unwrappedRet && unwrappedRet.type === "TSTypeReference" && (unwrappedRet.typeName?.name === "Promise" || unwrappedRet.typeName?.value === "Promise")) {
          const innerParam = unwrappedRet.typeParameters?.params?.[0] || unwrappedRet.typeArguments?.params?.[0];
          innerRetType = innerParam ? this.resolveType(innerParam) : "none";
        } else {
          innerRetType = this.resolveType(node.returnType);
        }

        const retType = isAsync ? "!llvm.ptr" : innerRetType;
        const structRetName = this.getStructName(node.returnType);
        const isRetString = this.isStringType(node.returnType);

        const rawParams = Array.isArray(node.params)
          ? node.params
          : Array.isArray(node.params?.items)
          ? node.params.items
          : [];
        const params = [];
        const paramTypes = [];

        rawParams.forEach((param, i) => {
          const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
          const isFn = this.isFunctionType(typeAnnot);
          const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
          const isUnion = this.isUnionType(typeAnnot);
          const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
          const pType = isFn ? fnSig.mlirType : (isUnion || isArr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
          params.push({ name: param.name || `arg_${i}`, type: pType, isUnion, isArray: isArr, isFunction: isFn, fnSig });
          paramTypes.push(pType);
        });

        const mlirType = `(${paramTypes.join(", ")}) -> ${retType === "none" ? "()" : retType}`;
        this.functionRegistry.set(funcName, { isAsync, innerRetType, retType, structRetName, isRetString, params, paramTypes, mlirType });
      }
    }

    for (const cls of this.classList) {
      this.lowerClassMethods(cls.node);
    }

    this.emitVCallRouters();

    for (const node of allParsedNodes) {
      if (node.type === "FunctionDeclaration") {
        this.lowerFunction(node);
      }
    }

    this.builder.block("func.func @main() -> i32", () => {
      this.enterScope(true);

      for (const stmt of nonEntryTopLevelStatements) {
        this.lowerStatement(stmt);
      }
      for (const stmt of entryTopLevelStatements) {
        this.lowerStatement(stmt);
      }

      this.exitScope();
      const zero = this.builder.createConstant(0, "i32");
      this.builder.createReturn(zero);
    });
  }

  registerEnum(node) {
    const enumName = node.id.name;
    const members = new Map();
    let currentVal = 0;
    let enumKind = "numeric";

    const rawMembers =
      node.members ||
      node.body?.members ||
      node.body?.body ||
      node.elements ||
      node.body?.elements ||
      (Array.isArray(node.body) ? node.body : []);

    for (const member of rawMembers) {
      const memberName =
        member.id?.name ??
        member.id?.value ??
        member.key?.name ??
        member.key?.value ??
        member.name;

      const init = member.initializer || member.init;

      if (init) {
        if (
          init.type === "NumericLiteral" ||
          (init.type === "Literal" && typeof init.value === "number")
        ) {
          currentVal = init.value;
          members.set(memberName, { type: "i64", value: currentVal, isString: false });
          members.set(String(currentVal), { type: "!llvm.ptr", value: memberName, isString: true });
          currentVal++;
        } else if (
          init.type === "StringLiteral" ||
          (init.type === "Literal" && typeof init.value === "string")
        ) {
          members.set(memberName, { type: "!llvm.ptr", value: init.value, isString: true });
          enumKind = "string";
        }
      } else {
        members.set(memberName, { type: "i64", value: currentVal, isString: false });
        members.set(String(currentVal), { type: "!llvm.ptr", value: memberName, isString: true });
        currentVal++;
      }
    }

    this.enumRegistry.set(enumName, { name: enumName, members, kind: enumKind });
  }

  registerTypeAlias(node) {
    const aliasName = node.id.name;
    const innerType = this.unwrapType(node.typeAnnotation);

    if (innerType.type === "TSTypeLiteral") {
      const rawMembers =
        innerType.members ||
        innerType.body?.body ||
        innerType.body?.members ||
        (Array.isArray(innerType.body) ? innerType.body : []);

      const fields = [];
      const types = [];

      rawMembers.forEach((member, index) => {
        const fieldName = member.key?.name || member.key?.value || member.name || member.id?.name;
        const typeAnnot = member.typeAnnotation;
        const fieldType = this.resolveType(typeAnnot);
        const structName = this.getStructName(typeAnnot);
        const isString = this.isStringType(typeAnnot);
        fields.push({ name: fieldName, type: fieldType, structName, isString, index });
        types.push(fieldType);
      });

      const mlirType = `!llvm.struct<(${types.join(", ")})>`;
      this.structRegistry.set(aliasName, { name: aliasName, fields, mlirType, methods: new Map() });
    } else if (innerType.type === "TSIntersectionType") {
      const mergedFields = [];
      const mergedTypes = [];
      let idx = 0;

      const typesList = innerType.types || [];
      for (const t of typesList) {
        const sName = this.getStructName(t);
        if (sName && this.structRegistry.has(sName)) {
          const meta = this.structRegistry.get(sName);
          for (const f of meta.fields) {
            if (f.name !== "__type_id") {
              mergedFields.push({ ...f, index: idx++ });
              mergedTypes.push(f.type);
            }
          }
        }
      }
      const mlirType = `!llvm.struct<(${mergedTypes.join(", ")})>`;
      this.structRegistry.set(aliasName, { name: aliasName, fields: mergedFields, mlirType, methods: new Map() });
    }

    this.typeAliasRegistry.set(aliasName, innerType);
  }

  lowerInterface(node) {
    const structName = node.id.name;
    const fields = [];
    const types = [];

    const members =
      node.members ||
      node.body?.body ||
      node.body?.members ||
      (Array.isArray(node.body) ? node.body : []);

    members.forEach((member, index) => {
      if (member.type === "TSPropertySignature" || member.key) {
        const fieldName = member.key?.name || member.key?.value || member.name;
        const fieldType = this.resolveType(member.typeAnnotation);
        const structName = this.getStructName(member.typeAnnotation);
        const isString = this.isStringType(member.typeAnnotation);
        fields.push({ name: fieldName, type: fieldType, structName, isString, index });
        types.push(fieldType);
      }
    });

    const mlirType = `!llvm.struct<(${types.join(", ")})>`;
    this.structRegistry.set(structName, { name: structName, fields, mlirType, methods: new Map() });
  }

  resolveClassHierarchy(rawClasses) {
    const classMap = new Map();
    for (const node of rawClasses) {
      const name = node.id.name;
      const superClass = node.superClass?.name || null;
      classMap.set(name, { node, name, superClass });
    }

    const visited = new Set();
    const ordered = [];

    const visit = (name) => {
      if (visited.has(name)) return;
      const item = classMap.get(name);
      if (!item) return;
      if (item.superClass) visit(item.superClass);
      visited.add(name);
      ordered.push(item);
    };

    for (const name of classMap.keys()) {
      visit(name);
    }

    this.classList = ordered;
    let nextTypeId = 1;

    for (const { node, name, superClass } of ordered) {
      const parentMeta = superClass ? this.structRegistry.get(superClass) : null;
      const fields = [];
      const types = [];
      const typeId = nextTypeId++;

      fields.push({ name: "__type_id", type: "i32", index: 0 });
      types.push("i32");

      if (parentMeta) {
        for (let i = 1; i < parentMeta.fields.length; i++) {
          const f = parentMeta.fields[i];
          fields.push({
            name: f.name,
            type: f.type,
            structName: f.structName,
            isString: f.isString,
            index: fields.length,
          });
          types.push(f.type);
        }
      }

      const bodyElements = node.body?.body || [];
      const ownMethods = new Map();

      for (const elem of bodyElements) {
        if (elem.type === "PropertyDefinition") {
          const fieldName = elem.key.name || elem.key.value;
          const fieldType = this.resolveType(elem.typeAnnotation);
          const structName = this.getStructName(elem.typeAnnotation);
          const isString = this.isStringType(elem.typeAnnotation);
          fields.push({ name: fieldName, type: fieldType, structName, isString, index: fields.length });
          types.push(fieldType);
        } else if (elem.type === "MethodDefinition") {
          const mName = elem.key.name || elem.key.value;
          const isConstructor = elem.kind === "constructor";
          const retType = isConstructor ? "none" : this.resolveType(elem.value?.returnType);
          const structRetName = isConstructor ? name : this.getStructName(elem.value?.returnType);
          const isRetString = !isConstructor && this.isStringType(elem.value?.returnType);

          const rawParams = Array.isArray(elem.value?.params)
            ? elem.value.params
            : Array.isArray(elem.value?.params?.items)
            ? elem.value.params.items
            : [];
          const params = [];
          rawParams.forEach((param, i) => {
            const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
            const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
            const isFn = this.isFunctionType(typeAnnot);
            const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
            const isUnion = this.isUnionType(typeAnnot);
            const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
            const pType = isFn ? fnSig.mlirType : (isUnion || isArr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
            params.push({ name: pName, type: pType, isUnion, isArray: isArr, isFunction: isFn, fnSig });
          });

          ownMethods.set(mName, {
            name: mName,
            className: name,
            isConstructor,
            retType,
            structRetName,
            isRetString,
            params,
            node: elem,
          });
        }
      }

      const mlirType = `!llvm.struct<(${types.join(", ")})>`;
      this.structRegistry.set(name, {
        name,
        superClass,
        typeId,
        fields,
        types,
        mlirType,
        methods: ownMethods,
        isClass: true,
      });
    }
  }

  emitVCallRouters() {
    for (const baseCls of this.classList) {
      const baseMeta = this.structRegistry.get(baseCls.name);

      for (const [mName, mMeta] of baseMeta.methods.entries()) {
        if (mMeta.isConstructor) continue;

        const overrides = [];
        for (const subCls of this.classList) {
          if (subCls.name === baseCls.name) continue;
          let curr = this.structRegistry.get(subCls.name);
          let isDescendant = false;
          while (curr && curr.superClass) {
            if (curr.superClass === baseCls.name) {
              isDescendant = true;
              break;
            }
            curr = this.structRegistry.get(curr.superClass);
          }

          if (isDescendant) {
            const subMeta = this.structRegistry.get(subCls.name);
            if (subMeta.methods.has(mName)) {
              overrides.push(subMeta);
            }
          }
        }

        if (overrides.length === 0) continue;

        const routerName = `${baseCls.name}_vcall_${mName}`;
        this.vcallRouters.add(routerName);

        const retType = mMeta.retType;
        const sig = retType === "none" ? "" : ` -> ${retType}`;

        const methodParams = mMeta.params || [];
        const paramSigList = [`%arg_this: !llvm.ptr`, ...methodParams.map((p, idx) => `%arg_${idx}: ${p.type}`)];
        const callArgsList = [`%arg_this`, ...methodParams.map((p, idx) => `%arg_${idx}`)];
        const callTypesList = [`!llvm.ptr`, ...methodParams.map((p) => p.type)];

        this.builder.block(`func.func @${routerName}(${paramSigList.join(", ")})${sig}`, () => {
          const typeIdSSA = this.builder.nextSSA();
          this.builder.emit(`${typeIdSSA} = llvm.load %arg_this : !llvm.ptr -> i32`);

          let resSlot = null;
          if (retType !== "none") {
            resSlot = this.builder.allocateStack(retType);
            const defVal = this.builder.nextSSA();
            this.builder.emit(
              `${defVal} = func.call @${baseCls.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ${retType}`
            );
            this.builder.emit(`llvm.store ${defVal}, ${resSlot.ptr} : ${retType}, !llvm.ptr`);
          } else {
            this.builder.emit(
              `func.call @${baseCls.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ()`
            );
          }

          for (const ov of overrides) {
            const cId = this.builder.nextSSA();
            const cmp = this.builder.nextSSA();
            this.builder.emit(`${cId} = arith.constant ${ov.typeId} : i32`);
            this.builder.emit(`${cmp} = arith.cmpi eq, ${typeIdSSA}, ${cId} : i32`);

            this.builder.createIf({ ssa: cmp }, () => {
              if (retType !== "none") {
                const subVal = this.builder.nextSSA();
                this.builder.emit(
                  `${subVal} = func.call @${ov.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ${retType}`
                );
                this.builder.emit(`llvm.store ${subVal}, ${resSlot.ptr} : ${retType}, !llvm.ptr`);
              } else {
                this.builder.emit(
                  `func.call @${ov.name}_${mName}(${callArgsList.join(", ")}) : (${callTypesList.join(", ")}) -> ()`
                );
              }
            });
          }

          if (retType !== "none") {
            const finalVal = this.builder.load(resSlot.ptr, retType);
            this.builder.emit(`func.return ${finalVal.ssa} : ${retType}`);
          } else {
            this.builder.createReturn();
          }
        });
      }
    }
  }

  lowerClassMethods(node) {
    const className = node.id.name;
    const bodyElements = node.body?.body || [];

    for (const elem of bodyElements) {
      if (elem.type !== "MethodDefinition") continue;

      const isConstructor = elem.kind === "constructor";
      const methodName = elem.key.name || elem.key.value;
      const fnName = isConstructor ? `${className}_constructor` : `${className}_${methodName}`;

      const fnExpr = elem.value;
      const rawParams = Array.isArray(fnExpr.params)
        ? fnExpr.params
        : Array.isArray(fnExpr.params?.items)
        ? fnExpr.params.items
        : [];

      const paramStrings = [`%arg_this: !llvm.ptr`];
      const params = [{ name: "this", ssa: "%arg_this", type: "!llvm.ptr", structName: className }];

      rawParams.forEach((param, i) => {
        const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
        const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
        const isFn = this.isFunctionType(typeAnnot);
        const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
        const isUnion = this.isUnionType(typeAnnot);
        const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
        const pType = isFn ? fnSig.mlirType : (isUnion || isArr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
        const structName = this.getStructName(typeAnnot);
        const ssaArg = `%arg_${pName}`;

        paramStrings.push(`${ssaArg}: ${pType}`);
        params.push({ name: pName, ssa: ssaArg, type: pType, structName, isUnion, isArray: isArr, isFunction: isFn, fnSig, typeAnnot });
      });

      const retType = isConstructor ? "none" : this.resolveType(fnExpr.returnType);
      const sig = retType === "none" ? "" : ` -> ${retType}`;

      this.builder.block(`func.func @${fnName}(${paramStrings.join(", ")})${sig}`, () => {
        this.enterScope(true);

        const prevSyms = new Map(this.symbolTable);
        this.symbolTable.clear();

        this.symbolTable.set("this", {
          ptr: "%arg_this",
          ssa: "%arg_this",
          type: "!llvm.ptr",
          structName: className,
          isRef: true,
        });

        for (const p of params) {
          if (p.name === "this") continue;
          if (p.isFunction) {
            this.symbolTable.set(p.name, {
              ssa: p.ssa,
              ptr: p.ssa,
              type: p.type,
              isFunction: true,
              fnSig: p.fnSig,
            });
          } else if (p.isUnion) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              isUnion: true,
              unionNode: p.typeAnnot,
            });
          } else if (p.isArray) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              isArray: true,
              isRef: true,
            });
          } else if (p.structName) {
            this.symbolTable.set(p.name, {
              ptr: p.ssa,
              ssa: p.ssa,
              type: "!llvm.ptr",
              structName: p.structName,
              isRef: true,
            });
          } else {
            const slot = this.builder.allocateStack(p.type);
            this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
            this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true });
          }
        }

        if (fnExpr.body?.body) {
          for (const s of fnExpr.body.body) {
            this.lowerStatement(s);
          }
        }

        if (retType === "none") {
          this.exitScope();
          this.builder.createReturn();
        } else if (this.scopeStack.length > 0 && this.scopeStack[this.scopeStack.length - 1].isFunction) {
          this.scopeStack.pop();
        }

        this.symbolTable = prevSyms;
      });
    }
  }

  // --- ASYNC & STANDART FONKSİYON LOWERING ---
  lowerFunction(node) {
    const funcName = node.id.name;
    const isAsync = Boolean(node.async);
    const fnMeta = this.functionRegistry.get(funcName);

    const params = [];
    const paramStrings = [];
    const paramTypes = [];

    const rawParams = Array.isArray(node.params)
      ? node.params
      : Array.isArray(node.params?.items)
      ? node.params.items
      : [];

    rawParams.forEach((param, i) => {
      const pName = param.name || param.pattern?.name || param.id?.name || `arg_${i}`;
      const typeAnnot = param.typeAnnotation || param.pattern?.typeAnnotation || param.id?.typeAnnotation;
      const isFn = this.isFunctionType(typeAnnot);
      const fnSig = isFn ? this.extractFunctionType(typeAnnot) : null;
      const isUnion = this.isUnionType(typeAnnot);
      const isArr = this.unwrapType(typeAnnot)?.type === "TSArrayType";
      const pType = isFn ? fnSig.mlirType : (isUnion || isArr) ? "!llvm.ptr" : this.resolveType(typeAnnot);
      const structName = this.getStructName(typeAnnot);

      const ssaArg = `%arg_${pName}`;
      paramStrings.push(`${ssaArg}: ${pType}`);
      paramTypes.push(pType);
      params.push({ name: pName, ssa: ssaArg, type: pType, structName, isUnion, isArray: isArr, isFunction: isFn, fnSig, typeAnnot });
    });

    const innerRetType = fnMeta?.innerRetType || "f64";
    const retType = isAsync ? "!llvm.ptr" : innerRetType;

    // A. ASYNC FUNCTION: Arka plan thread'ine lifting
    if (isAsync) {
      const innerName = `__async_inner_${funcName}`;
      const runnerName = `__async_runner_${funcName}`;
      const innerSig = innerRetType === "none" ? "" : ` -> ${innerRetType}`;

      // 1. İç mantık fonksiyonu (@__async_inner_*)
      this.builder.block(`func.func @${innerName}(${paramStrings.join(", ")})${innerSig}`, () => {
        this.enterScope(true);
        const prevSyms = new Map(this.symbolTable);

        for (const p of params) {
          const slot = this.builder.allocateStack(p.type);
          this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
          this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true });
        }

        if (node.body?.body) {
          for (const s of node.body.body) {
            this.lowerStatement(s);
          }
        }

        if (innerRetType === "none") {
          this.exitScope();
          this.builder.createReturn();
        }
        this.symbolTable = prevSyms;
      });

      // 2. pthread runner fonksiyonu (@__async_runner_*)
      this.builder.block(`func.func @${runnerName}(%arg_ctx: !llvm.ptr) -> !llvm.ptr`, () => {
        const callArgs = [];
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p.type === "f64") {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr %arg_ctx[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            const loaded = this.builder.load(gep, "f64");
            callArgs.push(loaded.ssa);
          } else {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr %arg_ctx[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            const loaded = this.builder.load(gep, "!llvm.ptr");
            callArgs.push(loaded.ssa);
          }
        }

        const callStr = callArgs.join(", ");
        const typeStr = paramTypes.join(", ");

        if (innerRetType === "none") {
          this.builder.emit(`func.call @${innerName}(${callStr}) : (${typeStr}) -> ()`);
        } else {
          const resSSA = this.builder.nextSSA();
          this.builder.emit(`${resSSA} = func.call @${innerName}(${callStr}) : (${typeStr}) -> ${innerRetType}`);
          if (innerRetType === "f64") {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr %arg_ctx[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${resSSA}, ${resGEP} : f64, !llvm.ptr`);
          } else {
            const resGEP = this.builder.nextSSA();
            this.builder.emit(`${resGEP} = llvm.getelementptr %arg_ctx[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${resSSA}, ${resGEP} : !llvm.ptr, !llvm.ptr`);
          }
        }

        const nullRet = this.builder.nextSSA();
        this.builder.emit(`${nullRet} = llvm.mlir.zero : !llvm.ptr`);
        this.builder.emit(`func.return ${nullRet} : !llvm.ptr`);
      });

      // 3. Çağrıcı fonksiyon (@compute: TaskContext ayırır, pthread_create başlatır ve döner)
      this.builder.block(`func.func @${funcName}(${paramStrings.join(", ")}) -> !llvm.ptr`, () => {
        const ctxSz = this.builder.nextSSA();
        this.builder.emit(`${ctxSz} = llvm.mlir.constant(48 : i64) : i64`);
        const taskPtr = this.builder.nextSSA();
        this.builder.emit(`${taskPtr} = llvm.call @malloc(${ctxSz}) : (i64) -> !llvm.ptr`);

        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p.type === "f64") {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr ${taskPtr}[0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${p.ssa}, ${gep} : f64, !llvm.ptr`);
          } else {
            const gep = this.builder.nextSSA();
            this.builder.emit(`${gep} = llvm.getelementptr ${taskPtr}[0, 2] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
            this.builder.emit(`llvm.store ${p.ssa}, ${gep} : !llvm.ptr, !llvm.ptr`);
          }
        }

        const nullAttr = this.builder.nextSSA();
        this.builder.emit(`${nullAttr} = llvm.mlir.zero : !llvm.ptr`);

        // DÜZELTME: Runner fonksiyonunu func.constant ile alıp func.call ile pthread_create'e geçiyoruz
        const runnerAddr = this.builder.nextSSA();
        this.builder.emit(`${runnerAddr} = func.constant @${runnerName} : (!llvm.ptr) -> !llvm.ptr`);

        const createRes = this.builder.nextSSA();
        this.builder.emit(
          `${createRes} = func.call @pthread_create(${taskPtr}, ${nullAttr}, ${runnerAddr}, ${taskPtr}) : (!llvm.ptr, !llvm.ptr, (!llvm.ptr) -> !llvm.ptr, !llvm.ptr) -> i32`
        );

        this.builder.emit(`func.return ${taskPtr} : !llvm.ptr`);
      });

      return;
    }

    // B. STANDART SENKRON FONKSİYON
    const sig = retType === "none" ? "" : ` -> ${retType}`;
    this.builder.block(`func.func @${funcName}(${paramStrings.join(", ")})${sig}`, () => {
      this.enterScope(true);
      const prevSyms = new Map(this.symbolTable);

      for (const p of params) {
        if (p.isFunction) {
          this.symbolTable.set(p.name, {
            ssa: p.ssa,
            ptr: p.ssa,
            type: p.type,
            isFunction: true,
            fnSig: p.fnSig,
          });
        } else if (p.isUnion) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isUnion: true,
            unionNode: p.typeAnnot,
          });
        } else if (p.isArray) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            isArray: true,
            isRef: true,
          });
        } else if (p.structName) {
          this.symbolTable.set(p.name, {
            ptr: p.ssa,
            ssa: p.ssa,
            type: "!llvm.ptr",
            structName: p.structName,
            isRef: true,
          });
        } else {
          const slot = this.builder.allocateStack(p.type);
          this.builder.store(slot.ptr, { ssa: p.ssa, type: p.type });
          this.symbolTable.set(p.name, { ptr: slot.ptr, type: p.type, isRef: true });
        }
      }

      if (node.body?.body) {
        for (const stmt of node.body.body) {
          this.lowerStatement(stmt);
        }
      }

      if (retType === "none") {
        this.exitScope();
        this.builder.createReturn();
      } else if (this.scopeStack.length > 0 && this.scopeStack[this.scopeStack.length - 1].isFunction) {
        this.scopeStack.pop();
      }

      this.symbolTable = prevSyms;
    });
  }

  lowerStatement(stmt) {
    switch (stmt.type) {
      case "TryStatement": {
        const localJmpBuf = this.builder.allocateStack("!llvm.array<200 x i8>");
        const gJmpBufAddr = this.builder.nextSSA();
        this.builder.emit(`${gJmpBufAddr} = llvm.mlir.addressof @rts_current_jmpbuf : !llvm.ptr`);
        const prevJmpBuf = this.builder.load(gJmpBufAddr, "!llvm.ptr");
        this.builder.store(gJmpBufAddr, { ssa: localJmpBuf.ptr, type: "!llvm.ptr" });

        const setjmpRes = this.builder.nextSSA();
        this.builder.emit(`${setjmpRes} = llvm.call @setjmp(${localJmpBuf.ptr}) : (!llvm.ptr) -> i32`);

        const zero = this.builder.createConstant(0, "i32");
        const cmp = this.builder.createComparison("==", { ssa: setjmpRes, type: "i32" }, zero);

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

        if (stmt.finalizer) {
          this.lowerStatement(stmt.finalizer);
        }
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
        for (const decl of stmt.declarations) {
          const varName = decl.id.name;
          const isUnion = this.isUnionType(decl.id.typeAnnotation);
          const explicitStruct = this.getStructName(decl.id.typeAnnotation);

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
            const val = this.lowerExpression(decl.init);

            if (val.isMap || val.isSet) {
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
            } else if (val.isFunction) {
              this.symbolTable.set(varName, {
                ssa: val.ssa,
                ptr: val.ssa,
                type: val.type,
                isFunction: true,
                fnSig: val.fnSig,
              });
            } else if (val.isArray || (decl.init && decl.init.type === "ArrayExpression")) {
              this.symbolTable.set(varName, {
                ptr: val.ptr || val.ssa,
                ssa: val.ssa || val.ptr,
                type: "!llvm.ptr",
                isArray: true,
                arrayLen: val.arrayLen || val.length,
                elemType: val.elemType || "f64",
                isRef: true,
              });
            } else if (decl.init.type === "NewExpression") {
              this.symbolTable.set(varName, {
                ptr: val.ssa,
                type: "!llvm.ptr",
                structName: val.structName,
                isRef: true,
              });
            } else {
              const finalStruct = explicitStruct || val.structName;

              if (finalStruct) {
                this.symbolTable.set(varName, {
                  ptr: val.ssa || val.ptr,
                  type: "!llvm.ptr",
                  structName: finalStruct,
                  isRef: true,
                });
              } else {
                const slot = this.builder.allocateStack(val.type);
                this.builder.store(slot.ptr, val);
                this.symbolTable.set(varName, {
                  ptr: slot.ptr,
                  type: val.type,
                  isRef: true,
                  isString: val.isString || this.isStringType(decl.id.typeAnnotation),
                });
              }
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

      case "ForStatement": {
        this.enterScope(false);
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            this.lowerStatement(stmt.init);
          } else {
            this.lowerExpression(stmt.init);
          }
        }
        this.builder.createWhile(
          () => (stmt.test ? this.lowerExpression(stmt.test) : this.builder.createConstant(1, "i1")),
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.body);
            if (stmt.update) {
              this.lowerExpression(stmt.update);
            }
            this.exitScope();
          }
        );
        this.exitScope();
        break;
      }

      case "WhileStatement": {
        this.builder.createWhile(
          () => this.lowerExpression(stmt.test),
          () => {
            this.enterScope(false);
            this.lowerStatement(stmt.body);
            this.exitScope();
          }
        );
        break;
      }

      case "IfStatement": {
        const typeofCheck = this.extractTypeofCheck(stmt.test);
        let originalSym = null;
        let narrowedVarName = null;

        if (typeofCheck) {
          const sym = this.symbolTable.get(typeofCheck.varName);
          if (sym && sym.isUnion) {
            narrowedVarName = typeofCheck.varName;
            originalSym = sym;
          }
        }

        const cond = this.lowerExpression(stmt.test);
        this.builder.createIf(
          cond,
          () => {
            this.enterScope(false);
            if (narrowedVarName) {
              const unboxed = this.unboxUnion(originalSym.ptr || originalSym.ssa, typeofCheck.targetType);
              if (unboxed) {
                this.symbolTable.set(narrowedVarName, unboxed);
              }
            }
            this.lowerStatement(stmt.consequent);
            if (narrowedVarName) {
              this.symbolTable.set(narrowedVarName, originalSym);
            }
            this.exitScope();
          },
          stmt.alternate
            ? () => {
                this.enterScope(false);
                if (narrowedVarName) {
                  let otherType = null;
                  if (typeofCheck.targetType === "string") otherType = "number";
                  else if (typeofCheck.targetType === "number") otherType = "string";

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
              }
            : null
        );
        break;
      }

      case "BlockStatement": {
        this.enterScope(false);
        for (const s of stmt.body) {
          this.lowerStatement(s);
        }
        this.exitScope();
        break;
      }

      case "ReturnStatement": {
        if (stmt.argument) {
          const val = this.lowerExpression(stmt.argument);
          if (val.type === "!llvm.ptr" || val.isHeap) {
            this.markTransferred(val.ssa || val.ptr);
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

  lowerNewExpression(expr) {
    const className = expr.callee.name;

    if (className === "Map" || className === "Set") {
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

    const classMeta = this.structRegistry.get(className);
    if (!classMeta) {
      throw new Error(`[Lowering] Tanımsız sınıf: ${className}`);
    }

    const byteSize = Math.max(classMeta.fields.length * 8, 8);
    const heapSlot = this.builder.allocateHeap(byteSize);

    const typeIdConst = this.builder.nextSSA();
    this.builder.emit(`${typeIdConst} = arith.constant ${classMeta.typeId} : i32`);
    this.builder.emit(`llvm.store ${typeIdConst}, ${heapSlot.ptr} : i32, !llvm.ptr`);

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
        if (paramMeta && !val.isFunction) {
          val = this.coerceType(val, paramMeta.type);
        }
        return val;
      }) : [];
      const allArgsSSA = [heapSlot.ptr, ...args.map((a) => a.ssa || a.ptr)];
      const allArgsType = ["!llvm.ptr", ...args.map((a) => a.type)];

      this.builder.emit(
        `func.call @${className}_constructor(${allArgsSSA.join(", ")}) : (${allArgsType.join(", ")}) -> ()`
      );
    }

    return {
      ssa: heapSlot.ptr,
      ptr: heapSlot.ptr,
      type: "!llvm.ptr",
      structName: className,
      isRef: true,
      isHeap: true,
    };
  }

  inferStructName(objExpr) {
    const propNames = objExpr.properties.map((p) => p.key?.name || p.key?.value);
    for (const [sName, sMeta] of this.structRegistry.entries()) {
      const metaFields = sMeta.fields.filter((f) => f.name !== "__type_id").map((f) => f.name);
      if (propNames.length === metaFields.length && propNames.every((p) => metaFields.includes(p))) {
        return sName;
      }
    }
    throw new Error(`[Lowering] Nesne alanlarıyla (${propNames.join(", ")}) eşleşen bir interface/class bulunamadı!`);
  }

  instantiateStruct(objExpr, structName) {
    const structMeta = this.structRegistry.get(structName);
    const byteSize = Math.max(structMeta.fields.length * 8, 8);
    const heapSlot = this.builder.allocateHeap(byteSize);

    if (structMeta.isClass && structMeta.typeId) {
      const typeIdConst = this.builder.nextSSA();
      this.builder.emit(`${typeIdConst} = arith.constant ${structMeta.typeId} : i32`);
      this.builder.emit(`llvm.store ${typeIdConst}, ${heapSlot.ptr} : i32, !llvm.ptr`);
    }

    for (const prop of objExpr.properties) {
      const fieldName = prop.key.name || prop.key.value;
      const fieldMeta = structMeta.fields.find((f) => f.name === fieldName);
      if (!fieldMeta) {
        throw new Error(`[Lowering] '${structName}' üzerinde '${fieldName}' alanı bulunamadı!`);
      }
      let val = this.lowerExpression(prop.value);
      val = this.coerceType(val, fieldMeta.type);

      const fieldPtr = this.builder.nextSSA();
      this.builder.emit(
        `${fieldPtr} = llvm.getelementptr ${heapSlot.ptr}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
      );
      this.builder.store(fieldPtr, val);
    }

    return heapSlot.ptr;
  }

  instantiateArray(arrExpr) {
    const len = arrExpr.elements.length;
    const byteSize = Math.max((len + 1) * 8, 16);
    const heapSlot = this.builder.allocateHeap(byteSize);

    const lenConst = this.builder.nextSSA();
    this.builder.emit(`${lenConst} = llvm.mlir.constant(${len} : i64) : i64`);
    this.builder.emit(`llvm.store ${lenConst}, ${heapSlot.ptr} : i64, !llvm.ptr`);

    arrExpr.elements.forEach((elem, index) => {
      let val = this.lowerExpression(elem);
      val = this.coerceType(val, "f64");
      const idxConst = this.builder.nextSSA();
      const elemPtr = this.builder.nextSSA();

      this.builder.emit(`${idxConst} = llvm.mlir.constant(${index + 1} : i64) : i64`);
      this.builder.emit(
        `${elemPtr} = llvm.getelementptr ${heapSlot.ptr}[${idxConst}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
      );
      this.builder.store(elemPtr, val);
    });

    return { ptr: heapSlot.ptr, length: len, arrayLen: len, elemType: "f64", isHeap: true, isArray: true };
  }

  lowerExpression(expr) {
    if (!expr) return { ssa: "", type: "none" };

    // --- ADIM 7: AWAIT İFADESİ (pthread_join) ---
    if (expr.type === "AwaitExpression") {
      const task = this.lowerExpression(expr.argument);
      const threadIdPtr = this.builder.nextSSA();
      this.builder.emit(`${threadIdPtr} = llvm.getelementptr ${task.ssa || task.ptr}[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
      const threadId = this.builder.load(threadIdPtr, "i64");

      const nullPtr = this.builder.nextSSA();
      this.builder.emit(`${nullPtr} = llvm.mlir.zero : !llvm.ptr`);

      const joinRes = this.builder.nextSSA();
      this.builder.emit(`${joinRes} = llvm.call @pthread_join(${threadId.ssa}, ${nullPtr}) : (i64, !llvm.ptr) -> i32`);

      const isStringRes = task.innerRetType === "!llvm.ptr" || task.isString;
      if (isStringRes) {
        const resPtrGEP = this.builder.nextSSA();
        this.builder.emit(`${resPtrGEP} = llvm.getelementptr ${task.ssa || task.ptr}[0, 4] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
        const loaded = this.builder.load(resPtrGEP, "!llvm.ptr");
        loaded.isString = true;
        return loaded;
      } else {
        const resF64GEP = this.builder.nextSSA();
        this.builder.emit(`${resF64GEP} = llvm.getelementptr ${task.ssa || task.ptr}[0, 3] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(i64, f64, !llvm.ptr, f64, !llvm.ptr, i32)>`);
        return this.builder.load(resF64GEP, "f64");
      }
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
      let fmtStr = "";
      const args = [];

      for (let i = 0; i < expr.quasis.length; i++) {
        const quasi = expr.quasis[i];
        fmtStr += quasi.value?.raw ?? quasi.value?.cooked ?? "";
        if (i < expr.expressions.length) {
          let arg = this.lowerExpression(expr.expressions[i]);
          if (arg.isUnion) {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call @rts_union_to_string(${arg.ssa || arg.ptr}) : (!llvm.ptr) -> !llvm.ptr`);
            arg = { ssa, ptr: ssa, type: "!llvm.ptr", isString: true, isHeap: true };
          }
          args.push(arg);
          if (arg.isString) fmtStr += "%s";
          else if (arg.type === "i64") fmtStr += "%ld";
          else if (arg.type === "i32") fmtStr += "%d";
          else if (arg.type === "i1") fmtStr += "%s";
          else fmtStr += "%f";
        }
      }

      return this.builder.createSprintf(fmtStr, args);
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

    if (expr.type === "UnaryExpression" && expr.operator === "typeof") {
      const arg = expr.argument;
      if (arg.type === "Identifier") {
        const sym = this.symbolTable.get(arg.name);
        if (sym && sym.isUnion) {
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
        const sym = this.symbolTable.get(expr.argument.name);
        const oldVal = this.builder.load(sym.ptr, sym.type);
        const step = oldVal.type === "i64" || oldVal.type === "i32" ? 1 : 1.0;
        const one = this.builder.createConstant(step, oldVal.type);
        const newVal = this.builder.createArithmetic(op, oldVal, one);
        this.builder.store(sym.ptr, newVal);
        return expr.prefix ? newVal : oldVal;
      }
    }

    if (expr.type === "Identifier") {
      if (this.symbolTable.has(expr.name)) {
        const sym = this.symbolTable.get(expr.name);
        if (sym.isFunction) {
          return {
            ssa: sym.ssa,
            ptr: sym.ptr,
            type: sym.type,
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
        if (sym.structName || sym.isArray || sym.isMap || sym.isSet || sym.isPromise) {
          return {
            ssa: sym.ptr,
            ptr: sym.ptr,
            type: "!llvm.ptr",
            structName: sym.structName,
            isArray: sym.isArray,
            isMap: sym.isMap,
            isSet: sym.isSet,
            isPromise: sym.isPromise,
            innerRetType: sym.innerRetType,
            valType: sym.valType,
            arrayLen: sym.arrayLen,
            isHeap: true,
          };
        }
        const loaded = this.builder.load(sym.ptr, sym.type);
        if (sym.isString) loaded.isString = true;
        return loaded;
      }

      if (this.functionRegistry.has(expr.name)) {
        const fnMeta = this.functionRegistry.get(expr.name);
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = func.constant @${expr.name} : ${fnMeta.mlirType}`);
        return {
          ssa,
          ptr: ssa,
          type: fnMeta.mlirType,
          isFunction: true,
          fnSig: {
            paramTypes: fnMeta.paramTypes,
            retType: fnMeta.retType,
            mlirType: fnMeta.mlirType,
          },
        };
      }

      throw new Error(`[Lowering] Tanımsız değişken veya fonksiyon: ${expr.name}`);
    }

    if (expr.type === "MemberExpression") {
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

      if (!expr.computed && (expr.property.name || expr.property.value) === "length") {
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = llvm.load ${base.ptr || base.ssa} : !llvm.ptr -> i64`);
        return { ssa, type: "i64" };
      }

      if (expr.computed) {
        let idxVal = this.lowerExpression(expr.property);
        idxVal = this.coerceType(idxVal, "i64");
        const one = this.builder.createConstant(1, "i64");
        const realIdx = this.builder.createArithmetic("+", idxVal, one);

        const elemPtr = this.builder.nextSSA();
        this.builder.emit(
          `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
        );
        return this.builder.load(elemPtr, "f64");
      }

      if (base.structName) {
        const structMeta = this.structRegistry.get(base.structName);
        const fieldName = expr.property.name || expr.property.value;
        const fieldMeta = structMeta?.fields.find((f) => f.name === fieldName);

        if (!fieldMeta) {
          return { base, methodName: fieldName, isMethodRef: true, structName: base.structName };
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
        return res;
      }
    }

    if (expr.type === "AssignmentExpression" && expr.operator === "=") {
      let rhs = this.lowerExpression(expr.right);

      if (expr.left.type === "MemberExpression") {
        const base = this.lowerExpression(expr.left.object);

        if (expr.left.computed) {
          let idxVal = this.lowerExpression(expr.left.property);
          idxVal = this.coerceType(idxVal, "i64");
          const one = this.builder.createConstant(1, "i64");
          const realIdx = this.builder.createArithmetic("+", idxVal, one);
          rhs = this.coerceType(rhs, "f64");

          const elemPtr = this.builder.nextSSA();
          this.builder.emit(
            `${elemPtr} = llvm.getelementptr ${base.ptr || base.ssa}[${realIdx.ssa}] : (!llvm.ptr, i64) -> !llvm.ptr, f64`
          );
          this.builder.store(elemPtr, rhs);
          return rhs;
        }

        if (base.structName) {
          const structMeta = this.structRegistry.get(base.structName);
          const fieldName = expr.left.property.name || expr.left.property.value;
          const fieldMeta = structMeta?.fields.find((f) => f.name === fieldName);
          rhs = this.coerceType(rhs, fieldMeta.type);

          const fieldPtr = this.builder.nextSSA();
          this.builder.emit(
            `${fieldPtr} = llvm.getelementptr ${base.ptr || base.ssa}[0, ${fieldMeta.index}] : (!llvm.ptr) -> !llvm.ptr, ${structMeta.mlirType}`
          );
          this.builder.store(fieldPtr, rhs);

          if (rhs.type === "!llvm.ptr" || rhs.isHeap) {
            this.markTransferred(rhs.ssa || rhs.ptr);
          }
          return rhs;
        }
      } else if (expr.left.type === "Identifier") {
        const sym = this.symbolTable.get(expr.left.name);
        if (sym.isUnion) {
          this.boxIntoUnion(sym.ptr, rhs);
          return { ssa: sym.ptr, ptr: sym.ptr, type: "!llvm.ptr", isUnion: true };
        }
        rhs = this.coerceType(rhs, sym.type);
        this.builder.store(sym.ptr, rhs);
        if (rhs.isString) sym.isString = true;
        return rhs;
      }
    }

    if (expr.type === "LogicalExpression") {
      const lhs = this.lowerExpression(expr.left);
      const rhs = this.lowerExpression(expr.right);
      return this.builder.createLogical(expr.operator, lhs, rhs);
    }

    if (expr.type === "BinaryExpression") {
      const lhs = this.lowerExpression(expr.left);
      const rhs = this.lowerExpression(expr.right);

      if (expr.operator === "+" && (lhs.isString || rhs.isString)) {
        const fmtL = lhs.isString ? "%s" : lhs.type === "i64" ? "%ld" : lhs.type === "i32" ? "%d" : "%f";
        const fmtR = rhs.isString ? "%s" : rhs.type === "i64" ? "%ld" : rhs.type === "i32" ? "%d" : "%f";
        return this.builder.createSprintf(`${fmtL}${fmtR}`, [lhs, rhs]);
      }

      if (["+", "-", "*", "/", "%"].includes(expr.operator)) {
        return this.builder.createArithmetic(expr.operator, lhs, rhs);
      }
      if (["<", "<=", ">", ">=", "==", "===", "!=", "!=="].includes(expr.operator)) {
        return this.builder.createComparison(expr.operator, lhs, rhs);
      }
    }

    if (expr.type === "CallExpression") {
      if (expr.callee.type === "Identifier" && expr.callee.name === "sleep") {
        const msVal = this.lowerExpression(expr.arguments[0]);
        const msI32 = this.coerceType(msVal, "i32");
        const c1000 = this.builder.createConstant(1000, "i32");
        const usec = this.builder.createArithmetic("*", msI32, c1000);
        const sleepRes = this.builder.nextSSA();
        this.builder.emit(`${sleepRes} = llvm.call @usleep(${usec.ssa}) : (i32) -> i32`);
        return { ssa: "", type: "none" };
      }

      const isConsoleLog =
        expr.callee.type === "MemberExpression" &&
        expr.callee.object?.name === "console" &&
        expr.callee.property?.name === "log";

      if (isConsoleLog) {
        expr.arguments.forEach((argNode, idx) => {
          const arg = this.lowerExpression(argNode);
          if (arg.isUnion) {
            this.builder.printUnion(arg.ssa || arg.ptr);
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
            this.builder.printString(arg.ssa || arg.ptr);
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
        const base = this.lowerExpression(expr.callee.object);
        const methodName = expr.callee.property.name || expr.callee.property.value;

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

        if (base.structName) {
          let curr = this.structRegistry.get(base.structName);
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
            throw new Error(`[Lowering] '${base.structName}' sınıfında '${methodName}' metodu bulunamadı!`);
          }

          const vcallName = `${declaringClass}_vcall_${methodName}`;
          const isVCall = this.vcallRouters.has(vcallName);
          const targetFn = isVCall ? `@${vcallName}` : `@${methodMeta.className || declaringClass}_${methodName}`;

          const args = expr.arguments ? expr.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const paramMeta = methodMeta?.params?.[i];
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
        if (localSym && localSym.isFunction) {
          const fnSig = localSym.fnSig;
          const args = expr.arguments ? expr.arguments.map((a, i) => {
            let val = this.lowerExpression(a);
            const targetPType = fnSig.paramTypes?.[i];
            if (targetPType) {
              val = this.coerceType(val, targetPType);
            }
            return val;
          }) : [];

          const argSSAs = args.map((a) => a.ssa || a.ptr).join(", ");
          if (fnSig.retType === "none") {
            this.builder.emit(`func.call_indirect ${localSym.ssa || localSym.ptr}(${argSSAs}) : ${fnSig.mlirType}`);
            return { ssa: "", ptr: "", type: "none" };
          } else {
            const ssa = this.builder.nextSSA();
            this.builder.emit(`${ssa} = func.call_indirect ${localSym.ssa || localSym.ptr}(${argSSAs}) : ${fnSig.mlirType}`);
            return { ssa, ptr: ssa, type: fnSig.retType };
          }
        }
      }

      const funcName = expr.callee.name;
      const fnMeta = this.functionRegistry.get(funcName);

      const args = expr.arguments ? expr.arguments.map((a, i) => {
        let val = this.lowerExpression(a);
        const paramMeta = fnMeta?.params?.[i];
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

      const argStr = args.map((a) => a.ssa || a.ptr).join(", ");
      const typeStr = args.map((a) => a.type).join(", ");
      const retType = fnMeta?.retType || "f64";

      if (retType === "none") {
        this.builder.emit(`func.call @${funcName}(${argStr}) : (${typeStr}) -> ()`);
        return { ssa: "", ptr: "", type: "none" };
      } else {
        const ssa = this.builder.nextSSA();
        this.builder.emit(`${ssa} = func.call @${funcName}(${argStr}) : (${typeStr}) -> ${retType}`);
        return {
          ssa,
          ptr: ssa,
          type: retType,
          isPromise: Boolean(fnMeta?.isAsync),
          innerRetType: fnMeta?.innerRetType || "f64",
          structName: fnMeta?.structRetName || null,
          isString: fnMeta?.isRetString || false,
          isHeap: retType === "!llvm.ptr",
        };
      }
    }

    throw new Error(`[Lowering] Desteklenmeyen ifade: ${expr.type}`);
  }
}