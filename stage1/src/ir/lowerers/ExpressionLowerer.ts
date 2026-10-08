// stage1/src/ir/lowerers/ExpressionLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class ExpressionLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }

  lowerExpression(expr: string): string {
    return "";
  }
}
