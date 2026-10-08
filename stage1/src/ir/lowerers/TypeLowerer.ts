// stage1/src/ir/lowerers/TypeLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class TypeLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }

  toMLIRType(tsType: string): string {
    if (tsType === "number") return "f64";
    if (tsType === "i32") return "i32";
    if (tsType === "i64") return "i64";
    if (tsType === "u8") return "i8";
    if (tsType === "boolean") return "i1";
    if (tsType === "string") return "!llvm.ptr";
    if (tsType === "pointer") return "!llvm.ptr";
    if (tsType === "void") return "none";
    return "!llvm.ptr";
  }
}
