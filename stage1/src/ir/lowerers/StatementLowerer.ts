// stage1/src/ir/lowerers/StatementLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class StatementLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }

  lowerStatement(stmt: string): void {
    // Statement lowering logic
  }
}
