// src/frontend/Monomorphizer.js
import { LambdaLifter } from "./LambdaLifter.js";

/**
 * Generic class, function, interface ve type alias şablonlarını
 * somut parametre tiplerine göre monomorphize eden (somutlaştıran) motor.
 */
export class Monomorphizer {
  constructor(enumRegistry = null, typeAliasRegistry = null) {
    this.enumRegistry = enumRegistry || new Map();
    this.typeAliasRegistry = typeAliasRegistry || new Map();

    this.genericClassTemplates = new Map();
    this.genericFunctionTemplates = new Map();
    this.genericTypeTemplates = new Map();
    this.genericInterfaceTemplates = new Map();

    this.specializedClasses = new Set();
    this.specializedFunctions = new Set();
    this.specializedTypes = new Set();

    this.registerBuiltins();
  }

  registerBuiltins() {
    // Standart Kütüphane: Yerleşik Result<T, E = string> Şablonu
    this.genericInterfaceTemplates.set("Result", {
      type: "TSInterfaceDeclaration",
      id: { type: "Identifier", name: "Result" },
      typeParameters: {
        params: [
          { name: { name: "T" } },
          { name: { name: "E" }, default: { type: "TSStringKeyword" } },
        ],
      },
      body: {
        type: "TSInterfaceBody",
        body: [
          {
            type: "TSPropertySignature",
            key: { name: "ok" },
            typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: { type: "TSBooleanKeyword" } },
          },
          {
            type: "TSPropertySignature",
            key: { name: "value" },
            typeAnnotation: {
              type: "TSTypeAnnotation",
              typeAnnotation: { type: "TSTypeReference", typeName: { name: "T" } },
            },
          },
          {
            type: "TSPropertySignature",
            key: { name: "error" },
            typeAnnotation: {
              type: "TSTypeAnnotation",
              typeAnnotation: { type: "TSTypeReference", typeName: { name: "E" } },
            },
          },
        ],
      },
    });
  }

  unwrapType(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === "TSTypeAnnotation") {
      return this.unwrapType(typeNode.typeAnnotation);
    }
    return typeNode;
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
        if (["i64", "int64", "u64", "uint64"].includes(name)) return "i64";
        if (["i32", "int32", "u32", "uint32", "int"].includes(name)) return "i32";
        if (["f64", "double"].includes(name)) return "f64";
        if (["f32", "float"].includes(name)) return "f32";
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

    if (
      (cloned.type === "ClassDeclaration" ||
        cloned.type === "FunctionDeclaration" ||
        cloned.type === "TSInterfaceDeclaration" ||
        cloned.type === "TSTypeAliasDeclaration") &&
      specializedName
    ) {
      cloned.id = { type: "Identifier", name: specializedName };
      delete cloned.typeParameters;
      delete cloned.exportAlias;
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

  instantiateGenericStruct(baseName, typeArgs) {
    const isInterface = this.genericInterfaceTemplates.has(baseName);
    const templateNode = isInterface
      ? this.genericInterfaceTemplates.get(baseName)
      : this.genericTypeTemplates.get(baseName);

    if (!templateNode) return baseName;

    const rawParams = templateNode.typeParameters?.params || [];
    const substMap = new Map();
    const resolvedTypeArgs = [];

    rawParams.forEach((param, i) => {
      const pName = param.name?.name || param.name?.value || param.name || `T${i}`;
      const defaultType = param.default || { type: "TSNumberKeyword" };
      const concreteType = typeArgs[i] || defaultType;
      substMap.set(pName, concreteType);
      resolvedTypeArgs.push(concreteType);
    });

    const typeKeys = resolvedTypeArgs.map((t) => this.getTypeKey(t));
    const specializedName = `${baseName}_${typeKeys.join("_")}`;

    if (this.specializedTypes.has(specializedName)) {
      return specializedName;
    }
    this.specializedTypes.add(specializedName);

    const specializedNode = this.deepCloneWithSubst(templateNode, substMap, specializedName);
    return { specializedName, node: specializedNode, isInterface };
  }

  specializeAll(allParsedNodes, onSynthesizedInterface = null, onSynthesizedTypeAlias = null) {
    const synthesizedClasses = [];
    const synthesizedFunctions = [];

    const scanAndSpecialize = (rootNode) => {
      LambdaLifter.walkAST(rootNode, (n) => {
        if (n.type === "TSTypeReference") {
          const typeName = n.typeName?.name || n.typeName?.value;
          const typeParams = n.typeParameters?.params || n.typeArguments?.params;
          if (typeName && typeParams) {
            if (this.genericClassTemplates.has(typeName)) {
              const spec = this.instantiateGenericClass(typeName, typeParams);
              if (spec && spec.node) {
                synthesizedClasses.push(spec.node);
              }
              n.typeName.name = spec.specializedName || spec;
              delete n.typeParameters;
              delete n.typeArguments;
            } else if (this.genericInterfaceTemplates.has(typeName) || this.genericTypeTemplates.has(typeName)) {
              const spec = this.instantiateGenericStruct(typeName, typeParams);
              if (spec && spec.node) {
                if (spec.isInterface && onSynthesizedInterface) {
                  onSynthesizedInterface(spec.node);
                } else if (!spec.isInterface && onSynthesizedTypeAlias) {
                  onSynthesizedTypeAlias(spec.node);
                }
              }
              n.typeName.name = spec.specializedName || spec;
              delete n.typeParameters;
              delete n.typeArguments;
            }
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

    return { synthesizedClasses, synthesizedFunctions };
  }
}
