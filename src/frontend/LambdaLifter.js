// src/frontend/LambdaLifter.js

/**
 * Arrow ve anonim fonksiyon ifadelerini Fat Pointer destekli closure fonksiyon bildirimlerine
 * dönüştüren ve üst kapsama taşıyan (closure conversion & lifting) AST geçiş motoru.
 */
export class LambdaLifter {
  static walkAST(node, visitor) {
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

  static collectFunctionDeclarations(node) {
    const map = new Map();
    const rawParams = Array.isArray(node.params)
      ? node.params
      : Array.isArray(node.params?.items)
      ? node.params.items
      : [];

    for (const p of rawParams) {
      const name = p.name || p.pattern?.name || p.id?.name;
      const typeAnnotation = p.typeAnnotation || p.pattern?.typeAnnotation || p.id?.typeAnnotation;
      if (name) map.set(name, { name, typeAnnotation });
    }

    function scanDecls(n) {
      if (!n || typeof n !== "object") return;
      if (n.type === "VariableDeclaration") {
        for (const d of n.declarations || []) {
          const dName = d.id?.name || d.id?.pattern?.name;
          const typeAnnotation = d.id?.typeAnnotation;
          if (dName) map.set(dName, { name: dName, typeAnnotation });
        }
      } else if (
        n.type === "FunctionDeclaration" ||
        n.type === "ArrowFunctionExpression" ||
        n.type === "FunctionExpression"
      ) {
        return;
      }
      for (const key of Object.keys(n)) {
        if (key === "parent") continue;
        const child = n[key];
        if (Array.isArray(child)) {
          for (const item of child) scanDecls(item);
        } else if (child && typeof child === "object") {
          scanDecls(child);
        }
      }
    }
    if (node.body) {
      scanDecls(node.body);
    }
    return map;
  }

  static extractFreeVariables(lambdaNode, enclosingDeclared) {
    const localDeclared = new Set();
    const rawParams = Array.isArray(lambdaNode.params)
      ? lambdaNode.params
      : Array.isArray(lambdaNode.params?.items)
      ? lambdaNode.params.items
      : [];

    for (const p of rawParams) {
      const name = p.name || p.pattern?.name || p.id?.name;
      if (name) localDeclared.add(name);
    }

    function scanDeclarations(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "VariableDeclaration") {
        for (const d of node.declarations || []) {
          const dName = d.id?.name || d.id?.pattern?.name;
          if (dName) localDeclared.add(dName);
        }
      } else if (
        node.type === "FunctionDeclaration" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression"
      ) {
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) scanDeclarations(item);
        } else if (child && typeof child === "object") {
          scanDeclarations(child);
        }
      }
    }

    scanDeclarations(lambdaNode.body);

    const captured = new Map();
    const builtins = new Set([
      "console",
      "Math",
      "undefined",
      "NaN",
      "Infinity",
      "true",
      "false",
      "null",
      "borrow",
      "panic",
      "assert",
      "sleep",
      "unwrap",
      "print",
      "rts_strlen",
      "rts_str_slice",
      "rts_strcmp",
    ]);

    function scanUses(node, parent, parentKey) {
      if (!node || typeof node !== "object") return;

      if (node.type === "Identifier") {
        if (parent && parent.type === "MemberExpression" && parentKey === "property" && !parent.computed) {
          return;
        }
        if (
          parent &&
          (parent.type === "Property" || parent.type === "ObjectProperty") &&
          parentKey === "key" &&
          !parent.computed
        ) {
          return;
        }
        if (parent && (parent.type === "BreakStatement" || parent.type === "ContinueStatement")) {
          return;
        }
        if (parent && (parentKey === "typeAnnotation" || parent.type?.startsWith?.("TS"))) {
          return;
        }

        const name = node.name;
        if (!localDeclared.has(name) && !builtins.has(name) && enclosingDeclared.has(name)) {
          captured.set(name, enclosingDeclared.get(name));
        }
        return;
      }

      if (node.type === "TSTypeAnnotation" || node.type === "TSType") return;

      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) scanUses(item, node, key);
        } else if (child && typeof child === "object") {
          scanUses(child, node, key);
        }
      }
    }

    scanUses(lambdaNode.body, null, null);
    return Array.from(captured.values());
  }

  static liftLambdas(rootNodes) {
    const lifted = [];
    let lambdaId = 0;
    const scopeStack = [];

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

    const processLambda = (item) => {
      // İç içe lambda'ları önce işle
      const lambdaScope = this.collectFunctionDeclarations(item);
      scopeStack.push(lambdaScope);
      recurse(item.body);
      scopeStack.pop();

      // Dış kapsamlardan yakalanan serbest değişkenleri tespit et
      const enclosing = new Map();
      for (const sc of scopeStack) {
        for (const [k, v] of sc.entries()) enclosing.set(k, v);
      }
      const captures = this.extractFreeVariables(item, enclosing);
      const lambdaName = `__closure_${lambdaId++}`;
      const body =
        item.body.type === "BlockStatement"
          ? item.body
          : { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: item.body }] };

      const retType = item.returnType || inferReturnType(item.body);

      const envParam = {
        type: "Identifier",
        name: "__env",
        typeAnnotation: { type: "TSTypeReference", typeName: { name: "!llvm.ptr" } },
      };

      const rawParams = Array.isArray(item.params)
        ? item.params
        : Array.isArray(item.params?.items)
        ? item.params.items
        : [];

      const fnDecl = {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: lambdaName },
        params: [envParam, ...rawParams],
        returnType: retType,
        body: body,
        isClosure: true,
        captures: captures.map((c) => c.name),
        capturesMeta: captures,
      };
      lifted.push(fnDecl);

      return {
        type: "ClosureExpression",
        lambdaName,
        captures: captures.map((c) => c.name),
        capturesMeta: captures,
        params: rawParams,
        returnType: retType,
        originalNode: item,
      };
    };

    const recurse = (node) => {
      if (!node || typeof node !== "object") return;

      if (node.type === "FunctionDeclaration") {
        const fnScope = this.collectFunctionDeclarations(node);
        scopeStack.push(fnScope);
        recurse(node.body);
        scopeStack.pop();
        return;
      }

      if (node.type === "ClassDeclaration") {
        if (node.body?.body) {
          for (const member of node.body.body) {
            if (member.type === "MethodDefinition" && member.value) {
              const mScope = this.collectFunctionDeclarations(member.value);
              scopeStack.push(mScope);
              recurse(member.value.body);
              scopeStack.pop();
            }
          }
        }
        return;
      }

      if (node.type === "MethodDefinition" && node.value) {
        const mScope = this.collectFunctionDeclarations(node.value);
        scopeStack.push(mScope);
        recurse(node.value.body);
        scopeStack.pop();
        return;
      }

      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const child = node[key];

        if (Array.isArray(child)) {
          for (let i = 0; i < child.length; i++) {
            const item = child[i];
            if (item && (item.type === "ArrowFunctionExpression" || item.type === "FunctionExpression")) {
              child[i] = processLambda(item);
            } else {
              recurse(item);
            }
          }
        } else if (child && typeof child === "object") {
          if (child.type === "ArrowFunctionExpression" || child.type === "FunctionExpression") {
            node[key] = processLambda(child);
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
}
