// stage1/src/ir/lowerers/MemoryLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class MemoryLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }

  lowerNew(className: string): string {
    return "";
  }
}
