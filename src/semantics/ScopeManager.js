// src/semantics/ScopeManager.js

/**
 * Kapsam yığını (scope stack), sembol çözümleme (lookupSymbol)
 * ve değişken yaşam döngüsünü yöneten bileşen.
 */
export class ScopeManager {
  constructor() {
    this.scopes = [];
  }

  enterScope(isFunction = false, expectedReturnType = null) {
    this.scopes.push({
      isFunction,
      expectedReturnType,
      symbols: new Map(),
    });
  }

  exitScope() {
    return this.scopes.pop();
  }

  currentScope() {
    if (this.scopes.length === 0) return null;
    return this.scopes[this.scopes.length - 1];
  }

  registerSymbol(name, data) {
    const scope = this.currentScope();
    if (scope) {
      scope.symbols.set(name, data);
    }
  }

  lookupSymbol(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].symbols.has(name)) {
        return this.scopes[i].symbols.get(name);
      }
    }
    return null;
  }

  lookupSymbolInCurrentScope(name) {
    if (this.scopes.length === 0) return null;
    return this.scopes[this.scopes.length - 1].symbols.get(name) || null;
  }

  isInFunction() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isFunction) return true;
    }
    return false;
  }

  getCurrentExpectedReturnType() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isFunction) {
        return this.scopes[i].expectedReturnType;
      }
    }
    return null;
  }

  clear() {
    this.scopes = [];
  }
}
