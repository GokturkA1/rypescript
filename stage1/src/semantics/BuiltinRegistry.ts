// stage1/src/semantics/BuiltinRegistry.ts

export class BuiltinFuncSig {
  name: string;
  paramTypes: string[];
  returnType: string;

  constructor(name: string, paramTypes: string[], returnType: string) {
    this.name = name;
    this.paramTypes = paramTypes;
    this.returnType = returnType;
  }
}

export class BuiltinRegistry {
  functions: BuiltinFuncSig[];
  count: number;

  constructor() {
    this.functions = [
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null
    ];
    this.count = 0;
    this.registerDefaults();
  }

  registerDefaults(): void {
    let emptyParams: string[] = [];

    let singlePtr: string[] = ["pointer"];
    let numParam: string[] = ["number"];
    let twoNumParam: string[] = ["number", "number"];

    this.register("malloc", numParam, "pointer");
    this.register("free", singlePtr, "void");
    this.register("alloca", numParam, "pointer");
    this.register("sleep", numParam, "void");
    this.register("panic", ["string"], "never");
    this.register("assert", ["boolean", "string"], "void");

    this.register("ptr_read_u8", singlePtr, "number");
    this.register("ptr_read_i32", singlePtr, "number");
    this.register("ptr_read_f64", singlePtr, "number");
    this.register("ptr_write_u8", ["pointer", "number", "number"], "void");
    this.register("ptr_write_i32", ["pointer", "number", "number"], "void");
    this.register("ptr_write_f64", ["pointer", "number", "number"], "void");
    this.register("ptr_add", ["pointer", "number"], "pointer");

    this.register("Ok", ["any"], "Result");
    this.register("Err", ["any"], "Result");
    this.register("unwrap", ["any"], "any");
  }

  register(name: string, params: string[], returnType: string): void {
    if (this.count < this.functions.length) {
      this.functions[this.count] = new BuiltinFuncSig(name, params, returnType);
      this.count = this.count + 1;
    }
  }

  hasFunction(name: string): boolean {
    for (let i: number = 0; i < this.count; i++) {
      if (this.functions[i].name === name) return true;
    }
    return false;
  }

  getFunction(name: string): BuiltinFuncSig {
    for (let i: number = 0; i < this.count; i++) {
      if (this.functions[i].name === name) return this.functions[i];
    }
    return null;
  }
}
