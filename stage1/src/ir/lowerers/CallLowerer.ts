// stage1/src/ir/lowerers/CallLowerer.ts
import { ASTLowering } from "../ASTLowerer.ts";

export class CallLowerer {
  astLowerer: ASTLowering;

  constructor(astLowerer: ASTLowering) {
    this.astLowerer = astLowerer;
  }

  lowerCall(callee: string, args: string[]): string {
    return "";
  }
}
