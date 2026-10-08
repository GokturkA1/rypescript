// stage1/src/ir/lowerers/NapiLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class NapiLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }
}
