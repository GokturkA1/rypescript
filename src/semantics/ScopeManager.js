// src/semantics/ScopeManager.js

/**
 * Kapsam yığını (scope stack), sembol çözümleme (lookupSymbol)
 * ve değişken yaşam döngüsünü yöneten bileşen.
 */
export class ScopeManager {
  constructor() {
    this.scopes = [];
  }

  /**
   * Kapsam açar.
   * Geriye dönük uyumluluk için `enterScope(isFunction, expectedReturnType)`
   * veya zengin seçenekler için `enterScope({ isFunction, expectedReturnType, isLoop, isSwitch, isClass, classMeta, isConstructor })` kabul eder.
   */
  enterScope(options = false, expectedReturnType = null) {
    let isFunction = false;
    let retType = expectedReturnType;
    let isLoop = false;
    let isSwitch = false;
    let isClass = false;
    let classMeta = null;
    let isConstructor = false;
    let isStaticMethod = false;

    if (typeof options === "boolean") {
      isFunction = options;
    } else if (typeof options === "object" && options !== null) {
      isFunction = Boolean(options.isFunction);
      retType = options.expectedReturnType || null;
      isLoop = Boolean(options.isLoop);
      isSwitch = Boolean(options.isSwitch);
      isClass = Boolean(options.isClass);
      classMeta = options.classMeta || null;
      isConstructor = Boolean(options.isConstructor);
      isStaticMethod = Boolean(options.isStaticMethod);
    }

    this.scopes.push({
      isFunction,
      expectedReturnType: retType,
      isLoop,
      isSwitch,
      isClass,
      classMeta,
      isConstructor,
      isStaticMethod,
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

  hasSymbolInCurrentScope(name) {
    const scope = this.currentScope();
    return scope ? scope.symbols.has(name) : false;
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

  isInConstructor() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isConstructor) return true;
      if (this.scopes[i].isFunction) return false;
    }
    return false;
  }

  isInLoop() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isLoop) return true;
    }
    return false;
  }

  isInSwitch() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isSwitch) return true;
    }
    return false;
  }

  isInClass() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isClass) return true;
    }
    return false;
  }

  isInStaticMethod() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isStaticMethod) return true;
      if (this.scopes[i].isFunction) return false;
    }
    return false;
  }

  getCurrentClass() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].isClass && this.scopes[i].classMeta) {
        return this.scopes[i].classMeta;
      }
    }
    return null;
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
