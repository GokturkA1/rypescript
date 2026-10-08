// stage1/src/semantics/ScopeManager.ts

export class SymbolInfo {
  name: string;
  type: string;
  isConst: boolean;

  constructor(name: string, type: string, isConst: boolean) {
    this.name = name;
    this.type = type;
    this.isConst = isConst;
  }
}

export class Scope {
  parent: Scope;
  symbols: SymbolInfo[];
  count: number;
  isFunction: boolean;
  expectedReturnType: string;

  constructor(parent: Scope, isFunction: boolean, expectedReturnType: string) {
    this.parent = parent;
    this.symbols = [
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null
    ];
    this.count = 0;
    this.isFunction = isFunction;
    this.expectedReturnType = expectedReturnType;
  }

  define(name: string, type: string, isConst: boolean): void {
    if (this.count < this.symbols.length) {
      this.symbols[this.count] = new SymbolInfo(name, type, isConst);
      this.count = this.count + 1;
    }
  }

  lookup(name: string): SymbolInfo {
    for (let i: number = 0; i < this.count; i++) {
      if (this.symbols[i].name === name) {
        return this.symbols[i];
      }
    }
    return null;
  }
}

export class ScopeManager {
  current: Scope;

  constructor() {
    this.current = null;
  }

  enterScope(isFunction: boolean, expectedReturnType: string): void {
    this.current = new Scope(this.current, isFunction, expectedReturnType);
  }

  exitScope(): Scope {
    let old = this.current;
    if (this.current !== null) {
      this.current = this.current.parent;
    }
    return old;
  }

  currentScope(): Scope {
    return this.current;
  }

  lookup(name: string): SymbolInfo {
    let curr = this.current;
    while (curr !== null) {
      let sym = curr.lookup(name);
      if (sym !== null) return sym;
      curr = curr.parent;
    }
    return null;
  }

  define(name: string, type: string, isConst: boolean): void {
    if (this.current !== null) {
      this.current.define(name, type, isConst);
    }
  }
}
