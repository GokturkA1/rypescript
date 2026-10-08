// stage1/src/ir/lowerers/SimdLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class SimdLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }
}
