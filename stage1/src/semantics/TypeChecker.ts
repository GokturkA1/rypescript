// stage1/src/semantics/TypeChecker.ts
import { BuiltinRegistry } from "./BuiltinRegistry.ts";
import { ScopeManager } from "./ScopeManager.ts";

export class TypeChecker {
  builtins: BuiltinRegistry;
  scopeManager: ScopeManager;

  constructor(builtins: BuiltinRegistry, scopeManager: ScopeManager) {
    this.builtins = builtins;
    this.scopeManager = scopeManager;
  }

  isAssignable(srcType: string, destType: string): boolean {
    if (srcType === destType) return true;
    if (destType === "number" && (srcType === "i32" || srcType === "i64" || srcType === "f64" || srcType === "u8")) return true;
    return false;
  }
}
