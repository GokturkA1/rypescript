// stage1/src/ir/lowerers/ClassLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class ClassLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }
}
