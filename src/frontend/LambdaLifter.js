// src/frontend/LambdaLifter.js

/**
 * Arrow ve anonim fonksiyon ifadelerini @__lambda_* fonksiyon bildirimlerine
 * dönüştüren ve üst kapsama taşıyan (lifting) AST geçiş motoru.
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

  static liftLambdas(rootNodes) {
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
              const body =
                item.body.type === "BlockStatement"
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
            const body =
              child.body.type === "BlockStatement"
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
}
